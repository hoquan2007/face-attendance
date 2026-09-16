/**
 * Internal helpers for the PHASE 5.1B create-class Server Action.
 *
 * PHASE 5.1E2 — split out of `create-class-action.ts` so the
 * action module only ships `async` exports (the `"use server"`
 * boundary constraint imposed by Next.js 16.3.4). The helpers
 * `assertAttemptsCeiling`, `buildError`, and `toSafeError` are
 * not Server Actions — they are pure module-internal logic that
 * the action body calls.
 *
 * Server-only. Tests import through
 * `apps/web/src/lib/classes/create-class-action-testing.ts`.
 */

import "server-only";

import {
  CLASS_ERROR_CODES,
  ClassServiceError,
} from "./class-service";
import { MAX_CLASS_CODE_ATTEMPTS } from "./create-class-action-constants";
import {
  CREATE_CLASS_ACTION_ERROR_MESSAGES,
  CREATE_CLASS_ACTION_RETRYABLE,
  type CreateClassActionError,
  type CreateClassActionErrorCode,
} from "./create-class-action-types";

/**
 * Hard ceiling for `MAX_CLASS_CODE_ATTEMPTS`. Defensive guard
 * against future regressions that accidentally raise the constant
 * above a sane bound.
 */
const HARD_MAX_ATTEMPTS = 10;

/**
 * Defensive guard around the retry ceiling constant. Catches
 * future accidental raises without changing the call site.
 */
export function assertAttemptsCeiling(): void {
  if (
    !Number.isInteger(MAX_CLASS_CODE_ATTEMPTS) ||
    MAX_CLASS_CODE_ATTEMPTS < 1 ||
    MAX_CLASS_CODE_ATTEMPTS > HARD_MAX_ATTEMPTS
  ) {
    // Surface the configuration problem as a generic creation
    // failure. We never leak the constant value or the harness
    // details to the browser.
    throw new ClassServiceError({
      code: CLASS_ERROR_CODES.CLASS_CREATE_FAILED,
      message: "Failed to create class.",
    });
  }
}

/**
 * Wraps an unknown thrown value into the browser-safe error
 * result. Only typed service errors receive a specific code; any
 * other error collapses to `CLASS_CREATION_FAILED` with a safe
 * generic message. Raw stacks, Mongo error codes, and connection
 * details are NEVER returned.
 */
export function toSafeError(err: unknown): CreateClassActionError {
  // A `ClassServiceError(CLASS_CODE_ALREADY_EXISTS)` after the retry
  // loop has been exhausted means we generated MAX_CLASS_CODE_ATTEMPTS
  // fresh codes and every one collided on the unique index. Map to a
  // dedicated, browser-safe code.
  if (err instanceof ClassServiceError) {
    if (err.code === CLASS_ERROR_CODES.CLASS_CODE_ALREADY_EXISTS) {
      return buildError("CLASS_CODE_GENERATION_FAILED");
    }
    return buildError("CLASS_CREATION_FAILED");
  }
  return buildError("CLASS_CREATION_FAILED");
}

export function buildError(
  code: CreateClassActionErrorCode,
): CreateClassActionError {
  return {
    ok: false,
    code,
    message: CREATE_CLASS_ACTION_ERROR_MESSAGES[code],
    retryable: CREATE_CLASS_ACTION_RETRYABLE[code],
  };
}
