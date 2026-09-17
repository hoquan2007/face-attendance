/**
 * Server-only authenticated Teacher Attendance History read model.
 *
 * PHASE 6.7 — ATTENDANCE HISTORY.
 *
 * Encapsulates the server-side read boundary that returns a list
 * of CLOSED AttendanceSessions for a class owned by the currently
 * authenticated teacher.
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
 *   - This module is READ-ONLY. It does NOT create / update /
 *     delete an `AttendanceMark`, an `AttendanceSession`, a
 *     `Class`, a `ClassMembership`, or a `Profile`. It does NOT
 *     call the Face Service.
 *   - Only CLOSED sessions are returned. Active session is
 *     explicitly excluded from history results.
 *   - N+1 queries are avoided: a single batch query fetches all
 *     marks for all session IDs and aggregates server-side.
 *
 * ## Authorization
 *
 *   - Teacher path → `ClassModel.findOne({ _id: classId,
 *     teacherUserId: session.user.id })`. The database itself
 *     refuses to surface a class the teacher does not own.
 *   - Student path → `TEACHER_REQUIRED` BEFORE any
 *     AttendanceSession query.
 *   - Malformed `classId` → `CLASS_NOT_ACCESSIBLE`.
 *
 * ## History content
 *
 *   - Returns ONLY CLOSED sessions for the class.
 *   - Active session is NOT included in historical results.
 *   - Sessions are sorted newest first (endedAt DESC).
 *   - Each entry contains: id, startedAt, endedAt, rosterCount,
 *     presentCount, absentCount.
 *   - NO rosterSnapshot, NO student IDs, NO startedByUserId.
 *
 * ## Counts aggregation
 *
 *   - `presentCount` and `absentCount` come from persisted
 *     AttendanceMarks for each closed session.
 *   - All marks for all session IDs are fetched in ONE batch
 *     query to avoid N+1.
 *   - Aggregation happens server-side in application memory.
 *
 * ## Privacy posture
 *
 *   - `studentUserId`, `AttendanceMark._id`, `startedByUserId`,
 *     `teacherUserId` are NEVER projected into the result.
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
 *   - Any unexpected DB / read failure → `ATTENDANCE_HISTORY_READ_FAILED`.
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
} from "@/lib/attendance/attendance-session-model";
import {
  AttendanceMarkModel,
} from "@/lib/attendance/attendance-mark-model";

// =============================================================================
// Stable error codes
// =============================================================================

export const ATTENDANCE_HISTORY_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
  TEACHER_REQUIRED: "TEACHER_REQUIRED",
  CLASS_NOT_ACCESSIBLE: "CLASS_NOT_ACCESSIBLE",
  ATTENDANCE_HISTORY_READ_FAILED: "ATTENDANCE_HISTORY_READ_FAILED",
} as const;

export type AttendanceHistoryErrorCode =
  (typeof ATTENDANCE_HISTORY_ERROR_CODES)[keyof typeof ATTENDANCE_HISTORY_ERROR_CODES];

const ERROR_MESSAGES: Readonly<
  Record<AttendanceHistoryErrorCode, string>
> = {
  UNAUTHENTICATED:
    "You must be signed in to view attendance history.",
  PROFILE_INCOMPLETE:
    "Complete your profile before viewing attendance history.",
  TEACHER_REQUIRED: "Only teachers can view attendance history.",
  CLASS_NOT_ACCESSIBLE: "This class is not available.",
  ATTENDANCE_HISTORY_READ_FAILED:
    "Could not load attendance history. Please try again.",
};

// =============================================================================
// Browser-safe DTO
// =============================================================================

/**
 * One entry in the attendance history list.
 *
 * Contains ONLY safe aggregate data:
 *
 *   - `id`                — session Mongo `_id` as string.
 *   - `startedAt`         — ISO 8601 string.
 *   - `endedAt`           — ISO 8601 string (closed sessions always have endedAt).
 *   - `rosterCount`       — total roster size from snapshot.
 *   - `presentCount`      — number of PRESENT marks.
 *   - `absentCount`       — number of ABSENT marks.
 *
 * NO rosterSnapshot, NO student IDs, NO startedByUserId,
 * NO teacherUserId.
 */
export interface SafeAttendanceHistorySessionDto {
  id: string;
  startedAt: string;
  endedAt: string;
  rosterCount: number;
  presentCount: number;
  absentCount: number;
}

/**
 * Browser-safe attendance history DTO.
 *
 *   - `sessions` — list of closed sessions, newest first.
 *
 * The function NEVER exposes internal IDs, Mongo internals,
 * `startedByUserId`, `teacherUserId`, biometric fields, or
 * raw server timestamps.
 */
export interface SafeAttendanceHistoryDto {
  sessions: SafeAttendanceHistorySessionDto[];
}

/**
 * Discriminated union mirroring the project-wide Server Action
 * convention.
 */
export type GetAttendanceHistoryResult =
  | { ok: true; result: SafeAttendanceHistoryDto }
  | {
      ok: false;
      code: AttendanceHistoryErrorCode;
      message: string;
    };

// =============================================================================
// Internal helpers
// =============================================================================

function buildError(
  code: AttendanceHistoryErrorCode,
): Extract<GetAttendanceHistoryResult, { ok: false }> {
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
 * Loads ALL CLOSED AttendanceSessions for a given class, sorted
 * newest first (endedAt DESC).
 *
 * Active session is explicitly excluded.
 */
async function listClosedSessionsForClass(
  classId: Types.ObjectId,
): Promise<
  Array<{
    _id: Types.ObjectId;
    startedAt: Date;
    endedAt: Date;
    rosterSnapshot: Array<{
      studentUserId: string;
      fullNameSnapshot: string;
      identificationCodeSnapshot: string;
    }>;
  }>
> {
  const docs = await AttendanceSessionModel.find({
    classId,
    status: "closed",
  })
    .select({ _id: 1, startedAt: 1, endedAt: 1, rosterSnapshot: 1 })
    .sort({ endedAt: -1 })
    .lean<
      Array<{
        _id: Types.ObjectId;
        startedAt: Date;
        endedAt: Date;
        rosterSnapshot: Array<{
          studentUserId: string;
          fullNameSnapshot: string;
          identificationCodeSnapshot: string;
        }>;
      }>
    >()
    .exec();
  return docs;
}

/**
 * Batch-loads ALL attendance marks for the supplied session IDs
 * in a SINGLE query, then aggregates presentCount/absentCount
 * per session server-side.
 *
 * This avoids N+1 queries (one query per session for marks).
 *
 * Returns a Map: sessionId (string) → { presentCount, absentCount }
 */
async function aggregateMarkCountsForSessions(
  sessionIds: Types.ObjectId[],
): Promise<
  Map<
    string,
    { presentCount: number; absentCount: number }
  >
> {
  if (sessionIds.length === 0) {
    return new Map();
  }

  // Single batch query for all marks across all sessions.
  const marks = await AttendanceMarkModel.find({
    sessionId: { $in: sessionIds },
  })
    .select({ sessionId: 1, status: 1 })
    .lean<
      Array<{
        sessionId: Types.ObjectId;
        status: string;
      }>
    >()
    .exec();

  // Aggregate server-side.
  const countsMap = new Map<
    string,
    { presentCount: number; absentCount: number }
  >();

  // Initialize all sessions with zero counts.
  for (const sid of sessionIds) {
    const key = sid.toString();
    countsMap.set(key, { presentCount: 0, absentCount: 0 });
  }

  // Tally marks.
  for (const mark of marks) {
    const key = mark.sessionId.toString();
    const counts = countsMap.get(key);
    if (!counts) continue; // Should not happen.
    if (mark.status === "present") {
      counts.presentCount++;
    } else if (mark.status === "absent") {
      counts.absentCount++;
    }
  }

  return countsMap;
}

// =============================================================================
// Public function
// =============================================================================

/**
 * Returns the attendance history (list of CLOSED sessions) for the
 * specified class when the authenticated user is the teacher who
 * owns the class.
 *
 * The function accepts ONLY `classId` (resource identifier). It
 * does NOT accept `userId`, `teacherUserId`, `role`, or any other
 * identity parameter — those are all derived exclusively from the
 * Better Auth server session and the persisted Profile.
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
 *   6. Load ALL CLOSED sessions for the class, sorted
 *      `endedAt DESC` (newest first). Active session is excluded.
 *   7. Batch-load ALL marks for all session IDs in ONE query.
 *   8. Aggregate presentCount/absentCount per session server-side.
 *   9. Compose the safe DTO with per-session counts.
 *
 * ## Privacy guarantees
 *
 *   - The success result NEVER contains `studentUserId`,
 *     `AttendanceMark._id`, `startedByUserId`, `teacherUserId`,
 *     `rosterSnapshot`, biometric fields, `passwordHash`,
 *     `emailSnapshot`, or any raw server timestamps.
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
export async function getAttendanceHistoryForCurrentTeacher(
  classId: string,
): Promise<GetAttendanceHistoryResult> {
  // 1. Authentication
  const session = await getSession();
  if (!session) {
    return buildError(
      ATTENDANCE_HISTORY_ERROR_CODES.UNAUTHENTICATED,
    );
  }
  const userId = session.user.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return buildError(
      ATTENDANCE_HISTORY_ERROR_CODES.UNAUTHENTICATED,
    );
  }

  // 2. Profile gating
  let profile;
  try {
    profile = await getProfileByUserId(userId);
  } catch {
    return buildError(
      ATTENDANCE_HISTORY_ERROR_CODES.ATTENDANCE_HISTORY_READ_FAILED,
    );
  }
  if (!profile || !profile.onboardingCompleted) {
    return buildError(
      ATTENDANCE_HISTORY_ERROR_CODES.PROFILE_INCOMPLETE,
    );
  }

  // 3. Role gating — TEACHER-ONLY boundary.
  const role = profile.role;
  if (role !== "teacher" && role !== "student") {
    return buildError(
      ATTENDANCE_HISTORY_ERROR_CODES.ATTENDANCE_HISTORY_READ_FAILED,
    );
  }
  if (role !== "teacher") {
    return buildError(
      ATTENDANCE_HISTORY_ERROR_CODES.TEACHER_REQUIRED,
    );
  }

  // 4. classId syntax validation
  if (!isSyntacticallyValidObjectId(classId)) {
    return buildError(
      ATTENDANCE_HISTORY_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
    );
  }

  // 5. Authorization-encoded class lookup
  let classDoc: ClassAttrs | null;
  try {
    classDoc = await findOwnedClassForTeacher(classId, userId);
  } catch {
    return buildError(
      ATTENDANCE_HISTORY_ERROR_CODES.ATTENDANCE_HISTORY_READ_FAILED,
    );
  }
  if (!classDoc) {
    return buildError(
      ATTENDANCE_HISTORY_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
    );
  }

  // 6. Load all CLOSED sessions for the class, sorted newest first.
  let closedSessions: ReturnType<typeof listClosedSessionsForClass> extends Promise<infer T> ? T : never;
  try {
    closedSessions = await listClosedSessionsForClass(
      new Types.ObjectId(classId),
    );
  } catch {
    return buildError(
      ATTENDANCE_HISTORY_ERROR_CODES.ATTENDANCE_HISTORY_READ_FAILED,
    );
  }

  // 7 & 8. Batch-load marks and aggregate counts.
  const sessionIds = closedSessions.map((s) => s._id);
  let markCounts: Map<string, { presentCount: number; absentCount: number }>;
  try {
    markCounts = await aggregateMarkCountsForSessions(sessionIds);
  } catch {
    return buildError(
      ATTENDANCE_HISTORY_ERROR_CODES.ATTENDANCE_HISTORY_READ_FAILED,
    );
  }

  // 9. Compose safe DTO.
  const sessions: SafeAttendanceHistorySessionDto[] = closedSessions.map(
    (sessionDoc) => {
      const sessionIdStr = sessionDoc._id.toString();
      const counts = markCounts.get(sessionIdStr) ?? {
        presentCount: 0,
        absentCount: 0,
      };
      const rosterCount = Array.isArray(sessionDoc.rosterSnapshot)
        ? sessionDoc.rosterSnapshot.length
        : 0;

      return {
        id: sessionIdStr,
        startedAt:
          sessionDoc.startedAt instanceof Date
            ? sessionDoc.startedAt.toISOString()
            : new Date(sessionDoc.startedAt as unknown as string).toISOString(),
        endedAt:
          sessionDoc.endedAt instanceof Date
            ? sessionDoc.endedAt.toISOString()
            : new Date(sessionDoc.endedAt as unknown as string).toISOString(),
        rosterCount,
        presentCount: counts.presentCount,
        absentCount: counts.absentCount,
      };
    },
  );

  return {
    ok: true,
    result: {
      sessions,
    },
  };
}
