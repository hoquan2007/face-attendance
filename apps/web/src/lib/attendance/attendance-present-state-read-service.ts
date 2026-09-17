/**
 * Server-only authenticated Teacher Present-State read model.
 *
 * PHASE 6.4 — IDEMPOTENT PRESENT ATTENDANCE MARKS +
 * LIVE PRESENT STATE.
 *
 * Encapsulates the server-side read boundary that returns the
 * browser-safe PRESENT-attendance state for ONE class to the
 * currently authenticated teacher. The function is the
 * canonical, READ-ONLY entry point for the future Server
 * Component that renders the live persisted attendance list on
 * `/classes/[classId]/attendance`.
 *
 * This module is **NOT** a Server Action. It is a server-only
 * read primitive intentionally written as a plain `async`
 * function so a Server Component can `import` and `await` it
 * directly. It is **NOT** exposed as a REST route.
 *
 * ## Architectural invariants
 *
 *   - `import "server-only"` is the very first import.
 *   - The function accepts ONLY `classId`. Identity comes
 *     exclusively from the Better Auth server session and the
 *     persisted Profile.
 *   - The branch on teacher-vs-student visibility is decided
 *     inside this module from `profile.role`. The browser never
 *     supplies a userId, a teacher id, or a student id.
 *   - This module is READ-ONLY. It does NOT create / update /
 *     delete an `AttendanceMark`, an `AttendanceSession`, a
 *     `Class`, a `ClassMembership`, or a `Profile`. It does NOT
 *     call the Face Service.
 *
 * ## Authorization
 *
 *   - Teacher path → `ClassModel.findOne({ _id: classId,
 *     teacherUserId: session.user.id })`. The database itself
 *     refuses to surface a class the teacher does not own.
 *   - Student path → `TEACHER_REQUIRED` BEFORE any
 *     AttendanceMark / AttendanceSession query is performed. A
 *     student must not be able to probe whether attendance is
 *     running through this boundary.
 *   - Malformed `classId` → `CLASS_NOT_ACCESSIBLE`
 *     (indistinguishable from "missing class" / "wrong teacher").
 *
 * ## Snapshot authority
 *
 *   - Display identity (fullName, identificationCode) ALWAYS
 *     comes from the active AttendanceSession's immutable
 *     `rosterSnapshot`. The function NEVER queries current
 *     `Profile.fullName` / `Profile.identificationCode` for
 *     display — historical names / identification codes
 *     remain authoritative even if the Profile is renamed
 *     later.
 *   - A `studentUserId` that has a mark but is NOT in the
 *     current roster snapshot (orphaned / removed student) is
 *     skipped silently. It is NEVER surfaced to the browser
 *     because the snapshot is the authoritative identity gate.
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
 *     `CLASS_NOT_ACCESSIBLE` (one safe boundary).
 *   - No active session          → `ATTENDANCE_SESSION_NOT_ACTIVE`.
 *   - Any unexpected DB / read failure → `ATTENDANCE_PRESENT_READ_FAILED`.
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
  listPresentAttendanceMarksForSession,
} from "@/lib/attendance/attendance-mark-service";

// =============================================================================
// Stable error codes
// =============================================================================

export const ATTENDANCE_PRESENT_READ_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
  TEACHER_REQUIRED: "TEACHER_REQUIRED",
  CLASS_NOT_ACCESSIBLE: "CLASS_NOT_ACCESSIBLE",
  ATTENDANCE_SESSION_NOT_ACTIVE: "ATTENDANCE_SESSION_NOT_ACTIVE",
  ATTENDANCE_PRESENT_READ_FAILED: "ATTENDANCE_PRESENT_READ_FAILED",
} as const;

export type AttendancePresentReadErrorCode =
  (typeof ATTENDANCE_PRESENT_READ_ERROR_CODES)[keyof typeof ATTENDANCE_PRESENT_READ_ERROR_CODES];

const ERROR_MESSAGES: Readonly<
  Record<AttendancePresentReadErrorCode, string>
> = {
  UNAUTHENTICATED:
    "You must be signed in to view present attendance.",
  PROFILE_INCOMPLETE:
    "Complete your profile before viewing present attendance.",
  TEACHER_REQUIRED: "Only teachers can view present attendance.",
  CLASS_NOT_ACCESSIBLE: "This class is not available.",
  ATTENDANCE_SESSION_NOT_ACTIVE:
    "Attendance session is not currently active.",
  ATTENDANCE_PRESENT_READ_FAILED:
    "Could not load present attendance. Please try again.",
};

// =============================================================================
// Browser-safe DTO
// =============================================================================

/**
 * One row of the persisted present list.
 *
 * The row carries ONLY safe display data:
 *
 *   - `fullName`           — historical snapshot value.
 *   - `identificationCode` — historical snapshot value.
 *   - `recognizedAt`       — ISO 8601 string (server wall
 *                            clock of the FIRST accepted
 *                            recognition; preserved verbatim
 *                            on repeated recognition).
 *
 * `studentUserId`, `AttendanceMark._id`, Mongo internals,
 * `classId`, `sessionId`, `status`, `source` are NEVER
 * projected into the row.
 */
export interface SafeAttendancePresentStudentDto {
  fullName: string;
  identificationCode: string;
  recognizedAt: string;
}

/**
 * Browser-safe present-state DTO returned to the
 * `AttendanceLivePage` Server Component on
 * `/classes/[classId]/attendance`.
 *
 *   - `sessionId`     — canonical Mongo `_id.toString()`.
 *   - `rosterCount`   — length of the immutable
 *                       `AttendanceSession.rosterSnapshot`.
 *   - `presentCount`  — number of PRESENT marks for this
 *                       session.
 *   - `students`      — ordered list of present students (sorted
 *                       by `recognizedAt` ASC).
 *
 * The function NEVER exposes internal IDs, Mongo internals,
 * `startedByUserId`, `teacherUserId`, biometric fields, or
 * raw server timestamps.
 */
export interface SafeAttendancePresentStateDto {
  sessionId: string;
  rosterCount: number;
  presentCount: number;
  students: SafeAttendancePresentStudentDto[];
}

/**
 * Discriminated union mirroring the project-wide Server Action
 * convention.
 */
export type GetAttendancePresentStateResult =
  | { ok: true; result: SafeAttendancePresentStateDto }
  | {
      ok: false;
      code: AttendancePresentReadErrorCode;
      message: string;
    };

// =============================================================================
// Internal helpers
// =============================================================================

function buildError(
  code: AttendancePresentReadErrorCode,
): Extract<GetAttendancePresentStateResult, { ok: false }> {
  return { ok: false, code, message: ERROR_MESSAGES[code] };
}

function isSyntacticallyValidClassId(classId: string): boolean {
  if (typeof classId !== "string" || classId.length === 0) {
    return false;
  }
  if (classId.length !== 24) return false;
  return /^[0-9a-fA-F]{24}$/.test(classId);
}

async function findOwnedClassForTeacher(
  classId: string,
  teacherUserId: string,
): Promise<ClassAttrs | null> {
  const doc = await ClassModel.findOne({
    _id: classId,
    teacherUserId,
  })
    .select({
      _id: 1,
      teacherUserId: 1,
    })
    .lean<ClassAttrs | null>()
    .exec();
  return doc ?? null;
}

/**
 * Loads the ACTIVE AttendanceSession for `classId`. Returns
 * `null` when no session exists or the session is closed. The
 * `status: "active"` filter is encoded directly in the query so
 * the database itself refuses to surface a closed session on
 * this read.
 */
async function findActiveSessionByClassId(
  classId: Types.ObjectId,
): Promise<{
  _id: Types.ObjectId;
  rosterSnapshot: AttendanceRosterSnapshotItemDoc[];
} | null> {
  const doc = await AttendanceSessionModel.findOne({
    classId,
    status: "active",
  })
    .select({ _id: 1, rosterSnapshot: 1 })
    .lean<{
      _id: Types.ObjectId;
      rosterSnapshot: AttendanceRosterSnapshotItemDoc[];
    } | null>()
    .exec();
  return doc ?? null;
}

// =============================================================================
// Public function
// =============================================================================

/**
 * Returns the safe PRESENT-attendance state for the class
 * identified by `classId` when the currently authenticated user
 * is the teacher who owns the class.
 *
 * The function accepts ONLY `classId` (the resource identifier).
 * It does NOT accept `userId`, `teacherUserId`, `studentUserId`,
 * `role`, `sessionId`, or `membershipId` — those are all derived
 * exclusively from the Better Auth server session, the persisted
 * Profile, and the active AttendanceSession.
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
 *      database query: `ClassModel.findOne({ _id: classId,
 *      teacherUserId: session.user.id })`. Missing / non-owner →
 *      `CLASS_NOT_ACCESSIBLE`.
 *   6. Look up the ACTIVE AttendanceSession. None →
 *      `ATTENDANCE_SESSION_NOT_ACTIVE`. (This is a separate
 *      error code from `CLASS_NOT_ACCESSIBLE` so the UI can
 *      route the teacher back to /classes/[classId] without
 *      implying the class itself is inaccessible.)
 *   7. Load PRESENT marks for the session, sorted
 *      `recognizedAt` ASC.
 *   8. Map each mark's `studentUserId` through the session's
 *      immutable `rosterSnapshot` to obtain the safe display
 *      identity (`fullNameSnapshot`, `identificationCodeSnapshot`).
 *   9. Sort the result by `recognizedAt` ASC (the database
 *      already sorted at step 7).
 *  10. Compose the safe DTO with `{ sessionId, rosterCount,
 *      presentCount, students }`.
 *
 * ## Privacy guarantees
 *
 *   - The success result NEVER contains `studentUserId`,
 *     `AttendanceMark._id`, `classId` (as a top-level key in the
 *     DTO), `sessionId` (as an internal ObjectId), `status`,
 *     `source`, raw server timestamps, `passwordHash`,
 *     `emailSnapshot`, `phone`, `FaceProfile`, embeddings,
 *     centroids, biometric fields, or Better Auth user data.
 *   - The error result NEVER contains internal stack traces,
 *     raw HTTP bodies, service URLs, `CastError`, or the Mongo
 *     connection string.
 *
 * ## Read-only
 *
 * The function NEVER writes an `AttendanceMark`, an
 * `AttendanceSession`, a `Class`, a `ClassMembership`, or a
 * `Profile`. It NEVER calls the Face Service. It NEVER
 * recomputes the roster.
 */
export async function getAttendancePresentStateForCurrentTeacher(
  classId: string,
): Promise<GetAttendancePresentStateResult> {
  // 1. Authentication
  const session = await getSession();
  if (!session) {
    return buildError(
      ATTENDANCE_PRESENT_READ_ERROR_CODES.UNAUTHENTICATED,
    );
  }
  const userId = session.user.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return buildError(
      ATTENDANCE_PRESENT_READ_ERROR_CODES.UNAUTHENTICATED,
    );
  }

  // 2. Profile gating
  let profile;
  try {
    profile = await getProfileByUserId(userId);
  } catch {
    return buildError(
      ATTENDANCE_PRESENT_READ_ERROR_CODES.ATTENDANCE_PRESENT_READ_FAILED,
    );
  }
  if (!profile || !profile.onboardingCompleted) {
    return buildError(
      ATTENDANCE_PRESENT_READ_ERROR_CODES.PROFILE_INCOMPLETE,
    );
  }

  // 3. Role gating — TEACHER-ONLY boundary.
  const role = profile.role;
  if (role !== "teacher" && role !== "student") {
    return buildError(
      ATTENDANCE_PRESENT_READ_ERROR_CODES.ATTENDANCE_PRESENT_READ_FAILED,
    );
  }
  if (role !== "teacher") {
    return buildError(
      ATTENDANCE_PRESENT_READ_ERROR_CODES.TEACHER_REQUIRED,
    );
  }

  // 4. classId syntax validation
  if (!isSyntacticallyValidClassId(classId)) {
    return buildError(
      ATTENDANCE_PRESENT_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
    );
  }

  // 5. Authorization-encoded class lookup
  let classDoc: ClassAttrs | null;
  try {
    classDoc = await findOwnedClassForTeacher(classId, userId);
  } catch {
    return buildError(
      ATTENDANCE_PRESENT_READ_ERROR_CODES.ATTENDANCE_PRESENT_READ_FAILED,
    );
  }
  if (!classDoc) {
    return buildError(
      ATTENDANCE_PRESENT_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
    );
  }

  // 6. ACTIVE session lookup
  const classIdObjectId = new Types.ObjectId(classId);
  let sessionDoc: {
    _id: Types.ObjectId;
    rosterSnapshot: AttendanceRosterSnapshotItemDoc[];
  } | null;
  try {
    sessionDoc = await findActiveSessionByClassId(classIdObjectId);
  } catch {
    return buildError(
      ATTENDANCE_PRESENT_READ_ERROR_CODES.ATTENDANCE_PRESENT_READ_FAILED,
    );
  }
  if (!sessionDoc) {
    return buildError(
      ATTENDANCE_PRESENT_READ_ERROR_CODES.ATTENDANCE_SESSION_NOT_ACTIVE,
    );
  }

  // 7. Load PRESENT marks sorted recognizedAt ASC.
  let marks;
  try {
    marks = await listPresentAttendanceMarksForSession(sessionDoc._id);
  } catch {
    return buildError(
      ATTENDANCE_PRESENT_READ_ERROR_CODES.ATTENDANCE_PRESENT_READ_FAILED,
    );
  }

  // 8. Map each mark.studentUserId through rosterSnapshot.
  const rosterByUserId = new Map<string, AttendanceRosterSnapshotItemDoc>();
  const rosterSnapshot = Array.isArray(sessionDoc.rosterSnapshot)
    ? sessionDoc.rosterSnapshot
    : [];
  for (const item of rosterSnapshot) {
    if (
      item &&
      typeof item.studentUserId === "string" &&
      item.studentUserId.length > 0
    ) {
      rosterByUserId.set(item.studentUserId, item);
    }
  }

  const students: SafeAttendancePresentStudentDto[] = [];
  // Explicitly sort by `recognizedAt` ASC to make the result
  // deterministic regardless of the underlying cursor order.
  // This is the canonical order for the persisted present list.
  // Coerce `recognizedAt` to an ISO 8601 string on the way out
  // so the browser DTO always carries the same primitive type
  // regardless of the underlying driver / mock shape.
  const sortedMarks = [...marks]
    .map((m) => {
      const value = m.recognizedAt as unknown;
      let iso: string;
      if (value instanceof Date) {
        iso = value.toISOString();
      } else if (typeof value === "string") {
        iso = new Date(value).toISOString();
      } else {
        iso = new Date(value as number).toISOString();
      }
      return {
        studentUserId: m.studentUserId,
        recognizedAt: iso,
      };
    })
    .sort(
      (a, b) =>
        new Date(a.recognizedAt).getTime() -
        new Date(b.recognizedAt).getTime(),
    );
  for (const mark of sortedMarks) {
    const snapshotItem = rosterByUserId.get(mark.studentUserId);
    if (!snapshotItem) {
      // Orphaned / removed student — skip silently. We do NOT
      // surface the orphan studentUserId or any internal id.
      continue;
    }
    students.push({
      fullName: snapshotItem.fullNameSnapshot,
      identificationCode: snapshotItem.identificationCodeSnapshot,
      recognizedAt: mark.recognizedAt,
    });
  }

  // 9. Result is sorted ASC by `recognizedAt` (applied above).

  // 10. Compose the safe DTO.
  return {
    ok: true,
    result: {
      sessionId: String(sessionDoc._id),
      rosterCount: rosterSnapshot.length,
      presentCount: students.length,
      students,
    },
  };
}
