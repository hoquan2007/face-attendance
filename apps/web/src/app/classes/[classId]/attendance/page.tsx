/**
 * `/classes/[classId]/attendance` — live face recognition +
 * persisted present state.
 *
 * PHASE 6.4 — IDEMPOTENT PRESENT ATTENDANCE MARKS +
 * LIVE PRESENT STATE.
 *
 * Server Component shell. Teacher-only. Requires an ACTIVE
 * attendance session. If no active session exists: redirects
 * safely back to `/classes/[classId]`.
 *
 * PHASE 6.4 extends the PHASE 6.3 live preview shell so the
 * Server Component reads the persisted PRESENT state via the
 * server-only `getAttendancePresentStateForCurrentTeacher`
 * boundary. The Client Component is unchanged on the camera
 * side — it continues to drive `/api/attendance/recognize` and
 * triggers `router.refresh()` on a successful scan so the
 * Server Component re-fetches the persisted state.
 *
 * Entry guard chain:
 *   - no session        → redirect /login
 *   - profile incomplete → redirect /onboarding
 *   - CLASS_NOT_ACCESSIBLE / malformed classId → notFound()
 *   - student viewer    → notFound() (teachers only)
 *   - no active session → redirect to /classes/[classId]
 *
 * This page does NOT:
 *   - Create attendance marks directly (the recognize route does)
 *   - Store camera images (transient only)
 *   - Modify AttendanceSession roster snapshot
 *   - Expose studentUserId, candidateKey, embedding, centroid,
 *     FaceProfile id, membershipId, teacherUserId, or biometric
 *     data to the browser
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
import { getAttendancePresentStateForCurrentTeacher } from "@/lib/attendance/attendance-present-state-read-service";
import { AttendanceCameraClient } from "@/components/classes/attendance-camera-client";
import { AttendancePresentStatePanel } from "@/components/classes/attendance-present-state-panel";
import { PageContainer } from "@/components/layout/PageContainer";
import { PageHeader } from "@/components/layout/PageHeader";

export const metadata = {
  title: "Live Attendance — Face Recognition",
};

/**
 * Server Component that renders the live attendance camera page
 * with the persisted present state panel.
 *
 * Authorization: teacher with ACTIVE attendance session.
 * Redirects to /classes/[classId] if no active session exists.
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
    // CLASS_READ_FAILED → notFound() for safety.
    notFound();
  }

  // ---- 4. Teacher-only gate ----
  if (classResult.result.role !== "teacher") {
    // Students cannot access this page.
    notFound();
  }

  // ---- 5. Attendance session status ----
  const attendanceResult =
    await getAttendanceSessionStatusForCurrentTeacher(classId);
  if (!attendanceResult.ok) {
    // Attendance read failed — redirect back to class detail.
    redirect(`/classes/${classId}`);
  }

  // ---- 6. ACTIVE session required ----
  if (attendanceResult.result.state !== "active" || !attendanceResult.result.session) {
    // No active session — redirect back to class detail.
    redirect(`/classes/${classId}`);
  }

  // ---- 7. Read the persisted present state for the active session ----
  // The read boundary is the source of truth for the persisted
  // "recorded present" list. It NEVER falls back to the latest
  // camera response and NEVER queries current Profiles for
  // display identity.
  const presentStateResult =
    await getAttendancePresentStateForCurrentTeacher(classId);

  // The read is expected to succeed because we just verified
  // an active session exists. On any failure we render an
  // empty present panel — the camera UI remains usable.
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
