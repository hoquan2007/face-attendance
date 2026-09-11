/**
 * Application-level error helpers for the Face ID enrollment API routes.
 *
 * PHASE 4.4B1 — Face ID Enrollment Start API.
 *
 * These helpers wrap authorization and persistence failures into a
 * stable shape that Route Handlers can render as JSON without leaking
 * Mongoose / MongoDB / Better Auth internals to the browser.
 *
 * Conventions follow `docs/api.md`:
 *   {
 *     error: {
 *       code: "STRING_CODE",
 *       message: "Human readable."
 *     }
 *   }
 *
 * Codes intentionally introduced here:
 *   - UNAUTHENTICATED
 *       Caller has no valid Better Auth server session.
 *   - PROFILE_INCOMPLETE
 *       Authenticated user has no Profile, or onboardingCompleted is
 *       not true. The route deliberately does NOT auto-create a
 *       Profile — onboarding is a separate flow.
 *   - FACE_PROFILE_ALREADY_EXISTS
 *       Authenticated user already has an active FaceProfile. The
 *       start route blocks new CREATE enrollments in PHASE 4.4B1;
 *       explicit re-enrollment belongs to a later mini-phase.
 *   - ENROLLMENT_START_FAILED
 *       Database / persistence failure during enrollment session
 *       create-or-reset.
 *
 * Mongoose / MongoDB / Better Auth internals never leave this module.
 */

import {
  BIOMETRIC_PERSISTENCE_ERROR_CODES,
  BiometricPersistenceError,
} from "@/lib/biometrics/biometric-errors";
import {
  FACE_SERVICE_ERROR_CODES,
  FaceServiceClientError,
} from "@/lib/biometrics/face-service-errors";

/**
 * Stable error codes for the enrollment API surface.
 *
 * The full set of application codes may include codes inherited from
 * `BIOMETRIC_PERSISTENCE_ERROR_CODES` when persistence errors map
 * directly (e.g. `BIOMETRIC_PROFILE_ALREADY_EXISTS`).
 */
export const ENROLLMENT_ROUTE_ERROR_CODES = {
  // Authentication errors
  UNAUTHENTICATED: "UNAUTHENTICATED",

  // Profile requirement errors
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",

  // Enrollment session errors
  ENROLLMENT_NOT_STARTED: "ENROLLMENT_NOT_STARTED",
  ENROLLMENT_EXPIRED: "ENROLLMENT_EXPIRED",

  // Input validation errors
  INVALID_IMAGE: "INVALID_IMAGE",
  IMAGE_TOO_LARGE: "IMAGE_TOO_LARGE",

  // Face Service domain errors (preserved from Face Service)
  NO_FACE: "NO_FACE",
  MULTIPLE_FACES: "MULTIPLE_FACES",

  // Face Service infrastructure errors (safe mapping)
  FACE_SERVICE_UNAVAILABLE: "FACE_SERVICE_UNAVAILABLE",
  FACE_SERVICE_TIMEOUT: "FACE_SERVICE_TIMEOUT",
  FACE_SERVICE_UNAUTHORIZED: "FACE_SERVICE_UNAUTHORIZED",
  FACE_SERVICE_INVALID_RESPONSE: "FACE_SERVICE_INVALID_RESPONSE",
  FACE_SERVICE_NOT_CONFIGURED: "FACE_SERVICE_NOT_CONFIGURED",

  // Model compatibility errors
  MODEL_MISMATCH: "MODEL_MISMATCH",

  // Sample limit errors
  ENROLLMENT_SAMPLE_LIMIT_REACHED: "ENROLLMENT_SAMPLE_LIMIT_REACHED",

  // Sample conflict (stale request lost a race against another
  // concurrent sample submission). The route deliberately does NOT
  // retry automatically — the user/browser may explicitly retry.
  ENROLLMENT_SAMPLE_CONFLICT: "ENROLLMENT_SAMPLE_CONFLICT",

  // Encryption errors
  BIOMETRIC_ENCRYPTION_UNAVAILABLE: "BIOMETRIC_ENCRYPTION_UNAVAILABLE",

  // General persistence errors
  FACE_PROFILE_ALREADY_EXISTS: "FACE_PROFILE_ALREADY_EXISTS",
  ENROLLMENT_START_FAILED: "ENROLLMENT_START_FAILED",
  ENROLLMENT_STATUS_FAILED: "ENROLLMENT_STATUS_FAILED",
  ENROLLMENT_SAMPLE_FAILED: "ENROLLMENT_SAMPLE_FAILED",
} as const;

export type EnrollmentRouteErrorCode =
  (typeof ENROLLMENT_ROUTE_ERROR_CODES)[keyof typeof ENROLLMENT_ROUTE_ERROR_CODES];

export interface EnrollmentRouteErrorShape {
  code: EnrollmentRouteErrorCode | string;
  message: string;
}

/**
 * Application-level error for the Face ID enrollment routes.
 *
 * Does NOT expose raw Mongoose / MongoDB stack traces, connection
 * strings, or Better Auth session internals.
 */
export class EnrollmentRouteError extends Error {
  public readonly code: EnrollmentRouteErrorCode | string;

  constructor({
    code,
    message,
  }: {
    code: EnrollmentRouteErrorCode | string;
    message: string;
  }) {
    super(message);
    this.name = "EnrollmentRouteError";
    this.code = code;
  }

  toJSON(): EnrollmentRouteErrorShape {
    return {
      code: this.code,
      message: this.message,
    };
  }
}

/**
 * Maps any unknown thrown value (typically a service-layer error) to a
 * safe `EnrollmentRouteError` that the route can serialize.
 *
 * - `BiometricPersistenceError(BIOMETRIC_PROFILE_ALREADY_EXISTS)` →
 *   `FACE_PROFILE_ALREADY_EXISTS` (FaceProfile service layer code).
 * - any other `BiometricPersistenceError` →
 *   `ENROLLMENT_START_FAILED`.
 * - any other thrown value →
 *   `ENROLLMENT_START_FAILED` with a generic message.
 *
 * The function deliberately NEVER returns Mongoose / MongoDB stack
 * traces, error names, or connection-string fragments. The browser
 * only sees the stable `code` + `message`.
 */
export function mapEnrollmentStartError(err: unknown): EnrollmentRouteError {
  if (err instanceof BiometricPersistenceError) {
    if (
      err.code === BIOMETRIC_PERSISTENCE_ERROR_CODES.BIOMETRIC_PROFILE_ALREADY_EXISTS
    ) {
      return new EnrollmentRouteError({
        code: ENROLLMENT_ROUTE_ERROR_CODES.FACE_PROFILE_ALREADY_EXISTS,
        message:
          "A face profile already exists for this account. Re-enrollment is not supported yet.",
      });
    }
    return new EnrollmentRouteError({
      code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_START_FAILED,
      message: "Could not start the enrollment session. Please try again.",
    });
  }

  return new EnrollmentRouteError({
    code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_START_FAILED,
    message: "Could not start the enrollment session. Please try again.",
  });
}

/**
 * Maps any unknown thrown value (typically a service-layer error) to a
 * safe `EnrollmentRouteError` that the enrollment status route can
 * serialize.
 *
 * PHASE 4.4B2 — Face ID Enrollment Status API.
 *
 * Unlike the start route, the status route does NOT promote
 * `BIOMETRIC_PROFILE_ALREADY_EXISTS` to `FACE_PROFILE_ALREADY_EXISTS`
 * — the existence of an active `FaceProfile` is a normal, success-side
 * fact that the status response must report (with `configured: true`).
 * Any thrown value is therefore mapped to a single, generic failure
 * code so a service-layer exception cannot surface a biometric detail
 * to the browser.
 *
 * The function deliberately NEVER returns Mongoose / MongoDB stack
 * traces, error names, or connection-string fragments. The browser
 * only sees the stable `code` + `message`.
 */
export function mapEnrollmentStatusError(
  err: unknown,
): EnrollmentRouteError {
  // If a caller already wrapped the error, preserve its stable code
  // (e.g. UNAUTHENTICATED) so the route does not double-translate it.
  if (err instanceof EnrollmentRouteError) {
    return err;
  }
  if (err instanceof BiometricPersistenceError) {
    return new EnrollmentRouteError({
      code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_STATUS_FAILED,
      message: "Could not read the enrollment status. Please try again.",
    });
  }
  return new EnrollmentRouteError({
    code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_STATUS_FAILED,
    message: "Could not read the enrollment status. Please try again.",
  });
}

/**
 * Maps any unknown thrown value to a safe `EnrollmentRouteError` for
 * the enrollment sample route.
 *
 * PHASE 4.4C — Face ID Enrollment Sample API.
 *
 * Preserves safe Face Service domain errors where practical:
 *   - NO_FACE, MULTIPLE_FACES are returned as-is
 *   - Infrastructure errors (unavailable, timeout, unauthorized,
 *     invalid response, not configured) are mapped to stable
 *     FACE_SERVICE_* codes
 *
 * BiometricEncryption errors are mapped to a safe
 * BIOMETRIC_ENCRYPTION_UNAVAILABLE code.
 *
 * Any other thrown value is mapped to a generic ENROLLMENT_SAMPLE_FAILED.
 */
export function mapEnrollmentSampleError(err: unknown): EnrollmentRouteError {
  // Preserve already-wrapped errors
  if (err instanceof EnrollmentRouteError) {
    return err;
  }

  // Preserve Face Service domain errors
  if (err instanceof FaceServiceClientError) {
    // Domain errors from the Face Service are preserved for UI feedback
    if (err.domainError?.code === "NO_FACE") {
      return new EnrollmentRouteError({
        code: ENROLLMENT_ROUTE_ERROR_CODES.NO_FACE,
        message: "No face detected in the image.",
      });
    }
    if (err.domainError?.code === "MULTIPLE_FACES") {
      return new EnrollmentRouteError({
        code: ENROLLMENT_ROUTE_ERROR_CODES.MULTIPLE_FACES,
        message: "Multiple faces detected. Please ensure only one face is visible.",
      });
    }

    // Infrastructure errors map to stable safe codes
    switch (err.code) {
      case FACE_SERVICE_ERROR_CODES.FACE_SERVICE_NOT_CONFIGURED:
        return new EnrollmentRouteError({
          code: ENROLLMENT_ROUTE_ERROR_CODES.FACE_SERVICE_NOT_CONFIGURED,
          message: "Face recognition service is not configured.",
        });
      case FACE_SERVICE_ERROR_CODES.FACE_SERVICE_TIMEOUT:
        return new EnrollmentRouteError({
          code: ENROLLMENT_ROUTE_ERROR_CODES.FACE_SERVICE_TIMEOUT,
          message: "Face recognition service timed out. Please try again.",
        });
      case FACE_SERVICE_ERROR_CODES.FACE_SERVICE_UNAUTHORIZED:
        return new EnrollmentRouteError({
          code: ENROLLMENT_ROUTE_ERROR_CODES.FACE_SERVICE_UNAUTHORIZED,
          message: "Face recognition service authorization failed.",
        });
      case FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE:
        return new EnrollmentRouteError({
          code: ENROLLMENT_ROUTE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
          message: "Face recognition service returned an unexpected response.",
        });
      case FACE_SERVICE_ERROR_CODES.FACE_SERVICE_UNAVAILABLE:
      case FACE_SERVICE_ERROR_CODES.FACE_SERVICE_REJECTED_REQUEST:
      default:
        return new EnrollmentRouteError({
          code: ENROLLMENT_ROUTE_ERROR_CODES.FACE_SERVICE_UNAVAILABLE,
          message: "Face recognition service is unavailable. Please try again.",
        });
    }
  }

  // Map BiometricEncryption errors
  if (err instanceof BiometricPersistenceError) {
    return new EnrollmentRouteError({
      code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_SAMPLE_FAILED,
      message: "Could not process the sample. Please try again.",
    });
  }

  // Generic fallback — never leak raw error details
  return new EnrollmentRouteError({
    code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_SAMPLE_FAILED,
    message: "Could not process the sample. Please try again.",
  });
}