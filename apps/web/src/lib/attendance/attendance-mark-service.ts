/**
 * AttendanceMark service layer.
 *
 * PHASE 6.4 — IDEMPOTENT PRESENT ATTENDANCE MARKS.
 *
 * Server-only module. Encapsulates all reads and writes against
 * the `attendance_marks` collection. The route handler
 * `POST /api/attendance/recognize` and the present-state read
 * service consume this module — no other code path may create,
 * update, or delete attendance marks in PHASE 6.4.
 *
 * ## Architectural invariants
 *
 *   - `studentUserId` is INTERNAL persistence data. It is NEVER
 *     accepted from the browser, NEVER accepted from the Face
 *     Service, and NEVER projected into a browser DTO.
 *   - `rosterSnapshot` from `AttendanceSession` is the ONLY
 *     authority for `studentUserId`. Current `ClassMembership`
 *     rows are NEVER used to decide mark eligibility — a student
 *     who leaves the class AFTER the session started still owns
 *     the captured roster snapshot entry, and the snapshot entry
 *     is the authoritative identity.
 *   - Marks may ONLY be created for `studentUserId` values that
 *     appear in the session's immutable `rosterSnapshot`.
 *   - Marks may ONLY be created when the AttendanceSession is
 *     ACTIVE at the final pre-write check. A session that was
 *     closed mid-flight (e.g. teacher pressed Stop while the
 *     Face Service was processing) creates NO new marks.
 *   - Persistence is IDEMPOTENT. Repeated recognition of the same
 *     `(sessionId, studentUserId)` does NOT create duplicate
 *     marks, does NOT shift `recognizedAt`, and does NOT error
 *     — the existing mark's `recognizedAt` is preserved.
 *   - No multi-document MongoDB transaction is introduced. The
 *     `(sessionId, studentUserId)` unique index is the
 *     authoritative safety net.
 *
 * ## Privacy posture
 *
 *   - `studentUserId` never reaches the browser.
 *   - `AttendanceMark._id` never reaches the browser.
 *   - `classId`, `status`, `source` are NOT projected into the
 *     present-state read DTO — only the safe per-student display
 *     fields from the session's roster snapshot are surfaced.
 *   - The service never logs raw Mongo errors, stack traces,
 *     E11000 details, or any database internals.
 */

import "server-only";

import mongoose, { Types } from "mongoose";

import { getMongooseConnection } from "@/lib/mongoose";
import {
  AttendanceMarkModel,
  type AttendanceMarkAttrs,
  type AttendanceMarkDoc,
  type AttendanceMarkStatus,
} from "@/lib/attendance/attendance-mark-model";
import {
  AttendanceSessionModel,
  type AttendanceRosterSnapshotItemDoc,
} from "@/lib/attendance/attendance-session-model";

// =============================================================================
// Connection
// =============================================================================

async function ensureConnection(): Promise<void> {
  await getMongooseConnection();
}

// =============================================================================
// Service errors
// =============================================================================

export const ATTENDANCE_MARK_ERROR_CODES = {
  /** The sessionId is not a valid ObjectId / cannot be cast. */
  INVALID_SESSION_ID: "INVALID_SESSION_ID",
  /** The active session was not found for the supplied sessionId. */
  ATTENDANCE_SESSION_NOT_FOUND: "ATTENDANCE_SESSION_NOT_FOUND",
  /**
   * The session exists but is no longer ACTIVE at the
   * authoritative pre-write check.
   */
  ATTENDANCE_SESSION_NOT_ACTIVE: "ATTENDANCE_SESSION_NOT_ACTIVE",
  /**
   * The caller supplied a `studentUserId` that is NOT present in
   * the session's immutable `rosterSnapshot`. Roster snapshot
   * is the SOLE authority.
   */
  STUDENT_NOT_IN_SNAPSHOT: "STUDENT_NOT_IN_SNAPSHOT",
  /**
   * The persistence write failed for an unmapped reason. The
   * message is intentionally generic — no internals, no stack,
   * no `E11000`, no collection name.
   */
  ATTENDANCE_MARK_WRITE_FAILED: "ATTENDANCE_MARK_WRITE_FAILED",
} as const;

export type AttendanceMarkErrorCode =
  (typeof ATTENDANCE_MARK_ERROR_CODES)[keyof typeof ATTENDANCE_MARK_ERROR_CODES];

export class AttendanceMarkServiceError extends Error {
  readonly code: AttendanceMarkErrorCode;

  constructor({
    code,
    message,
  }: {
    code: AttendanceMarkErrorCode;
    message: string;
  }) {
    super(message);
    this.name = "AttendanceMarkServiceError";
    this.code = code;
  }
}

// =============================================================================
// Duplicate-key classifier
// =============================================================================

/**
 * Returns `true` ONLY when the supplied thrown value matches the
 * canonical Mongo / Mongoose duplicate-key error shape AND the
 * collided index is the `(sessionId, studentUserId)` unique
 * compound constraint on the `attendance_marks` collection.
 *
 * Any other error — including a non-11000 error, a 11000 error
 * from a different index, or a 11000 error without the canonical
 * keyValue / keyPattern signature — returns `false`. The caller
 * maps `false` to `ATTENDANCE_MARK_WRITE_FAILED` so an unrelated
 * uniqueness collision is NEVER silently reported as a duplicate
 * mark.
 *
 * The function is total and never throws.
 */
export function isAttendanceMarkDuplicateKeyError(
  err: unknown,
): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { code?: unknown }).code !== 11000) return false;

  // 1. Compound identification via `keyValue` (the modern Mongo /
  //    Mongoose shape).
  const keyValue = (err as { keyValue?: unknown }).keyValue;
  if (keyValue && typeof keyValue === "object") {
    const kv = keyValue as Record<string, unknown>;
    if (
      "sessionId" in kv &&
      "studentUserId" in kv &&
      kv["sessionId"] !== null &&
      kv["sessionId"] !== undefined &&
      typeof kv["studentUserId"] === "string" &&
      kv["studentUserId"].length > 0
    ) {
      return true;
    }
  }

  // 2. Compound identification via `keyPattern`.
  const keyPattern = (err as { keyPattern?: unknown }).keyPattern;
  if (keyPattern && typeof keyPattern === "object") {
    const kp = keyPattern as Record<string, unknown>;
    if ("sessionId" in kp && "studentUserId" in kp) {
      return true;
    }
  }

  return false;
}

// =============================================================================
// Snapshot authority resolution
// =============================================================================

/**
 * Reads the immutable `rosterSnapshot` for the active session.
 *
 * The function:
 *
 *   - Validates `sessionId` syntax. A malformed value (not a
 *     24-hex string) collapses to `INVALID_SESSION_ID` so the
 *     caller can route to a safe failure code.
 *   - Loads the session with `status: "active"` filter encoded
 *     directly in the query — the database itself refuses to
 *     surface a closed session on this read.
 *   - Returns the snapshot verbatim. The function NEVER recomputes
 *     the snapshot, NEVER queries ClassMembership, NEVER queries
 *     Profile.
 *
 * The function is server-only and never throws on a missing /
 * closed session.
 */
async function readActiveSessionSnapshot(
  sessionId: string,
): Promise<{
  sessionDocId: Types.ObjectId;
  classId: Types.ObjectId;
  rosterSnapshot: AttendanceRosterSnapshotItemDoc[];
}> {
  await ensureConnection();

  if (typeof sessionId !== "string" || sessionId.length !== 24) {
    throw new AttendanceMarkServiceError({
      code: ATTENDANCE_MARK_ERROR_CODES.INVALID_SESSION_ID,
      message: "Invalid sessionId.",
    });
  }
  if (!/^[0-9a-fA-F]{24}$/.test(sessionId)) {
    throw new AttendanceMarkServiceError({
      code: ATTENDANCE_MARK_ERROR_CODES.INVALID_SESSION_ID,
      message: "Invalid sessionId.",
    });
  }

  const doc = await AttendanceSessionModel.findOne({
    _id: sessionId,
    status: "active",
  })
    .select({ _id: 1, classId: 1, rosterSnapshot: 1 })
    .lean<{
      _id: Types.ObjectId;
      classId: Types.ObjectId;
      rosterSnapshot: AttendanceRosterSnapshotItemDoc[];
    } | null>()
    .exec();

  if (!doc) {
    throw new AttendanceMarkServiceError({
      code: ATTENDANCE_MARK_ERROR_CODES.ATTENDANCE_SESSION_NOT_ACTIVE,
      message: "Attendance session is not active.",
    });
  }

  return {
    sessionDocId: doc._id,
    classId: doc.classId,
    rosterSnapshot: Array.isArray(doc.rosterSnapshot)
      ? doc.rosterSnapshot
      : [],
  };
}

/**
 * Filters a list of candidate `studentUserId` values down to
 * the subset that is actually present in the supplied roster
 * snapshot. Deduplicates while preserving the FIRST occurrence
 * order — Face Service may return the same student multiple
 * times across one frame; we collapse to a single entry.
 *
 * Returns the deduplicated, snapshot-authoritative id list.
 * The caller must already have a non-null session; this helper
 * is total and never throws.
 */
function filterToSnapshotStudents(
  candidateStudentUserIds: string[],
  rosterSnapshot: AttendanceRosterSnapshotItemDoc[],
): string[] {
  const allowed = new Set<string>();
  for (const item of rosterSnapshot) {
    if (
      item &&
      typeof item.studentUserId === "string" &&
      item.studentUserId.length > 0
    ) {
      allowed.add(item.studentUserId);
    }
  }

  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of candidateStudentUserIds) {
    if (typeof id !== "string" || id.length === 0) continue;
    if (!allowed.has(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

// =============================================================================
// Public API — write
// =============================================================================

/**
 * Result of an idempotent batch persistence attempt.
 *
 * The function NEVER returns `studentUserId` to the caller — the
 * caller already knows which ids it asked to be persisted.
 *
 * `persistedStudentUserIds` lists the ids whose FIRST mark was
 * created in THIS call. `idempotentStudentUserIds` lists the ids
 * whose mark already existed (repeated recognition).
 */
export interface RecordAttendanceMarksResult {
  /** IDs whose mark was newly created in this call. */
  persistedStudentUserIds: string[];
  /** IDs whose mark already existed (idempotent repeat). */
  idempotentStudentUserIds: string[];
  /** The server-side timestamp used for `recognizedAt`. */
  recognizedAt: string;
}

/**
 * Idempotently records PRESENT attendance marks for the supplied
 * `studentUserId` values within the active AttendanceSession
 * identified by `sessionId`.
 *
 * The function:
 *
 *   1. Reads the immutable `rosterSnapshot` for the active
 *      session. If the session is no longer active, throws
 *      `AttendanceMarkServiceError(ATTENDANCE_SESSION_NOT_ACTIVE)`
 *      — the caller maps this to NO marks created.
 *   2. Filters the input ids against the snapshot. Ids NOT in
 *      the snapshot are silently dropped (they are NOT errors
 *      because the caller may receive candidates from Face
 *      Service that we cannot reject at the route layer without
 *      leaking ids — the snapshot is the authoritative gate).
 *   3. Captures ONE server-side `recognizedAt` timestamp for the
 *      entire batch. This is the timestamp that wins for any
 *      newly created mark.
 *   4. Iterates the filtered ids and uses `$setOnInsert` to
 *      attempt to create each mark. Existing marks are
 *      preserved verbatim — `recognizedAt` is NOT updated.
 *   5. Classifies an exact `(sessionId, studentUserId)` unique
 *      collision as IDEMPOTENT SUCCESS. The existing mark's
 *      `recognizedAt` is preserved.
 *   6. Any other Mongo error collapses to
 *      `AttendanceMarkServiceError(ATTENDANCE_MARK_WRITE_FAILED)`.
 *      The error message is intentionally generic — no stack,
 *      no `E11000`, no collection name.
 *
 * No transaction. No automatic retry. The route layer maps a
 * write failure to a controlled safe error response.
 *
 * The function is server-only.
 */
export async function recordPresentAttendanceMarksForActiveSession(input: {
  sessionId: string;
  candidateStudentUserIds: string[];
}): Promise<RecordAttendanceMarksResult> {
  const { sessionId, candidateStudentUserIds } = input;

  await ensureConnection();

  // 1. Read active session + immutable snapshot.
  const { sessionDocId, classId, rosterSnapshot } =
    await readActiveSessionSnapshot(sessionId);

  // 2. Snapshot-authoritative filter.
  const snapshotIds = filterToSnapshotStudents(
    candidateStudentUserIds,
    rosterSnapshot,
  );

  // 3. Single server-side timestamp for the batch.
  const recognizedAtDate = new Date();

  const persisted: string[] = [];
  const idempotent: string[] = [];

  // 4. Idempotent per-student insert.
  for (const studentUserId of snapshotIds) {
    try {
      const result = await AttendanceMarkModel.findOneAndUpdate(
        { sessionId: sessionDocId, studentUserId },
        {
          $setOnInsert: {
            sessionId: sessionDocId,
            classId,
            studentUserId,
            status: "present" as AttendanceMarkStatus,
            recognizedAt: recognizedAtDate,
            source: "face_recognition",
          },
        },
        {
          upsert: true,
          new: false,
          includeResultMetadata: true,
        },
      );
      // `findOneAndUpdate` with `upsert: true` and
      // `includeResultMetadata: true` returns a metadata wrapper.
      // If `lastErrorObject.upserted` is set, a new document was
      // created. Otherwise the upsert was a no-op (existing
      // document preserved).
      const metadata = result as unknown as {
        lastErrorObject?: { upserted?: unknown };
        value?: AttendanceMarkDoc | null;
      } | null;
      const wasUpserted =
        metadata?.lastErrorObject?.upserted !== undefined &&
        metadata?.lastErrorObject?.upserted !== null;
      if (wasUpserted) {
        persisted.push(studentUserId);
      } else {
        idempotent.push(studentUserId);
      }
    } catch (err: unknown) {
      if (isAttendanceMarkDuplicateKeyError(err)) {
        // Race: another concurrent path wrote the mark first.
        // Idempotent success.
        idempotent.push(studentUserId);
        continue;
      }
      if (err instanceof AttendanceMarkServiceError) throw err;
      if (err instanceof mongoose.Error.ValidationError) {
        throw new AttendanceMarkServiceError({
          code: ATTENDANCE_MARK_ERROR_CODES.ATTENDANCE_MARK_WRITE_FAILED,
          message: "Failed to record attendance mark.",
        });
      }
      throw new AttendanceMarkServiceError({
        code: ATTENDANCE_MARK_ERROR_CODES.ATTENDANCE_MARK_WRITE_FAILED,
        message: "Failed to record attendance mark.",
      });
    }
  }

  return {
    persistedStudentUserIds: persisted,
    idempotentStudentUserIds: idempotent,
    recognizedAt: recognizedAtDate.toISOString(),
  };
}

/**
 * Re-reads the AttendanceSession and asserts it is STILL active
 * at the time of the call. This is the FINAL pre-write check
 * that the recognize route performs BEFORE invoking
 * `recordPresentAttendanceMarksForActiveSession`.
 *
 * The function is intentionally separated from the write path
 * so the route can:
 *
 *   - decide to short-circuit before any write attempt when the
 *     session was closed mid-flight (Teacher pressed Stop while
 *     Face Service was processing), and
 *   - treat the final check as the source of truth for
 *     "is this session still accepting marks".
 *
 * The function never throws on a closed session. It returns a
 * boolean instead, so the route can branch without catching
 * exceptions in the hot path.
 */
export async function isAttendanceSessionStillActive(
  sessionId: string,
): Promise<boolean> {
  await ensureConnection();

  if (typeof sessionId !== "string" || sessionId.length !== 24) {
    return false;
  }
  if (!/^[0-9a-fA-F]{24}$/.test(sessionId)) {
    return false;
  }

  const doc = await AttendanceSessionModel.findOne({
    _id: sessionId,
    status: "active",
  })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId } | null>()
    .exec();

  return doc !== null;
}

// =============================================================================
// Public API — read
// =============================================================================

/**
 * Browser-safe projection of a single present AttendanceMark.
 *
 * Used internally by the present-state read service to compose
 * the final Teacher DTO. The shape carries ONLY the fields the
 * UI needs:
 *
 *   - `studentUserId`     — INTERNAL persistence data. The
 *                           present-state read service NEVER
 *                           projects this into the final DTO;
 *                           it uses it ONLY to look up the
 *                           matching rosterSnapshot entry.
 *   - `recognizedAt`      — ISO 8601 string (server wall clock).
 *
 * `classId`, `sessionId`, `status`, `source`, Mongo `_id`, and
 * timestamps other than `recognizedAt` are NEVER projected.
 */
export interface SafeAttendanceMarkSummary {
  studentUserId: string;
  recognizedAt: string;
}

/**
 * Lists PRESENT attendance marks for the supplied active
 * AttendanceSession, sorted by `recognizedAt` ASCENDING. The
 * "first recognition wins" rule guarantees that no mark's
 * `recognizedAt` is updated on later recognition — so the
 * ASC sort is deterministic and stable.
 *
 * The function never throws on an empty result set. It NEVER
 * projects internal Mongo ids, `classId`, `status`, `source`,
 * or any biometric field into the result.
 */
export async function listPresentAttendanceMarksForSession(
  sessionId: string | Types.ObjectId,
): Promise<SafeAttendanceMarkSummary[]> {
  await ensureConnection();

  const docs = await AttendanceMarkModel.find({
    sessionId,
    status: "present",
  })
    .select({ studentUserId: 1, recognizedAt: 1 })
    .sort({ recognizedAt: 1 })
    .lean<
      Array<{
        studentUserId: string;
        recognizedAt: Date;
      }>
    >()
    .exec();

  // Explicitly re-sort by `recognizedAt` ASC after projection so
  // the result is deterministic regardless of the underlying
  // cursor order. Also normalize `recognizedAt` to an ISO 8601
  // string and project ONLY the safe DTO subset.
  return [...docs]
    .map((d) => ({
      studentUserId: d.studentUserId,
      recognizedAt:
        d.recognizedAt instanceof Date
          ? d.recognizedAt.toISOString()
          : new Date(d.recognizedAt as unknown as string).toISOString(),
    }))
    .sort(
      (a, b) =>
        new Date(a.recognizedAt).getTime() -
        new Date(b.recognizedAt).getTime(),
    );
}

/**
 * Loads attendance marks persistence document by Mongo `_id`.
 * Server-internal — used by tests that exercise the model. The
 * present-state read service does NOT need this primitive; it
 * uses `listPresentAttendanceMarksForSession` instead.
 */
export async function findAttendanceMarkById(
  id: Types.ObjectId | string,
): Promise<AttendanceMarkAttrs | null> {
  await ensureConnection();
  const doc = await AttendanceMarkModel.findById(id)
    .lean<AttendanceMarkAttrs | null>()
    .exec();
  return doc ?? null;
}
