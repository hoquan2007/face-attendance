/**
 * `AttendancePanel` — focused Server Component for PHASE 6.2.
 *
 * The teacher-only Attendance lifecycle panel rendered on the
 * `/classes/[classId]` class detail page. The component receives
 * the safe attendance session status projection from the
 * canonical server-only
 * `getAttendanceSessionStatusForCurrentTeacher(classId)` read
 * boundary and renders ONLY the safe fields:
 *
 *   - `state`            — `"none" | "active" | "closed"`.
 *   - `session.id`       — canonical Mongo `_id.toString()`.
 *   - `session.status`   — `"active" | "closed"`.
 *   - `session.startedAt`— ISO 8601 string.
 *   - `session.endedAt`  — ISO 8601 string or `null`.
 *   - `session.rosterCount` — immutable snapshot size.
 *
 * The component:
 *
 *   - Renders a calm "Attendance" section heading with a
 *     restrained one-line description.
 *   - Renders the THREE canonical states:
 *       - NONE    → restrained copy + "Start attendance" control.
 *       - ACTIVE  → in-progress copy, startedAt, rosterCount,
 *                   "Stop attendance" control.
 *       - CLOSED  → ended copy, startedAt, endedAt, rosterCount,
 *                   "Start new attendance" control.
 *   - Renders an ARCHIVED affordance: the panel is still
 *     visible, but the Start control is replaced with the calm
 *     "Attendance cannot be started for an archived class."
 *     copy. Historical closed session information is still
 *     displayed when present.
 *   - Renders a local safe failure block when the read returns
 *     a safe failure — no raw exception text, no stack traces,
 *     no Mongo detail, no user IDs, no class / student / teacher
 *     id leak.
 *   - Renders NOTHING when the caller explicitly opted out
 *     (`state.status === "absent"`) so the student viewer path
 *     performs ZERO reads and renders zero DOM.
 *   - Uses semantic HTML for assistive technology.
 *   - The interactive Start / Stop controls are delegated to
 *     the dedicated Client Component `AttendanceControlButton`
 *     to keep this Server Component free of `"use client"` and
 *     `useTransition` plumbing.
 *
 * Privacy guarantees:
 *
 *   - DOM NEVER contains `password`, `passwordHash`,
 *     `teacherUserId`, `studentUserId`, `membershipId`,
 *     `startedByUserId`, `rosterSnapshot`, `emailSnapshot`,
 *     `phone`, `FaceProfile`, embedding, centroid, biometric
 *     fields, or attendance marks (present / absent / late /
 *     confidence / recognizedAt).
 *   - The component receives ONLY the safe DTO. There is no
 *     `useEffect`, no SWR / React Query, no `fetch`, no
 *     `localStorage`, `sessionStorage`, IndexedDB, or Cache
 *     API access. The render is purely server-side.
 *   - No Face Service call. No camera code. No biometric / face
 *     recognition UI.
 */

import * as React from "react";

import {
  Card,
  CardContent,
  CardSection,
} from "@/components/ui/card";
import { AttendanceControlButton } from "@/components/classes/attendance-control-button";
import type {
  AttendanceSessionStatusDto,
  AttendanceSessionStatusSessionDto,
  AttendanceSessionStatusState,
} from "@/lib/attendance/attendance-session-status-types";

/**
 * Alias exported for the page import — the page references this
 * type as `AttendancePanelState` so the import matches the
 * existing roster-panel convention. `AttendancePanelState` is
 * the union of the three admissible `state` shapes the page
 * passes through.
 */
export type AttendancePanelState =
  | { status: "success"; payload: AttendanceSessionStatusDto }
  | { status: "absent" }
  | { status: "failure" };

/**
 * Props accepted by the `AttendancePanel` Server Component.
 */
export interface AttendancePanelProps {
  /**
   * The safe attendance read state. The component renders
   * NOTHING when `status === "absent"` so the student viewer
   * path can opt out of the entire panel — and the entire read.
   */
  state: AttendancePanelState;
  /**
   * The canonical Mongo `Class._id` (24-hex string). Required
   * by the Start / Stop Client Component to invoke the
   * `startAttendanceSessionAction` / `stopAttendanceSessionAction`
   * Server Actions.
   *
   * The student viewer path passes an empty string (the panel
   * never renders in that branch — `status === "absent"`).
   */
  classId: string;
  /**
   * The class archive status, used to swap the Start control
   * for the restrained "archived class" copy. The class detail
   * page passes the server-authoritative value; the panel does
   * NOT fetch it.
   */
  classStatus: "active" | "archived";
}

/**
 * Locale-stable, ISO-based date formatter for `startedAt` /
 * `endedAt`.
 *
 * Mirrors the helper used on `/classes` and `/classes/[classId]`
 * so the rendered text is deterministic across server / client.
 */
function formatIsoDateTime(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}

/**
 * Safe copy for the lifecycle heading + sub-copy.
 *
 * The wording is restrained per `docs/frontend-design.md` —
 * no fake analytics, no fake progress, no count of "present"
 * / "absent" students. Only the documented lifecycle state and
 * the snapshot size captured at session start.
 */
function describeSessionState(
  state: AttendanceSessionStatusState,
): { heading: string; description: string } {
  switch (state) {
    case "none":
      return {
        heading: "Attendance",
        description:
          "Start attendance to capture who is present for this class.",
      };
    case "active":
      return {
        heading: "Attendance",
        description: "Attendance is currently in progress.",
      };
    case "closed":
      return {
        heading: "Attendance",
        description: "The most recent attendance session has ended.",
      };
  }
}

/**
 * Restrained start / stop action copy.
 *
 * The wording intentionally varies by lifecycle state so the
 * teacher understands whether the button STARTS a fresh
 * session or STOPS the active one.
 */
function controlLabel(
  state: AttendanceSessionStatusState,
): string {
  switch (state) {
    case "none":
      return "Start attendance";
    case "active":
      return "Stop attendance";
    case "closed":
      return "Start new attendance";
  }
}

/**
 * Restrained, calm failure block for the attendance-local error
 * path.
 *
 * The block NEVER surfaces a raw error string, a stack trace,
 * a Mongo detail, an ownership copy, a user id, a membership
 * id, the failure cause, or any backend message. The user sees
 * a single, short, hardcoded copy and is invited to refresh
 * the page. No automatic retry is triggered.
 *
 * The copy is intentionally constant so a future backend
 * regression that surfaces a raw `E11000` / `mongodb://` /
 * stack-trace through the failure message can NEVER leak into
 * the rendered DOM through this surface.
 */
function AttendanceFailureBlock() {
  return (
    <Card>
      <CardContent>
        <div
          role="status"
          aria-live="polite"
          className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface px-5 py-5"
        >
          <p className="text-sm font-medium text-foreground">
            Attendance status could not be loaded.
          </p>
          <p className="text-sm leading-[21px] text-muted-foreground">
            Please refresh the page in a moment.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * The attendance session metadata block — renders ONLY the safe
 * fields.
 *
 * `rosterCount` is rendered as a plain integer — it represents
 * the IMMUTABLE snapshot captured at session start. A student
 * who joins the class after attendance starts does NOT change
 * the count.
 */
function SessionMetadataBlock({
  session,
}: {
  session: AttendanceSessionStatusSessionDto;
}) {
  return (
    <dl className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">
          Started
        </dt>
        <dd className="text-sm text-foreground">
          {formatIsoDateTime(session.startedAt)}
        </dd>
      </div>
      {session.endedAt ? (
        <div className="flex flex-col gap-1.5">
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">
            Ended
          </dt>
          <dd className="text-sm text-foreground">
            {formatIsoDateTime(session.endedAt)}
          </dd>
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <dt className="text-xs uppercase tracking-wide text-muted-foreground">
          Roster count
        </dt>
        <dd
          className="text-sm text-foreground"
          data-attendance-roster-count={session.rosterCount}
        >
          {session.rosterCount}
        </dd>
      </div>
    </dl>
  );
}

/**
 * `AttendancePanel` — the teacher Attendance lifecycle section.
 *
 * The panel hides itself entirely on the student viewer path
 * (`state.status === "absent"`). On the teacher viewer path the
 * panel renders the lifecycle state, the safe session metadata
 * (when available), and the Start / Stop interactive component.
 *
 * The archived-class affordance replaces the Start control with
 * a calm, restrained notice; historical closed-session
 * information is still rendered because the panel supports
 * read-only inspection of past attendance.
 */
export function AttendancePanel({
  state,
  classId,
  classStatus,
}: AttendancePanelProps) {
  if (state.status === "absent") {
    return null;
  }

  if (state.status === "failure") {
    return <AttendanceFailureBlock />;
  }

  const payload = state.payload;
  const { heading, description } = describeSessionState(payload.state);
  const isArchived = classStatus === "archived";
  const canStart =
    !isArchived && (payload.state === "none" || payload.state === "closed");
  const canStop = !isArchived && payload.state === "active";

  return (
    <Card data-component="attendance-panel" data-attendance-state={payload.state}>
      <CardSection>
        <h2 className="text-base font-semibold text-foreground">
          {heading}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </CardSection>
      <CardContent>
        <div className="flex flex-col gap-5">
          {payload.session ? (
            <SessionMetadataBlock session={payload.session} />
          ) : null}

          {isArchived ? (
            <div
              role="status"
              className="flex flex-col gap-1.5 rounded-xl border border-border bg-muted px-5 py-4"
              data-attendance-archived-notice="true"
            >
              <p className="text-sm font-medium text-foreground">
                Attendance cannot be started for an archived class.
              </p>
            </div>
          ) : canStop ? (
            <AttendanceControlButton
              classId={classId}
              mode="stop"
              label={controlLabel(payload.state)}
            />
          ) : canStart ? (
            <AttendanceControlButton
              classId={classId}
              mode="start"
              label={controlLabel(payload.state)}
            />
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}