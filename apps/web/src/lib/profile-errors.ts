/**
 * Application-level error helpers for Profile mutations.
 *
 * Phase 2: profile onboarding and profile-edit Server Actions surface
 * errors using a stable shape so the UI can render safe, human-readable
 * messages without leaking MongoDB internals, Better Auth internals, or
 * connection-string fragments.
 *
 * Error code conventions follow `docs/api.md`:
 *
 *   {
 *     error: {
 *       code: "STRING_CODE",
 *       message: "Human readable.",
 *       fieldErrors?: { [field]: string[] }
 *     }
 *   }
 */

export const PROFILE_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PROFILE_NOT_FOUND: "PROFILE_NOT_FOUND",
  PROFILE_ALREADY_EXISTS: "PROFILE_ALREADY_EXISTS",
  IDENTIFICATION_CODE_TAKEN: "IDENTIFICATION_CODE_TAKEN",
  INVALID_PROFILE_DATA: "INVALID_PROFILE_DATA",
  UNKNOWN_ERROR: "UNKNOWN_ERROR",
} as const;

export type ProfileErrorCode =
  (typeof PROFILE_ERROR_CODES)[keyof typeof PROFILE_ERROR_CODES];

export interface ProfileErrorShape {
  code: ProfileErrorCode | string;
  message: string;
  fieldErrors?: Record<string, string[] | undefined>;
}

export class ProfileError extends Error {
  public readonly code: ProfileErrorCode | string;
  public readonly fieldErrors?: Record<string, string[] | undefined>;

  constructor({
    code,
    message,
    fieldErrors,
  }: {
    code: ProfileErrorCode | string;
    message: string;
    fieldErrors?: Record<string, string[] | undefined>;
  }) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }

  toJSON(): ProfileErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.fieldErrors ? { fieldErrors: this.fieldErrors } : {}),
    };
  }
}

/**
 * Maps Mongoose / MongoDB duplicate-key errors into a safe,
 * user-facing ProfileError.
 *
 * Only the duplicate-key code path is mapped; other Mongo errors bubble
 * up as UNKNOWN_ERROR so we never leak connection strings or stack
 * traces to the client.
 */
export function mapMongoDuplicateKeyError(err: unknown): ProfileError {
  // We import the duplicate-key constant lazily to avoid pulling the
  // Mongoose types into files that don't need them.
  // Mongoose error codes are stable: 11000.
  if (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === 11000
  ) {
    const keyValue = (err as { keyValue?: Record<string, unknown> }).keyValue;
    if (keyValue && "identificationCode" in keyValue) {
      return new ProfileError({
        code: PROFILE_ERROR_CODES.IDENTIFICATION_CODE_TAKEN,
        message: "This identification code is already in use.",
      });
    }
    if (keyValue && "userId" in keyValue) {
      return new ProfileError({
        code: PROFILE_ERROR_CODES.PROFILE_ALREADY_EXISTS,
        message: "A profile already exists for this account.",
      });
    }
    return new ProfileError({
      code: PROFILE_ERROR_CODES.PROFILE_ALREADY_EXISTS,
      message: "This record already exists.",
    });
  }

  return new ProfileError({
    code: PROFILE_ERROR_CODES.UNKNOWN_ERROR,
    message: "An unexpected error occurred.",
  });
}

/**
 * Converts a Zod safeParse failure into a user-facing ProfileError.
 */
export function mapZodError(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  zodError: any,
): ProfileError {
  const flat = zodError?.flatten?.() ?? {};
  const fieldErrors: Record<string, string[] | undefined> =
    flat.fieldErrors ?? {};
  return new ProfileError({
    code: PROFILE_ERROR_CODES.INVALID_PROFILE_DATA,
    message: "Some fields are missing or invalid.",
    fieldErrors,
  });
}