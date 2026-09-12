/**
 * Application-level error helpers for biometric persistence.
 *
 * PHASE 4.2 — FaceProfile + FaceEnrollmentSession database foundation.
 *
 * These helpers wrap raw Mongoose / MongoDB errors into safe
 * `BiometricPersistenceError` instances so callers (Server Actions,
 * Route Handlers) can render user-facing messages without leaking
 * driver internals.
 *
 * Conventions follow `docs/api.md`:
 *   {
 *     error: {
 *       code: "STRING_CODE",
 *       message: "Human readable."
 *     }
 *   }
 *
 * Notes:
 *   - Only duplicate-key errors are mapped specifically; all other
 *     Mongo errors are wrapped as `UNKNOWN_ERROR` so connection-string
 *     fragments or driver stacks never escape this module.
 *   - This module deliberately does NOT import the FaceProfile /
 *     FaceEnrollmentSession models. It only inspects error shapes.
 */

export const BIOMETRIC_PERSISTENCE_ERROR_CODES = {
  BIOMETRIC_PROFILE_NOT_FOUND: "BIOMETRIC_PROFILE_NOT_FOUND",
  BIOMETRIC_PROFILE_ALREADY_EXISTS: "BIOMETRIC_PROFILE_ALREADY_EXISTS",
  INVALID_BIOMETRIC_DATA: "INVALID_BIOMETRIC_DATA",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
  // PHASE 4.6B2A — active finalization claim blocks session reset.
  ENROLLMENT_FINALIZATION_IN_PROGRESS:
    "ENROLLMENT_FINALIZATION_IN_PROGRESS",
} as const;

export type BiometricPersistenceErrorCode =
  (typeof BIOMETRIC_PERSISTENCE_ERROR_CODES)[keyof typeof BIOMETRIC_PERSISTENCE_ERROR_CODES];

export interface BiometricPersistenceErrorShape {
  code: BiometricPersistenceErrorCode | string;
  message: string;
}

export class BiometricPersistenceError extends Error {
  public readonly code: BiometricPersistenceErrorCode | string;

  constructor({
    code,
    message,
  }: {
    code: BiometricPersistenceErrorCode | string;
    message: string;
  }) {
    super(message);
    this.name = "BiometricPersistenceError";
    this.code = code;
  }

  toJSON(): BiometricPersistenceErrorShape {
    return {
      code: this.code,
      message: this.message,
    };
  }
}

/**
 * Maps Mongoose / MongoDB duplicate-key errors into a safe,
 * user-facing `BiometricPersistenceError`.
 *
 * Only `code === 11000` (duplicate key) is mapped specifically. Any
 * other error is wrapped as `UNKNOWN_ERROR`.
 */
export function mapMongoDuplicateKeyErrorForBiometrics(
  err: unknown,
): BiometricPersistenceError {
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === 11000
  ) {
    const keyValue = (err as { keyValue?: Record<string, unknown> }).keyValue;
    if (keyValue && "userId" in keyValue) {
      return new BiometricPersistenceError({
        code: BIOMETRIC_PERSISTENCE_ERROR_CODES.BIOMETRIC_PROFILE_ALREADY_EXISTS,
        message: "A face profile already exists for this account.",
      });
    }
    return new BiometricPersistenceError({
      code: BIOMETRIC_PERSISTENCE_ERROR_CODES.BIOMETRIC_PROFILE_ALREADY_EXISTS,
      message: "This biometric record already exists.",
    });
  }

  return new BiometricPersistenceError({
    code: BIOMETRIC_PERSISTENCE_ERROR_CODES.UNKNOWN_ERROR,
    message: "An unexpected error occurred.",
  });
}
