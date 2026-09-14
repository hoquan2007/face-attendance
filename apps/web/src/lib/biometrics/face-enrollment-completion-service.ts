/**
 * Server-only enrollment completion + crash-recovery orchestration.
 *
 * PHASE 4.6B2C — temporary enrollment consumption + post-persistence
 * crash recovery.
 *
 * This module is the SERVER-ONLY completion layer that consumes (or
 * recovers) the temporary `FaceEnrollmentSession` AFTER the
 * PHASE 4.6B2B `FaceProfile` has already been persisted.
 *
 * Why this exists:
 *   - PHASE 4.6B2B persists the `FaceProfile` and KEEPS the
 *     `finalizationClaim` + temporary session in place so that this
 *     phase can atomically consume the matching generation.
 *   - A crash between B2B (persistence) and B2C (cleanup) leaves a
 *     stale `FaceEnrollmentSession` document behind. A retry must
 *     recognize the already-persisted `FaceProfile`, prove lineage,
 *     and consume the matching session safely — WITHOUT rerunning
 *     B1B, WITHOUT calling the Face Service, WITHOUT decrypting or
 *     re-encrypting samples, WITHOUT rewriting the `FaceProfile`.
 *
 * Core principle — FaceProfile IS the commit point:
 *   Once a valid `FaceProfile` has been persisted for
 *   `(userId, sourceEnrollmentGenerationId)`, the durable
 *   enrollment result exists. Deleting the temporary session is
 *   CLEANUP.
 *
 *   Therefore:
 *     - Cleanup failure must NOT roll back `FaceProfile`.
 *     - A retry must NOT attempt to create a second `FaceProfile`.
 *
 * Design rules:
 *   - This module is `import "server-only"`.
 *   - It accepts only an AUTHORITATIVE server `userId` (PHASE 4.6B3
 *     will obtain it from `auth.api.getSession()`). The browser
 *     never chooses the userId.
 *   - No browser route, Server Action, or UI is added in B2C.
 *   - No MongoDB multi-document transaction.
 *   - No plaintext centroid / embedding / ciphertext / IV / authTag
 *     in the final result.
 *   - No claim token / generationId / userId leakage in the final
 *     result.
 *
 * Public API:
 *   - `completeFinalizedFaceEnrollmentForUser(userId)` —
 *     orchestrator that consumes the temporary session and returns a
 *     safe server-only completion shape. Performs pre-flight
 *     inspection of the existing FaceProfile to choose between the
 *     normal path and the recovery path.
 *
 * Service primitives:
 *   - `consumeEnrollmentSession({ userId, generationId, claimToken })`
 *     — strict CAS session delete keyed on the B2A claim token.
 *     Used by the NORMAL path.
 *   - `recoverAndConsumeEnrollmentSession({ userId, generationId })`
 *     — lineage-bound CAS session delete used ONLY after a server-side
 *     `FaceProfile` lineage check has proven the generation already
 *     committed a durable profile. Never matches a session whose
 *     `generationId` differs from the input. Used by the
 *     CRASH-RECOVERY path.
 *
 * No new biometric math:
 *   - Normal fresh completion reuses
 *     `persistFinalizedFaceProfileForUser(...)` from B2B.
 *   - Recovery does NOT rerun B1B, does NOT call the Face Service,
 *     does NOT decrypt samples, does NOT encrypt the centroid,
 *     does NOT rewrite the `FaceProfile`.
 *
 * Privacy posture:
 *   - The completion result never contains `userId`, `claimToken`,
 *     `sourceEnrollmentGenerationId`, `centroid`, encrypted
 *     samples, ciphertext, IV, authTag, keyVersion, model metadata,
 *     embeddings, or biometric payloads.
 *   - Safe completion shape carries only:
 *       `configured: boolean`
 *       `enrolledAt: Date | null` (the persisted FaceProfile time)
 *       `sampleCount: number | null`
 *       `cleanupStatus: "consumed" | "already_consumed" | "cleanup_pending"`
 *
 * What this module does NOT do:
 *   - No browser route / Server Action / UI.
 *   - No re-enrollment.
 *   - No `FaceProfile` creation here; that is B2B's job.
 *   - No manual AES / direct `BIOMETRIC_ENCRYPTION_KEY` access.
 *   - No MongoDB transaction.
 */

import "server-only";

import {
  getEnrollmentSessionByUserId,
} from "@/lib/biometrics/enrollment-session-service";
import {
  FaceEnrollmentSessionModel,
  type FaceEnrollmentSessionAttrs,
} from "@/lib/biometrics/enrollment-session-model";
import {
  classifyFaceProfileByLineage,
  getFaceProfileByUserId,
} from "@/lib/biometrics/face-profile-service";
import {
  persistFinalizedFaceProfileForUser,
  PersistedFaceProfile,
} from "@/lib/biometrics/face-profile-finalization-service";
import {
  BiometricPersistenceError,
} from "@/lib/biometrics/biometric-errors";

// =============================================================================
// Stable B2C error codes
// =============================================================================

/**
 * Stable completion error codes for PHASE 4.6B2C.
 *
 * The B2C orchestrator surfaces a focused, non-overlapping set of
 * codes that downstream callers (a future authenticated route) can
 * map to safe HTTP envelopes. Codes are deliberately distinct from
 * existing B2A, B2B, persistence, or claim error codes to keep the
 * orchestration surface traceable.
 */
export const FACE_ENROLLMENT_COMPLETION_ERROR_CODES = {
  /** The supplied userId was empty / not a string. */
  INVALID_USER_ID: "INVALID_USER_ID",
  /** No FaceProfile exists for the user — incomplete enrollment. */
  NO_PROFILE_PERSISTED: "NO_PROFILE_PERSISTED",
  /** The persisted FaceProfile pre-dates the lineage field — legacy. */
  LEGACY_PROFILE_PRESENT: "LEGACY_PROFILE_PRESENT",
  /** The persisted FaceProfile was created by a different generation. */
  LINEAGE_MISMATCH: "LINEAGE_MISMATCH",
  /** An unspecified / unrecoverable completion failure. */
  ENROLLMENT_COMPLETION_FAILED: "ENROLLMENT_COMPLETION_FAILED",
} as const;

export type FaceEnrollmentCompletionErrorCode =
  (typeof FACE_ENROLLMENT_COMPLETION_ERROR_CODES)[keyof typeof FACE_ENROLLMENT_COMPLETION_ERROR_CODES];

export interface FaceEnrollmentCompletionErrorShape {
  code: FaceEnrollmentCompletionErrorCode | string;
  message: string;
}

/**
 * Application-level error for the B2C completion orchestrator.
 *
 * Stable surface. Never contains raw ciphertext, IV, authTag, claim
 * token, plain embeddings, lineage, or stack traces. The
 * underlying-code string is a stable application code (e.g. a B2B
 * code), never a raw Mongo stack or driver dump.
 */
export class FaceEnrollmentCompletionError extends Error {
  public readonly code: FaceEnrollmentCompletionErrorCode | string;
  public readonly underlyingCode?: string;

  constructor({
    code,
    message,
    underlyingCode,
  }: {
    code: FaceEnrollmentCompletionErrorCode | string;
    message: string;
    underlyingCode?: string;
  }) {
    super(message);
    this.name = "FaceEnrollmentCompletionError";
    this.code = code;
    this.underlyingCode = underlyingCode;
  }

  toJSON(): FaceEnrollmentCompletionErrorShape {
    return {
      code: this.code,
      message: this.message,
    };
  }
}

// =============================================================================
// Cleanup status enumeration (result envelope)
// =============================================================================

/**
 * The status of the temporary-session cleanup step after B2B
 * persistence. Surfaced as the `cleanupStatus` field of the B2C
 * completion result.
 *
 *   - `"consumed"`         — the temporary session was atomically
 *                            deleted during this call (normal path
 *                            CAS match, or recovery CAS match).
 *   - `"already_consumed"` — there was no temporary session to delete
 *                            (TTL-removed, already deleted by a prior
 *                            completion, or simply absent from the
 *                            start). The durable enrollment is still
 *                            authoritative.
 *   - `"cleanup_pending"`  — the temporary session still exists for
 *                            a future retry / cleanup pass. The
 *                            durable `FaceProfile` is still
 *                            authoritative.
 *
 * The status does NOT expose the claim token, the generation, or any
 * other lineage. A future caller surfaces only `consumed`,
 * `already_consumed`, or `cleanup_pending` to the end user.
 */
export type EnrollmentCleanupStatus =
  | "consumed"
  | "already_consumed"
  | "cleanup_pending";

// =============================================================================
// Service primitives — input / output shapes
// =============================================================================

/**
 * Input for `consumeEnrollmentSession` (the NORMAL-path primitive).
 *
 * All three fields are REQUIRED. The function will refuse to run
 * without them so the atomic CAS filter never falls back to a
 * delete-by-userId-only operation.
 */
export interface ConsumeEnrollmentSessionInput {
  userId: string;
  generationId: string;
  claimToken: string;
}

/**
 * Output for `consumeEnrollmentSession`.
 *
 * `deleted` is `true` when the strict CAS matched and the session
 * was atomically removed. `deleted` is `false` when the CAS missed
 * (wrong token, wrong generation, wrong user, missing session).
 *
 * The function is idempotent — it never throws for an absent claim
 * or for a CAS miss.
 */
export interface EnrollmentSessionConsumptionResult {
  userId: string;
  generationId: string;
  deleted: boolean;
}

/**
 * Input for `recoverAndConsumeEnrollmentSession` (the RECOVERY-path
 * primitive, server-internal only).
 *
 * The primitive does NOT accept a claim token on purpose — the
 * recovery path proves persistence via the `FaceProfile` lineage,
 * not via the B2A claim. The function MUST be invoked only AFTER
 * the caller has observed a persisted `FaceProfile` whose
 * `sourceEnrollmentGenerationId === generationId`.
 */
export interface RecoverAndConsumeEnrollmentSessionInput {
  userId: string;
  generationId: string;
}

/**
 * Output for `recoverAndConsumeEnrollmentSession`.
 *
 * `deleted` is `true` when the lineage-bound CAS matched and the
 * session was atomically removed. `deleted` is `false` otherwise
 * (different generation, missing session, already absent).
 */
export interface EnrollmentSessionRecoveryResult {
  userId: string;
  generationId: string;
  deleted: boolean;
}

// =============================================================================
// Completion result shape (server-only, safe to surface)
// =============================================================================

/**
 * Server-only completion result returned by
 * `completeFinalizedFaceEnrollmentForUser`.
 *
 * Privacy:
 *   - `configured` is the ONLY boolean indicating whether a
 *     `FaceProfile` is in place.
 *   - `enrolledAt` is the persisted `FaceProfile.enrolledAt`
 *     timestamp (or `null` if no profile exists).
 *   - `sampleCount` is the persisted `sampleCount` (or `null`).
 *   - `cleanupStatus` distinguishes consumed / already consumed /
 *     cleanup pending.
 *
 * The result NEVER includes:
 *   - `userId` (not necessary for the completion summary).
 *   - `sourceEnrollmentGenerationId` (lineage is internal).
 *   - `claimToken` (server-only, never browser-exposed).
 *   - `centroid` / embeddings / ciphertext / IV / authTag /
 *     keyVersion / model metadata.
 *
 * This shape is safe to feed into a future browser payload — B3 may
 * add `configured` rendering.
 */
export interface FinalizedEnrollmentCompletion {
  /** True iff an active `FaceProfile` exists for the user. */
  configured: boolean;
  /** Persisted `FaceProfile.enrolledAt`, or null. */
  enrolledAt: Date | null;
  /** Persisted `FaceProfile.sampleCount`, or null. */
  sampleCount: number | null;
  /** Temporary session cleanup outcome. */
  cleanupStatus: EnrollmentCleanupStatus;
}

// =============================================================================
// Helpers
// =============================================================================

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

// =============================================================================
// Service primitive — STRICT CAS consume (NORMAL path)
// =============================================================================

/**
 * Atomically deletes the temporary `FaceEnrollmentSession` for the
 * given `userId` + `generationId` + `claimToken` triple.
 *
 * The MongoDB `findOneAndDelete` filter requires ALL of:
 *   - `userId === input.userId`
 *   - `generationId === input.generationId`
 *   - `finalizationClaim.token === input.claimToken`
 *   - `finalizationClaim.generationId === input.generationId`
 *     (defense-in-depth — the persisted claim generation must equal
 *     the input generation, in case the schema stores it)
 *
 * The function NEVER deletes by `userId` alone. There is no read →
 * check → write path. The CAS IS the only deletion path.
 *
 * Behaviour:
 *   - active matching claim → deleted, `{ deleted: true }`.
 *   - missing session       → no-op, `{ deleted: false }`.
 *   - wrong token           → no-op, `{ deleted: false }`.
 *   - wrong generation      → no-op, `{ deleted: false }`.
 *   - claim already absent  → no-op, `{ deleted: false }`.
 *
 * The function is idempotent and NEVER throws on a CAS miss. It
 * throws a safe `BiometricPersistenceError` on a genuine
 * infrastructure failure.
 */
export async function consumeEnrollmentSession(
  input: ConsumeEnrollmentSessionInput,
): Promise<EnrollmentSessionConsumptionResult> {
  if (
    !isNonEmptyString(input.userId) ||
    !isNonEmptyString(input.generationId) ||
    !isNonEmptyString(input.claimToken)
  ) {
    // Invalid input → no-op. We do NOT silently delete anything.
    return {
      userId: input.userId ?? "",
      generationId: input.generationId ?? "",
      deleted: false,
    };
  }

  // ---------------------------------------------------------------------------
  // THE STRICT CAS FILTER
  //
  // The atomic findOneAndDelete succeeds ONLY when:
  //   - userId matches
  //   - generationId matches
  //   - finalizationClaim.token matches
  //   - finalizationClaim.generationId matches the input generation
  //
  // ---------------------------------------------------------------------------
  const atomicFilter: Record<string, unknown> = {
    userId: input.userId,
    generationId: input.generationId,
    "finalizationClaim.token": input.claimToken,
    "finalizationClaim.generationId": input.generationId,
  };

  try {
    const result = await FaceEnrollmentSessionModel.findOneAndDelete(
      atomicFilter,
    )
      .lean<FaceEnrollmentSessionAttrs>()
      .exec();

    return {
      userId: input.userId,
      generationId: input.generationId,
      deleted: result !== null,
    };
  } catch (err) {
    if (err instanceof BiometricPersistenceError) throw err;
    // Map unknown driver errors to a safe persistence error.
    throw new BiometricPersistenceError({
      code: "FACE_PROFILE_PERSISTENCE_FAILED",
      message: "Failed to consume enrollment session.",
    });
  }
}

// =============================================================================
// Service primitive — LINEAGE-BOUND recovery consume (CRASH-RECOVERY path)
// =============================================================================

/**
 * Atomically deletes the temporary `FaceEnrollmentSession` for the
 * given `userId` + `generationId` pair using a lineage-bound CAS
 * that REQUIRES the session's `generationId` to match the supplied
 * `generationId` EXACTLY.
 *
 * The primitive deliberately does NOT accept a `claimToken` because
 * crash recovery runs after the B2A claim may have disappeared or
 * become ambiguous (the durable `FaceProfile` lineage is the
 * authoritative proof of completion).
 *
 * This primitive is server-internal ONLY. It MUST be invoked only
 * after a server-side `FaceProfile` lineage check has confirmed
 * `FaceProfile.sourceEnrollmentGenerationId === generationId`.
 * Exposing the primitive as a browser API would be unsafe because
 * it could allow a different generation to be deleted by inference.
 *
 * The atomic filter requires:
 *   - `userId === input.userId`
 *   - `generationId === input.generationId`
 *
 * The function NEVER deletes by `userId` only. The CAS IS the only
 * deletion path.
 *
 * Behaviour:
 *   - session exists with matching generation → deleted,
 *     `{ deleted: true }`.
 *   - session exists with DIFFERENT generation → no-op,
 *     `{ deleted: false }`.
 *   - session missing (TTL-removed or already cleaned up) → no-op,
 *     `{ deleted: false }`.
 *
 * The primitive is idempotent and never throws on a CAS miss.
 */
export async function recoverAndConsumeEnrollmentSession(
  input: RecoverAndConsumeEnrollmentSessionInput,
): Promise<EnrollmentSessionRecoveryResult> {
  if (
    !isNonEmptyString(input.userId) ||
    !isNonEmptyString(input.generationId)
  ) {
    return {
      userId: input.userId ?? "",
      generationId: input.generationId ?? "",
      deleted: false,
    };
  }

  // ---------------------------------------------------------------------------
  // LINEAGE-BOUND CAS FILTER
  //
  // Releases / deletes ONLY when userId AND generationId both match.
  // A session for a DIFFERENT generation is NEVER deleted.
  // ---------------------------------------------------------------------------
  const atomicFilter: Record<string, unknown> = {
    userId: input.userId,
    generationId: input.generationId,
  };

  try {
    const result = await FaceEnrollmentSessionModel.findOneAndDelete(
      atomicFilter,
    )
      .lean<FaceEnrollmentSessionAttrs>()
      .exec();

    return {
      userId: input.userId,
      generationId: input.generationId,
      deleted: result !== null,
    };
  } catch (err) {
    if (err instanceof BiometricPersistenceError) throw err;
    throw new BiometricPersistenceError({
      code: "FACE_PROFILE_PERSISTENCE_FAILED",
      message: "Failed to recover enrollment session.",
    });
  }
}

// =============================================================================
// Orchestrator — completeFinalizedFaceEnrollmentForUser
// =============================================================================

/**
 * Completes (or recovers) a finalized face enrollment for the
 * authoritative `userId`. This is the B2C server-internal entry
 * point.
 *
 * The function performs a pre-flight inspection of the existing
 * `FaceProfile` to decide between the two paths:
 *
 *   (A) NORMAL path:
 *       No `FaceProfile` exists yet → call B2B
 *       (`persistFinalizedFaceProfileForUser`). B2B persists the
 *       durable `FaceProfile` and keeps the `finalizationClaim` for
 *       B2C. Then atomically consume the matching temporary session
 *       using the claim token issued by B2A. Return idempotent
 *       completion.
 *
 *   (B) CRASH-RECOVERY path:
 *       A `FaceProfile` already exists. Re-classify its persisted
 *       lineage. Lineage-bound recover-and-consume the matching
 *       temporary session.
 *
 * After (A) or (B) succeeds the function returns a safe,
 * privacy-preserving `FinalizedEnrollmentCompletion`:
 *
 *   - `configured: boolean`           — true iff a durable profile exists.
 *   - `enrolledAt: Date | null`       — persisted enrollment timestamp.
 *   - `sampleCount: number | null`    — persisted sample count.
 *   - `cleanupStatus`                 — `consumed` / `already_consumed`
 *                                       / `cleanup_pending`.
 *
 * The function NEVER:
 *   - decodes or decrypts biometric samples.
 *   - calls the Face Service.
 *   - re-encrypts the centroid.
 *   - rewrites the `FaceProfile` unnecessarily.
 *   - deletes a temporary session belonging to a different generation.
 *   - exposes `userId`, `sourceEnrollmentGenerationId`, claim token,
 *     centroid, embeddings, ciphertext, IV, authTag, model metadata.
 */
export async function completeFinalizedFaceEnrollmentForUser(
  userId: string,
): Promise<FinalizedEnrollmentCompletion> {
  if (!isNonEmptyString(userId)) {
    throw new FaceEnrollmentCompletionError({
      code: FACE_ENROLLMENT_COMPLETION_ERROR_CODES.INVALID_USER_ID,
      message:
        "completeFinalizedFaceEnrollmentForUser requires a non-empty userId.",
    });
  }

  // ---------------------------------------------------------------------------
  // STEP 1 — pre-flight: classify the existing FaceProfile.
  // ---------------------------------------------------------------------------
  // We don't yet know the B1B generationId, so we first check
  // whether ANY FaceProfile exists for the user. If yes, we read
  // its persisted lineage marker. If no, we proceed with the NORMAL
  // path through B2B.
  const existingProfile = await getFaceProfileByUserId(userId);

  if (!existingProfile) {
    // ---------------------------------------------------------------------
    // CASE A — NORMAL path.
    // No profile exists yet → run B2B to persist one. B2B owns
    // B1B → B2A claim → centroid encryption → FaceProfile persistence.
    // B2B returns a `PersistedFaceProfile` containing the
    // `sourceEnrollmentGenerationId` and the B2A-issued `claimToken`.
    // ---------------------------------------------------------------------
    return await runNormalPath(userId);
  }

  // ---------------------------------------------------------------------------
  // A FaceProfile already exists — CRASH-RECOVERY path.
  // Inspect its lineage marker.
  // ---------------------------------------------------------------------------
  const persistedLineage = existingProfile.sourceEnrollmentGenerationId;
  if (!isNonEmptyString(persistedLineage)) {
    // Legacy profile (PHASE 4.6B2B predecessor fixtures). Do NOT
    // guess the generation. Do NOT touch any temporary session by
    // inference. Return a safe existing-profile completion. The
    // temporary session (if any) is left untouched.
    const session = await getEnrollmentSessionByUserId(userId);
    return {
      configured: true,
      enrolledAt: existingProfile.enrolledAt ?? null,
      sampleCount: existingProfile.sampleCount ?? null,
      cleanupStatus: session ? "cleanup_pending" : "already_consumed",
    };
  }

  // The persisted profile carries lineage. Classify against the
  // persisted lineage — should be "same" by definition (the
  // profile's lineage must match itself).
  const classification = await classifyFaceProfileByLineage({
    userId,
    lineage: persistedLineage,
  });

  if (classification === "different") {
    // Should never happen: a profile exists for the user but its
    // lineage differs from itself. We treat this conservatively as
    // `LINEAGE_MISMATCH` and refuse to touch any temporary session.
    throw new FaceEnrollmentCompletionError({
      code: FACE_ENROLLMENT_COMPLETION_ERROR_CODES.LINEAGE_MISMATCH,
      message:
        "Persisted FaceProfile lineage disagrees with itself; refusing to consume any session by inference.",
    });
  }

  // "same" or "legacy" — a persisted FaceProfile already proves
  // durability. Run the lineage-bound recovery CAS against the
  // persisted lineage.
  return await runRecoveryPath(userId, persistedLineage, existingProfile);
}

/**
 * Runs the NORMAL path. Called when no FaceProfile exists for the
 * user yet. Delegates to B2B to persist the profile, then runs the
 * strict-CAS consume on the temporary session using the B2A-issued
 * claim token.
 */
async function runNormalPath(
  userId: string,
): Promise<FinalizedEnrollmentCompletion> {
  let persisted: PersistedFaceProfile;
  try {
    persisted = await persistFinalizedFaceProfileForUser(userId);
  } catch (err) {
    throw wrapUnderlyingError(err);
  }

  // Strict CAS consume using the B2A-issued claim token.
  const consume = await consumeEnrollmentSession({
    userId,
    generationId: persisted.sourceEnrollmentGenerationId,
    claimToken: persisted.claimToken,
  });

  // Re-read the profile to surface its persisted `enrolledAt` /
  // `sampleCount` for the safe completion shape.
  const persistedProfile = await getFaceProfileByUserId(userId);
  if (!persistedProfile) {
    // B2B claims it persisted the profile, but the read returns
    // nothing. This is an edge case (TTL on a brand-new doc is
    // impossible). Report deterministic cleanup_pending so the
    // caller can decide.
    return {
      configured: false,
      enrolledAt: null,
      sampleCount: null,
      cleanupStatus: "cleanup_pending",
    };
  }

  return {
    configured: true,
    enrolledAt: persistedProfile.enrolledAt ?? null,
    sampleCount: persistedProfile.sampleCount ?? null,
    cleanupStatus: consume.deleted
      ? "consumed"
      : "already_consumed",
  };
}

/**
 * Runs the CRASH-RECOVERY path. Called when a FaceProfile already
 * exists for the user. Proves lineage via the persisted profile and
 * lineage-bound-recover-consume the matching temporary session.
 */
async function runRecoveryPath(
  userId: string,
  persistedLineage: string,
  existingProfile: NonNullable<Awaited<ReturnType<typeof getFaceProfileByUserId>>>,
): Promise<FinalizedEnrollmentCompletion> {
  const recovery = await recoverAndConsumeEnrollmentSession({
    userId,
    generationId: persistedLineage,
  });

  if (recovery.deleted) {
    return {
      configured: true,
      enrolledAt: existingProfile.enrolledAt ?? null,
      sampleCount: existingProfile.sampleCount ?? null,
      cleanupStatus: "consumed",
    };
  }

  // Recovery CAS missed. The temporary session is either:
  //   (i)  absent (TTL-removed or already cleaned up), OR
  //   (ii) present with a DIFFERENT generation (NEVER touched).
  //
  // Read once more — purely — to distinguish (i) from (ii).
  const session = await getEnrollmentSessionByUserId(userId);
  if (!session) {
    return {
      configured: true,
      enrolledAt: existingProfile.enrolledAt ?? null,
      sampleCount: existingProfile.sampleCount ?? null,
      cleanupStatus: "already_consumed",
    };
  }
  if (session.generationId === persistedLineage) {
    // Same generation present but the lineage-bound CAS missed
    // (rare — e.g. the session was just re-created with the same
    // id by a parallel test). Surface cleanup_pending.
    return {
      configured: true,
      enrolledAt: existingProfile.enrolledAt ?? null,
      sampleCount: existingProfile.sampleCount ?? null,
      cleanupStatus: "cleanup_pending",
    };
  }

  // Different generation present. Leave it untouched and surface
  // cleanup_pending so the caller knows the current session is
  // out of date with the persisted profile.
  return {
    configured: true,
    enrolledAt: existingProfile.enrolledAt ?? null,
    sampleCount: existingProfile.sampleCount ?? null,
    cleanupStatus: "cleanup_pending",
  };
}

/**
 * Wraps an underlying error (B2B or persistence layer) into a safe
 * B2C envelope. The orchestrator NEVER masks the underlying code,
 * but always wraps it under a stable B2C code.
 */
function wrapUnderlyingError(
  err: unknown,
): FaceEnrollmentCompletionError {
  if (err instanceof FaceEnrollmentCompletionError) return err;
  if (err instanceof BiometricPersistenceError) {
    return new FaceEnrollmentCompletionError({
      code: FACE_ENROLLMENT_COMPLETION_ERROR_CODES
        .ENROLLMENT_COMPLETION_FAILED,
      message: "Enrollment completion failed.",
      underlyingCode: String(err.code),
    });
  }
  // Other errors (B2B FaceProfileFinalizationError, generic error,
  // etc.) are wrapped safely. Only the stable code string is
  // forwarded — never the raw message or stack.
  const underlying =
    err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string"
      ? String((err as { code: string }).code)
      : "UNKNOWN_ERROR";
  return new FaceEnrollmentCompletionError({
    code: FACE_ENROLLMENT_COMPLETION_ERROR_CODES
      .ENROLLMENT_COMPLETION_FAILED,
    message: "Enrollment completion failed.",
    underlyingCode: underlying,
  });
}

// =============================================================================
// Exposed for tests
// =============================================================================

export const __testing = {
  runNormalPath,
  runRecoveryPath,
};
