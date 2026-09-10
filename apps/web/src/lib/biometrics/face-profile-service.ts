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
