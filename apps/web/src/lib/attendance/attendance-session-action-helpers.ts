/**
 * Internal helpers for the PHASE 6.1 attendance session Server
 * Actions.
 *
 * PHASE 6.1E — Authenticated Teacher start/stop Attendance Session
 * Server Actions.
 *
 * This module is split out of the `"use server"` action modules
 * because Next.js 16.3.4's `"use server"` boundary only allows
 * `async` functions to be exported from such a module. The
 * helpers `buildError` and `toSafeError` are pure module-internal
 * logic that the action body calls. They are NOT Server Actions.
 *
 * Server-only. Tests import through
 * `apps/web/src/lib/attendance/attendance-session-action-testing.ts`.
 */

import "server-only";

import { AttendanceSessionServiceError } from "@/lib/attendance/attendance-session-service";
import {
  ATTENDANCE_SESSION_ACTION_ERROR_MESSAGES,
  ATTENDANCE_SESSION_ACTION_RETRYABLE,
  type AttendanceSessionActionErrorCode,
} from "./attendance-session-action-types";

/**
 * Wraps an unknown thrown value into the browser-safe error
 * result. Only typed service errors receive a specific code; any
 * other error collapses to the generic
 * `ATTENDANCE_SESSION_CREATE_FAILED` (start) or
 * `ATTENDANCE_SESSION_STOP_FAILED` (stop) result. Raw stacks,
 * Mongo error codes, and connection details are NEVER returned.
 *
 * The `defaultCode` parameter is the canonical fallback the
 * caller has chosen for its action.
 */
export function toSafeAttendanceError(
  err: unknown,
  defaultCode: AttendanceSessionActionErrorCode,
): {
  ok: false;
  code: AttendanceSessionActionErrorCode;
  message: string;
  retryable: boolean;
} {
  if (err instanceof AttendanceSessionServiceError) {
    // Map the typed service codes to the action surface.
    switch (err.code) {
      case "ATTENDANCE_ROSTER_INVALID":
        return buildAttendanceError("ATTENDANCE_ROSTER_INVALID");
      case "ATTENDANCE_SESSION_ALREADY_ACTIVE":
        // The start action folds this into an idempotent success
        // BEFORE reaching this helper; reaching here means the
        // caller misclassified the path. Collapse to the safe
        // generic code so we never leak the typed code to the
        // browser.
        return buildAttendanceError("ATTENDANCE_SESSION_CREATE_FAILED");
      case "ATTENDANCE_SESSION_NOT_ACTIVE":
        // The stop action folds this into an idempotent success
        // (`alreadyStopped: true`) BEFORE reaching this helper.
        // Reaching here means the caller misclassified the path.
        // Collapse to the safe generic code.
        return buildAttendanceError("ATTENDANCE_SESSION_STOP_FAILED");
      case "ATTENDANCE_SESSION_CREATE_FAILED":
        return buildAttendanceError("ATTENDANCE_SESSION_CREATE_FAILED");
      case "ATTENDANCE_SESSION_STOP_FAILED":
        return buildAttendanceError("ATTENDANCE_SESSION_STOP_FAILED");
      case "ATTENDANCE_SESSION_NOT_FOUND":
        return buildAttendanceError(defaultCode);
      default:
        return buildAttendanceError(defaultCode);
    }
  }
  return buildAttendanceError(defaultCode);
}

/**
 * Wraps an unknown thrown value into the browser-safe error
 * result, treating it like the START action's default fallback.
 * Existence is justified by symmetry with
 * `create-class-action-helpers.ts`.
 */
export function toSafeStartError(
  err: unknown,
): {
  ok: false;
  code: AttendanceSessionActionErrorCode;
  message: string;
  retryable: boolean;
} {
  return toSafeAttendanceError(err, "ATTENDANCE_SESSION_CREATE_FAILED");
}

/**
 * Wraps an unknown thrown value into the browser-safe error
 * result, treating it like the STOP action's default fallback.
 */
export function toSafeStopError(
  err: unknown,
): {
  ok: false;
  code: AttendanceSessionActionErrorCode;
  message: string;
  retryable: boolean;
} {
  return toSafeAttendanceError(err, "ATTENDANCE_SESSION_STOP_FAILED");
}

/**
 * Builds a typed, browser-safe error result. The message is the
 * restrained copy from `ATTENDANCE_SESSION_ACTION_ERROR_MESSAGES`;
 * the `retryable` hint is derived from
 * `ATTENDANCE_SESSION_ACTION_RETRYABLE`.
 */
export function buildAttendanceError(
  code: AttendanceSessionActionErrorCode,
): {
  ok: false;
  code: AttendanceSessionActionErrorCode;
  message: string;
  retryable: boolean;
} {
  return {
    ok: false,
    code,
    message: ATTENDANCE_SESSION_ACTION_ERROR_MESSAGES[code],
    retryable: ATTENDANCE_SESSION_ACTION_RETRYABLE[code],
  };
}
