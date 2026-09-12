/**
 * Enrollment finalization claim service (PHASE 4.6B2A).
 *
 * Server-only atomic claim acquisition + release for the temporary
 * `FaceEnrollmentSession`. The claim is the bridge between the
 * PHASE 4.6B1B B1B finalized snapshot and the future PHASE 4.6B2B
 * FaceProfile persistence.
 *
 * Why this exists (PHASE 4.6B2A):
 *   B1B currently performs:
 *     load generation A → decrypt → Face Service finalize →
 *     re-read generation A → return centroid.
 *   But a reset could theoretically occur AFTER that re-check and
 *   BEFORE future `FaceProfile` persistence.
 *
 *   The atomic completion claim ties B2B persistence to the exact
 *   generation that B1B finalized. The B2B persistence layer will
 *   be allowed to write only while it holds the claim; reset/start
 *   paths must reject while a claim is active.
 *
 * Design rules:
 *   - The claim is OPTIONAL on the document so legacy / pre-B2A
 *     sessions remain valid.
 *   - The claim token is server-generated, opaque, and
 *     cryptographically random (`node:crypto` `randomUUID()`).
 *     The browser MUST NOT supply it.
 *   - There is NO claim expiry / lease / heartbeat / setTimeout /
 *     background cleanup. The existing session `expiresAt` TTL
 *     remains the lifecycle boundary. B2B persistence explicitly
 *     releases the claim on its own.
 *   - There is NO unique index on `token`.
 *   - The claim is NEVER exposed through any browser-visible DTO.
 *
 * Atomic guarantees:
 *   - `claimEnrollmentSessionForFinalization` performs a single
 *     atomic MongoDB `findOneAndUpdate`. It succeeds ONLY when:
 *       userId matches
 *       generationId matches
 *       session is not expired (expiresAt > now)
 *       mode is in the supported set
 *       acceptedSamples.length === requiredSampleCount
 *       finalizationClaim is absent
 *     No read → check → write path. No in-memory lock.
 *   - `releaseEnrollmentFinalizationClaim` performs a single atomic
 *     MongoDB `findOneAndUpdate`. It succeeds ONLY when:
 *       userId matches
 *       generationId matches
 *       finalizationClaim.token matches
 *     A wrong token or generation does NOT clear another
 *     finalizer's claim.
 *
 * What this module does NOT do:
 *   - It does NOT persist a FaceProfile.
 *   - It does NOT encrypt or persist a centroid.
 *   - It does NOT delete a successful enrollment session.
 *   - It does NOT add a finalize API / UI.
 *   - It does NOT log the claim token. The token never leaves the
 *     server-only orchestration pipeline.
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { getMongooseConnection } from "@/lib/mongoose";
import {
  FaceEnrollmentSessionModel,
  type FaceEnrollmentFinalizationClaimDoc,
  type FaceEnrollmentSessionAttrs,
} from "@/lib/biometrics/enrollment-session-model";
import {
  BiometricPersistenceError,
  mapMongoDuplicateKeyErrorForBiometrics,
} from "@/lib/biometrics/biometric-errors";
import type { EnrollmentMode, Normalization } from "@/lib/biometrics/biometric-schema";
import { DEFAULT_FACE_ENROLLMENT_TEMPLATE_VERSION } from "@/lib/biometrics/biometric-constants";

// =============================================================================
// Stable claim error codes
// =============================================================================

/**
 * Stable claim service error codes.
 *
 * Mongoose / MongoDB internals are NEVER returned. Callers map these
 * codes to safe browser-facing responses.
 */
export const ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES = {
  /** No enrollment session exists for this user. */
  ENROLLMENT_SESSION_NOT_FOUND: "ENROLLMENT_SESSION_NOT_FOUND",
  /** Session exists but `expiresAt <= now`. */
  ENROLLMENT_SESSION_EXPIRED: "ENROLLMENT_SESSION_EXPIRED",
  /** Caller's generationId does not match the session's generationId. */
  ENROLLMENT_GENERATION_CHANGED: "ENROLLMENT_GENERATION_CHANGED",
  /** `acceptedSamples.length !== requiredSampleCount`. */
  ENROLLMENT_INCOMPLETE: "ENROLLMENT_INCOMPLETE",
  /** Session already carries an active finalizationClaim. */
  ENROLLMENT_FINALIZATION_ALREADY_CLAIMED:
    "ENROLLMENT_FINALIZATION_ALREADY_CLAIMED",
  /** Caller tried to reset a session that already holds a claim. */
  ENROLLMENT_FINALIZATION_IN_PROGRESS:
    "ENROLLMENT_FINALIZATION_IN_PROGRESS",
  /** Session mode / templateVersion / normalization unsupported. */
  UNSUPPORTED_ENROLLMENT_MODE: "UNSUPPORTED_ENROLLMENT_MODE",
  UNSUPPORTED_TEMPLATE_VERSION: "UNSUPPORTED_TEMPLATE_VERSION",
  UNSUPPORTED_NORMALIZATION: "UNSUPPORTED_NORMALIZATION",
  /** Unknown / unrecoverable database failure. */
  ENROLLMENT_FINALIZATION_CLAIM_FAILED:
    "ENROLLMENT_FINALIZATION_CLAIM_FAILED",
  /** Internal invariant violation — should never surface to callers. */
  ENROLLMENT_FINALIZATION_CLAIM_INVALID:
    "ENROLLMENT_FINALIZATION_CLAIM_INVALID",
} as const;

export type EnrollmentFinalizationClaimErrorCode =
  (typeof ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES)[keyof typeof ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES];

export interface EnrollmentFinalizationClaimErrorShape {
  code: EnrollmentFinalizationClaimErrorCode | string;
  message: string;
}

/**
 * Application-level error for claim operations. Stable, safe code
 * surface. Never carries ciphertext, IV, authTag, claim token,
 * plaintext embeddings, or stack traces.
 */
export class EnrollmentFinalizationClaimError extends Error {
  public readonly code: EnrollmentFinalizationClaimErrorCode | string;

  constructor({
    code,
    message,
  }: {
    code: EnrollmentFinalizationClaimErrorCode | string;
    message: string;
  }) {
    super(message);
    this.name = "EnrollmentFinalizationClaimError";
    this.code = code;
  }

  toJSON(): EnrollmentFinalizationClaimErrorShape {
    return {
      code: this.code,
      message: this.message,
    };
  }
}

// =============================================================================
// Internal constants
// =============================================================================

/**
 * Supported enrollment modes for the claim. Today only `create`.
 * `replace` is rejected with a stable domain code so the future
 * re-enrollment flow can decide what to do.
 */
const SUPPORTED_CLAIM_MODES: ReadonlySet<EnrollmentMode> = new Set(["create"]);

/**
 * Supported template versions. Only the default declared in
 * `biometric-constants.ts` is currently accepted. Older versions
 * are rejected with a stable error so the future caller can decide
 * whether to start a fresh enrollment.
 */
const SUPPORTED_CLAIM_TEMPLATE_VERSIONS: ReadonlySet<number> = new Set([
  DEFAULT_FACE_ENROLLMENT_TEMPLATE_VERSION,
]);

/**
 * Supported normalization strategies for the persisted session.
 * Mirrors `NORMALIZATIONS = ["l2"]`.
 */
const SUPPORTED_CLAIM_NORMALIZATIONS: ReadonlySet<Normalization> = new Set([
  "l2",
]);

// =============================================================================
// Result types
// =============================================================================

/**
 * Result of a successful claim acquisition.
 *
 * SERVER-ONLY data. The token is a server-side capability that
 * future PHASE 4.6B2B orchestration must hold before persisting a
 * `FaceProfile` for the captured generation. It is NEVER sent to
 * the browser, NEVER logged, and NEVER persisted outside the
 * temporary enrollment session.
 */
export interface ClaimedEnrollmentSession {
  userId: string;
  generationId: string;
  claimToken: string;
  claimedAt: Date;
}

/**
 * Result of a successful release operation.
 *
 * `released` is `true` when an active claim matching
 * `userId`/`generationId`/`claimToken` was cleared.
 * `released` is `false` when no claim matched — either because
 * the claim had already been released, the token was wrong, or
 * the generation drifted. The function never throws for a missing
 * claim.
 */
export interface ReleasedEnrollmentClaim {
  userId: string;
  generationId: string;
  released: boolean;
}

/**
 * Input for `claimEnrollmentSessionForFinalization`.
 *
 * `userId` MUST come from an authoritative server identity (the
 * future PHASE 4.6B3 authenticated session). The browser MUST NOT
 * provide it.
 *
 * `generationId` MUST come from the PHASE 4.6B1B finalized
 * snapshot — the generation that B1B just successfully finalized.
 */
export interface ClaimEnrollmentSessionForFinalizationInput {
  userId: string;
  generationId: string;
  /** Override token generator (tests only). */
  generateClaimToken?: () => string;
}

/**
 * Input for `releaseEnrollmentFinalizationClaim`.
 *
 * `claimToken` MUST match the token previously returned by
 * `claimEnrollmentSessionForFinalization`. Wrong tokens / wrong
 * generations / wrong userIds do NOT clear another finalizer's
 * claim.
 */
export interface ReleaseEnrollmentFinalizationClaimInput {
  userId: string;
  generationId: string;
  claimToken: string;
}

// =============================================================================
// Helpers
// =============================================================================

async function ensureConnection(): Promise<void> {
  await getMongooseConnection();
}

function generateClaimToken(): string {
  // node:crypto randomUUID() is the canonical, cryptographically
  // secure source. The browser never sees or provides this token.
  return randomUUID();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function wrapMongoError(err: unknown): never {
  if (err instanceof BiometricPersistenceError) throw err;
  throw mapMongoDuplicateKeyErrorForBiometrics(err);
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Atomically acquires the finalization claim for the user's current
 * enrollment session.
 *
 * The atomic MongoDB `findOneAndUpdate` filter requires ALL of:
 *   - `userId === input.userId`
 *   - `generationId === input.generationId`
 *   - `expiresAt > now`
 *   - `mode` is in the supported set (currently `create`)
 *   - `templateVersion` is in the supported set
 *   - `normalization` is in the supported set
 *   - `$size(acceptedSamples) === requiredSampleCount`
 *   - `finalizationClaim` is absent
 *
 * On match the update installs:
 *   - `finalizationClaim.token` (server-generated UUID)
 *   - `finalizationClaim.generationId` (echoes the active session's id)
 *   - `finalizationClaim.claimedAt` (current wall-clock time)
 *
 * On no match the function performs a controlled, server-side
 * re-read to classify the safe domain reason for the loss. The CAS
 * itself is NOT weakened. The re-read is best-effort diagnostic.
 *
 * The CAS can only lose for one of:
 *   - missing session → ENROLLMENT_SESSION_NOT_FOUND
 *   - expired session → ENROLLMENT_SESSION_EXPIRED
 *   - generation drift → ENROLLMENT_GENERATION_CHANGED
 *   - incomplete samples → ENROLLMENT_INCOMPLETE
 *   - existing claim → ENROLLMENT_FINALIZATION_ALREADY_CLAIMED
 *   - unsupported mode / templateVersion / normalization →
 *     UNSUPPORTED_ENROLLMENT_MODE / UNSUPPORTED_TEMPLATE_VERSION /
 *     UNSUPPORTED_NORMALIZATION
 *
 * @returns The server-only claim payload on success.
 * @throws EnrollmentFinalizationClaimError on any safe domain
 *         failure.
 * @throws BiometricPersistenceError on infrastructure failure.
 */
export async function claimEnrollmentSessionForFinalization(
  input: ClaimEnrollmentSessionForFinalizationInput,
): Promise<ClaimedEnrollmentSession> {
  if (!isNonEmptyString(input.userId)) {
    throw new EnrollmentFinalizationClaimError({
      code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES
        .ENROLLMENT_FINALIZATION_CLAIM_INVALID,
      message:
        "claimEnrollmentSessionForFinalization requires a non-empty userId.",
    });
  }
  if (!isNonEmptyString(input.generationId)) {
    throw new EnrollmentFinalizationClaimError({
      code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES
        .ENROLLMENT_FINALIZATION_CLAIM_INVALID,
      message:
        "claimEnrollmentSessionForFinalization requires a non-empty generationId.",
    });
  }

  await ensureConnection();
  const now = new Date();
  const claimToken = (input.generateClaimToken ?? generateClaimToken)();

  // ---------------------------------------------------------------------------
  // THE ATOMIC FILTER
  //
  // All preconditions are evaluated atomically by MongoDB in a single
  // findOneAndUpdate. This is the ONLY claim acquisition path. There is no
  // read → check → write fallback.
  // ---------------------------------------------------------------------------
  const atomicFilter: Record<string, unknown> = {
    userId: input.userId,
    generationId: input.generationId,
    expiresAt: { $gt: now },
    mode: { $in: Array.from(SUPPORTED_CLAIM_MODES) },
    templateVersion: { $in: Array.from(SUPPORTED_CLAIM_TEMPLATE_VERSIONS) },
    normalization: { $in: Array.from(SUPPORTED_CLAIM_NORMALIZATIONS) },
    finalizationClaim: { $exists: false },
    // The size-of-acceptedSamples == requiredSampleCount guard is the
    // database-level claim condition that proves the enrollment is
    // complete. The B1B in-memory count is NOT trusted on its own.
    $expr: {
      $eq: [{ $size: "$acceptedSamples" }, "$requiredSampleCount"],
    },
  };

  const newClaim: FaceEnrollmentFinalizationClaimDoc = {
    token: claimToken,
    generationId: input.generationId,
    claimedAt: now,
  };

  try {
    const result = await FaceEnrollmentSessionModel.findOneAndUpdate(
      atomicFilter,
      { $set: { finalizationClaim: newClaim } },
      { new: true },
    )
      .lean<FaceEnrollmentSessionAttrs>()
      .exec();

    if (result && result.finalizationClaim) {
      // Success. Return server-only payload.
      return {
        userId: result.userId,
        generationId: result.finalizationClaim.generationId,
        claimToken: result.finalizationClaim.token,
        claimedAt: result.finalizationClaim.claimedAt,
      };
    }

    // CAS lost. Perform a controlled, server-side diagnostic re-read
    // to classify the safe domain reason. The CAS itself is NOT
    // weakened — the re-read never affects state.
    const fresh = await FaceEnrollmentSessionModel.findOne({
      userId: input.userId,
    })
      .lean<FaceEnrollmentSessionAttrs>()
      .exec();

    if (!fresh) {
      throw new EnrollmentFinalizationClaimError({
        code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES
          .ENROLLMENT_SESSION_NOT_FOUND,
        message: "No enrollment session exists for this user.",
      });
    }
    if (fresh.generationId !== input.generationId) {
      throw new EnrollmentFinalizationClaimError({
        code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES
          .ENROLLMENT_GENERATION_CHANGED,
        message:
          "Enrollment generation changed between finalization and claim.",
      });
    }
    if (fresh.expiresAt.getTime() <= now.getTime()) {
      throw new EnrollmentFinalizationClaimError({
        code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES
          .ENROLLMENT_SESSION_EXPIRED,
        message: "Enrollment session is expired.",
      });
    }
    if (!SUPPORTED_CLAIM_MODES.has(fresh.mode)) {
      throw new EnrollmentFinalizationClaimError({
        code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES
          .UNSUPPORTED_ENROLLMENT_MODE,
        message: `Enrollment mode "${fresh.mode}" is not supported by claim.`,
      });
    }
    if (
      !isPositiveInteger(fresh.templateVersion) ||
      !SUPPORTED_CLAIM_TEMPLATE_VERSIONS.has(fresh.templateVersion)
    ) {
      throw new EnrollmentFinalizationClaimError({
        code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES
          .UNSUPPORTED_TEMPLATE_VERSION,
        message: `Enrollment session uses unsupported templateVersion ${fresh.templateVersion}.`,
      });
    }
    if (
      !fresh.normalization ||
      !SUPPORTED_CLAIM_NORMALIZATIONS.has(fresh.normalization)
    ) {
      throw new EnrollmentFinalizationClaimError({
        code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES
          .UNSUPPORTED_NORMALIZATION,
        message: `Enrollment session has unsupported normalization: ${fresh.normalization ?? "<missing>"}.`,
      });
    }
    if (fresh.acceptedSamples.length !== fresh.requiredSampleCount) {
      throw new EnrollmentFinalizationClaimError({
        code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES.ENROLLMENT_INCOMPLETE,
        message: "Enrollment session is not complete.",
      });
    }
    if (fresh.finalizationClaim) {
      throw new EnrollmentFinalizationClaimError({
        code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES
          .ENROLLMENT_FINALIZATION_ALREADY_CLAIMED,
        message:
          "Enrollment finalization is already claimed by another finalizer.",
      });
    }
    // Unknown loss — surface a generic failure. We do NOT silently
    // retry the CAS.
    throw new EnrollmentFinalizationClaimError({
      code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES
        .ENROLLMENT_FINALIZATION_CLAIM_FAILED,
      message:
        "Failed to acquire the enrollment finalization claim for an unknown reason.",
    });
  } catch (err) {
    if (err instanceof EnrollmentFinalizationClaimError) throw err;
    wrapMongoError(err);
  }
}

/**
 * Atomically releases the finalization claim for the user's
 * enrollment session.
 *
 * The atomic MongoDB `findOneAndUpdate` filter requires ALL of:
 *   - `userId === input.userId`
 *   - `generationId === input.generationId`
 *   - `finalizationClaim.token === input.claimToken`
 *
 * The update clears `finalizationClaim` to `undefined`. No other
 * fields are modified.
 *
 * Behavior matrix:
 *   - correct active claim → cleared, `{ released: true }`.
 *   - claim already absent (e.g. previously released) → no-op,
 *     `{ released: false }`. NEVER throws.
 *   - wrong token → no-op, `{ released: false }`. NEVER throws.
 *     Another finalizer's claim is NEVER cleared.
 *   - wrong generation → no-op, `{ released: false }`. NEVER throws.
 *   - missing session → no-op, `{ released: false }`. NEVER throws.
 *
 * This function is idempotent. It NEVER throws a raw Mongo error.
 * Callers do not need to retry.
 *
 * @returns Whether an active matching claim was released.
 */
export async function releaseEnrollmentFinalizationClaim(
  input: ReleaseEnrollmentFinalizationClaimInput,
): Promise<ReleasedEnrollmentClaim> {
  if (
    !isNonEmptyString(input.userId) ||
    !isNonEmptyString(input.generationId) ||
    !isNonEmptyString(input.claimToken)
  ) {
    // Invalid input: treat as already-released. Never throw raw
    // errors for caller-owned inputs.
    return {
      userId: input.userId,
      generationId: input.generationId,
      released: false,
    };
  }

  await ensureConnection();

  // ---------------------------------------------------------------------------
  // THE ATOMIC FILTER
  //
  // Releases ONLY when userId, generationId AND token all match.
  // Wrong token / wrong generation / wrong userId → no-op.
  // ---------------------------------------------------------------------------
  const atomicFilter: Record<string, unknown> = {
    userId: input.userId,
    generationId: input.generationId,
    "finalizationClaim.token": input.claimToken,
  };

  try {
    const result = await FaceEnrollmentSessionModel.findOneAndUpdate(
      atomicFilter,
      { $set: { finalizationClaim: undefined } },
      { new: true },
    )
      .lean<FaceEnrollmentSessionAttrs>()
      .exec();

    const released = Boolean(
      result &&
        (result.finalizationClaim === undefined ||
          result.finalizationClaim === null),
    );
    return {
      userId: input.userId,
      generationId: input.generationId,
      released,
    };
  } catch {
    // Deterministic: any failure here means we did not successfully
    // release. We never surface raw driver errors.
    return {
      userId: input.userId,
      generationId: input.generationId,
      released: false,
    };
  }
}