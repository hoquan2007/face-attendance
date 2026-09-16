/**
 * Test-only exports for the PHASE 6.1 attendance session Server
 * Actions.
 *
 * This module lives OUTSIDE the `"use server"` boundary so tests
 * can import the internal schemas + helpers without Next.js 16.3.4
 * rejecting the import. The corresponding action modules
 * (`start-attendance-session-action.ts` and
 * `stop-attendance-session-action.ts`) only ship `async`
 * exports — see their file headers for the rationale.
 *
 * Server-only. Tests import it directly because the Vitest
 * environment aliases `server-only` to a no-op stub
 * (see `apps/web/tests/stubs/server-only.ts`).
 */

import "server-only";

import {
  StartAttendanceInputSchema,
  StopAttendanceInputSchema,
} from "./attendance-session-action-types";
import {
  ATTENDANCE_SESSION_ACTION_ERROR_MESSAGES,
  ATTENDANCE_SESSION_ACTION_RETRYABLE,
} from "./attendance-session-action-types";
import {
  buildAttendanceError as _buildAttendanceError,
  toSafeStartError as _toSafeStartError,
  toSafeStopError as _toSafeStopError,
} from "./attendance-session-action-helpers";

export const __testing = {
  StartAttendanceInputSchema,
  StopAttendanceInputSchema,
  ATTENDANCE_SESSION_ACTION_ERROR_MESSAGES,
  ATTENDANCE_SESSION_ACTION_RETRYABLE,
  buildAttendanceError: _buildAttendanceError,
  toSafeStartError: _toSafeStartError,
  toSafeStopError: _toSafeStopError,
};
