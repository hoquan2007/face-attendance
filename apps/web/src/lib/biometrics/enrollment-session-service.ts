/**
 * FaceEnrollmentSession service layer.
 *
 * PHASE 4.2 — FaceProfile + FaceEnrollmentSession database foundation.
 * PHASE 4.5B4.3 — Stable `generationId` + lazy legacy backfill.
 *
 * Encapsulates all reads and writes against the
 * `face_enrollment_sessions` collection. Server Components, Server
 * Actions, and Route Handlers call this module instead of touching
 * the Mongoose model directly.
 *
 * Authorization:
 *   - Every service function receives an authenticated Better Auth
 *     `userId`. The service NEVER derives identity from request bodies
 *     or query strings.
 *
 * Idempotency:
 *   - `createOrResetEnrollmentSession` uses an upsert keyed on
 *     `userId`. The unique index on `userId` guarantees at most one
 *     active session per user at the database layer.
 *   - Reset semantics: `acceptedSamples` is cleared, `expiresAt` is
 *     refreshed, `generationId` is freshly regenerated, and model
 *     metadata is reset to `undefined`.
 *
 * Expiration:
 *   - `isEnrollmentSessionExpired(session)` uses `expiresAt <= now`.
 *     Service code must call this before consuming a session because
 *     MongoDB TTL deletion is asynchronous.
 *
 * `generationId` (PHASE 4.5B4.3):
 *   - Each enrollment session carries a stable, server-generated
 *     `generationId` (UUID v4) created atomically with the document.
 *   - The `generationId` is the primary multi-tab / reload-resilience
 *     discriminator. It is the ONLY thing that survives across
 *     upserts; `expiresAt` is only a TTL / display field.
 *   - Legacy documents that pre-date this field are migrated lazily
 *     and atomically by `getEnrollmentSessionByUserId`. The backfill
 *     preserves every other field (samples, mode, model metadata,
 *     expiresAt). Exactly one backfill wins when two concurrent
 *     reads race; the loser re-reads and observes the persisted
 *     winner's `generationId`.
 *
 * This service intentionally does NOT implement:
 *   - quality checking
 *   - Face Service calls
 *   - finalization
 *
 * Those belong to later phases.
 */

import { randomUUID } from "node:crypto";

import { getMongooseConnection } from "@/lib/mongoose";
import {
  FaceEnrollmentSessionModel,
  type FaceEnrollmentSessionAttrs,
  type FaceEnrollmentAcceptedSampleDoc,
} from "@/lib/biometrics/enrollment-session-model";
import { DEFAULT_ENROLLMENT_SESSION_TTL_MS } from "@/lib/biometrics/enrollment-session-ttl";
import {
  BiometricPersistenceError,
  BIOMETRIC_PERSISTENCE_ERROR_CODES,
  mapMongoDuplicateKeyErrorForBiometrics,
} from "@/lib/biometrics/biometric-errors";
import type { EnrollmentMode, Normalization } from "@/lib/biometrics/biometric-schema";
import type { EncryptedBiometricValueDoc } from "@/lib/biometrics/biometric-schema";

/**
 * Lazily ensures the Mongoose connection is ready before any model
 * operation.
 */
async function ensureConnection(): Promise<void> {
  await getMongooseConnection();
}

/**
 * Generates a stable, server-side UUID for a single enrollment
 * generation. Exported for tests that need deterministic IDs.
 *
 * Production callers MUST NOT import this directly — the service
 * layer is the only place that creates / backfills `generationId`.
 */
export function createGenerationId(): string {
  return randomUUID();
}

/**
 * Returns the active enrollment session for the given Better Auth
 * user, or `null` if none exists.
 *
 * This function does NOT check expiration. Callers must use
 * `isEnrollmentSessionExpired(session)` to decide whether the session
 * is still usable; expired sessions should be discarded (or reset)
 * rather than consumed.
 *
 * Legacy backfill (PHASE 4.5B4.3):
 *   - If the persisted document lacks `generationId` (a legacy
 *     document from a PHASE 4.x version that pre-dates this field),
 *     this function performs a one-time atomic backfill:
 *       1. Read the persisted document.
 *       2. If `generationId` is already present → return it unchanged.
 *       3. Otherwise, generate a candidate UUID and apply an atomic
 *          `findOneAndUpdate` that ONLY mutates a document matching
 *          `userId === X` AND `generationId` is absent.
 *       4. The winner sees its candidate persisted. The loser reads
 *          back the persisted winner's `generationId` and returns it.
 *   - The backfill preserves every other field (samples, mode, model
 *     metadata, expiresAt, timestamps).
 *   - No in-memory lock is held — concurrency safety is purely the
 *     atomic MongoDB filter.
 *   - The function returns `null` (does NOT invent a UUID) when no
 *     document exists. Inventing a UUID for a non-existent session
 *     would create the unstable-ID anti-pattern this phase forbids.
 *   - Expired legacy sessions are NOT revived. They continue to be
 *     treated as inactive by the caller via
 *     `isEnrollmentSessionExpired(...)`.
 */
export async function getEnrollmentSessionByUserId(
  userId: string,
): Promise<FaceEnrollmentSessionAttrs | null> {
  await ensureConnection();
  const doc = await FaceEnrollmentSessionModel.findOne({ userId })
    .lean<FaceEnrollmentSessionAttrs>()
    .exec();
  if (!doc) return null;

  // Fast path: legacy-free document — return it verbatim.
  if (typeof doc.generationId === "string" && doc.generationId.length > 0) {
    return doc;
  }

  // Legacy backfill path: persist a generationId atomically iff the
  // field is still absent. Exactly one concurrent caller wins.
  const candidate = createGenerationId();
  let updated: FaceEnrollmentSessionAttrs | null = null;
  try {
    updated = await FaceEnrollmentSessionModel.findOneAndUpdate(
      { userId, generationId: { $exists: false } },
      { $set: { generationId: candidate } },
      { new: true },
    )
      .lean<FaceEnrollmentSessionAttrs>()
      .exec();
  } catch (err) {
    // The atomic filter cannot fail with a duplicate-key error
    // (generationId has no unique index), so any thrown error here is
    // a true infrastructure failure. Surface it via the safe mapper.
    throw mapMongoDuplicateKeyErrorForBiometrics(err);
  }

  if (updated && updated.generationId) {
    return updated;
  }

  // Either we lost the race, or another concurrent caller persisted a
  // different value first. Re-read and return the persisted winner.
  const reread = await FaceEnrollmentSessionModel.findOne({ userId })
    .lean<FaceEnrollmentSessionAttrs>()
    .exec();
  return reread ?? null;
}

/**
 * Input shape for `createOrResetEnrollmentSession`.
 *
 * `expiresAt` is required so callers can decide their own lifetime —
 * the service never invents expiration timestamps beyond the default
 * fallback computed when the caller does not supply one.
 */
export interface CreateOrResetEnrollmentSessionInput {
  userId: string;
  mode: EnrollmentMode;
  requiredSampleCount: number;
  templateVersion: number;
  /**
   * Absolute expiry timestamp. If omitted, the service defaults to
   * `now + DEFAULT_ENROLLMENT_SESSION_TTL_MS`.
   */
  expiresAt?: Date;
  /**
   * Override the generation-id generator (tests only). Production
   * callers MUST leave this undefined.
   *
   * @internal
   */
  generateGenerationId?: () => string;
}

/**
 * Atomically creates (or resets) the enrollment session for the given
 * Better Auth user.
 *
 * Reset semantics:
 *   - `acceptedSamples` is cleared to `[]`.
 *   - `mode`, `requiredSampleCount`, `templateVersion`, `expiresAt`
 *     are refreshed to the supplied values.
 *   - `modelIdentity`, `modelName`, `embeddingDimension`,
 *     `normalization` are reset to `undefined` because no sample has
 *     been processed yet.
 *   - `generationId` is freshly regenerated (a new server-side UUID).
 *
 * This function deliberately does NOT touch any existing FaceProfile.
 * Replacement behavior (revoking the previous FaceProfile) belongs to
 * a later phase.
 *
 * Throws:
 *   - `BiometricPersistenceError(BIOMETRIC_PROFILE_ALREADY_EXISTS)` on
 *     unexpected duplicate-key races.
 *   - `BiometricPersistenceError(UNKNOWN_ERROR)` on any other database
 *     failure.
 */
export async function createOrResetEnrollmentSession(
  input: CreateOrResetEnrollmentSessionInput,
): Promise<FaceEnrollmentSessionAttrs> {
  await ensureConnection();

  const now = new Date();
  const expiresAt =
    input.expiresAt ?? new Date(now.getTime() + DEFAULT_ENROLLMENT_SESSION_TTL_MS);
  const generationId = (
    input.generateGenerationId ?? createGenerationId
  )();

  try {
    const doc = await FaceEnrollmentSessionModel.findOneAndUpdate(
      { userId: input.userId },
      {
        $set: {
          mode: input.mode,
          templateVersion: input.templateVersion,
          requiredSampleCount: input.requiredSampleCount,
          expiresAt,
          generationId,
          // Reset transient fields.
          acceptedSamples: [],
          // Model metadata is intentionally absent until the first
          // sample is processed in a later phase.
          modelIdentity: undefined,
          modelName: undefined,
          embeddingDimension: undefined,
          normalization: undefined,
        },
        $setOnInsert: {
          userId: input.userId,
          createdAt: now,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
        runValidators: true,
      },
    )
      .lean<FaceEnrollmentSessionAttrs>()
      .exec();

    if (!doc) {
      throw new BiometricPersistenceError({
        code: BIOMETRIC_PERSISTENCE_ERROR_CODES.UNKNOWN_ERROR,
        message: "Failed to create enrollment session.",
      });
    }
    return doc;
  } catch (err) {
    if (err instanceof BiometricPersistenceError) throw err;
    throw mapMongoDuplicateKeyErrorForBiometrics(err);
  }
}

/**
 * Deletes the enrollment session belonging to the given Better Auth
 * user, if one exists.
 *
 * Authorization: only the current user's own session can be deleted.
 * There is no public API to delete another user's session.
 *
 * Returns `true` if a document was deleted, `false` otherwise.
 */
export async function deleteEnrollmentSessionByUserId(
  userId: string,
): Promise<boolean> {
  await ensureConnection();
  const result = await FaceEnrollmentSessionModel.deleteOne({ userId }).exec();
  return Boolean(result.deletedCount && result.deletedCount > 0);
}

/**
 * Result of an atomic append operation.
 */
export interface AppendSampleResult {
  /** Whether the append was successful */
  success: boolean;
  /** New count of accepted samples after the append */
  newAcceptedCount: number;
  /** Required sample count from the session */
  requiredSampleCount: number;
  /** Whether the enrollment is now complete (accepted >= required) */
  complete: boolean;
  /**
   * Why the operation failed (present when `success` is false).
   * Enables callers to map to the correct application error code.
   */
  reason?: AppendSampleFailureReason;
}

/**
 * Failure reason codes for atomic append operations.
 * These are internal service-layer codes that callers map to
 * safe application-level error codes.
 */
export const APPEND_SAMPLE_FAILURE_REASONS = {
  SESSION_EXPIRED: "SESSION_EXPIRED",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  SAMPLE_LIMIT_REACHED: "SAMPLE_LIMIT_REACHED",
  MODEL_MISMATCH: "MODEL_MISMATCH",
  /** Atomic update failed because another request won the race. */
  CONFLICT: "CONFLICT",
} as const;

export type AppendSampleFailureReason =
  (typeof APPEND_SAMPLE_FAILURE_REASONS)[keyof typeof APPEND_SAMPLE_FAILURE_REASONS];

/**
 * Input for appending an accepted enrollment sample.
 *
 * The caller (route handler) computes `expectedSampleIndex` as the
 * current `acceptedSamples.length`. The service atomically verifies
 * that MongoDB's `acceptedSamples` array still has exactly that many
 * elements before appending, preventing concurrent requests from
 * assigning the same index.
 */
export interface AppendAcceptedEnrollmentSampleInput {
  /** The user whose session to update */
  userId: string;
  /** The encrypted biometric vector to store */
  encryptedVector: EncryptedBiometricValueDoc;
  /**
   * The index the caller expects to be assigned to this sample.
   * Must equal the current `acceptedSamples.length` at call time.
   * The atomic update verifies this is still true before appending.
   */
  expectedSampleIndex: number;
  /** Quality metrics (optional) */
  quality?: FaceSampleQualityDoc;
  /** Model identity for the first sample (establishes session model) */
  modelIdentity?: string;
  /** Model name for the first sample */
  modelName?: string;
  /** Embedding dimension for the first sample */
  embeddingDimension?: number;
  /** Normalization for the first sample */
  normalization?: Normalization;
}

/**
 * Quality metrics for a face sample.
 */
interface FaceSampleQualityDoc {
  detectionScore?: number;
  blurScore?: number;
  brightness?: number;
  relativeFaceArea?: number;
}

/**
 * Atomically appends an accepted enrollment sample to the user's session.
 *
 * Concurrency guarantee:
 *   The atomic filter includes `acceptedSamples.length == expectedSampleIndex`
 *   as a MongoDB `$expr` condition alongside the existing
 *   `acceptedSamples.length < requiredSampleCount` upper bound.
 *
 *   This means:
 *   - If request A reads acceptedSamples.length = 0 and request B races,
 *     B's atomic update will only succeed if MongoDB still has exactly
 *     0 samples at update time. If A won the race and persisted index 0,
 *     B's filter fails and the function returns `CONFLICT`.
 *   - No two concurrent requests can persist the same `sampleIndex`.
 *   - The index stored in the persisted document is ALWAYS equal to
 *     `expectedSampleIndex` (not from caller input — enforced by the
 *     service, not by trusting the input).
 *
 * Failure cases:
 *   - Session not found → SESSION_NOT_FOUND
 *   - Session expired → SESSION_EXPIRED
 *   - Sample limit reached → SAMPLE_LIMIT_REACHED
 *   - Model mismatch (later sample) → MODEL_MISMATCH
 *   - Atomic filter failed (stale index) → CONFLICT
 *
 * The function deliberately does NOT retry after a CONFLICT. The
 * caller (route handler) returns a safe HTTP 409 response so the
 * browser/client can decide whether and when to submit a fresh sample.
 *
 * @param input The sample data, session identity, and expected index.
 * @returns Result indicating success/failure and updated counts.
 * @throws BiometricPersistenceError on unexpected database errors.
 */
export async function appendAcceptedEnrollmentSample(
  input: AppendAcceptedEnrollmentSampleInput,
): Promise<AppendSampleResult> {
  await ensureConnection();

  const now = new Date();
  const { expectedSampleIndex } = input;

  // Defensive pre-check: if the caller computed an obviously wrong index,
  // reject immediately without hitting the database. This is a sanity
  // check only — the atomic filter below is the real safety guard.
  if (expectedSampleIndex < 0) {
    return {
      success: false,
      newAcceptedCount: 0,
      requiredSampleCount: 5,
      complete: false,
      reason: APPEND_SAMPLE_FAILURE_REASONS.CONFLICT,
    };
  }

  // Load the session for pre-validation checks.
  // These are pre-checks only; the atomic filter is the definitive guard.
  const session = await FaceEnrollmentSessionModel.findOne({ userId: input.userId })
    .lean<FaceEnrollmentSessionAttrs>()
    .exec();

  if (!session) {
    return {
      success: false,
      newAcceptedCount: 0,
      requiredSampleCount: 5,
      complete: false,
      reason: APPEND_SAMPLE_FAILURE_REASONS.SESSION_NOT_FOUND,
    };
  }

  // Defensive expiration check (MongoDB TTL is asynchronous).
  if (session.expiresAt.getTime() <= now.getTime()) {
    return {
      success: false,
      newAcceptedCount: session.acceptedSamples.length,
      requiredSampleCount: session.requiredSampleCount,
      complete: false,
      reason: APPEND_SAMPLE_FAILURE_REASONS.SESSION_EXPIRED,
    };
  }

  // Pre-check sample limit.
  const currentCount = session.acceptedSamples.length;
  if (currentCount >= session.requiredSampleCount) {
    return {
      success: false,
      newAcceptedCount: currentCount,
      requiredSampleCount: session.requiredSampleCount,
      complete: true,
      reason: APPEND_SAMPLE_FAILURE_REASONS.SAMPLE_LIMIT_REACHED,
    };
  }

  // Pre-check for stale expected index.
  // If the caller's expected index is already behind the current count,
  // another request has already won the race.
  if (expectedSampleIndex !== currentCount) {
    return {
      success: false,
      newAcceptedCount: currentCount,
      requiredSampleCount: session.requiredSampleCount,
      complete: currentCount >= session.requiredSampleCount,
      reason: APPEND_SAMPLE_FAILURE_REASONS.CONFLICT,
    };
  }

  // Detect first sample based on session model metadata absence.
  const sessionHasModelMetadata = Boolean(
    session.modelIdentity &&
      session.modelName &&
      typeof session.embeddingDimension === "number" &&
      session.normalization,
  );
  const isFirstSample = !sessionHasModelMetadata;

  // For non-first samples, enforce model compatibility before the
  // atomic update so we can return a stable MODEL_MISMATCH instead
  // of CONFLICT.
  if (!isFirstSample) {
    if (
      session.modelIdentity !== input.modelIdentity ||
      session.modelName !== input.modelName ||
      session.embeddingDimension !== input.embeddingDimension ||
      session.normalization !== input.normalization
    ) {
      return {
        success: false,
        newAcceptedCount: currentCount,
        requiredSampleCount: session.requiredSampleCount,
        complete: false,
        reason: APPEND_SAMPLE_FAILURE_REASONS.MODEL_MISMATCH,
      };
    }
  }

  // Build the new sample document.
  // The sampleIndex stored is ALWAYS expectedSampleIndex — we do NOT
  // trust the caller to supply a correct index; we derive it from the
  // atomic filter's length condition.
  const newSample: FaceEnrollmentAcceptedSampleDoc = {
    encryptedVector: input.encryptedVector,
    sampleIndex: expectedSampleIndex,
    acceptedAt: now,
  };

  if (input.quality) {
    newSample.quality = {
      detectionScore: input.quality.detectionScore,
      blurScore: input.quality.blurScore,
      brightness: input.quality.brightness,
      relativeFaceArea: input.quality.relativeFaceArea ?? undefined,
    };
  }

  // Build the update operation.
  const updateDoc: Record<string, unknown> = {
    $push: {
      acceptedSamples: newSample,
    },
  };

  // For the first sample, also initialize model metadata in the same
  // atomic operation.
  if (isFirstSample) {
    (updateDoc as Record<string, unknown>).$set = {
      modelIdentity: input.modelIdentity,
      modelName: input.modelName,
      embeddingDimension: input.embeddingDimension,
      normalization: input.normalization,
    };
  }

  // ---------------------------------------------------------------------------
  // THE ATOMIC FILTER
  //
  // Must satisfy ALL of the following conditions atomically:
  //   1. userId matches
  //   2. expiresAt is in the future
  //   3. acceptedSamples.length == expectedSampleIndex  ← prevents duplicate index
  //   4. acceptedSamples.length < requiredSampleCount   ← enforces sample limit
  //   5. For first sample: modelIdentity does NOT exist (prevents two
  //      concurrent first-sample requests from racing)
  //   6. For later sample: model metadata matches exactly
  // ---------------------------------------------------------------------------
  const atomicFilter: Record<string, unknown> = {
    userId: input.userId,
    expiresAt: { $gt: now },
    // THE KEY CONCURRENCY GUARD: both conditions in one $expr.
    // $expr uses aggregation expressions evaluated at update time, so
    // MongoDB compares the CURRENT array size against expectedSampleIndex.
    $expr: {
      $and: [
        { $eq: [{ $size: "$acceptedSamples" }, expectedSampleIndex] },
        { $lt: [{ $size: "$acceptedSamples" }, "$requiredSampleCount"] },
      ],
    },
  };

  if (isFirstSample) {
    // First sample: require model metadata fields to be absent.
    // Combined with the $eq condition above, only one request can win
    // (the one that finds acceptedSamples.length == 0 and no model metadata).
    atomicFilter.modelIdentity = { $exists: false };
    atomicFilter.modelName = { $exists: false };
    atomicFilter.embeddingDimension = { $exists: false };
    atomicFilter.normalization = { $exists: false };
  } else {
    // Later sample: require exact model compatibility.
    atomicFilter.modelIdentity = input.modelIdentity;
    atomicFilter.modelName = input.modelName;
    atomicFilter.embeddingDimension = input.embeddingDimension;
    atomicFilter.normalization = input.normalization;
  }

  try {
    const result = await FaceEnrollmentSessionModel.findOneAndUpdate(
      atomicFilter,
      updateDoc,
      { new: true },
    )
      .lean<FaceEnrollmentSessionAttrs>()
      .exec();

    if (!result) {
      // Atomic update failed — fetch fresh session to diagnose.
      const freshSession = await FaceEnrollmentSessionModel.findOne({ userId: input.userId })
        .lean<FaceEnrollmentSessionAttrs>()
        .exec();

      if (!freshSession) {
        return {
          success: false,
          newAcceptedCount: 0,
          requiredSampleCount: 5,
          complete: false,
          reason: APPEND_SAMPLE_FAILURE_REASONS.SESSION_NOT_FOUND,
        };
      }

      if (freshSession.expiresAt.getTime() <= now.getTime()) {
        return {
          success: false,
          newAcceptedCount: freshSession.acceptedSamples.length,
          requiredSampleCount: freshSession.requiredSampleCount,
          complete: false,
          reason: APPEND_SAMPLE_FAILURE_REASONS.SESSION_EXPIRED,
        };
      }

      if (freshSession.acceptedSamples.length >= freshSession.requiredSampleCount) {
        return {
          success: false,
          newAcceptedCount: freshSession.acceptedSamples.length,
          requiredSampleCount: freshSession.requiredSampleCount,
          complete: true,
          reason: APPEND_SAMPLE_FAILURE_REASONS.SAMPLE_LIMIT_REACHED,
        };
      }

      if (!isFirstSample) {
        const freshHasMetadata = Boolean(
          freshSession.modelIdentity &&
            freshSession.modelName &&
            typeof freshSession.embeddingDimension === "number" &&
            freshSession.normalization,
        );
        if (!freshHasMetadata) {
          // Another request won the first-sample race.
          return {
            success: false,
            newAcceptedCount: freshSession.acceptedSamples.length,
            requiredSampleCount: freshSession.requiredSampleCount,
            complete: false,
            reason: APPEND_SAMPLE_FAILURE_REASONS.CONFLICT,
          };
        }
        // Check if it's a model mismatch.
        if (
          freshSession.modelIdentity !== input.modelIdentity ||
          freshSession.modelName !== input.modelName ||
          freshSession.embeddingDimension !== input.embeddingDimension ||
          freshSession.normalization !== input.normalization
        ) {
          return {
            success: false,
            newAcceptedCount: freshSession.acceptedSamples.length,
            requiredSampleCount: freshSession.requiredSampleCount,
            complete: false,
            reason: APPEND_SAMPLE_FAILURE_REASONS.MODEL_MISMATCH,
          };
        }
      }

      // Stale index — another request appended while this one was pending.
      return {
        success: false,
        newAcceptedCount: freshSession.acceptedSamples.length,
        requiredSampleCount: freshSession.requiredSampleCount,
        complete: freshSession.acceptedSamples.length >= freshSession.requiredSampleCount,
        reason: APPEND_SAMPLE_FAILURE_REASONS.CONFLICT,
      };
    }

    const newCount = result.acceptedSamples.length;
    return {
      success: true,
      newAcceptedCount: newCount,
      requiredSampleCount: result.requiredSampleCount,
      complete: newCount >= result.requiredSampleCount,
    };
  } catch (err) {
    if (err instanceof BiometricPersistenceError) throw err;
    throw mapMongoDuplicateKeyErrorForBiometrics(err);
  }
}

/**
 * Returns `true` when the session's `expiresAt` is at or before the
 * supplied `now` (or the current wall-clock time).
 *
 * This helper exists because MongoDB TTL deletion is asynchronous —
 * a document with `expiresAt` already in the past may still be present
 * in the collection for a brief window. Service code must treat
 * `expiresAt <= now` as expired regardless of physical deletion.
 *
 * @param session The session to check.
 * @param now     Optional reference timestamp. Defaults to `new Date()`.
 *                Tests inject a fixed value here.
 */
export function isEnrollmentSessionExpired(
  session: Pick<FaceEnrollmentSessionAttrs, "expiresAt">,
  now: Date = new Date(),
): boolean {
  return session.expiresAt.getTime() <= now.getTime();
}

// Internal helpers exported for tests only.
export const __testing = {
  FaceEnrollmentSessionModel,
  DEFAULT_ENROLLMENT_SESSION_TTL_MS,
};