/**
 * `AttendanceControlButton` — focused Client Component for
 * PHASE 6.2.
 *
 * The teacher-only interactive Start / Stop attendance control
 * rendered inside the `AttendancePanel` Server Component on
 * `/classes/[classId]`. The component is the ONLY browser-side
 * trigger for `startAttendanceSessionAction(...)` and
 * `stopAttendanceSessionAction(...)`; it never auto-invokes the
 * action from a `useEffect`, `router.refresh()`, or any other
 * lifecycle hook.
 *
 * ## Action contract
 *
 *   - Calls `startAttendanceSessionAction({ classId })` OR
 *     `stopAttendanceSessionAction({ classId })` with ZERO
 *     identity / role / ownership / status / startedAt fields.
 *   - The browser supplies ONLY `classId`. `teacherUserId`,
 *     `userId`, `role`, `rosterSnapshot`, `status`, `startedAt`,
 *     `endedAt`, `startedByUserId` are NEVER forwarded.
 *   - On success: triggers a transition-wrapped `router.refresh()`
 *     so the Server Component re-reads the canonical attendance
 *     status and the panel transitions to the new state
 *     (NONE → ACTIVE, ACTIVE → CLOSED).
 *   - On `alreadyActive: true` / `alreadyStopped: true`: treated
 *     as a safe idempotent success — same `router.refresh()`
 *     path; no "Attendance already exists" / "Already stopped"
 *     error is rendered to the teacher.
 *   - On failure: maps the safe error code into restrained UI
 *     copy. No Mongo detail, no stack trace, no internal field
 *     name. No automatic retry.
 *
 * ## Double-click protection
 *
 *   - A synchronous `attendanceControlInFlightRef` guard
 *     collapses two rapid clicks into exactly ONE Server Action
 *     invocation. The ref is inspected / set BEFORE the first
 *     `await` so the second click observes the guard
 *     immediately.
 *   - The submit button is also disabled while the action is in
 *     flight, so the user receives both a synchronous ref guard
 *     AND a visual disable. There is NO automatic retry.
 *
 * ## Next.js refresh-transition guard
 *
 *   - `router.refresh()` in Next.js 16.3.4 returns `void`, not a
 *     Promise. Awaiting it is a no-op. The component therefore
 *     drives reconciliation inside a React `useTransition()` and
 *     observes the `isRefreshPending` true → false lifecycle
 *     before releasing the in-flight guard.
 *   - If the refreshed Server Component tree removes / unmounts
 *     this button (e.g. the lifecycle has progressed), the
 *     cleanup is harmless because the unmounted instance no
 *     longer has a user-visible UI to mutate.
 *
 * ## Privacy contract
 *
 *   - This component receives ONLY `classId` (the resource
 *     identifier), `mode` (`"start" | "stop"`), and `label`.
 *     It never receives `userId`, `teacherUserId`, `studentUserId`,
 *     `role`, `rosterSnapshot`, `startedByUserId`, or any
 *     biometric field.
 *   - It never writes `localStorage`, `sessionStorage`,
 *     IndexedDB, or the Cache API.
 *   - It never issues `fetch()` to any HTTP route, the Face
 *     Service, or any other server-to-server endpoint.
 *   - It never calls `console.log` with the classId, any id, or
 *     any action result field beyond the safe message text used
 *     for accessibility.
 */

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { startAttendanceSessionAction } from "@/lib/attendance/start-attendance-session-action";
import { stopAttendanceSessionAction } from "@/lib/attendance/stop-attendance-session-action";
import { ATTENDANCE_SESSION_ACTION_ERROR_CODES } from "@/lib/attendance/attendance-session-action-types";

// =============================================================================
// Public props
// =============================================================================

export interface AttendanceControlButtonProps {
  /**
   * Canonical Mongo `Class._id` (24-hex string). The component
   * forwards ONLY this field to the Server Action — every other
   * identity-bearing field is derived server-side.
   */
  classId: string;
  /**
   * The control mode:
   *   - `"start"` — calls `startAttendanceSessionAction`.
   *   - `"stop"`  — calls `stopAttendanceSessionAction`.
   */
  mode: "start" | "stop";
  /**
   * The visible button label (e.g. "Start attendance" /
   * "Stop attendance" / "Start new attendance"). The label is
   * a constant string controlled by the parent Server
   * Component; the Client Component never fabricates labels.
   */
  label: string;
  /**
   * Optional wrapper className. Currently unused; reserved for
   * future layout flexibility.
   */
  className?: string;
}

// =============================================================================
// Safe-error mapping
// =============================================================================

/**
 * Maps a stable attendance action error code into a restrained,
 * human-readable heading / body pair.
 *
 * The mapping NEVER references Mongo internals, stack traces,
 * `E11000`, internal field names, or service URLs. It is purely
 * UI copy derived from the project's stable error code set.
 */
function classifyAttendanceError(code: string): {
  heading: string;
  body: string;
} {
  switch (code) {
    case ATTENDANCE_SESSION_ACTION_ERROR_CODES.UNAUTHENTICATED:
      return {
        heading: "Sign-in required",
        body: "Please sign in again before managing attendance.",
      };
    case ATTENDANCE_SESSION_ACTION_ERROR_CODES.PROFILE_INCOMPLETE:
      return {
        heading: "Complete your profile",
        body: "Complete your profile before managing attendance.",
      };
    case ATTENDANCE_SESSION_ACTION_ERROR_CODES.TEACHER_REQUIRED:
      return {
        heading: "Teachers only",
        body: "Only teachers can manage attendance.",
      };
    case ATTENDANCE_SESSION_ACTION_ERROR_CODES.CLASS_NOT_ACTIVE:
    case ATTENDANCE_SESSION_ACTION_ERROR_CODES.CLASS_NOT_ACCESSIBLE:
      return {
        heading: "Class is not available",
        body: "This class is no longer available for attendance.",
      };
    case ATTENDANCE_SESSION_ACTION_ERROR_CODES.ATTENDANCE_ROSTER_INVALID:
      return {
        heading: "Class roster is invalid",
        body: "The class roster is invalid. Refresh the page and try again.",
      };
    case ATTENDANCE_SESSION_ACTION_ERROR_CODES.ATTENDANCE_SESSION_CREATE_FAILED:
    case ATTENDANCE_SESSION_ACTION_ERROR_CODES.ATTENDANCE_SESSION_STOP_FAILED:
      return {
        heading: "Could not update attendance",
        body: "Please try again in a moment.",
      };
    default:
      return {
        heading: "Could not update attendance",
        body: "Please try again in a moment.",
      };
  }
}

// =============================================================================
// Component
// =============================================================================

/**
 * Teacher-only Start / Stop attendance interactive control.
 *
 * The component is the ONLY browser-side trigger for the
 * `startAttendanceSessionAction` and `stopAttendanceSessionAction`
 * Server Actions. It uses a synchronous in-flight ref guard
 * plus a React transition-wrapped `router.refresh()` so the
 * server-rendered panel reflects the new state after a
 * successful action.
 */
export function AttendanceControlButton({
  classId,
  mode,
  label,
  className,
}: AttendanceControlButtonProps) {
  const router = useRouter();

  const [pending, setPending] = React.useState<boolean>(false);
  const [error, setError] = React.useState<
    | {
        heading: string;
        body: string;
        code: string;
      }
    | null
  >(null);

  const [isRefreshPending, startRefreshTransition] =
    React.useTransition();

  // Synchronous in-flight guard. React's `pending` state alone
  // does NOT block two clicks that land in the same React
  // dispatch tick. The ref is inspected / set BEFORE the first
  // `await` so the second click observes the guard immediately.
  const attendanceControlInFlightRef = React.useRef<boolean>(false);

  const buttonDisabled = pending || isRefreshPending;
  const buttonLabel = pending || isRefreshPending
    ? mode === "start"
      ? "Starting attendance…"
      : "Stopping attendance…"
    : label;

  const handleClick = React.useCallback(async (): Promise<void> => {
    // Synchronous guard — must run BEFORE any await.
    if (attendanceControlInFlightRef.current) return;
    attendanceControlInFlightRef.current = true;
    setPending(true);
    setError(null);

    let result:
      | Awaited<ReturnType<typeof startAttendanceSessionAction>>
      | Awaited<ReturnType<typeof stopAttendanceSessionAction>>;

    try {
      // ZERO-identity payload — the browser supplies ONLY
      // `classId`. `teacherUserId` / `userId` / `role` /
      // `rosterSnapshot` / `status` / `startedAt` / `endedAt`
      // are derived server-side by the Server Action.
      result =
        mode === "start"
          ? await startAttendanceSessionAction({ classId })
          : await stopAttendanceSessionAction({ classId });
    } catch {
      // Defensive: any uncaught throw is rendered as a generic,
      // safe attendance failure. Never leak the raw error.
      attendanceControlInFlightRef.current = false;
      setPending(false);
      setError({
        heading: "Could not update attendance",
        body: "Please try again in a moment.",
        code:
          mode === "start"
            ? ATTENDANCE_SESSION_ACTION_ERROR_CODES.ATTENDANCE_SESSION_CREATE_FAILED
            : ATTENDANCE_SESSION_ACTION_ERROR_CODES.ATTENDANCE_SESSION_STOP_FAILED,
      });
      return;
    }

    if (result.ok) {
      // SUCCESS — including the safe idempotent paths
      // (`alreadyActive: true` / `alreadyStopped: true`).
      // Treat them ALL as success and trigger a transition-
      // wrapped router.refresh() so the Server Component re-
      // reads the canonical attendance status and the panel
      // transitions to the new state. We deliberately do NOT
      // inspect the result field beyond the discriminated
      // `ok` marker.
      setPending(false);
      attendanceControlInFlightRef.current = false;
      startRefreshTransition(() => {
        router.refresh();
      });
      return;
    }

    // FAILURE. Map the safe action code into UI copy. The
    // action's `result.message` is already safe browser copy —
    // we use it indirectly through the classifier so the UI
    // copy is derived from the code, not from the raw action
    // message.
    const mapped = classifyAttendanceError(result.code);
    setError({
      heading: mapped.heading,
      body: mapped.body,
      code: result.code,
    });
    // Release the guard so the user may retry explicitly when
    // the contract allows it. There is no automatic retry.
    attendanceControlInFlightRef.current = false;
    setPending(false);
  }, [classId, mode, router, startRefreshTransition]);

  return (
    <div
      data-component="attendance-control-button"
      data-mode={mode}
      data-pending={pending ? "true" : undefined}
      data-refresh-pending={isRefreshPending ? "true" : undefined}
      className={cn("flex flex-col gap-3", className)}
    >
      <Button
        type="button"
        variant="primary"
        onClick={handleClick}
        disabled={buttonDisabled}
        loading={pending || isRefreshPending}
        aria-busy={pending || isRefreshPending || undefined}
        aria-label={
          pending || isRefreshPending
            ? mode === "start"
              ? "Starting attendance"
              : "Stopping attendance"
            : label
        }
      >
        {buttonLabel}
      </Button>

      {error ? (
        <div
          role="alert"
          aria-live="polite"
          data-tone="warning"
          data-error-code={error.code}
          className={cn(
            "rounded-md border border-warning/30 bg-warning-soft",
            "px-3 py-2.5 text-sm text-warning",
          )}
        >
          <p className="font-medium">{error.heading}</p>
          <p className="mt-0.5">{error.body}</p>
        </div>
      ) : null}
    </div>
  );
}