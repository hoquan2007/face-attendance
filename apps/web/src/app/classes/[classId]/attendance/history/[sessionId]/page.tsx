/**
 * `/classes/[classId]/attendance/history/[sessionId]` — historical
 * session detail page.
 *
 * PHASE 6.7 — ATTENDANCE HISTORY.
 *
 * Server Component. Teacher-only.
 *
 * Reuses `getAttendanceFinalSummaryForCurrentTeacher` for the
 * final summary data. The final summary service already correctly
 * supports arbitrary closed sessions.
 *
 * Entry guard chain:
 *   - no session        → redirect /login
 *   - profile incomplete → redirect /onboarding
 *   - CLASS_NOT_ACCESSIBLE / malformed classId → notFound()
 *   - student viewer   → notFound() (teachers only)
 *   - wrong-class session → notFound()
 *   - non-owner session → notFound()
 *   - active session → notFound() (only closed sessions)
 *   - final summary load failed → render error state
 *   - success → render historical session detail
 *
 * This page does NOT:
 *   - Accept userId, teacherUserId, or role from browser
 *   - Expose studentUserId, AttendanceMark._id, startedByUserId,
 *     teacherUserId, biometric data to the browser
 *   - Modify any attendance data
 *   - Call the Face Service
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CheckCircle } from "lucide-react";

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import {
  getClassDetailForCurrentUser,
  CLASS_DETAIL_READ_ERROR_CODES,
} from "@/lib/classes/class-read-service";
import {
  getAttendanceFinalSummaryForCurrentTeacher,
  ATTENDANCE_FINAL_SUMMARY_ERROR_CODES,
} from "@/lib/attendance/attendance-final-summary-read-service";
import { AttendanceFinalSummaryPanel } from "@/components/classes/attendance-final-summary-panel";
import { ExportCsvButton } from "@/components/classes/export-csv-button";
import { PageContainer } from "@/components/layout/PageContainer";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  Card,
  CardContent,
  CardSection,
} from "@/components/ui/card";

export const metadata = {
  title: "Attendance Session",
};

/**
 * Locale-stable date/time formatter.
 */
function formatDateTime(iso: string | null): string {
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
    return iso;
  }
}

/**
 * Session metadata card.
 */
function SessionMetadataCard({
  startedAt,
  endedAt,
  presentCount,
  absentCount,
  rosterCount,
}: {
  startedAt: string;
  endedAt: string | null;
  presentCount: number;
  absentCount: number;
  rosterCount: number;
}) {
  return (
    <Card>
      <CardSection>
        <div className="flex items-center gap-2">
          <CheckCircle
            className="h-4 w-4 text-muted-foreground"
            aria-hidden="true"
          />
          <h2 className="text-base font-semibold text-foreground">
            Session Details
          </h2>
        </div>
      </CardSection>
      <CardContent>
        <dl className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div className="flex flex-col gap-1">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Started
              </dt>
              <dd className="text-foreground">{formatDateTime(startedAt)}</dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Ended
              </dt>
              <dd className="text-foreground">{formatDateTime(endedAt)}</dd>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div className="flex flex-col gap-1">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Total
              </dt>
              <dd
                className="text-foreground"
                data-attendance-final-roster-count={rosterCount}
              >
                {rosterCount}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Present
              </dt>
              <dd
                className="text-foreground"
                data-attendance-final-present-count={presentCount}
              >
                {presentCount}
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Absent
              </dt>
              <dd
                className="text-foreground"
                data-attendance-final-absent-count={absentCount}
              >
                {absentCount}
              </dd>
            </div>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

export default async function AttendanceHistoryDetailPage({
  params,
}: {
  params: Promise<{ classId: string; sessionId: string }>;
}) {
  const { classId, sessionId } = await params;

  // ---- 1. Authentication ----
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  // ---- 2. Profile gating ----
  const profile = await getProfileByUserId(session.user.id);
  if (!profile || !profile.onboardingCompleted) {
    redirect("/onboarding");
  }

  // ---- 3. Read canonical class detail ----
  const classResult = await getClassDetailForCurrentUser(classId);
  if (!classResult.ok) {
    if (
      classResult.code === CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE
    ) {
      notFound();
    }
    notFound();
  }

  // ---- 4. Teacher-only gate ----
  if (classResult.result.role !== "teacher") {
    notFound();
  }

  // ---- 5. Load final summary (includes session authorization) ----
  const summaryResult = await getAttendanceFinalSummaryForCurrentTeacher(
    classId,
    sessionId,
  );

  if (!summaryResult.ok) {
    // Map the error to appropriate UI.
    // - ATTENDANCE_SESSION_NOT_FOUND: session doesn't exist, wrong class,
    //   or non-owner — render notFound.
    // - ATTENDANCE_SESSION_NOT_CLOSED: session is still active — render notFound.
    // - Other errors: render error state.
    if (
      summaryResult.code ===
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SESSION_NOT_FOUND ||
      summaryResult.code ===
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SESSION_NOT_CLOSED ||
      summaryResult.code ===
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.CLASS_NOT_ACCESSIBLE
    ) {
      notFound();
    }

    // Generic failure — render error state.
    return (
      <PageContainer size="default">
        <PageHeader
          title="Attendance Session"
          description={`Session detail for ${classResult.result.class.name}`}
          as="h1"
        />

        <div
          role="alert"
          className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface px-5 py-5"
          data-attendance-session-error="true"
        >
          <p className="text-sm font-medium text-foreground">
            Could not load attendance session
          </p>
          <p className="text-sm leading-[21px] text-muted-foreground">
            Please try again in a moment.
          </p>
        </div>
      </PageContainer>
    );
  }

  const { session: sessionData, presentCount, absentCount } =
    summaryResult.result;
  const rosterCount = sessionData.rosterCount;

  return (
    <PageContainer size="default">
      <PageHeader
        title="Attendance Session"
        description={`Session detail for ${classResult.result.class.name}`}
        as="h1"
      />

      <div className="flex flex-col gap-5">
        <SessionMetadataCard
          startedAt={sessionData.startedAt}
          endedAt={sessionData.endedAt}
          presentCount={presentCount}
          absentCount={absentCount}
          rosterCount={rosterCount}
        />

        <Card>
          <CardSection>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CheckCircle
                  className="h-4 w-4 text-muted-foreground"
                  aria-hidden="true"
                />
                <h2 className="text-base font-semibold text-foreground">
                  Attendance Record
                </h2>
              </div>
              <ExportCsvButton
                classId={classId}
                sessionId={sessionId}
              />
            </div>
          </CardSection>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              Export the final attendance record as a CSV file for use
              in spreadsheet applications.
            </p>
          </CardContent>
        </Card>

        <AttendanceFinalSummaryPanel summary={summaryResult.result} />

        <div className="flex justify-start">
          <Link
            href={`/classes/${classId}/attendance/history`}
            className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-sm"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span>Back to attendance history</span>
          </Link>
        </div>
      </div>
    </PageContainer>
  );
}
