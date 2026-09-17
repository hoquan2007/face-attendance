/**
 * `/classes/[classId]/attendance/history` — attendance history list.
 *
 * PHASE 6.7 — ATTENDANCE HISTORY.
 *
 * Server Component. Teacher-only.
 *
 * Entry guard chain:
 *   - no session        → redirect /login
 *   - profile incomplete → redirect /onboarding
 *   - CLASS_NOT_ACCESSIBLE / malformed classId → notFound()
 *   - student viewer   → notFound() (teachers only)
 *   - history load failed → render error state
 *   - success → render history list
 *
 * This page does NOT:
 *   - Accept userId, teacherUserId, or role from browser
 *   - Expose studentUserId, startedByUserId, teacherUserId,
 *     AttendanceMark._id, biometric data to the browser
 *   - Modify any attendance data
 *   - Call the Face Service
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { History, ChevronRight } from "lucide-react";

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import {
  getClassDetailForCurrentUser,
  CLASS_DETAIL_READ_ERROR_CODES,
} from "@/lib/classes/class-read-service";
import { getAttendanceHistoryForCurrentTeacher } from "@/lib/attendance/attendance-history-read-service";
import { PageContainer } from "@/components/layout/PageContainer";
import { PageHeader } from "@/components/layout/PageHeader";
import {
  Card,
  CardContent,
  CardSection,
} from "@/components/ui/card";
import { StatusBadge } from "@/components/layout/StatusBadge";

export const metadata = {
  title: "Attendance History",
};

/**
 * Locale-stable date formatter for history entries.
 */
function formatDate(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

/**
 * Locale-stable time formatter for history entries.
 */
function formatTime(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleTimeString("en-US", {
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
 * Empty state when no completed sessions exist.
 */
function EmptyHistoryState() {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface px-5 py-6"
      data-attendance-history-empty="true"
    >
      <p className="text-sm font-medium text-foreground">
        No completed attendance sessions yet.
      </p>
      <p className="text-sm text-muted-foreground">
        Completed sessions will appear here after you stop an
        attendance session.
      </p>
    </div>
  );
}

/**
 * Error state when history load fails.
 */
function HistoryReadFailureState() {
  return (
    <div
      role="alert"
      className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface px-5 py-5"
      data-attendance-history-error="true"
    >
      <p className="text-sm font-medium text-foreground">
        Could not load attendance history
      </p>
      <p className="text-sm leading-[21px] text-muted-foreground">
        Please try again in a moment.
      </p>
    </div>
  );
}

/**
 * One history entry row.
 */
function HistoryEntryRow({
  session,
  classId,
}: {
  session: {
    id: string;
    startedAt: string;
    endedAt: string;
    rosterCount: number;
    presentCount: number;
    absentCount: number;
  };
  classId: string;
}) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2 text-sm font-medium text-foreground">
          <span>{formatDate(session.startedAt)}</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>
            {formatTime(session.startedAt)} —{" "}
            {formatTime(session.endedAt)}
          </span>
          <span className="text-border-strong">|</span>
          <span>
            Total: {session.rosterCount}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <StatusBadge tone="present" label="Present" />
          <span className="text-sm font-medium text-foreground">
            {session.presentCount}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge tone="absent" label="Absent" />
          <span className="text-sm font-medium text-foreground">
            {session.absentCount}
          </span>
        </div>
      </div>

      <Link
        href={`/classes/${classId}/attendance/history/${session.id}`}
        className="flex items-center gap-1 text-sm font-medium text-primary transition-colors hover:text-primary/80 focus-visible:text-primary/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-sm"
        data-attendance-history-view-link={session.id}
      >
        <span>View session</span>
        <ChevronRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </li>
  );
}

export default async function AttendanceHistoryPage({
  params,
}: {
  params: Promise<{ classId: string }>;
}) {
  const { classId } = await params;

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

  // ---- 5. Load attendance history ----
  const historyResult = await getAttendanceHistoryForCurrentTeacher(classId);

  if (!historyResult.ok) {
    return (
      <PageContainer size="default">
        <PageHeader
          title="Attendance History"
          description={`History for ${classResult.result.class.name}`}
          as="h1"
        />

        <HistoryReadFailureState />
      </PageContainer>
    );
  }

  const { sessions } = historyResult.result;

  return (
    <PageContainer size="default">
      <PageHeader
        title="Attendance History"
        description={`Completed sessions for ${classResult.result.class.name}`}
        as="h1"
      />

      <Card data-component="attendance-history-panel">
        <CardSection>
          <div className="flex items-center gap-2">
            <History
              className="h-4 w-4 text-muted-foreground"
              aria-hidden="true"
            />
            <h2 className="text-base font-semibold text-foreground">
              Completed Sessions
            </h2>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Review past attendance records for this class.
          </p>
        </CardSection>
        <CardContent>
          {sessions.length === 0 ? (
            <EmptyHistoryState />
          ) : (
            <ul
              className="flex flex-col gap-2"
              data-attendance-history-list="true"
            >
              {sessions.map((session) => (
                <HistoryEntryRow
                  key={session.id}
                  session={session}
                  classId={classId}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
