/**
 * FaceEnrollmentSession service layer.
 *
 * PHASE 4.2 — FaceProfile + FaceEnrollmentSession database foundation.
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
 *     refreshed, and model metadata is reset to `undefined`.
 *
 * Expiration:
 *   - `isEnrollmentSessionExpired(session)` uses `expiresAt <= now`.
 *     Service code must call this before consuming a session because
 *     MongoDB TTL deletion is asynchronous.
 *
 * This service intentionally does NOT implement:
 *   - adding a face sample
 *   - quality checking
 *   - embedding encryption
 *   - Face Service calls
 *   - finalization
 *
 * Those belong to later phases.
 */

import { getMongooseConnection } from "@/lib/mongoose";
import {
  FaceEnrollmentSessionModel,
  type FaceEnrollmentSessionAttrs,
} from "@/lib/biometrics/enrollment-session-model";
import { DEFAULT_ENROLLMENT_SESSION_TTL_MS } from "@/lib/biometrics/enrollment-session-ttl";
import {
  BiometricPersistenceError,
  BIOMETRIC_PERSISTENCE_ERROR_CODES,
  mapMongoDuplicateKeyErrorForBiometrics,
} from "@/lib/biometrics/biometric-errors";
import type { EnrollmentMode } from "@/lib/biometrics/biometric-schema";

/**
 * Lazily ensures the Mongoose connection is ready before any model
 * operation.
 */
async function ensureConnection(): Promise<void> {
  await getMongooseConnection();
}

/**
 * Returns the active enrollment session for the given Better Auth
 * user, or `null` if none exists.
 *
 * This function does NOT check expiration. Callers must use
 * `isEnrollmentSessionExpired(session)` to decide whether the session
 * is still usable; expired sessions should be discarded (or reset)
 * rather than consumed.
 */
export async function getEnrollmentSessionByUserId(
  userId: string,
): Promise<FaceEnrollmentSessionAttrs | null> {
  await ensureConnection();
  const doc = await FaceEnrollmentSessionModel.findOne({ userId })
    .lean<FaceEnrollmentSessionAttrs>()
    .exec();
  return doc ?? null;
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

  try {
    const doc = await FaceEnrollmentSessionModel.findOneAndUpdate(
      { userId: input.userId },
      {
        $set: {
          mode: input.mode,
          templateVersion: input.templateVersion,
          requiredSampleCount: input.requiredSampleCount,
          expiresAt,
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
