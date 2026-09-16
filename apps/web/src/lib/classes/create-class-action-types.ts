/**
 * Browser-safe error codes and types for the PHASE 5.1B create-class
 * Server Action.
 *
 * This module is INTENTIONALLY split out of
 * `apps/web/src/lib/classes/create-class-action.ts` because Next.js
 * 16.3.4's `"use server"` module boundary only allows `async`
 * functions to be exported from such a module. The constants and
 * types defined here are not Server Action surfaces — they are
 * browser-safe error-code enums + result types that the
 * Client Component reads to map action results into UI copy.
 *
 * No biometric / class-secret data lives here. The shapes mirror
 * the project-wide Server Action convention
 * `{ ok: true, class: {...} }` / `{ ok: false, code, message, retryable }`.
 *
 * See `docs/api.md` PHASE 5.1B for the full contract.
 */

export const CREATE_CLASS_ACTION_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
  TEACHER_REQUIRED: "TEACHER_REQUIRED",
  INVALID_CLASS_NAME: "INVALID_CLASS_NAME",
  INVALID_CLASS_PASSWORD: "INVALID_CLASS_PASSWORD",
  CLASS_CODE_GENERATION_FAILED: "CLASS_CODE_GENERATION_FAILED",
  CLASS_CREATION_FAILED: "CLASS_CREATION_FAILED",
} as const;

export type CreateClassActionErrorCode =
  (typeof CREATE_CLASS_ACTION_ERROR_CODES)[keyof typeof CREATE_CLASS_ACTION_ERROR_CODES];

/**
 * Browser-safe success result. Contains ONLY fields the teacher
 * legitimately needs to see and share.
 */
export interface CreateClassActionSuccess {
  ok: true;
  class: {
    id: string;
    name: string;
    classCode: string;
    status: "active";
    createdAt: string;
  };
}

/**
 * Browser-safe error result. The shape mirrors the project-wide
 * convention: `{ ok, code, message, retryable }`.
 */
export interface CreateClassActionError {
  ok: false;
  code: CreateClassActionErrorCode;
  message: string;
  retryable: boolean;
}

export type CreateClassActionResult =
  | CreateClassActionSuccess
  | CreateClassActionError;

/**
 * Maximum number of insert attempts the action will perform for a
 * single teacher invocation.
 *
 * Re-exported here so tests + non-`"use server"` callers can read
 * the constant without crossing the `"use server"` boundary.
 */
export { MAX_CLASS_CODE_ATTEMPTS } from "./create-class-action-constants";

/**
 * Restrained, browser-safe copy for every documented error code.
 * Mirrors the table that lives in the action module's body —
 * kept here so non-`"use server"` callers (tests, the test-only
 * module, the helpers module) can resolve the same message text
 * without crossing the `"use server"` boundary.
 */
export const CREATE_CLASS_ACTION_ERROR_MESSAGES: Readonly<
  Record<CreateClassActionErrorCode, string>
> = {
  UNAUTHENTICATED: "You must be signed in to create a class.",
  PROFILE_INCOMPLETE: "Complete your profile before creating a class.",
  TEACHER_REQUIRED: "Only teachers can create classes.",
  INVALID_CLASS_NAME: "Class name is invalid.",
  INVALID_CLASS_PASSWORD: "Class password is invalid.",
  CLASS_CODE_GENERATION_FAILED:
    "Could not generate a unique class code. Please try again.",
  CLASS_CREATION_FAILED: "Could not create the class. Please try again.",
};

/**
 * Retry hint for each documented error code. See the action
 * module's file header for the rationale.
 */
export const CREATE_CLASS_ACTION_RETRYABLE: Readonly<
  Record<CreateClassActionErrorCode, boolean>
> = {
  UNAUTHENTICATED: false,
  PROFILE_INCOMPLETE: false,
  TEACHER_REQUIRED: false,
  INVALID_CLASS_NAME: false,
  INVALID_CLASS_PASSWORD: false,
  CLASS_CODE_GENERATION_FAILED: true,
  CLASS_CREATION_FAILED: true,
};
