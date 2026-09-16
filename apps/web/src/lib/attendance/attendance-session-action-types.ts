/**
 * Validation schemas and result types for the PHASE 6.1 attendance
 * session Server Actions.
 *
 * PHASE 6.1E — Authenticated Teacher start/stop Attendance Session
 * Server Actions.
 *
 * This module is split out of the `"use server"` action modules
 * because Next.js 16.3.4's `"use server"` boundary only allows
 * `async` functions to be exported. The schemas, result types,
 * error codes, and safe-copy messages defined here are pure
 * browser-safe data — they are read by tests, by the helper
 * modules, and by future Client Components / Server Components
 * that need to render the action result.
 *
 * No biometric data, no Mongo internals, no Better Auth fields.
 */

import { z } from "zod";

// =============================================================================
// Constants
// =============================================================================

/**
 * Canonical Mongo ObjectId length. Mirrors the constant used by the
 * 5.1D2A read service so the attendance actions validate `classId`
 * syntax against the same 24-hex canonical shape.
 */
const OBJECT_ID_HEX_LENGTH = 24;

/**
 * `classId` validation.
 *
 * The browser supplies ONLY the resource identifier — never
 * `teacherUserId`, `userId`, `role`, `rosterSnapshot`,
 * `studentUserId`, `status`, or `startedAt`. The schema enforces
 * the 24-hex Mongo canonical form so a malformed id is rejected
 * at the action boundary BEFORE any database query is performed.
 */
const ClassIdSchema = z
  .string({ error: "classId is required." })
  .min(OBJECT_ID_HEX_LENGTH, "classId must be 24 hexadecimal characters.")
  .max(OBJECT_ID_HEX_LENGTH, "classId must be 24 hexadecimal characters.")
  .regex(/^[0-9a-fA-F]{24}$/, "classId must be a 24-hex string.");

/**
 * Start attendance input schema. The browser supplies ONLY
 * `classId` — every other identity-bearing field is derived
 * server-side.
 */
export const StartAttendanceInputSchema = z
  .object({
    classId: ClassIdSchema,
  })
  .strict();

export type StartAttendanceBrowserInput = z.infer<
  typeof StartAttendanceInputSchema
>;

/**
 * Stop attendance input schema. Same contract as the start
 * action — the browser supplies ONLY `classId`.
 */
export const StopAttendanceInputSchema = z
  .object({
    classId: ClassIdSchema,
  })
  .strict();

export type StopAttendanceBrowserInput = z.infer<
  typeof StopAttendanceInputSchema
>;

// =============================================================================
// Browser-safe error codes
// =============================================================================

/**
 * Stable browser-facing error codes for the attendance session
 * Server Actions. The shape mirrors the documented project-wide
 * Server Action convention (`{ ok, code, message, retryable }`).
 *
 * The codes overlap with the existing class / profile / membership
 * Server Action conventions; the unique `ATTENDANCE_*` codes are
 * reserved for the attendance-session domain and are NEVER
 * surfaced by any other action.
 */
export const ATTENDANCE_SESSION_ACTION_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
  TEACHER_REQUIRED: "TEACHER_REQUIRED",
  CLASS_NOT_ACCESSIBLE: "CLASS_NOT_ACCESSIBLE",
  CLASS_NOT_ACTIVE: "CLASS_NOT_ACTIVE",
  ATTENDANCE_ROSTER_INVALID: "ATTENDANCE_ROSTER_INVALID",
  ATTENDANCE_SESSION_CREATE_FAILED: "ATTENDANCE_SESSION_CREATE_FAILED",
  ATTENDANCE_SESSION_STOP_FAILED: "ATTENDANCE_SESSION_STOP_FAILED",
} as const;

export type AttendanceSessionActionErrorCode =
  (typeof ATTENDANCE_SESSION_ACTION_ERROR_CODES)[keyof typeof ATTENDANCE_SESSION_ACTION_ERROR_CODES];

/**
 * Restrained, browser-safe copy. No Mongo URI, no raw stack, no
 * `passwordHash`, no `studentUserId`, no `teacherUserId`, no
 * `rosterSnapshot`, no biometric fields, no `ObjectId`.
 */
export const ATTENDANCE_SESSION_ACTION_ERROR_MESSAGES: Readonly<
  Record<AttendanceSessionActionErrorCode, string>
> = {
  UNAUTHENTICATED: "You must be signed in to manage attendance.",
  PROFILE_INCOMPLETE: "Complete your profile before managing attendance.",
  TEACHER_REQUIRED: "Only teachers can start or stop attendance.",
  CLASS_NOT_ACCESSIBLE: "This class is not available.",
  CLASS_NOT_ACTIVE: "This class is not active.",
  ATTENDANCE_ROSTER_INVALID:
    "Cannot start attendance: the class roster is invalid.",
  ATTENDANCE_SESSION_CREATE_FAILED:
    "Could not start the attendance session. Please try again.",
  ATTENDANCE_SESSION_STOP_FAILED:
    "Could not stop the attendance session. Please try again.",
};

/**
 * Retry hint for each failure mode. The future attendance UI may
 * use this flag to decide whether to render a "Try again" affordance
 * or a more conservative flow.
 */
export const ATTENDANCE_SESSION_ACTION_RETRYABLE: Readonly<
  Record<AttendanceSessionActionErrorCode, boolean>
> = {
  UNAUTHENTICATED: false,
  PROFILE_INCOMPLETE: false,
  TEACHER_REQUIRED: false,
  CLASS_NOT_ACCESSIBLE: false,
  CLASS_NOT_ACTIVE: false,
  ATTENDANCE_ROSTER_INVALID: false,
  ATTENDANCE_SESSION_CREATE_FAILED: true,
  ATTENDANCE_SESSION_STOP_FAILED: true,
};

// =============================================================================
// Result types
// =============================================================================

/**
 * Browser-safe success result for the START action.
 *
 * The shape intentionally contains:
 *
 *   - `ok`              — the project-wide discriminated-union marker.
 *   - `alreadyActive`   — `true` when the start action observed an
 *                          existing ACTIVE session for the class.
 *                          The browser receives the SAME safe
 *                          success shape regardless of whether
 *                          this call CREATED the session or
 *                          merely returned the existing one.
 *   - `session`         — the safe summary projection.
 *                          `startedByUserId`, `rosterSnapshot`,
 *                          `passwordHash`, biometric fields, and
 *                          Mongoose internals are NEVER projected.
 *
 * `classId` is intentionally omitted from the result because the
 * browser already knows the resource identifier from its own input.
 * `rosterCount` is included so a future UI can render the roster
 * size without re-issuing the action.
 */
export interface StartAttendanceActionSuccess {
  ok: true;
  alreadyActive: boolean;
  session: {
    id: string;
    classId: string;
    status: "active" | "closed";
    startedAt: string;
    rosterCount: number;
  };
}

export interface StartAttendanceActionError {
  ok: false;
  code: AttendanceSessionActionErrorCode;
  message: string;
  retryable: boolean;
}

export type StartAttendanceActionResult =
  | StartAttendanceActionSuccess
  | StartAttendanceActionError;

/**
 * Browser-safe success result for the STOP action.
 *
 *   - `ok`             — discriminated-union marker.
 *   - `alreadyStopped` — `true` when the stop action observed that
 *                        the session was already CLOSED. The browser
 *                        receives the same safe success shape either
 *                        way.
 *   - `session`        — the safe summary projection of the
 *                        now-closed session.
 */
export interface StopAttendanceActionSuccess {
  ok: true;
  alreadyStopped: boolean;
  session: {
    id: string;
    classId: string;
    status: "active" | "closed";
    startedAt: string;
    endedAt: string | null;
    rosterCount: number;
  };
}

export interface StopAttendanceActionError {
  ok: false;
  code: AttendanceSessionActionErrorCode;
  message: string;
  retryable: boolean;
}

export type StopAttendanceActionResult =
  | StopAttendanceActionSuccess
  | StopAttendanceActionError;
