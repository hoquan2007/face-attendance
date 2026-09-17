/**
 * `/classes/[classId]/attendance` — live face recognition +
 * persisted present state (active) OR final attendance summary (closed).
 *
 * PHASE 6.4 — IDEMPOTENT PRESENT ATTENDANCE MARKS + LIVE PRESENT STATE.
 * PHASE 6.6 — ATTENDANCE SESSION FINALIZATION (adds closed-session final summary).
 *
 * Server Component shell. Teacher-only.
 *
 * Entry guard chain:
 *   - no session        → redirect /login
 *   - profile incomplete → redirect /onboarding
 *   - CLASS_NOT_ACCESSIBLE / malformed classId → notFound()
 *   - student viewer    → notFound() (teachers only)
 *   - no session / NONE state → redirect to /classes/[classId]
 *   - ACTIVE session → render live camera + persisted present state
 *   - CLOSED session → render final attendance summary
 *
 * This page does NOT:
 *   - Create attendance marks directly (the recognize route does)
 *   - Store camera images (transient only)
 *   - Modify AttendanceSession roster snapshot
 *   - Expose studentUserId, candidateKey, embedding, centroid,
 *     FaceProfile id, membershipId, teacherUserId, or biometric
 *     data to the browser
 *   - Allow manual attendance editing
 *   - Implement late marks
 *   - Implement Excel export
 */

import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import {
  getClassDetailForCurrentUser,
  CLASS_DETAIL_READ_ERROR_CODES,
} from "@/lib/classes/class-read-service";
import {
  getAttendanceSessionStatusForCurrentTeacher,
} from "@/lib/attendance/attendance-session-status-read-service";
import {
  getAttendancePresentStateForCurrentTeacher,
} from "@/lib/attendance/attendance-present-state-read-service";
import {
  getAttendanceFinalSummaryForCurrentTeacher,
} from "@/lib/attendance/attendance-final-summary-read-service";
import { AttendanceCameraClient } from "@/components/classes/attendance-camera-client";
import { AttendancePresentStatePanel } from "@/components/classes/attendance-present-state-panel";
import { AttendanceFinalSummaryPanel } from "@/components/classes/attendance-final-summary-panel";
import { PageContainer } from "@/components/layout/PageContainer";
import { PageHeader } from "@/components/layout/PageHeader";

export const metadata = {
  title: "Attendance — Face Recognition",
};

/**
 * Server Component that renders the attendance page.
 *
 * Authorization: teacher.
 *
 * Behavior:
 *   - ACTIVE session → live camera + persisted present state
 *   - CLOSED session → final attendance summary
 *   - NONE state → redirect to /classes/[classId]
 */
export default async function AttendanceLivePage({
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

  // ---- 5. Attendance session status ----
  const attendanceResult =
    await getAttendanceSessionStatusForCurrentTeacher(classId);
  if (!attendanceResult.ok) {
    redirect(`/classes/${classId}`);
  }

  // ---- 6. Route based on session state ----
  if (attendanceResult.result.state === "none" || !attendanceResult.result.session) {
    // No session ever existed — redirect to class detail.
    redirect(`/classes/${classId}`);
  }

  if (attendanceResult.result.state === "closed") {
    // PHASE 6.6: CLOSED session → render final attendance summary.
    const sessionId = attendanceResult.result.session.id;
    const finalResult = await getAttendanceFinalSummaryForCurrentTeacher(
      classId,
      sessionId,
    );

    const summary = finalResult.ok
      ? finalResult.result
      : null;

    return (
      <PageContainer size="default">
        <PageHeader
          title="Attendance Summary"
          description={`Final attendance for ${classResult.result.class.name}`}
          as="h1"
        />

        <AttendanceFinalSummaryPanel summary={summary} />
      </PageContainer>
    );
  }

  // ACTIVE session — render live camera + present state
  // ---- 7. Read the persisted present state for the active session ----
  const presentStateResult =
    await getAttendancePresentStateForCurrentTeacher(classId);

  const presentState = presentStateResult.ok
    ? presentStateResult.result
    : {
        sessionId: attendanceResult.result.session.id,
        rosterCount: attendanceResult.result.session.rosterCount,
        presentCount: 0,
        students: [],
      };

  // ---- 8. Render camera page + persisted present panel ----
  return (
    <PageContainer size="default">
      <PageHeader
        title="Live Attendance"
        description={`Face recognition for ${classResult.result.class.name}`}
        as="h1"
      />

      <AttendancePresentStatePanel
        sessionId={presentState.sessionId}
        rosterCount={presentState.rosterCount}
        presentCount={presentState.presentCount}
        students={presentState.students}
      />

      <AttendanceCameraClient
        classId={classId}
        sessionId={attendanceResult.result.session.id}
        rosterCount={attendanceResult.result.session.rosterCount}
      />
    </PageContainer>
  );
}
