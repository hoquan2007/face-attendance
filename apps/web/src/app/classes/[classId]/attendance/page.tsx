/**
 * `/classes/[classId]/attendance` — live face recognition preview.
 *
 * PHASE 6.3 — LIVE FACE RECOGNITION PREVIEW.
 *
 * Server Component shell. Teacher-only. Requires an ACTIVE attendance session.
 * If no active session exists: redirects safely back to `/classes/[classId]`.
 *
 * Entry guard chain:
 *   - no session        → redirect /login
 *   - profile incomplete → redirect /onboarding
 *   - CLASS_NOT_ACCESSIBLE / malformed classId → notFound()
 *   - student viewer    → notFound() (teachers only)
 *   - no active session → redirect to /classes/[classId]
 *
 * This page does NOT:
 *   - Create attendance marks (preview only)
 *   - Store camera images (transient only)
 *   - Modify AttendanceSession roster snapshot
 *   - Expose studentUserId, candidateKey, embedding, centroid, FaceProfile
 *     id, membershipId, or biometric data to the browser
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
import { AttendanceCameraClient } from "@/components/classes/attendance-camera-client";
import { PageContainer } from "@/components/layout/PageContainer";
import { PageHeader } from "@/components/layout/PageHeader";

export const metadata = {
  title: "Live Attendance — Face Recognition",
};

/**
 * Server Component that renders the live attendance camera page.
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

  // ---- 7. Render camera page ----
  return (
    <PageContainer size="default">
      <PageHeader
        title="Live Attendance"
        description={`Face recognition for ${classResult.result.class.name}`}
        as="h1"
      />

      <AttendanceCameraClient
        classId={classId}
        sessionId={attendanceResult.result.session.id}
        rosterCount={attendanceResult.result.session.rosterCount}
      />
    </PageContainer>
  );
}
