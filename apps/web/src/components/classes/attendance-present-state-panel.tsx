/**
 * `AttendancePresentStatePanel` — Server Component for the
 * persisted PRESENT-attendance list.
 *
 * PHASE 6.4 — IDEMPOTENT PRESENT ATTENDANCE MARKS +
 * LIVE PRESENT STATE.
 *
 * Renders the live persisted "Recorded present" counter plus the
 * recognized students table. The component is rendered as a
 * pure Server Component on `/classes/[classId]/attendance` — it
 * receives the safe present-state DTO from
 * `getAttendancePresentStateForCurrentTeacher` and projects
 * ONLY:
 *
 *   - `presentCount`        — number of persisted PRESENT marks.
 *   - `rosterCount`         — length of the immutable
 *                              AttendanceSession roster snapshot.
 *   - per-row `fullName`    — historical snapshot value.
 *   - per-row `identificationCode` — historical snapshot value.
 *   - per-row `recognizedAt` — ISO 8601 string of the FIRST
 *                              accepted recognition for that
 *                              student.
 *
 * The component NEVER projects:
 *
 *   - `studentUserId`
 *   - `AttendanceMark._id`
 *   - `classId`
 *   - `sessionId` (other than as a `data-` attribute on the
 *      root for live-update reconciliation)
 *   - biometric fields, embeddings, centroids
 *   - `passwordHash`
 *
 * The component intentionally does NOT render any "Absent" or
 * "Late" labels. Unrecognized roster students are NOT surfaced
 * as absent — absence belongs to a later phase.
 *
 * The component is fully rendered server-side. There is no
 * `useEffect`, no `useState`, no client-side fetch, no
 * `localStorage` access. The next render after a successful
 * recognition comes from `router.refresh()` in
 * `AttendanceCameraClient`, not from client polling.
 */

import * as React from "react";
import { Users } from "lucide-react";

import {
  Card,
  CardContent,
  CardSection,
} from "@/components/ui/card";
import type {
  SafeAttendancePresentStudentDto,
} from "@/lib/attendance/attendance-present-state-read-service";

/**
 * Props accepted by `AttendancePresentStatePanel`.
 *
 * The component receives ONLY the safe DTO from the
 * server-only `getAttendancePresentStateForCurrentTeacher`
 * read boundary. `sessionId` is required for `data-`
 * reconciliation; `rosterCount` is the immutable snapshot size.
 */
export interface AttendancePresentStatePanelProps {
  sessionId: string;
  rosterCount: number;
  presentCount: number;
  students: SafeAttendancePresentStudentDto[];
}

/**
 * Locale-stable, ISO-based date formatter for `recognizedAt`.
 *
 * Mirrors the helper used on the `AttendancePanel` so the
 * rendered text is deterministic across server / client.
 */
function formatRecognizedAt(iso: string): string {
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
 * Restrained empty-state copy for zero recorded presents.
 *
 * The empty state intentionally does NOT call the absent
 * students "Absent" or "Late" — absence belongs to a later
 * phase. Unrecognized roster students are simply NOT YET
 * RECORDED.
 */
function EmptyPresentState({
  rosterCount,
}: {
  rosterCount: number;
}) {
  return (
    <div
      data-attendance-present-empty="true"
      className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface px-5 py-5"
    >
      <p className="text-sm font-medium text-foreground">
        No students recorded yet
      </p>
      <p className="text-sm leading-[21px] text-muted-foreground">
        {rosterCount > 0
          ? `Once a face is recognized, the student will appear here. ${rosterCount} student${rosterCount === 1 ? "" : "s"} on the roster.`
          : "Once a face is recognized, the student will appear here."}
      </p>
    </div>
  );
}

/**
 * `AttendancePresentStatePanel` — the persisted present list
 * rendered on `/classes/[classId]/attendance`.
 *
 * The component renders a calm counter card (`X / N`) followed
 * by either a present-students table or the restrained empty
 * state.
 */
export function AttendancePresentStatePanel({
  sessionId,
  rosterCount,
  presentCount,
  students,
}: AttendancePresentStatePanelProps) {
  return (
    <Card data-component="attendance-present-state-panel">
      <CardSection>
        <div className="flex items-center gap-2">
          <Users
            className="h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <h2 className="text-base font-semibold text-foreground">
            Recorded present
          </h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Students recorded as present from face recognition.
        </p>
        <p
          className="mt-2 text-sm font-medium text-foreground"
          data-attendance-present-count={presentCount}
          data-attendance-roster-count={rosterCount}
        >
          {presentCount} / {rosterCount}
        </p>
      </CardSection>
      <CardContent>
        <div
          data-attendance-present-session={sessionId}
          className="flex flex-col gap-3"
        >
          {students.length === 0 ? (
            <EmptyPresentState rosterCount={rosterCount} />
          ) : (
            <ul
              className="flex flex-col gap-2"
              data-attendance-present-list="true"
            >
              {students.map((student, index) => (
                <li
                  key={`${student.identificationCode}-${index}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-2.5"
                  data-attendance-present-row="true"
                >
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">
                      {student.fullName}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {student.identificationCode}
                    </span>
                  </div>
                  <div className="flex flex-col items-end">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">
                      Recognized at
                    </span>
                    <span className="text-sm text-foreground">
                      {formatRecognizedAt(student.recognizedAt)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
