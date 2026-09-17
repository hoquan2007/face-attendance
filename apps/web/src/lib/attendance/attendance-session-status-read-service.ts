/**
 * Server-only authenticated AttendanceSession status read model.
 *
 * PHASE 6.2 — TEACHER ATTENDANCE CONTROL UI.
 *
 * Encapsulates the server-side read boundary that returns the
 * browser-safe attendance lifecycle state for ONE class to the
 * currently authenticated teacher. The function is the canonical,
 * READ-ONLY entry point for the future Server Component that
 * renders the teacher-only Attendance section on
 * `/classes/[classId]`.
 *
 * This module is **NOT** a Server Action. It is a server-only
 * read primitive intentionally written as a plain `async` function
 * so a Server Component can `import` and `await` it directly. It
 * is **NOT** exposed as a REST route.
 *
 * ## Architectural invariants
 *
 *   - `import "server-only"` is the very first import. The Next.js
 *     bundler refuses to compile this module into a Client Component
 *     bundle, so a hand-crafted browser cannot smuggle it.
 *   - The function signature accepts ONLY `classId`. Identity
 *     (`session.user.id`) and role (`Profile.role`) come
 *     exclusively from the Better Auth server session and the
 *     persisted Profile.
 *   - The branch on teacher-vs-student visibility is decided
 *     inside this module from `profile.role`. The browser never
 *     supplies a role, a userId, a teacher id, or a student id.
 *   - This module is READ-ONLY. It does NOT create / update /
 *     delete an `AttendanceSession`, a `Class`, a `ClassMembership`,
 *     or a `Profile`. It does NOT call the Face Service. It does
 *     NOT touch `FaceProfile`.
 *
 * ## Session selection
 *
 *   1. If an ACTIVE session exists for `classId`, the active
 *      session is returned with `state = "active"`. ACTIVE always
 *      wins over CLOSED.
 *   2. Otherwise, the LATEST CLOSED session (by `startedAt`
 *      DESC) is returned with `state = "closed"`.
 *   3. Otherwise `state = "none"` and `session = null`.
 *
 * The selection is performed via TWO focused read primitives —
 * NO N+1, NO application-memory scan over the
 * `attendance_sessions` collection.
 *
 * ## Authorization
 *
 *   - Teacher path → `ClassModel.findOne({ _id: classId,
 *     teacherUserId: session.user.id })`. The database itself
 *     refuses to surface a class the teacher does not own.
 *   - Student path → `TEACHER_REQUIRED` BEFORE any
 *     `AttendanceSession` query is performed. A student must not
 *     be able to probe the existence of an attendance session
 *     through this boundary.
 *   - Malformed `classId` → `CLASS_NOT_ACCESSIBLE` (indistinguishable
 *     from "missing class" / "wrong teacher").
 *
 * ## Privacy posture
 *
 *   - `rosterSnapshot`, `studentUserId`, `startedByUserId`,
 *     `teacherUserId`, and any profile id are NEVER projected.
 *     The safe DTO contains ONLY `{ id, status, startedAt,
 *     endedAt, rosterCount }`.
 *   - The browser-facing result intentionally carries ONLY the
 *     values the Attendance panel renders. No biometric fields,
 *     no embeddings, no centroids, no Face Service call, no
 *     `passwordHash`, no membership internal ids.
 *
 * ## Failure-mode invariants
 *
 *   - No Better Auth session    → `UNAUTHENTICATED`.
 *   - Missing / incomplete Profile → `PROFILE_INCOMPLETE`.
 *   - Student role              → `TEACHER_REQUIRED`.
 *   - Malformed classId / wrong teacher / missing class →
 *     `CLASS_NOT_ACCESSIBLE` (one safe boundary).
 *   - Any unexpected DB / read failure → `ATTENDANCE_READ_FAILED`.
 *
 * `MongoError`, raw stack traces, the connection string, and the
 * collection name are NEVER serialized.
 *
 * ## DO NOT DO HERE
 *
 *   - Do NOT create / mutate any persisted document.
 *   - Do NOT call the Face Service.
 *   - Do NOT read `passwordHash`, `embedding`, `centroid`,
 *     `FaceProfile`, `rosterSnapshot`, `studentUserId`,
 *     `startedByUserId`, or `teacherUserId` into the result.
 *   - Do NOT add a `/api/attendance` route.
 *   - Do NOT add UI.
 *   - Do NOT implement face recognition, attendance marks, or
 *     camera code.
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
  type AttendanceSessionAttrs,
} from "@/lib/attendance/attendance-session-model";
import type {
  AttendanceSessionStatusDto,
  AttendanceSessionStatusSessionDto,
  AttendanceSessionStatusState,
} from "./attendance-session-status-types";

// =============================================================================
// Stable error codes
// =============================================================================

/**
 * Stable browser-facing error codes for the AttendanceSession
 * status read boundary. Mirrors the project-wide Server Action
 * convention so a future Server Component / Route Handler can
 * surface the same codes to the UI without inventing a parallel
 * error contract.
 *
 * Codes overlap with the documented `ATTENDANCE_SESSION_ACTION_ERROR_CODES`
 * union — the attendance UI surface may reuse the start/stop
 * action codes for refresh-failure mapping without inventing
 * new copy.
 */
export const ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
  TEACHER_REQUIRED: "TEACHER_REQUIRED",
  CLASS_NOT_ACCESSIBLE: "CLASS_NOT_ACCESSIBLE",
  ATTENDANCE_READ_FAILED: "ATTENDANCE_READ_FAILED",
} as const;

export type AttendanceSessionStatusReadErrorCode =
  (typeof ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES)[keyof typeof ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES];

/**
 * Restrained, browser-safe copy.
 *
 * No Mongo URI, no raw class id, no driver internals, no
 * CastError details. The messages never identify which kind
 * of persistence failure occurred.
 */
const ERROR_MESSAGES: Readonly<
  Record<AttendanceSessionStatusReadErrorCode, string>
> = {
  UNAUTHENTICATED:
    "You must be signed in to view attendance status.",
  PROFILE_INCOMPLETE:
    "Complete your profile before viewing attendance.",
  TEACHER_REQUIRED: "Only teachers can view attendance status.",
  CLASS_NOT_ACCESSIBLE: "This class is not available.",
  ATTENDANCE_READ_FAILED:
    "Could not load attendance status. Please try again.",
};

/**
 * Discriminated union for the AttendanceSession status read
 * boundary.
 *
 * The shape mirrors the project-wide Server Action convention
 * (`{ ok, … }` plus a small, browser-safe `code` / `message` on
 * failure) so the future Server Component on `/classes/[classId]`
 * can surface the same codes without inventing a parallel
 * error contract.
 */
export type GetAttendanceSessionStatusResult =
  | { ok: true; result: AttendanceSessionStatusDto }
  | {
      ok: false;
      code: AttendanceSessionStatusReadErrorCode;
      message: string;
    };

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Builds a typed error result for the attendance status read
 * boundary.
 *
 * Local to this module — never exported. The message is the
 * browser-safe copy from `ERROR_MESSAGES`; raw thrown values
 * are NEVER serialized.
 */
function buildError(
  code: AttendanceSessionStatusReadErrorCode,
): Extract<GetAttendanceSessionStatusResult, { ok: false }> {
  return {
    ok: false,
    code,
    message: ERROR_MESSAGES[code],
  };
}

/**
 * Validates that `classId` is a syntactically-valid Mongo
 * ObjectId string. Returns `true` for a 24-character
 * hexadecimal string (Mongoose's `Types.ObjectId.isValid`
 * accepts the canonical hex form).
 *
 * The function NEVER throws. A malformed input collapses to
 * `false` so the caller can route to the safe inaccessible
 * boundary without exposing the `CastError` raised by an
 * unguarded `findById`.
 *
 * Mirrors the helper used by the class-read service so the
 * validation surface is consistent.
 */
function isSyntacticallyValidClassId(classId: string): boolean {
  if (typeof classId !== "string" || classId.length === 0) {
    return false;
  }
  if (classId.length !== 24) return false;
  return /^[0-9a-fA-F]{24}$/.test(classId);
}

/**
 * Projects an AttendanceSession persistence document into the
 * browser-safe status summary DTO.
 *
 * The function is total: missing / malformed fields collapse
 * to safe defaults rather than throwing. Date fields are
 * converted to ISO 8601 strings so the result is
 * `JSON.stringify`-safe. `rosterSnapshot` is NEVER read into
 * the projection — only its length is exposed as
 * `rosterCount`. `startedByUserId`, `_id` (other than the safe
 * string `id`), and any future sensitive field are NEVER
 * projected.
 */
function toSafeAttendanceSessionStatusSession(
  doc: AttendanceSessionAttrs,
): AttendanceSessionStatusSessionDto {
  const idSource = (doc as unknown as {
    _id?: Types.ObjectId | string;
  })._id;
  const id =
    idSource !== undefined && idSource !== null
      ? String(idSource)
      : "";
  const status: "active" | "closed" =
    doc.status === "closed" ? "closed" : "active";
  const startedAtRaw = (doc as unknown as { startedAt?: Date })
    .startedAt;
  const startedAt =
    startedAtRaw instanceof Date
      ? startedAtRaw.toISOString()
      : new Date(
          startedAtRaw as unknown as string,
        ).toISOString();
  const endedAtRaw = (doc as unknown as { endedAt?: Date | null })
    .endedAt;
  const endedAt =
    endedAtRaw instanceof Date
      ? endedAtRaw.toISOString()
      : endedAtRaw === null
        ? null
        : null;
  const rosterSnapshot = Array.isArray(doc.rosterSnapshot)
    ? doc.rosterSnapshot
    : [];
  return {
    id,
    status,
    startedAt,
    endedAt,
    rosterCount: rosterSnapshot.length,
  };
}

/**
 * Finds the class OWNED BY `teacherUserId` whose `_id` equals
 * `classId`. Returns `null` when:
 *
 *   - the class does not exist;
 *   - the class exists but is owned by a different teacher.
 *
 * The query ENCODES the authorization constraint directly:
 * `_id = classId AND teacherUserId = teacherUserId`. This is
 * deliberately stricter than "fetch the class, then compare
 * owner" — the database itself refuses to surface a class the
 * teacher does not own.
 *
 * The function NEVER throws on a missing class. A malformed
 * `classId` that survives `isSyntacticallyValidClassId` still
 * cannot crash the query: Mongoose's `findOne` returns `null`
 * for an unmatched filter rather than throwing a CastError,
 * because the `_id` is paired with the literal `classId` in a
 * single equality match.
 */
async function findOwnedClassForTeacher(
  classId: string,
  teacherUserId: string,
): Promise<ClassAttrs | null> {
  const doc = await ClassModel.findOne({
    _id: classId,
    teacherUserId,
  })
    // Project the safe fields only — `passwordHash` is excluded
    // explicitly so the hash is never even read from the driver
    // buffer.
    .select({
      _id: 1,
      name: 1,
      classCode: 1,
      status: 1,
      teacherUserId: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    .lean<ClassAttrs | null>()
    .exec();
  return doc ?? null;
}

/**
 * Returns the single ACTIVE AttendanceSession for `classId`,
 * or `null` when no active session exists.
 *
 * Uses the partial unique index — at most one
 * `status: "active"` document exists per classId at any time.
 * Never throws on a missing session.
 */
async function findActiveSessionByClassId(
  classId: Types.ObjectId,
): Promise<AttendanceSessionAttrs | null> {
  const doc = await AttendanceSessionModel.findOne({
    classId,
    status: "active",
  })
    .lean<AttendanceSessionAttrs | null>()
    .exec();
  return doc ?? null;
}

/**
 * Returns the most recently closed AttendanceSession for
 * `classId`, or `null` when no session has ever been created.
 *
 * Sort order: `startedAt` DESCENDING (newest first). The
 * existing `startedAt` index on `attendance_sessions` makes
 * this lookup O(log n).
 */
async function findLatestClosedSessionByClassId(
  classId: Types.ObjectId,
): Promise<AttendanceSessionAttrs | null> {
  const docs = await AttendanceSessionModel.find({
    classId,
    status: "closed",
  })
    .sort({ startedAt: -1 })
    .limit(1)
    .lean<AttendanceSessionAttrs[]>()
    .exec();
  if (docs.length === 0) return null;
  return docs[0] ?? null;
}

// =============================================================================
// Public function
// =============================================================================

/**
 * Returns the safe attendance lifecycle state for the class
 * identified by `classId` when the currently authenticated user
 * is the teacher who owns the class.
 *
 * The function accepts ONLY `classId` (the resource identifier).
 * It does NOT accept `userId`, `teacherUserId`, `studentUserId`,
 * `role`, or `membershipId` — those are all derived exclusively
 * from the Better Auth server session and the persisted Profile.
 *
 * ## Behavior
 *
 *   1. Derive the Better Auth session via `getSession()`. If no
 *      session exists, return `UNAUTHENTICATED`. No class /
 *      session query is performed on this branch.
 *   2. Load the application `Profile` for `session.user.id`.
 *      The profile must exist and `onboardingCompleted` must be
 *      `true`. Otherwise return `PROFILE_INCOMPLETE`. No class /
 *      session query is performed on this branch.
 *   3. Require `profile.role === "teacher"`. An authenticated
 *      student (or any non-teacher role) returns `TEACHER_REQUIRED`
 *      WITHOUT performing any class / session query. The
 *      attendance status boundary is teacher-only; a student must
 *      not be able to probe whether attendance is running.
 *   4. Validate the `classId` syntax. A malformed id (not a
 *      canonical 24-hex string) collapses to the safe
 *      `CLASS_NOT_ACCESSIBLE` boundary so an attacker cannot
 *      use the error path to differentiate "malformed syntax"
 *      from "missing class" / "not yours".
 *   5. Encode the authorization constraint directly in the
 *      database query: `ClassModel.findOne({ _id: classId,
 *      teacherUserId: session.user.id })`. The database itself
 *      refuses to surface a class the teacher does not own. A
 *      `null` result collapses to `CLASS_NOT_ACCESSIBLE` —
 *      there is intentionally NO separate `NOT_CLASS_OWNER`
 *      code. This means the browser cannot use the read to
 *      probe whether another teacher has attendance running.
 *   6. Look up the ACTIVE AttendanceSession for the class. If
 *      one exists, return `state = "active"` with the safe
 *      projection. ACTIVE always wins.
 *   7. Otherwise, look up the LATEST CLOSED AttendanceSession
 *      for the class (by `startedAt` DESC, limit 1). If one
 *      exists, return `state = "closed"` with the safe
 *      projection.
 *   8. Otherwise, return `state = "none"` and `session = null`.
 *
 * ## Privacy guarantees
 *
 *   - The success result NEVER contains `rosterSnapshot`,
 *     `studentUserId`, `startedByUserId`, `teacherUserId`,
 *     `passwordHash`, `emailSnapshot`, `phone`, `FaceProfile`,
 *     embeddings, centroids, biometric fields, Better Auth user
 *     data, or membership internal ids.
 *   - The success result is `{ state, session }` only —
 *     `session` carries ONLY `{ id, status, startedAt, endedAt,
 *     rosterCount }`.
 *   - The error result NEVER contains internal stack traces,
 *     raw HTTP bodies, service URLs, `CastError`, or the
 *     Mongo connection string.
 *   - The function NEVER reads `passwordHash` into the
 *     projected `Class` document — the projection excludes it
 *     explicitly.
 *
 * ## Read-only
 *
 * The function NEVER writes an `AttendanceSession`, a `Class`,
 * a `ClassMembership`, or a `Profile`. It NEVER calls the Face
 * Service. It NEVER queries `FaceProfile`. It NEVER computes
 * present / absent / late / confidence.
 */
export async function getAttendanceSessionStatusForCurrentTeacher(
  classId: string,
): Promise<GetAttendanceSessionStatusResult> {
  // 1. Authentication — identity comes from the Better Auth
  //    session only. No userId is accepted from the browser.
  const session = await getSession();
  if (!session) {
    return buildError(ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.UNAUTHENTICATED);
  }
  const userId = session.user.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return buildError(ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.UNAUTHENTICATED);
  }

  // 2. Profile gating — load the Profile and require a complete
  //    record. Missing / incomplete → `PROFILE_INCOMPLETE`. No
  //    class / session query is performed on this branch.
  let profile;
  try {
    profile = await getProfileByUserId(userId);
  } catch {
    return buildError(
      ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.ATTENDANCE_READ_FAILED,
    );
  }
  if (!profile || !profile.onboardingCompleted) {
    return buildError(
      ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.PROFILE_INCOMPLETE,
    );
  }

  // 3. Role gating — the attendance status boundary is
  //    TEACHER-ONLY. Any documented student role returns
  //    `TEACHER_REQUIRED`. Truly unknown role values collapse
  //    to `ATTENDANCE_READ_FAILED` so a legacy Profile cannot
  //    leak the unknown value through the failure path. Both
  //    branches are evaluated BEFORE any class / session query
  //    is performed.
  const role = profile.role;
  if (role !== "teacher" && role !== "student") {
    return buildError(
      ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.ATTENDANCE_READ_FAILED,
    );
  }
  if (role !== "teacher") {
    return buildError(
      ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.TEACHER_REQUIRED,
    );
  }

  // 4. classId syntax validation. A malformed id collapses to
  //    the safe inaccessible boundary so the browser cannot
  //    enumerate valid vs. invalid ids via the error path.
  if (!isSyntacticallyValidClassId(classId)) {
    return buildError(
      ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
    );
  }

  // 5. Authorization-encoded class lookup. The teacherUserId
    //    filter is part of the query so the database refuses to
    //    surface a class the teacher does not own.
  let classDoc: ClassAttrs | null;
  try {
    classDoc = await findOwnedClassForTeacher(classId, userId);
  } catch {
    return buildError(
      ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.ATTENDANCE_READ_FAILED,
    );
  }
  if (!classDoc) {
    // Missing class OR non-owner teacher. There is intentionally
    // NO separate `NOT_CLASS_OWNER` outward-facing code. A
    // non-owner teacher cannot probe whether another teacher
    // has attendance running.
    return buildError(
      ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
    );
  }

  // 6. Active session wins. ONE focused read — uses the partial
  //    unique index on `(classId, status) WHERE status = "active"`.
  const classIdObjectId = new Types.ObjectId(classId);
  let activeDoc: AttendanceSessionAttrs | null;
  try {
    activeDoc = await findActiveSessionByClassId(classIdObjectId);
  } catch {
    return buildError(
      ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.ATTENDANCE_READ_FAILED,
    );
  }
  if (activeDoc) {
    const sessionDto = toSafeAttendanceSessionStatusSession(activeDoc);
    const state: AttendanceSessionStatusState = "active";
    return {
      ok: true,
      result: {
        state,
        session: sessionDto,
      },
    };
  }

  // 7. Otherwise, look up the latest closed session.
  let latestClosedDoc: AttendanceSessionAttrs | null;
  try {
    latestClosedDoc = await findLatestClosedSessionByClassId(
      classIdObjectId,
    );
  } catch {
    return buildError(
      ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.ATTENDANCE_READ_FAILED,
    );
  }
  if (latestClosedDoc) {
    const sessionDto = toSafeAttendanceSessionStatusSession(
      latestClosedDoc,
    );
    const state: AttendanceSessionStatusState = "closed";
    return {
      ok: true,
      result: {
        state,
        session: sessionDto,
      },
    };
  }

  // 8. No session has ever existed for this class.
  return {
    ok: true,
    result: {
      state: "none",
      session: null,
    },
  };
}