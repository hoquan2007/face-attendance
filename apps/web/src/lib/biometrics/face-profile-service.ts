/**
 * FaceProfile service layer.
 *
 * PHASE 4.2 — FaceProfile + FaceEnrollmentSession database foundation.
 *
 * Encapsulates all reads and writes against the `face_profiles`
 * collection. Server Components, Server Actions, and Route Handlers
 * call this module instead of touching the Mongoose model directly.
 *
 * Authorization:
 *   - Every service function receives an authenticated Better Auth
 *     `userId`. The service NEVER derives identity from request bodies
 *     or query strings.
 *   - Lookup-by-arbitrary-user-id is not exposed here.
 *
 * Idempotency:
 *   - `saveFaceProfile` uses an upsert keyed on `userId`. The unique
 *     index on `userId` guarantees at most one active FaceProfile per
 *     user at the database layer.
 *
 * Errors:
 *   - Duplicate-key errors are mapped to safe user-facing
 *     `BiometricPersistenceError` instances via `biometric-errors.ts`.
 *   - Raw Mongoose / MongoDB errors never escape this module.
 */

import { getMongooseConnection } from "@/lib/mongoose";
import {
  FaceProfileModel,
  FACE_PROFILE_STATUSES,
  type FaceProfileAttrs,
} from "@/lib/biometrics/face-profile-model";
import {
  BiometricPersistenceError,
  BIOMETRIC_PERSISTENCE_ERROR_CODES,
  mapMongoDuplicateKeyErrorForBiometrics,
} from "@/lib/biometrics/biometric-errors";

/**
 * Lazily ensures the Mongoose connection is ready before any model
 * operation. Cheap on subsequent calls (sub-millisecond) and keeps
 * each function safe to invoke from any server-side context.
 */
async function ensureConnection(): Promise<void> {
  await getMongooseConnection();
}

/**
 * Returns the FaceProfile document for the given Better Auth user, or
 * `null` if no profile exists.
 *
 * Authorization: only the current user's own profile can be read.
 * The caller is responsible for ensuring `userId` came from the
 * authenticated session, not from the request body.
 */
export async function getFaceProfileByUserId(
  userId: string,
): Promise<FaceProfileAttrs | null> {
  await ensureConnection();
  const doc = await FaceProfileModel.findOne({ userId })
    .lean<FaceProfileAttrs>()
    .exec();
  return doc ?? null;
}

/**
 * Returns `true` if the given user already has a FaceProfile.
 *
 * `false` means no document exists for the user — the user has not yet
 * completed (or has revoked) face enrollment.
 */
export async function hasFaceProfile(userId: string): Promise<boolean> {
  await ensureConnection();
  const doc = await FaceProfileModel.exists({ userId });
  return doc !== null && doc !== undefined;
}

/**
 * Input shape for `saveFaceProfile`.
 *
 * `userId` is required and identifies the Better Auth user this
 * FaceProfile belongs to. All other fields are required to fully
 * describe an active FaceProfile — partial updates are not part of
 * PHASE 4.2's scope.
 */
export type SaveFaceProfileInput = Omit<FaceProfileAttrs, "createdAt" | "updatedAt">;

/**
 * Atomically inserts (or replaces) the FaceProfile for the given
 * Better Auth user.
 *
 * Behavior:
 *   - If no FaceProfile exists for `userId`, a new document is created.
 *   - If one already exists, it is replaced with the supplied payload
 *     via upsert. This keeps enrollment finalization idempotent.
 *   - Because `userId` is uniquely indexed, parallel saves collapse to
 *     a single document at the database layer.
 *
 * The caller is responsible for ensuring the input has been fully
 * validated (status, model metadata, samples, centroid). Service code
 * does not run business validation — it only enforces the minimum
 * `status: "active"` invariant.
 *
 * Throws:
 *   - `BiometricPersistenceError(BIOMETRIC_PROFILE_ALREADY_EXISTS)` on
 *     unexpected duplicate-key races.
 *   - `BiometricPersistenceError(UNKNOWN_ERROR)` on any other database
 *     failure.
 */
export async function saveFaceProfile(
  input: SaveFaceProfileInput,
): Promise<FaceProfileAttrs> {
  await ensureConnection();

  if (!FACE_PROFILE_STATUSES.includes(input.status)) {
    throw new BiometricPersistenceError({
      code: BIOMETRIC_PERSISTENCE_ERROR_CODES.INVALID_BIOMETRIC_DATA,
      message: "FaceProfile status is invalid.",
    });
  }

  const now = new Date();
  try {
    const doc = await FaceProfileModel.findOneAndUpdate(
      { userId: input.userId },
      {
        $set: {
          status: input.status,
          modelIdentity: input.modelIdentity,
          modelName: input.modelName,
          embeddingDimension: input.embeddingDimension,
          normalization: input.normalization,
          templateVersion: input.templateVersion,
          requiredSampleCount: input.requiredSampleCount,
          sampleCount: input.sampleCount,
          samples: input.samples,
          centroid: input.centroid,
          qualitySummary: input.qualitySummary,
          enrolledAt: input.enrolledAt,
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
      .lean<FaceProfileAttrs>()
      .exec();

    if (!doc) {
      throw new BiometricPersistenceError({
        code: BIOMETRIC_PERSISTENCE_ERROR_CODES.UNKNOWN_ERROR,
        message: "Failed to save face profile.",
      });
    }
    return doc;
  } catch (err) {
    if (err instanceof BiometricPersistenceError) throw err;
    throw mapMongoDuplicateKeyErrorForBiometrics(err);
  }
}

/**
 * PHASE 4.6B2B — input shape for `saveFinalizedFaceProfile`.
 *
 * Mirrors `SaveFaceProfileInput` but additionally requires the
 * server-only `sourceEnrollmentGenerationId` lineage marker. The
 * new persistence service is responsible for stamping the value
 * before calling this function. Legacy / generic `saveFaceProfile`
 * callers continue to be allowed to omit it for backward
 * compatibility with PHASE 4.2 fixtures.
 */
export type SaveFinalizedFaceProfileInput = Omit<
  FaceProfileAttrs,
  "createdAt" | "updatedAt" | "sourceEnrollmentGenerationId"
> & {
  sourceEnrollmentGenerationId: string;
};

/**
 * PHASE 4.6B2B — atomically persists (or re-affirms) a
 * `FaceProfile` created by a specific enrollment generation.
 *
 * The atomic `findOneAndUpdate` filter requires ALL of:
 *   - `userId === input.userId`
 *   - `sourceEnrollmentGenerationId === input.sourceEnrollmentGenerationId`
 *     (matches either an existing profile created by the same
 *     generation OR, on first write, requires the field to be
 *     absent so an unrelated profile cannot be silently overwritten)
 *
 * Behaviour:
 *   - **First write (no existing profile):** a fresh document is
 *     inserted with `sourceEnrollmentGenerationId = input....`. The
 *     legacy `userId` unique index prevents two profiles for the
 *     same user regardless of generation.
 *   - **Same-generation retry:** the filter matches the existing
 *     document because its lineage equals the input's lineage. No
 *     new document is created; the stored `enrolledAt` is preserved
 *     (idempotent retry MUST NOT shift the enrolled-at timestamp).
 *   - **Different generation attempt:** the filter misses because
 *     the stored lineage differs. A `FACE_PROFILE_ALREADY_EXISTS`
 *     is surfaced; the existing profile is NOT overwritten.
 *
 * The function deliberately does NOT use a MongoDB transaction —
 * B2B persistence must be independently idempotent. Enrollment
 * session cleanup is B2C's responsibility.
 */
export async function saveFinalizedFaceProfile(
  input: SaveFinalizedFaceProfileInput,
): Promise<{
  profile: FaceProfileAttrs;
  created: boolean;
}> {
  await ensureConnection();

  if (!FACE_PROFILE_STATUSES.includes(input.status)) {
    throw new BiometricPersistenceError({
      code: BIOMETRIC_PERSISTENCE_ERROR_CODES.INVALID_BIOMETRIC_DATA,
      message: "FaceProfile status is invalid.",
    });
  }

  if (
    typeof input.sourceEnrollmentGenerationId !== "string" ||
    input.sourceEnrollmentGenerationId.length === 0
  ) {
    throw new BiometricPersistenceError({
      code: BIOMETRIC_PERSISTENCE_ERROR_CODES.INVALID_BIOMETRIC_DATA,
      message:
        "saveFinalizedFaceProfile requires a non-empty sourceEnrollmentGenerationId.",
    });
  }

  const now = new Date();
  const lineage = input.sourceEnrollmentGenerationId;

  // ---------------------------------------------------------------------------
  // The atomic filter — same lineage on retry.
  //
  // We accept an existing document ONLY when its
  // `sourceEnrollmentGenerationId` equals the lineage we are about
  // to persist. We do NOT match a document that lacks lineage at
  // all (legacy compatibility is read-only; new persistence
  // requires the lineage marker).
  //
  // Two CAS flavors, in order:
  //   1. Match an existing same-lineage document → idempotent retry
  //      (no field overwrite; preserve enrolledAt / createdAt).
  //   2. No existing document → upsert a fresh one. The legacy
  //      unique index on `userId` guarantees at most one profile
  //      per user, regardless of generation.
  // ---------------------------------------------------------------------------
  try {
    // ---- Flavor 1: same-lineage idempotent retry ----
    const retryMatch = await FaceProfileModel.findOneAndUpdate(
      {
        userId: input.userId,
        sourceEnrollmentGenerationId: lineage,
      },
      {
        // Same-generation retry does NOT refresh `enrolledAt`. We
        // also intentionally omit `samples`, `centroid`, and
        // `qualitySummary` from the update — the existing values
        // remain untouched. The $set only carries non-biometric
        // metadata that is allowed to be stable across retries.
        $set: {
          status: input.status,
          modelIdentity: input.modelIdentity,
          modelName: input.modelName,
          embeddingDimension: input.embeddingDimension,
          normalization: input.normalization,
          templateVersion: input.templateVersion,
          requiredSampleCount: input.requiredSampleCount,
          sampleCount: input.sampleCount,
          qualitySummary: input.qualitySummary,
        },
      },
      { new: true, runValidators: true },
    )
      .lean<FaceProfileAttrs>()
      .exec();

    if (retryMatch) {
      return { profile: retryMatch, created: false };
    }

    // ---- Flavor 2: first write. Upsert a fresh document. ----
    // The legacy `userId` unique index is the safety net — a
    // concurrent first-write attempt for the same user cannot
    // create two documents. If the upsert collides on `userId`,
    // we surface FACE_PROFILE_ALREADY_EXISTS via the duplicate-key
    // mapper so the caller can decide whether to retry with the
    // existing lineage.
    const fresh = await FaceProfileModel.findOneAndUpdate(
      { userId: input.userId },
      {
        $set: {
          status: input.status,
          modelIdentity: input.modelIdentity,
          modelName: input.modelName,
          embeddingDimension: input.embeddingDimension,
          normalization: input.normalization,
          templateVersion: input.templateVersion,
          requiredSampleCount: input.requiredSampleCount,
          sampleCount: input.sampleCount,
          samples: input.samples,
          centroid: input.centroid,
          qualitySummary: input.qualitySummary,
          enrolledAt: input.enrolledAt,
          sourceEnrollmentGenerationId: lineage,
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
      .lean<FaceProfileAttrs>()
      .exec();

    if (!fresh) {
      throw new BiometricPersistenceError({
        code: BIOMETRIC_PERSISTENCE_ERROR_CODES
          .FACE_PROFILE_PERSISTENCE_FAILED,
        message: "Failed to save finalized FaceProfile.",
      });
    }
    return { profile: fresh, created: true };
  } catch (err) {
    if (err instanceof BiometricPersistenceError) throw err;
    // Duplicate-key on the legacy userId index means another
    // process already created a profile for this user with a
    // different lineage. Surface a stable FACE_PROFILE_ALREADY_EXISTS.
    throw mapMongoDuplicateKeyErrorForBiometrics(err);
  }
}

/**
 * PHASE 4.6B2B — read-only classification of a stored FaceProfile
 * by its lineage marker.
 *
 * Returns:
 *   - `"none"`        — no FaceProfile exists for this user.
 *   - `"same"`        — existing profile was created by `lineage`.
 *   - `"different"`   — existing profile was created by a different
 *                       generation (write must be rejected to avoid
 *                       overwrite).
 *   - `"legacy"`      — existing profile predates the lineage field
 *                       (no lineage value present at all).
 *
 * This helper is read-only and never mutates state.
 */
export async function classifyFaceProfileByLineage(params: {
  userId: string;
  lineage: string;
}): Promise<"none" | "same" | "different" | "legacy"> {
  await ensureConnection();
  const existing = await FaceProfileModel.findOne({ userId: params.userId })
    .select({ sourceEnrollmentGenerationId: 1 })
    .lean<{ sourceEnrollmentGenerationId?: string }>()
    .exec();
  if (!existing) return "none";
  const existingLineage = existing.sourceEnrollmentGenerationId;
  if (
    typeof existingLineage !== "string" ||
    existingLineage.length === 0
  ) {
    return "legacy";
  }
  return existingLineage === params.lineage ? "same" : "different";
}

/**
 * Deletes the FaceProfile belonging to the given Better Auth user, if
 * one exists.
 *
 * Authorization: only the current user's own FaceProfile can be
 * deleted. There is no public API to delete another user's profile.
 *
 * Returns `true` if a document was deleted, `false` otherwise.
 */
export async function deleteFaceProfileByUserId(
  userId: string,
): Promise<boolean> {
  await ensureConnection();
  const result = await FaceProfileModel.deleteOne({ userId }).exec();
  return Boolean(result.deletedCount && result.deletedCount > 0);
}

// Internal helpers exported for tests only.
export const __testing = {
  FaceProfileModel,
};
