/**
 * `AttendanceFinalSummaryPanel` — Server Component for the
 * PHASE 6.6 final attendance summary.
 *
 * Renders the immutable final attendance summary after a session
 * has been closed. The panel shows every roster student with
 * their final status (Present or Absent), along with the
 * recognized-at timestamp for present students and a placeholder
 * for absent students.
 *
 * The component is rendered as a Server Component — it receives
 * the safe summary DTO from `getAttendanceFinalSummaryForCurrentTeacher`
 * and projects ONLY:
 *
 *   - `presentCount`    — number of PRESENT marks.
 *   - `absentCount`     — number of ABSENT marks.
 *   - `rosterCount`     — total roster size.
 *   - per-row `fullName`      — historical snapshot value.
 *   - per-row `identificationCode` — historical snapshot value.
 *   - per-row `status`  — "present" | "absent".
 *   - per-row `recognizedAt` — ISO 8601 string (present) or null (absent).
 *
 * The component NEVER projects:
 *
 *   - `studentUserId`
 *   - `AttendanceMark._id`
 *   - `classId`
 *   - `sessionId`
 *   - `source`
 *   - biometric fields, embeddings, centroids
 *   - `passwordHash`
 *
 * The component intentionally does NOT implement:
 *   - Manual attendance editing
 *   - Late marks
 *   - Excel / CSV export
 *   - Attendance history browsing
 */

import * as React from "react";
import { CheckCircle, XCircle } from "lucide-react";

import {
  Card,
  CardContent,
  CardSection,
} from "@/components/ui/card";
import { StatusBadge } from "@/components/layout/StatusBadge";
import type {
  SafeAttendanceFinalSummaryDto,
} from "@/lib/attendance/attendance-final-summary-read-service";

/**
 * Props for `AttendanceFinalSummaryPanel`.
 *
 * `summary` may be `null` if the read service failed — the
 * component renders a restrained error state in that case.
 */
export interface AttendanceFinalSummaryPanelProps {
  summary: SafeAttendanceFinalSummaryDto | null;
}

/**
 * Locale-stable, ISO-based date formatter for `recognizedAt`.
 */
function formatRecognizedAt(iso: string | null): string {
  if (!iso) return "—";
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
    return "—";
  }
}

/**
 * Restrained empty-state when no summary is available
 * (read service failed).
 */
function ErrorState() {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface px-5 py-5"
    >
      <p className="text-sm font-medium text-foreground">
        Could not load attendance summary
      </p>
      <p className="text-sm leading-[21px] text-muted-foreground">
        Please stop and restart the attendance session.
      </p>
    </div>
  );
}

/**
 * `AttendanceFinalSummaryPanel` — the final attendance summary
 * rendered on `/classes/[classId]/attendance` after the teacher
 * stops the session.
 *
 * The component renders a counter card (Present / Absent / Total)
 * followed by rows for each roster student.
 */
export function AttendanceFinalSummaryPanel({
  summary,
}: AttendanceFinalSummaryPanelProps) {
  if (!summary) {
    return (
      <Card data-component="attendance-final-summary-panel">
        <CardSection>
          <div className="flex items-center gap-2">
            <CheckCircle
              className="h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            <h2 className="text-base font-semibold text-foreground">
              Final Attendance
            </h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Final attendance summary for this session.
          </p>
        </CardSection>
        <CardContent>
          <ErrorState />
        </CardContent>
      </Card>
    );
  }

  const { session, presentCount, absentCount, students } = summary;
  const rosterCount = session.rosterCount;

  return (
    <Card data-component="attendance-final-summary-panel">
      <CardSection>
        <div className="flex items-center gap-2">
          <CheckCircle
            className="h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <h2 className="text-base font-semibold text-foreground">
            Final Attendance
          </h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          This attendance session has been closed. The final
          attendance record is shown below.
        </p>

        {/* Counters */}
        <div
          className="mt-4 flex flex-wrap items-center gap-4"
          data-final-summary-counts="true"
        >
          <div className="flex items-center gap-2">
            <StatusBadge tone="present" label="Present" />
            <span
              className="text-lg font-semibold text-foreground"
              data-attendance-final-present-count={presentCount}
            >
              {presentCount}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <StatusBadge tone="absent" label="Absent" />
            <span
              className="text-lg font-semibold text-foreground"
              data-attendance-final-absent-count={absentCount}
            >
              {absentCount}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Total:</span>
            <span
              className="text-lg font-semibold text-foreground"
              data-attendance-final-roster-count={rosterCount}
            >
              {rosterCount}
            </span>
          </div>
        </div>
      </CardSection>

      <CardContent>
        <div className="flex flex-col gap-3">
          {students.length === 0 ? (
            <div
              className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface px-5 py-5"
            >
              <p className="text-sm font-medium text-foreground">
                {rosterCount > 0
                  ? `All ${rosterCount} student${rosterCount === 1 ? "" : "s"} are recorded.`
                  : "No students on the roster."}
              </p>
            </div>
          ) : (
            <ul
              className="flex flex-col gap-2"
              data-attendance-final-list="true"
            >
              {students.map((student, index) => (
                <li
                  key={`${student.identificationCode}-${index}`}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-2.5"
                  data-attendance-final-row="true"
                  data-attendance-final-status={student.status}
                >
                  <div className="flex flex-col">
                    <span className="text-sm font-medium text-foreground">
                      {student.fullName}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {student.identificationCode}
                    </span>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="flex flex-col items-end">
                      <StatusBadge
                        tone={student.status === "present" ? "present" : "absent"}
                        label={student.status === "present" ? "Present" : "Absent"}
                        icon={
                          student.status === "present" ? (
                            <CheckCircle
                              className="mr-1 h-3 w-3"
                              aria-hidden="true"
                            />
                          ) : (
                            <XCircle
                              className="mr-1 h-3 w-3"
                              aria-hidden="true"
                            />
                          )
                        }
                      />
                    </div>

                    <div className="flex flex-col items-end">
                      <span className="text-xs uppercase tracking-wide text-muted-foreground">
                        {student.status === "present"
                          ? "Recognized at"
                          : "Recognized at"}
                      </span>
                      <span
                        className="text-sm text-foreground"
                        data-attendance-final-recognized-at={student.recognizedAt ?? ""}
                      >
                        {student.status === "present"
                          ? formatRecognizedAt(student.recognizedAt)
                          : "—"}
                      </span>
                    </div>
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
