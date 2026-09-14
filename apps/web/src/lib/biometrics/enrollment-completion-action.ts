/**
 * Server Action for finishing Face ID enrollment.
 *
 * PHASE 4.6B3A — authenticated server action that finalises a
 * completed Face ID enrollment session and consumes the temporary
 * `FaceEnrollmentSession` after the durable `FaceProfile` has been
 * persisted (PHASE 4.6B2B → 4.6B2C orchestration).
 *
 * This is the ONLY entry point that B3A exposes. It is a
 * server-only, zero-argument Server Action:
 *
 *   - It receives NO input from the browser. Identity is derived
 *     EXCLUSIVELY from the Better Auth server session via
 *     `getSession()`.
 *   - It gates on completed onboarding / Profile before delegating
 *     to the B2C orchestrator.
 *   - It delegates to `completeFinalizedFaceEnrollmentForUser(...)`
 *     EXACTLY ONCE per invocation.
 *   - It returns a small discriminated-union result that contains
 *     only safe, non-biometric completion information. It never
 *     returns `userId`, `generationId`, `claimToken`, `centroid`,
 *     embeddings, ciphertext, IV, authTag, keyVersion, or model
 *     metadata.
 *
 * This module opens with `"use server"` so it can only be invoked
 * as a Server Action from a Client Component, a Server Component,
 * a Route Handler, or another Server Action. The Client Component
 * bundle can import the function reference but cannot execute its
 * body (Next.js enforces this at build time).
 *
 * PHASE 4.6B3A deliberately does NOT:
 *   - Add a Finish setup button (UI is B3B's responsibility).
 *   - Add a public HTTP `/api/face-id/enrollment/finalize` route.
 *   - Call the Face Service directly.
 *   - Call B1B / B2A / B2B / Face Service directly. The B2C
 *     orchestrator is the authoritative completion boundary.
 *   - Retry on failure (Face Service timeout, claim conflict,
 *     generation drift, etc.) — failures surface a single, safe
 *     outcome that the future UI may decide to retry explicitly.
 *   - Trigger `router.refresh` / `redirect` / `revalidatePath`
 *     here. UI refresh belongs to B3B.
 */

"use server";

import { getSession } from "@/lib/session";
import { isOnboardingComplete } from "@/lib/profile-service";
import {
  completeFinalizedFaceEnrollmentForUser,
  FACE_ENROLLMENT_COMPLETION_ERROR_CODES,
  FaceEnrollmentCompletionError,
  type FinalizedEnrollmentCompletion,
} from "@/lib/biometrics/face-enrollment-completion-service";
import {
  FACE_PROFILE_FINALIZATION_ERROR_CODES,
  FaceProfileFinalizationError,
} from "@/lib/biometrics/face-profile-finalization-service";
import {
  ENROLLMENT_FINALIZATION_ERROR_CODES,
  EnrollmentFinalizationError,
} from "@/lib/biometrics/enrollment-finalization-service";
import {
  ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES,
  EnrollmentFinalizationClaimError,
} from "@/lib/biometrics/enrollment-finalization-claim-service";
import {
  BIOMETRIC_PERSISTENCE_ERROR_CODES,
  BiometricPersistenceError,
} from "@/lib/biometrics/biometric-errors";

// =============================================================================
// Safe action error codes
// =============================================================================

/**
 * Browser-facing error codes for the B3A completion action.
 *
 * These are a stable, safe, NON-OVERLAPPING subset of the codes
 * surfaced by:
 *   - `enrollment-start-action.ts` (`ENROLLMENT_ROUTE_ERROR_CODES`)
 *   - `biometric-errors.ts` (`BIOMETRIC_PERSISTENCE_ERROR_CODES`)
 *   - `enrollment-route-errors.ts` (`ENROLLMENT_ROUTE_ERROR_CODES`)
 *   - `enrollment-finalization-service.ts`
 *     (`ENROLLMENT_FINALIZATION_ERROR_CODES`)
 *   - `enrollment-finalization-claim-service.ts`
 *     (`ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES`)
 *   - `face-profile-finalization-service.ts`
 *     (`FACE_PROFILE_FINALIZATION_ERROR_CODES`)
 *   - `face-enrollment-completion-service.ts`
 *     (`FACE_ENROLLMENT_COMPLETION_ERROR_CODES`)
 *
 * Codes here NEVER expose:
 *   - the B2A claim token,
 *   - `sourceEnrollmentGenerationId`,
 *   - plaintext centroid / sample embeddings / ciphertext / IV /
 *     authTag / keyVersion,
 *   - `modelIdentity`, `modelName`, `embeddingDimension`, `normalization`,
 *   - thresholds / similarity scores,
 *   - raw HTTP status numbers or driver error codes.
 */
export const FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",

  ENROLLMENT_SESSION_NOT_FOUND: "ENROLLMENT_SESSION_NOT_FOUND",
  ENROLLMENT_SESSION_EXPIRED: "ENROLLMENT_SESSION_EXPIRED",
  ENROLLMENT_INCOMPLETE: "ENROLLMENT_INCOMPLETE",

  INCONSISTENT_FACE_SAMPLES: "INCONSISTENT_FACE_SAMPLES",
  MODEL_MISMATCH: "MODEL_MISMATCH",
  ENROLLMENT_SAMPLE_DECRYPTION_FAILED:
    "ENROLLMENT_SAMPLE_DECRYPTION_FAILED",
  ENROLLMENT_SAMPLE_VECTOR_INVALID: "ENROLLMENT_SAMPLE_VECTOR_INVALID",

  ENROLLMENT_GENERATION_CHANGED: "ENROLLMENT_GENERATION_CHANGED",
  ENROLLMENT_FINALIZATION_ALREADY_CLAIMED:
    "ENROLLMENT_FINALIZATION_ALREADY_CLAIMED",
  ENROLLMENT_FINALIZATION_IN_PROGRESS:
    "ENROLLMENT_FINALIZATION_IN_PROGRESS",

  FACE_PROFILE_ALREADY_EXISTS: "FACE_PROFILE_ALREADY_EXISTS",

  FACE_SERVICE_TIMEOUT: "FACE_SERVICE_TIMEOUT",
  FACE_SERVICE_UNAVAILABLE: "FACE_SERVICE_UNAVAILABLE",
  FACE_SERVICE_UNAUTHORIZED: "FACE_SERVICE_UNAUTHORIZED",
  FACE_SERVICE_INVALID_RESPONSE: "FACE_SERVICE_INVALID_RESPONSE",

  BIOMETRIC_ENCRYPTION_UNAVAILABLE: "BIOMETRIC_ENCRYPTION_UNAVAILABLE",

  ENROLLMENT_COMPLETION_FAILED: "ENROLLMENT_COMPLETION_FAILED",
} as const;

export type FaceEnrollmentCompletionActionErrorCode =
  (typeof FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES)[keyof typeof FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES];

/**
 * Human-readable, restrained copy for each error code. The strings
 * here are deliberately generic — no thresholds, no crypto detail,
 * no model identifiers. The future UI may map these verbatim or
 * rephrase further.
 */
const ERROR_MESSAGES: Readonly<Record<FaceEnrollmentCompletionActionErrorCode, string>> = {
  UNAUTHENTICATED: "Please sign in again.",
  PROFILE_INCOMPLETE:
    "Complete your profile before setting up Face ID.",

  ENROLLMENT_SESSION_NOT_FOUND:
    "Start Face ID setup before finishing.",
  ENROLLMENT_SESSION_EXPIRED:
    "This setup session expired. Start setup again.",
  ENROLLMENT_INCOMPLETE:
    "Collect all required face samples before finishing setup.",

  INCONSISTENT_FACE_SAMPLES:
    "The captured samples were not consistent enough. Start setup again and capture new samples.",
  MODEL_MISMATCH:
    "This setup session can no longer be completed. Start setup again.",
  ENROLLMENT_SAMPLE_DECRYPTION_FAILED:
    "This setup session can no longer be completed. Start setup again.",
  ENROLLMENT_SAMPLE_VECTOR_INVALID:
    "This setup session can no longer be completed. Start setup again.",

  ENROLLMENT_GENERATION_CHANGED:
    "This setup session was changed in another tab. Try again.",
  ENROLLMENT_FINALIZATION_ALREADY_CLAIMED:
    "Face setup is already being finished. Try again shortly.",
  ENROLLMENT_FINALIZATION_IN_PROGRESS:
    "Face setup is already being finished. Try again shortly.",

  FACE_PROFILE_ALREADY_EXISTS:
    "Face ID is already configured for this account.",

  FACE_SERVICE_TIMEOUT:
    "Face processing is temporarily unavailable. Try again later.",
  FACE_SERVICE_UNAVAILABLE:
    "Face processing is temporarily unavailable. Try again later.",
  FACE_SERVICE_UNAUTHORIZED:
    "Face processing is temporarily unavailable. Try again later.",
  FACE_SERVICE_INVALID_RESPONSE:
    "Face processing is temporarily unavailable. Try again later.",

  BIOMETRIC_ENCRYPTION_UNAVAILABLE:
    "Face processing is temporarily unavailable. Try again later.",

  ENROLLMENT_COMPLETION_FAILED:
    "Face setup could not be finished. Try again later.",
};

/**
 * Whether the failure is suitable for an immediate, user-initiated
 * retry. The future UI (PHASE 4.6B3B) can use this flag to decide
 * whether to surface a "Try again" affordance or a more
 * conservative "Restart setup" flow.
 *
 *   retryable=true   → transient infrastructure / concurrency / claim loss
 *   retryable=false  → domain / data integrity / configuration drift
 */
const RETRYABLE: Readonly<Record<FaceEnrollmentCompletionActionErrorCode, boolean>> = {
  UNAUTHENTICATED: false,
  PROFILE_INCOMPLETE: false,

  ENROLLMENT_SESSION_NOT_FOUND: false,
  ENROLLMENT_SESSION_EXPIRED: false,
  ENROLLMENT_INCOMPLETE: false,

  INCONSISTENT_FACE_SAMPLES: false,
  MODEL_MISMATCH: false,
  ENROLLMENT_SAMPLE_DECRYPTION_FAILED: false,
  ENROLLMENT_SAMPLE_VECTOR_INVALID: false,

  ENROLLMENT_GENERATION_CHANGED: true,
  ENROLLMENT_FINALIZATION_ALREADY_CLAIMED: true,
  ENROLLMENT_FINALIZATION_IN_PROGRESS: true,

  FACE_PROFILE_ALREADY_EXISTS: false,

  FACE_SERVICE_TIMEOUT: true,
  FACE_SERVICE_UNAVAILABLE: true,
  FACE_SERVICE_UNAUTHORIZED: false,
  FACE_SERVICE_INVALID_RESPONSE: false,

  BIOMETRIC_ENCRYPTION_UNAVAILABLE: false,

  ENROLLMENT_COMPLETION_FAILED: false,
};

// =============================================================================
// Result types (discriminated union)
// =============================================================================

/**
 * Safe, non-biometric success result. Returned ONLY when B2C
 * confirmed that a durable `FaceProfile` is in place. The browser
 * may render `configured: true` and the enrolled-at timestamp.
 *
 * The shape intentionally mirrors the safe surface of
 * `FinalizedEnrollmentCompletion` plus the `cleanupStatus` field
 * (which is useful for the future UI to decide whether the
 * temporary enrollment session has been fully retired).
 */
export interface FaceEnrollmentCompletionActionSuccess {
  ok: true;
  configured: true;
  faceId: {
    enrolledAt: string;
    sampleCount: number;
  };
  /**
   * Browser-safe cleanup outcome. `"consumed"` and
   * `"already_consumed"` both express a fully-finished enrollment;
   * `"cleanup_pending"` means the durable profile is in place but
   * a future pass will retire the temporary session. None of these
   * statuses expose the claim token, the generation, or any other
   * internal lineage.
   */
  cleanupStatus: "consumed" | "already_consumed" | "cleanup_pending";
}

/**
 * Safe, non-biometric error result. Returned for any failure
 * condition. The error `code` is always one of the codes in
 * `FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES`. The `message`
 * is the safe copy from `ERROR_MESSAGES`. The `retryable` flag is
 * derived from `RETRYABLE`.
 */
export interface FaceEnrollmentCompletionActionError {
  ok: false;
  code: FaceEnrollmentCompletionActionErrorCode;
  message: string;
  retryable: boolean;
}

export type FaceEnrollmentCompletionActionResult =
  | FaceEnrollmentCompletionActionSuccess
  | FaceEnrollmentCompletionActionError;

// =============================================================================
// Helpers
// =============================================================================

function isCompletionErrorCode(
  value: string,
): value is FaceEnrollmentCompletionActionErrorCode {
  return (
    value in FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES
  );
}

/**
 * Wraps an unknown thrown value into the safe error result shape.
 * The function inspects the typed upstream errors emitted by the
 * B1B / B2A / B2B / B2C layers and maps them to the closest safe
 * browser-facing code. Anything not recognised collapses to a
 * generic `ENROLLMENT_COMPLETION_FAILED` with a generic message.
 */
function toSafeError(
  err: unknown,
): FaceEnrollmentCompletionActionError {
  // --- B2C orchestrator errors -------------------------------------------
  if (err instanceof FaceEnrollmentCompletionError) {
    const code = String(err.code);
    if (code === FACE_ENROLLMENT_COMPLETION_ERROR_CODES.INVALID_USER_ID) {
      // Should never happen server-side — better-auth session is the
      // identity source. Surface as a generic failure.
      return buildError("ENROLLMENT_COMPLETION_FAILED");
    }
    if (
      code === FACE_ENROLLMENT_COMPLETION_ERROR_CODES.NO_PROFILE_PERSISTED
    ) {
      // B2B failed to persist a profile. The browser-side actionable
      // message is the same as a generic completion failure.
      return buildError("ENROLLMENT_COMPLETION_FAILED");
    }
    if (
      code === FACE_ENROLLMENT_COMPLETION_ERROR_CODES.LEGACY_PROFILE_PRESENT
    ) {
      // A legacy profile exists — durable configuration is in place.
      // Collapse to FACE_PROFILE_ALREADY_EXISTS so the UI can show
      // the existing enrolment.
      return buildError("FACE_PROFILE_ALREADY_EXISTS");
    }
    if (code === FACE_ENROLLMENT_COMPLETION_ERROR_CODES.LINEAGE_MISMATCH) {
      return buildError("ENROLLMENT_GENERATION_CHANGED");
    }
    return buildError("ENROLLMENT_COMPLETION_FAILED");
  }

  // --- B2B persistence errors --------------------------------------------
  if (err instanceof FaceProfileFinalizationError) {
    const code = String(err.code);
    if (
      code === FACE_PROFILE_FINALIZATION_ERROR_CODES.ENROLLMENT_SESSION_NOT_FOUND
    ) {
      return buildError("ENROLLMENT_SESSION_NOT_FOUND");
    }
    if (
      code === FACE_PROFILE_FINALIZATION_ERROR_CODES.ENROLLMENT_SESSION_EXPIRED
    ) {
      return buildError("ENROLLMENT_SESSION_EXPIRED");
    }
    if (
      code === FACE_PROFILE_FINALIZATION_ERROR_CODES.ENROLLMENT_INCOMPLETE
    ) {
      return buildError("ENROLLMENT_INCOMPLETE");
    }
    if (
      code === FACE_PROFILE_FINALIZATION_ERROR_CODES.UNSUPPORTED_ENROLLMENT_MODE
    ) {
      return buildError("MODEL_MISMATCH");
    }
    if (
      code === FACE_PROFILE_FINALIZATION_ERROR_CODES.UNSUPPORTED_TEMPLATE_VERSION
    ) {
      return buildError("MODEL_MISMATCH");
    }
    if (
      code === FACE_PROFILE_FINALIZATION_ERROR_CODES.ENROLLMENT_SAMPLE_INDEX_INVALID ||
      code === FACE_PROFILE_FINALIZATION_ERROR_CODES.ENROLLMENT_SAMPLE_STRUCTURE_INVALID
    ) {
      return buildError("ENROLLMENT_SAMPLE_VECTOR_INVALID");
    }
    if (
      code === FACE_PROFILE_FINALIZATION_ERROR_CODES.ENROLLMENT_METADATA_MISMATCH
    ) {
      return buildError("MODEL_MISMATCH");
    }
    if (
      code === FACE_PROFILE_FINALIZATION_ERROR_CODES.ENROLLMENT_FINALIZATION_CLAIM_FAILED
    ) {
      // Generic claim failure (e.g. atomic CAS race / unsupported
      // state) → treat as in-progress / try again shortly.
      return buildError("ENROLLMENT_FINALIZATION_IN_PROGRESS");
    }
    if (
      code === FACE_PROFILE_FINALIZATION_ERROR_CODES.ENROLLMENT_FINALIZATION_CLAIM_LOST
    ) {
      // Claim acquired but the session drifted → treat as a
      // generation change. The user can retry shortly.
      return buildError("ENROLLMENT_GENERATION_CHANGED");
    }
    if (
      code === FACE_PROFILE_FINALIZATION_ERROR_CODES.FACE_PROFILE_CENTROID_ENCRYPTION_FAILED
    ) {
      return buildError("BIOMETRIC_ENCRYPTION_UNAVAILABLE");
    }
    if (
      code === FACE_PROFILE_FINALIZATION_ERROR_CODES.FACE_PROFILE_PERSISTENCE_FAILED
    ) {
      return buildError("ENROLLMENT_COMPLETION_FAILED");
    }
    if (
      code === FACE_PROFILE_FINALIZATION_ERROR_CODES.FACE_PROFILE_ALREADY_EXISTS ||
      code === FACE_PROFILE_FINALIZATION_ERROR_CODES.FACE_PROFILE_SOURCE_GENERATION_MISMATCH
    ) {
      return buildError("FACE_PROFILE_ALREADY_EXISTS");
    }
    return buildError("ENROLLMENT_COMPLETION_FAILED");
  }

  // --- B1B finalization orchestration errors ------------------------------
  if (err instanceof EnrollmentFinalizationError) {
    const code = String(err.code);
    if (
      code === ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_SESSION_NOT_FOUND
    ) {
      return buildError("ENROLLMENT_SESSION_NOT_FOUND");
    }
    if (
      code === ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_SESSION_EXPIRED
    ) {
      return buildError("ENROLLMENT_SESSION_EXPIRED");
    }
    if (code === ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_INCOMPLETE) {
      return buildError("ENROLLMENT_INCOMPLETE");
    }
    if (
      code === ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_SESSION_INVALID ||
      code === ENROLLMENT_FINALIZATION_ERROR_CODES.UNSUPPORTED_ENROLLMENT_MODE ||
      code === ENROLLMENT_FINALIZATION_ERROR_CODES.UNSUPPORTED_TEMPLATE_VERSION
    ) {
      return buildError("MODEL_MISMATCH");
    }
    if (
      code === ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_SAMPLE_INDEX_INVALID
    ) {
      return buildError("ENROLLMENT_SAMPLE_VECTOR_INVALID");
    }
    if (
      code === ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_SAMPLE_DECRYPTION_FAILED
    ) {
      return buildError("ENROLLMENT_SAMPLE_DECRYPTION_FAILED");
    }
    if (
      code === ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_SAMPLE_VECTOR_INVALID
    ) {
      return buildError("ENROLLMENT_SAMPLE_VECTOR_INVALID");
    }
    if (
      code === ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_GENERATION_CHANGED
    ) {
      return buildError("ENROLLMENT_GENERATION_CHANGED");
    }
    if (
      code === ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_FINALIZATION_FAILED
    ) {
      // Inspect the preserved `domainError.code` for a more specific
      // mapping (e.g. INCONSISTENT_FACE_SAMPLES, Face Service
      // transport errors).
      const domainCode = err.domainError?.code;
      return mapDomainErrorCode(domainCode);
    }
    return buildError("ENROLLMENT_COMPLETION_FAILED");
  }

  // --- B2A claim service errors ------------------------------------------
  if (err instanceof EnrollmentFinalizationClaimError) {
    const code = String(err.code);
    if (
      code ===
      ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES.ENROLLMENT_FINALIZATION_ALREADY_CLAIMED
    ) {
      return buildError("ENROLLMENT_FINALIZATION_ALREADY_CLAIMED");
    }
    if (
      code ===
      ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES.ENROLLMENT_FINALIZATION_IN_PROGRESS
    ) {
      return buildError("ENROLLMENT_FINALIZATION_IN_PROGRESS");
    }
    if (
      code === ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES.ENROLLMENT_SESSION_NOT_FOUND ||
      code === ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES.ENROLLMENT_SESSION_EXPIRED
    ) {
      // B2A claim rejection due to session state collapse. Surface as
      // session-expired so the UI can prompt for a restart.
      return buildError("ENROLLMENT_SESSION_EXPIRED");
    }
    if (
      code === ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES.ENROLLMENT_INCOMPLETE
    ) {
      return buildError("ENROLLMENT_INCOMPLETE");
    }
    if (
      code ===
      ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES.ENROLLMENT_GENERATION_CHANGED
    ) {
      return buildError("ENROLLMENT_GENERATION_CHANGED");
    }
    return buildError("ENROLLMENT_FINALIZATION_IN_PROGRESS");
  }

  // --- Persistence-layer errors (Mongo / driver / biometric persistence) -
  if (err instanceof BiometricPersistenceError) {
    const code = String(err.code);
    if (
      code === BIOMETRIC_PERSISTENCE_ERROR_CODES.FACE_PROFILE_ALREADY_EXISTS ||
      code === BIOMETRIC_PERSISTENCE_ERROR_CODES.BIOMETRIC_PROFILE_ALREADY_EXISTS
    ) {
      return buildError("FACE_PROFILE_ALREADY_EXISTS");
    }
    if (
      code === BIOMETRIC_PERSISTENCE_ERROR_CODES.ENROLLMENT_FINALIZATION_IN_PROGRESS
    ) {
      return buildError("ENROLLMENT_FINALIZATION_IN_PROGRESS");
    }
    if (
      code === BIOMETRIC_PERSISTENCE_ERROR_CODES.ENROLLMENT_FINALIZATION_CLAIM_LOST ||
      code === BIOMETRIC_PERSISTENCE_ERROR_CODES.FACE_PROFILE_SOURCE_GENERATION_MISMATCH
    ) {
      return buildError("ENROLLMENT_GENERATION_CHANGED");
    }
    return buildError("ENROLLMENT_COMPLETION_FAILED");
  }

  // Anything else is mapped to a generic completion failure. No raw
  // stacks, no raw error messages, no driver internals.
  return buildError("ENROLLMENT_COMPLETION_FAILED");
}

/**
 * Maps a preserved Face Service / Face Service client `domainError.code`
 * string into the closest safe browser-facing code.
 */
function mapDomainErrorCode(
  domainCode: string | undefined,
): FaceEnrollmentCompletionActionError {
  if (!domainCode) {
    return buildError("FACE_SERVICE_UNAVAILABLE");
  }
  switch (domainCode) {
    case "INCONSISTENT_FACE_SAMPLES":
      return buildError("INCONSISTENT_FACE_SAMPLES");
    case "MODEL_MISMATCH":
      return buildError("MODEL_MISMATCH");
    case "INVALID_EMBEDDING":
    case "EMBEDDING_NOT_NORMALIZED":
    case "EMBEDDING_DIMENSION_MISMATCH":
    case "INVALID_CENTROID":
    case "INVALID_SAMPLE_COUNT":
      return buildError("MODEL_MISMATCH");
    case "FACE_SERVICE_TIMEOUT":
      return buildError("FACE_SERVICE_TIMEOUT");
    case "FACE_SERVICE_UNAVAILABLE":
      return buildError("FACE_SERVICE_UNAVAILABLE");
    case "FACE_SERVICE_UNAUTHORIZED":
      return buildError("FACE_SERVICE_UNAUTHORIZED");
    case "FACE_SERVICE_INVALID_RESPONSE":
      return buildError("FACE_SERVICE_INVALID_RESPONSE");
    case "FACE_SERVICE_NOT_CONFIGURED":
      return buildError("FACE_SERVICE_UNAVAILABLE");
    default:
      return buildError("FACE_SERVICE_UNAVAILABLE");
  }
}

function buildError(
  code: FaceEnrollmentCompletionActionErrorCode,
): FaceEnrollmentCompletionActionError {
  return {
    ok: false,
    code,
    message: ERROR_MESSAGES[code],
    retryable: RETRYABLE[code],
  };
}

/**
 * Converts the B2C server-only completion shape into the B3A safe
 * browser result. The mapping only projects the small set of fields
 * the future UI actually needs.
 */
function toSuccessResult(
  completion: FinalizedEnrollmentCompletion,
): FaceEnrollmentCompletionActionSuccess {
  if (!completion.configured || !completion.enrolledAt) {
    // Defensive: B2C never returns configured=false without
    // enrolledAt=null, but we coerce here so the discriminated union
    // stays exhaustive.
    throw new Error(
      "FaceProfile IS the commit point; configured=true is required.",
    );
  }
  return {
    ok: true,
    configured: true,
    faceId: {
      enrolledAt: completion.enrolledAt.toISOString(),
      sampleCount: completion.sampleCount ?? 0,
    },
    cleanupStatus: completion.cleanupStatus,
  };
}

// =============================================================================
// Public Server Action
// =============================================================================

/**
 * Finishes (completes or recovers) the authenticated user's Face ID
 * enrollment and returns a small, safe browser result.
 *
 * This is a ZERO-ARGUMENT Server Action. It accepts no parameters
 * from the browser. Identity is derived EXCLUSIVELY from the Better
 * Auth server session.
 *
 * Error / success mapping (browser-safe):
 *   - `UNAUTHENTICATED`             — no Better Auth session.
 *   - `PROFILE_INCOMPLETE`          — onboarding / Profile is missing.
 *   - `ENROLLMENT_SESSION_NOT_FOUND`— no temporary session exists.
 *   - `ENROLLMENT_SESSION_EXPIRED`  — temporary session is past its TTL.
 *   - `ENROLLMENT_INCOMPLETE`       — fewer than the required samples
 *                                     have been accepted.
 *   - `INCONSISTENT_FACE_SAMPLES`   — Face Service rejected the batch.
 *                                     `configured` stays FALSE.
 *   - `MODEL_MISMATCH`              — incompatible model / template.
 *   - `ENROLLMENT_SAMPLE_DECRYPTION_FAILED` /
 *     `ENROLLMENT_SAMPLE_VECTOR_INVALID` — data integrity failure.
 *   - `ENROLLMENT_GENERATION_CHANGED` — another tab reset the session.
 *   - `ENROLLMENT_FINALIZATION_ALREADY_CLAIMED` /
 *     `ENROLLMENT_FINALIZATION_IN_PROGRESS` — concurrent completion.
 *   - `FACE_PROFILE_ALREADY_EXISTS`— durable profile already in place.
 *   - `FACE_SERVICE_TIMEOUT` /
 *     `FACE_SERVICE_UNAVAILABLE` /
 *     `FACE_SERVICE_UNAUTHORIZED`  /
 *     `FACE_SERVICE_INVALID_RESPONSE` — infrastructure errors.
 *   - `BIOMETRIC_ENCRYPTION_UNAVAILABLE` — encryption key is missing
 *                                           or invalid.
 *   - `ENROLLMENT_COMPLETION_FAILED` — generic / unmapped failure.
 *
 * The action delegates to `completeFinalizedFaceEnrollmentForUser`
 * EXACTLY ONCE per invocation. No automatic retry is performed.
 *
 * The action does NOT call `router.refresh()`, `redirect()`, or
 * `revalidatePath()`. UI refresh belongs to PHASE 4.6B3B.
 */
export async function finishFaceEnrollment(): Promise<FaceEnrollmentCompletionActionResult> {
  // 1. Authentication — identity comes from the Better Auth session
  // only. No userId is accepted from the browser.
  const session = await getSession();
  if (!session) {
    return buildError("UNAUTHENTICATED");
  }

  const userId = session.user.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return buildError("UNAUTHENTICATED");
  }

  // 2. Profile gating — completed onboarding is required before any
  // biometric finalization can happen.
  let onboardingComplete: boolean;
  try {
    onboardingComplete = await isOnboardingComplete(userId);
  } catch {
    // A persistence failure during the profile check is treated as
    // a generic completion failure. We never leak driver details.
    return buildError("ENROLLMENT_COMPLETION_FAILED");
  }
  if (!onboardingComplete) {
    return buildError("PROFILE_INCOMPLETE");
  }

  // 3. Delegate to B2C exactly once. Watch for unexpected errors and
  // map them safely into the action result shape.
  let completion: FinalizedEnrollmentCompletion;
  try {
    completion = await completeFinalizedFaceEnrollmentForUser(userId);
  } catch (err) {
    return toSafeError(err);
  }

  // 4. Project the server-only completion shape into the browser-
  // safe success result.
  return toSuccessResult(completion);
}

// =============================================================================
// Exposed for tests
// =============================================================================

export const __testing = {
  toSafeError,
  toSuccessResult,
  buildError,
  mapDomainErrorCode,
  ERROR_MESSAGES,
  RETRYABLE,
  isCompletionErrorCode,
};

void isCompletionErrorCode; // referenced for type-narrowing helpers
