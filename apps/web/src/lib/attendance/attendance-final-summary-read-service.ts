/**
 * Server-only authenticated Teacher Final Attendance Summary read model.
 *
 * PHASE 6.6 — ATTENDANCE SESSION FINALIZATION.
 *
 * Encapsulates the server-side read boundary that returns the
 * immutable final attendance summary (present + absent) for a
 * CLOSED AttendanceSession to the currently authenticated teacher.
 *
 * This module is **NOT** a Server Action. It is a server-only
 * read primitive intentionally written as a plain `async`
 * function so a Server Component can `import` and `await` it
 * directly. It is **NOT** exposed as a REST route.
 *
 * ## Architectural invariants
 *
 *   - `import "server-only"` is the very first import.
 *   - The function accepts ONLY `classId` and `sessionId`. Identity
 *     comes exclusively from the Better Auth server session and the
 *     persisted Profile.
 *   - This module is READ-ONLY. It does NOT create / update /
 *     delete an `AttendanceMark`, an `AttendanceSession`, a
 *     `Class`, a `ClassMembership`, or a `Profile`. It does NOT
 *     call the Face Service.
 *   - The read boundary requires the session to be CLOSED. An
 *     active session returns an error — the teacher must finalize
 *     first by stopping the session.
 *
 * ## Authorization
 *
 *   - Teacher path → `ClassModel.findOne({ _id: classId,
 *     teacherUserId: session.user.id })`. The database itself
 *     refuses to surface a class the teacher does not own.
 *   - Student path → `TEACHER_REQUIRED` BEFORE any
 *     AttendanceSession / AttendanceMark query is performed.
 *   - Malformed `classId` / `sessionId` → `CLASS_NOT_ACCESSIBLE`
 *     (indistinguishable from "missing class" / "wrong teacher").
 *   - Session not found / not closed → `ATTENDANCE_SESSION_NOT_FOUND`
 *     or `ATTENDANCE_SESSION_NOT_CLOSED`.
 *
 * ## Snapshot authority
 *
 *   - Display identity (fullName, identificationCode) ALWAYS
 *     comes from the AttendanceSession's immutable `rosterSnapshot`.
 *     The function NEVER queries current `Profile.fullName` /
 *     `Profile.identificationCode` for display.
 *   - Historical snapshot values are authoritative even if the
 *     Profile has been updated since the session.
 *
 * ## Ordering
 *
 *   - Results are sorted deterministically by the rosterSnapshot
 *     order (which is stable, set at session start time).
 *   - The ordering is NOT derived from MongoDB query order.
 *
 * ## Privacy posture
 *
 *   - `studentUserId`, `AttendanceMark._id`, `classId`,
 *     `sessionId`, `status`, `source`, and Mongo internals are
 *     NEVER projected into the success result.
 *   - The function NEVER reads `passwordHash`, `embedding`,
 *     `centroid`, `FaceProfile`, `rosterSnapshot`,
 *     `startedByUserId`, or `teacherUserId` into the projection.
 *   - The error result NEVER contains raw stack traces, raw HTTP
 *     bodies, service URLs, `CastError`, or the Mongo
 *     connection string.
 *
 * ## Failure-mode invariants
 *
 *   - No Better Auth session     → `UNAUTHENTICATED`.
 *   - Missing / incomplete Profile → `PROFILE_INCOMPLETE`.
 *   - Student role               → `TEACHER_REQUIRED`.
 *   - Malformed classId / wrong teacher / missing class →
 *     `CLASS_NOT_ACCESSIBLE`.
 *   - Session not found          → `ATTENDANCE_SESSION_NOT_FOUND`.
 *   - Session still active        → `ATTENDANCE_SESSION_NOT_CLOSED`.
 *   - Any unexpected DB / read failure → `ATTENDANCE_SUMMARY_READ_FAILED`.
 */

import "server-only";

import { Types } from "mongoose";

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import {
  ClassModel,
  type ClassAttrs,
} from "@/lib/classes/class-model";
import {
  AttendanceSessionModel,
  type AttendanceRosterSnapshotItemDoc,
} from "@/lib/attendance/attendance-session-model";
import {
  listAllAttendanceMarksForSession,
} from "@/lib/attendance/attendance-mark-service";

// =============================================================================
// Stable error codes
// =============================================================================

export const ATTENDANCE_FINAL_SUMMARY_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
  TEACHER_REQUIRED: "TEACHER_REQUIRED",
  CLASS_NOT_ACCESSIBLE: "CLASS_NOT_ACCESSIBLE",
  ATTENDANCE_SESSION_NOT_FOUND: "ATTENDANCE_SESSION_NOT_FOUND",
  ATTENDANCE_SESSION_NOT_CLOSED: "ATTENDANCE_SESSION_NOT_CLOSED",
  ATTENDANCE_SUMMARY_READ_FAILED: "ATTENDANCE_SUMMARY_READ_FAILED",
} as const;

export type AttendanceFinalSummaryErrorCode =
  (typeof ATTENDANCE_FINAL_SUMMARY_ERROR_CODES)[keyof typeof ATTENDANCE_FINAL_SUMMARY_ERROR_CODES];

const ERROR_MESSAGES: Readonly<
  Record<AttendanceFinalSummaryErrorCode, string>
> = {
  UNAUTHENTICATED:
    "You must be signed in to view attendance.",
  PROFILE_INCOMPLETE:
    "Complete your profile before viewing attendance.",
  TEACHER_REQUIRED: "Only teachers can view final attendance.",
  CLASS_NOT_ACCESSIBLE: "This class is not available.",
  ATTENDANCE_SESSION_NOT_FOUND:
    "Attendance session not found.",
  ATTENDANCE_SESSION_NOT_CLOSED:
    "Attendance session is still active. Stop it first.",
  ATTENDANCE_SUMMARY_READ_FAILED:
    "Could not load attendance summary. Please try again.",
};

// =============================================================================
// Browser-safe DTO
// =============================================================================

/**
 * One row of the final attendance summary.
 *
 * The row carries ONLY safe display data:
 *
 *   - `fullName`           — historical snapshot value.
 *   - `identificationCode` — historical snapshot value.
 *   - `status`            — "present" | "absent".
 *   - `recognizedAt`      — ISO 8601 string. For present marks:
 *                            server wall clock of the FIRST accepted
 *                            recognition. For absent marks: server
 *                            wall clock of the finalization call.
 *                            May be `null` in defensive edge cases.
 *
 * `studentUserId`, `AttendanceMark._id`, Mongo internals,
 * `classId`, `sessionId`, `source` are NEVER projected.
 */
export interface SafeAttendanceFinalStudentDto {
  fullName: string;
  identificationCode: string;
  status: "present" | "absent";
  recognizedAt: string | null;
}

/**
 * Browser-safe final attendance summary DTO.
 *
 *   - `session`    — immutable session metadata.
 *   - `presentCount`  — number of PRESENT marks.
 *   - `absentCount`   — number of ABSENT marks.
 *   - `rosterCount`   — total roster size (presentCount + absentCount).
 *   - `students`      — ordered list of all roster students with their
 *                        final attendance status.
 *
 * The function NEVER exposes internal IDs, Mongo internals,
 * `startedByUserId`, `teacherUserId`, biometric fields, or
 * raw server timestamps.
 */
export interface SafeAttendanceFinalSummaryDto {
  session: {
    id: string;
    startedAt: string;
    endedAt: string | null;
    rosterCount: number;
  };
  presentCount: number;
  absentCount: number;
  students: SafeAttendanceFinalStudentDto[];
}

/**
 * Discriminated union mirroring the project-wide Server Action
 * convention.
 */
export type GetAttendanceFinalSummaryResult =
  | { ok: true; result: SafeAttendanceFinalSummaryDto }
  | {
      ok: false;
      code: AttendanceFinalSummaryErrorCode;
      message: string;
    };

// =============================================================================
// Internal helpers
// =============================================================================

function buildError(
  code: AttendanceFinalSummaryErrorCode,
): Extract<GetAttendanceFinalSummaryResult, { ok: false }> {
  return { ok: false, code, message: ERROR_MESSAGES[code] };
}

function isSyntacticallyValidObjectId(id: string): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  if (id.length !== 24) return false;
  return /^[0-9a-fA-F]{24}$/.test(id);
}

async function findOwnedClassForTeacher(
  classId: string,
  teacherUserId: string,
): Promise<ClassAttrs | null> {
  const doc = await ClassModel.findOne({
    _id: classId,
    teacherUserId,
  })
    .select({ _id: 1, teacherUserId: 1 })
    .lean<ClassAttrs | null>()
    .exec();
  return doc ?? null;
}

/**
 * Loads the CLOSED AttendanceSession by its `_id` + `classId`.
 * Returns `null` when not found or still active.
 */
async function findClosedSessionById(
  sessionId: Types.ObjectId,
  classId: Types.ObjectId,
): Promise<{
  _id: Types.ObjectId;
  classId: Types.ObjectId;
  status: string;
  startedAt: Date;
  endedAt: Date | null;
  rosterSnapshot: AttendanceRosterSnapshotItemDoc[];
} | null> {
  const doc = await AttendanceSessionModel.findOne({
    _id: sessionId,
    classId,
  })
    .select({ _id: 1, classId: 1, status: 1, startedAt: 1, endedAt: 1, rosterSnapshot: 1 })
    .lean<{
      _id: Types.ObjectId;
      classId: Types.ObjectId;
      status: string;
      startedAt: Date;
      endedAt: Date | null;
      rosterSnapshot: AttendanceRosterSnapshotItemDoc[];
    } | null>()
    .exec();
  if (!doc) return null;
  if (doc.status !== "closed") return null;
  return doc;
}

// =============================================================================
// Public function
// =============================================================================

/**
 * Returns the safe final attendance summary (present + absent) for the
 * specified CLOSED AttendanceSession when the authenticated user is
 * the teacher who owns the class.
 *
 * The function accepts `classId` (resource identifier) and `sessionId`
 * (specific session). It does NOT accept `userId`, `teacherUserId`,
 * `studentUserId`, `role`, or `membershipId` — those are all derived
 * exclusively from the Better Auth server session, the persisted
 * Profile, and the session document.
 *
 * ## Behavior
 *
 *   1. Authenticate via the Better Auth session. Missing session
 *      → `UNAUTHENTICATED`.
 *   2. Load the application `Profile`. Missing / incomplete →
 *      `PROFILE_INCOMPLETE`.
 *   3. Require `profile.role === "teacher"`. Student → `TEACHER_REQUIRED`.
 *   4. Validate `classId` syntax. Malformed → `CLASS_NOT_ACCESSIBLE`.
 *   5. Encode the teacher-owner constraint directly in the
 *      database query. Missing / non-owner → `CLASS_NOT_ACCESSIBLE`.
 *   6. Validate `sessionId` syntax. Malformed → `CLASS_NOT_ACCESSIBLE`.
 *   7. Look up the AttendanceSession. Not found → `ATTENDANCE_SESSION_NOT_FOUND`.
 *   8. Require the session to be CLOSED. Active → `ATTENDANCE_SESSION_NOT_CLOSED`.
 *   9. Load ALL attendance marks (present + absent) for the session.
 *  10. Map each mark's `studentUserId` through the session's
 *      immutable `rosterSnapshot` to obtain safe display identity.
 *      Students in the snapshot without any mark are skipped
 *      (should not happen after finalization, but defended safely).
 *  11. Sort results by rosterSnapshot order (deterministic).
 *  12. Compose the safe DTO.
 *
 * ## Privacy guarantees
 *
 *   - The success result NEVER contains `studentUserId`,
 *     `AttendanceMark._id`, `classId` (as a top-level key),
 *     `sessionId` (as an internal ObjectId), `status`,
 *     `source`, raw server timestamps, `passwordHash`,
 *     `emailSnapshot`, `phone`, `FaceProfile`, embeddings,
 *     centroids, biometric fields, or Better Auth user data.
 *   - The error result NEVER contains internal stack traces,
 *     raw HTTP bodies, service URLs, `CastError`, or the
 *     Mongo connection string.
 *
 * ## Read-only
 *
 * The function NEVER writes an `AttendanceMark`, an
 * `AttendanceSession`, a `Class`, a `ClassMembership`, or a
 * `Profile`. It NEVER calls the Face Service.
 */
export async function getAttendanceFinalSummaryForCurrentTeacher(
  classId: string,
  sessionId: string,
): Promise<GetAttendanceFinalSummaryResult> {
  // 1. Authentication
  const session = await getSession();
  if (!session) {
    return buildError(
      ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.UNAUTHENTICATED,
    );
  }
  const userId = session.user.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return buildError(
      ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.UNAUTHENTICATED,
    );
  }

  // 2. Profile gating
  let profile;
  try {
    profile = await getProfileByUserId(userId);
  } catch {
    return buildError(
      ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SUMMARY_READ_FAILED,
    );
  }
  if (!profile || !profile.onboardingCompleted) {
    return buildError(
      ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.PROFILE_INCOMPLETE,
    );
  }

  // 3. Role gating — TEACHER-ONLY boundary.
  const role = profile.role;
  if (role !== "teacher" && role !== "student") {
    return buildError(
      ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SUMMARY_READ_FAILED,
    );
  }
  if (role !== "teacher") {
    return buildError(
      ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.TEACHER_REQUIRED,
    );
  }

  // 4. classId syntax validation
  if (!isSyntacticallyValidObjectId(classId)) {
    return buildError(
      ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
    );
  }

  // 5. Authorization-encoded class lookup
  let classDoc: ClassAttrs | null;
  try {
    classDoc = await findOwnedClassForTeacher(classId, userId);
  } catch {
    return buildError(
      ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SUMMARY_READ_FAILED,
    );
  }
  if (!classDoc) {
    return buildError(
      ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
    );
  }

  // 6. sessionId syntax validation
  if (!isSyntacticallyValidObjectId(sessionId)) {
    return buildError(
      ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SESSION_NOT_FOUND,
    );
  }

  const classIdObjectId = new Types.ObjectId(classId);
  const sessionIdObjectId = new Types.ObjectId(sessionId);

  // 7. Load CLOSED session
  let sessionDoc: {
    _id: Types.ObjectId;
    classId: Types.ObjectId;
    status: string;
    startedAt: Date;
    endedAt: Date | null;
    rosterSnapshot: AttendanceRosterSnapshotItemDoc[];
  } | null;
  try {
    sessionDoc = await findClosedSessionById(
      sessionIdObjectId,
      classIdObjectId,
    );
  } catch {
    return buildError(
      ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SUMMARY_READ_FAILED,
    );
  }
  if (!sessionDoc) {
    // Try to determine whether it was not found or still active.
    try {
      const anySession = await AttendanceSessionModel.findOne({
        _id: sessionIdObjectId,
      })
        .select({ _id: 1, status: 1 })
        .lean<{ _id: Types.ObjectId; status: string } | null>()
        .exec();
      if (!anySession) {
        return buildError(
          ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SESSION_NOT_FOUND,
        );
      }
      return buildError(
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SESSION_NOT_CLOSED,
      );
    } catch {
      return buildError(
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SESSION_NOT_FOUND,
      );
    }
  }

  // 9. Load all marks for the session
  let marks: Array<{
    studentUserId: string;
    status: string;
    recognizedAt: string;
  }>;
  try {
    marks = await listAllAttendanceMarksForSession(sessionIdObjectId);
  } catch {
    return buildError(
      ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SUMMARY_READ_FAILED,
    );
  }

  // 8. (implicit in findClosedSessionById — session must be closed)

  // 10. Build roster map for display identity
  const rosterMap = new Map<string, AttendanceRosterSnapshotItemDoc>();
  const rosterSnapshot = Array.isArray(sessionDoc.rosterSnapshot)
    ? sessionDoc.rosterSnapshot
    : [];
  for (const item of rosterSnapshot) {
    if (
      item &&
      typeof item.studentUserId === "string" &&
      item.studentUserId.length > 0
    ) {
      rosterMap.set(item.studentUserId, item);
    }
  }

  // Build mark map for quick lookup
  const markMap = new Map<string, {
    status: string;
    recognizedAt: string;
  }>();
  for (const mark of marks) {
    markMap.set(mark.studentUserId, {
      status: mark.status,
      recognizedAt: mark.recognizedAt,
    });
  }

  // 11. Compose students in rosterSnapshot order
  const students: SafeAttendanceFinalStudentDto[] = [];
  let presentCount = 0;
  let absentCount = 0;

  for (const item of rosterSnapshot) {
    if (!item || typeof item.studentUserId !== "string") continue;
    const mark = markMap.get(item.studentUserId);
    if (!mark) {
      // No mark at all — skip defensively. Should not happen after
      // finalization, but handled safely.
      continue;
    }
    const isPresent = mark.status === "present";
    if (isPresent) presentCount++;
    else absentCount++;

    students.push({
      fullName: item.fullNameSnapshot,
      identificationCode: item.identificationCodeSnapshot,
      status: isPresent ? "present" : "absent",
      recognizedAt: mark.recognizedAt,
    });
  }

  // 12. Compose safe DTO
  const startedAtIso = sessionDoc.startedAt instanceof Date
    ? sessionDoc.startedAt.toISOString()
    : new Date(sessionDoc.startedAt as unknown as string).toISOString();
  const endedAtIso = sessionDoc.endedAt instanceof Date
    ? sessionDoc.endedAt.toISOString()
    : null;

  return {
    ok: true,
    result: {
      session: {
        id: String(sessionDoc._id),
        startedAt: startedAtIso,
        endedAt: endedAtIso,
        rosterCount: rosterSnapshot.length,
      },
      presentCount,
      absentCount,
      students,
    },
  };
}
