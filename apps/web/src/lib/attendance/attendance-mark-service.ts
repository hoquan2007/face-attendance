/**
 * AttendanceMark service layer.
 *
 * PHASE 6.4 — IDEMPOTENT PRESENT ATTENDANCE MARKS.
 * PHASE 6.6 — ATTENDANCE SESSION FINALIZATION (adds absent marks + session_finalization).
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
  /**
   * PHASE 6.6: Attempted to record an absent mark for a session
   * that is still ACTIVE. Absent marks may only be created during
   * session finalization (when the session is already closed).
   */
  SESSION_NOT_CLOSED: "SESSION_NOT_CLOSED",
  /**
   * PHASE 6.6: The session was not found for finalization.
   */
  ATTENDANCE_SESSION_NOT_FOUND_FOR_FINALIZATION:
    "ATTENDANCE_SESSION_NOT_FOUND_FOR_FINALIZATION",
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
 * PHASE 6.6 — STOP / RECOGNITION RACE RECONCILIATION.
 *
 * Reads the session's `endedAt` value for the race-reconciliation
 * check. The function loads the session document (which may be
 * ACTIVE or CLOSED) and returns its `endedAt` or `null`.
 *
 * This is an INTERNAL helper used ONLY by the race-reconciliation
 * path. It is NOT the authoritative "is session ACTIVE" check —
 * `isAttendanceSessionStillActive` is the gate for the initial
 * recognition acceptance.
 */
async function readSessionEndedAt(
  sessionId: Types.ObjectId,
): Promise<Date | null> {
  const doc = await AttendanceSessionModel.findOne({ _id: sessionId })
    .select({ endedAt: 1 })
    .lean<{ endedAt: Date | null } | null>()
    .exec();
  return doc?.endedAt ?? null;
}

/**
 * PHASE 6.6 — STOP / RECOGNITION RACE RECONCILIATION.
 *
 * Atomic conditional conversion of an Absent mark to Present.
 *
 * This function is the NARROW race-reconciliation path. It is
 * called ONLY when:
 *
 *   1. The recognition passed the final ACTIVE-session pre-write check.
 *   2. A `(sessionId, studentUserId)` duplicate-key collision was observed
 *      during the initial upsert attempt.
 *   3. The existing mark has status = "absent" AND source = "session_finalization".
 *   4. The server-generated `recognitionDecisionAt` is not later than
 *      the session's `endedAt` — meaning the recognition was accepted
 *      before the session closed.
 *
 * If ALL conditions hold, the function performs a SINGLE atomic
 * `findOneAndUpdate` that:
 *   - Requires the existing mark's status = "absent" AND source = "session_finalization"
 *   - Sets status = "present", source = "face_recognition",
 *     recognizedAt = recognitionDecisionAt
 *   - Returns the updated document (or null if the condition failed)
 *
 * If ANY condition fails, the function returns null and does NOT
 * modify the document.
 *
 * The function is server-only and does NOT introduce a transaction.
 * The unique `(sessionId, studentUserId)` index is the authoritative
 * safety net.
 */
async function reconcileAbsentToPresentIfEligible(params: {
  sessionId: Types.ObjectId;
  studentUserId: string;
  recognitionDecisionAt: Date;
  endedAt: Date;
}): Promise<boolean> {
  const { sessionId, studentUserId, recognitionDecisionAt, endedAt } = params;

  // Pre-flight check: recognitionDecisionAt must NOT be after endedAt.
  // If the session closed before the recognition was accepted, do not reconcile.
  if (recognitionDecisionAt > endedAt) {
    return false;
  }

  try {
    const result = await AttendanceMarkModel.findOneAndUpdate(
      {
        sessionId,
        studentUserId,
        status: "absent",
        source: "session_finalization",
      },
      {
        $set: {
          status: "present" as AttendanceMarkStatus,
          source: "face_recognition",
          recognizedAt: recognitionDecisionAt,
        },
      },
      {
        new: true,
        includeResultMetadata: true,
      },
    );
    if (!result) {
      // The existing mark no longer matches the conditions
      // (concurrent modification, or was already converted).
      return false;
    }
    return true;
  } catch {
    // Any error means the reconciliation failed — treat as no-op.
    return false;
  }
}

/**
 * Idempotently records PRESENT attendance marks for the supplied
 * `studentUserId` values within the active AttendanceSession
 * identified by `sessionId`.
 *
 * ## Normal path (no race)
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
 *   3. Uses the caller-supplied `recognitionDecisionAt` timestamp
 *      as the batch's `recognizedAt`. This is a server-generated
 *      value captured by the route handler after the Face Service
 *      accepted the match.
 *   4. Iterates the filtered ids and uses `$setOnInsert` to
 *      attempt to create each mark. Existing marks are
 *      preserved verbatim — `recognizedAt` is NOT updated.
 *   5. Classifies an exact `(sessionId, studentUserId)` unique
 *      collision as IDEMPOTENT SUCCESS. The existing mark's
 *      `recognizedAt` is preserved.
 *   6. Any other Mongo error collapses to
 *      `AttendanceMarkServiceError(ATTENDANCE_MARK_WRITE_FAILED)`.
 *
 * ## PHASE 6.6 — Stop / Recognition race reconciliation
 *
 * The recognition may encounter a pre-existing Absent mark
 * (source: "session_finalization") created by a concurrent
 * `stopAttendanceSessionAction` that ran between the route's
 * ACTIVE pre-write check and this write. In this case:
 *
 *   7. The duplicate-key collision is intercepted.
 *   8. The existing mark is loaded and inspected:
 *      - If status = "present" → idempotent success, preserve
 *        existing recognizedAt.
 *      - If status = "absent" AND source = "session_finalization":
 *        → read the session's `endedAt`
 *        → if `recognitionDecisionAt <= endedAt`:
 *            atomically convert Absent → Present
 *            recognizedAt = recognitionDecisionAt
 *          → else: do NOT modify (recognition was after close)
 *      - Any other status/source → idempotent no-op.
 *
 * This is the ONLY path that may modify a closed session's marks.
 * It is strictly scoped to the in-flight race window. No
 * transaction is introduced — the unique index and atomic
 * conditional update together provide the correctness guarantee.
 *
 * The function is server-only.
 */
export async function recordPresentAttendanceMarksForActiveSession(input: {
  sessionId: string;
  candidateStudentUserIds: string[];
  /**
   * PHASE 6.6: Server-generated timestamp captured by the
   * recognition route AFTER the Face Service accepted the match
   * and AFTER the final ACTIVE-session pre-write check.
   * This is the "recognition decision time" used to determine
   * whether an in-flight race can be reconciled.
   *
   * Must be a server-generated Date object. The caller (the
   * recognize route) is the ONLY source — the browser NEVER
   * supplies this value.
   */
  recognitionDecisionAt: Date;
}): Promise<RecordAttendanceMarksResult> {
  const { sessionId, candidateStudentUserIds, recognitionDecisionAt } = input;

  await ensureConnection();

  // 1. Read active session + immutable snapshot.
  const { sessionDocId, classId, rosterSnapshot } =
    await readActiveSessionSnapshot(sessionId);

  // 2. Snapshot-authoritative filter.
  const snapshotIds = filterToSnapshotStudents(
    candidateStudentUserIds,
    rosterSnapshot,
  );

  // 3. The batch's recognizedAt is the caller-supplied
  //    recognitionDecisionAt (server-generated by the route).
  const recognizedAtDate = recognitionDecisionAt;

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
        // ---- PHASE 6.6 RACE RECONCILIATION ----
        // A duplicate-key collision means a mark already exists for
        // (sessionId, studentUserId). We must inspect the existing
        // mark to determine whether reconciliation is possible.
        //
        // Path A: existing is PRESENT → idempotent success.
        // Path B: existing is ABSENT with source = session_finalization
        //         AND recognitionDecisionAt <= endedAt → convert to Present.
        // Path C: otherwise → idempotent no-op.
        const existing = await AttendanceMarkModel.findOne({
          sessionId: sessionDocId,
          studentUserId,
        })
          .select({ status: 1, source: 1 })
          .lean<{
            status: string;
            source: string;
          } | null>()
          .exec();

        if (!existing) {
          // Mark disappeared between the duplicate error and this read.
          // Treat as idempotent — the mark either went through
          // reconciliation in this batch or belongs to another path.
          idempotent.push(studentUserId);
          continue;
        }

        if (existing.status === "present") {
          // Path A: already present — idempotent success.
          idempotent.push(studentUserId);
          continue;
        }

        if (
          existing.status === "absent" &&
          existing.source === "session_finalization"
        ) {
          // Path B: Absent mark created by session finalization.
          // Read the session's endedAt to determine if reconciliation
          // is eligible.
          const endedAt = await readSessionEndedAt(sessionDocId);
          if (endedAt !== null) {
            const reconciled = await reconcileAbsentToPresentIfEligible({
              sessionId: sessionDocId,
              studentUserId,
              recognitionDecisionAt: recognizedAtDate,
              endedAt,
            });
            if (reconciled) {
              // Successfully converted Absent → Present.
              persisted.push(studentUserId);
              continue;
            }
          }
          // recognitionDecisionAt > endedAt, or endedAt is null
          // (session still active or already converted), or
          // reconciliation failed → do NOT modify.
        }

        // Path C: any other existing mark (arbitrary source, etc.)
        // → idempotent no-op.
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

// =============================================================================
// Public API — PHASE 6.6: absent mark finalization
// =============================================================================

/**
 * Result of an idempotent batch absent-mark finalization.
 *
 * `createdAbsent` lists the ids whose absent mark was created in
 * THIS call. `alreadyHadMark` lists the ids who already had a
 * mark (present) — these are NOT overwritten.
 */
export interface FinalizeAbsentMarksResult {
  /** IDs for whom an absent mark was created in this call. */
  createdAbsent: string[];
  /** IDs who already had a mark (present) — absent was NOT created. */
  alreadyHadMark: string[];
  /** The server-side timestamp used for `finalizedAt`. */
  finalizedAt: string;
}

/**
 * PHASE 6.6: Idempotently records ABSENT attendance marks for all
 * roster students of a CLOSED AttendanceSession who do NOT have a
 * present mark.
 *
 * ## Semantic contract
 *
 *   - The session MUST be CLOSED. An active session does NOT receive
 *     absent marks — students are only marked absent when the teacher
 *     explicitly closes the session.
 *   - "Present wins" — a student who already has a present mark is
 *     NEVER overwritten with absent.
 *   - The ONLY source of students to finalize is the session's
 *     immutable `rosterSnapshot`.
 *   - Finalization is IDEMPOTENT — repeated calls produce the same
 *     result without creating duplicate absent marks.
 *
 * ## Behavior
 *
 *   1. Reads the closed AttendanceSession and verifies it is CLOSED.
 *      A session that is still ACTIVE throws
 *      `AttendanceMarkServiceError(SESSION_NOT_CLOSED)`.
 *   2. Loads existing PRESENT marks for the session.
 *   3. Identifies roster students who do NOT have a present mark.
 *   4. For each unmatched student, uses `$setOnInsert` to create
 *      an absent mark with `status: "absent"` and
 *      `source: "session_finalization"`.
 *   5. Existing present marks are NEVER modified or overwritten.
 *   6. An exact `(sessionId, studentUserId)` unique collision on an
 *      absent mark is treated as idempotent success (no-op).
 *   7. Any other Mongo error collapses to
 *      `AttendanceMarkServiceError(ATTENDANCE_MARK_WRITE_FAILED)`.
 *
 * The function is server-only. No transaction. The unique compound
 * index `(sessionId, studentUserId)` is the authoritative safety net.
 *
 * ## Inputs
 *
 *   - `sessionId`   — canonical ObjectId string of the closed
 *                      AttendanceSession.
 *   - `classId`     — canonical ObjectId string (verified against
 *                      the session doc for safety).
 */
export async function finalizeAbsentMarksForClosedSession(input: {
  sessionId: string;
  classId: string;
}): Promise<FinalizeAbsentMarksResult> {
  const { sessionId, classId } = input;

  await ensureConnection();

  // 1. Read the closed session and verify status.
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

  const sessionDoc = await AttendanceSessionModel.findOne({
    _id: sessionId,
  })
    .select({
      _id: 1,
      classId: 1,
      status: 1,
      rosterSnapshot: 1,
    })
    .lean<{
      _id: Types.ObjectId;
      classId: Types.ObjectId;
      status: string;
      rosterSnapshot: AttendanceRosterSnapshotItemDoc[];
    } | null>()
    .exec();

  if (!sessionDoc) {
    throw new AttendanceMarkServiceError({
      code: ATTENDANCE_MARK_ERROR_CODES.ATTENDANCE_SESSION_NOT_FOUND_FOR_FINALIZATION,
      message: "Attendance session not found.",
    });
  }

  if (sessionDoc.status !== "closed") {
    throw new AttendanceMarkServiceError({
      code: ATTENDANCE_MARK_ERROR_CODES.SESSION_NOT_CLOSED,
      message: "Cannot finalize absent marks for an active session.",
    });
  }

  // Verify classId matches (defense-in-depth).
  if (sessionDoc.classId.toString() !== classId) {
    throw new AttendanceMarkServiceError({
      code: ATTENDANCE_MARK_ERROR_CODES.ATTENDANCE_SESSION_NOT_FOUND_FOR_FINALIZATION,
      message: "Session does not belong to the specified class.",
    });
  }

  // 2. Load existing PRESENT marks for the session.
  const existingMarks = await AttendanceMarkModel.find({
    sessionId,
  })
    .select({ studentUserId: 1, status: 1 })
    .lean<
      Array<{
        studentUserId: string;
        status: string;
      }>
    >()
    .exec();

  // Build a set of students who already have a mark.
  const studentsWithMark = new Set<string>();
  for (const mark of existingMarks) {
    if (
      mark.studentUserId &&
      typeof mark.studentUserId === "string"
    ) {
      studentsWithMark.add(mark.studentUserId);
    }
  }

  // 3. Identify roster students who do NOT have a present mark.
  const rosterSnapshot = Array.isArray(sessionDoc.rosterSnapshot)
    ? sessionDoc.rosterSnapshot
    : [];

  const studentsToMarkAbsent: AttendanceRosterSnapshotItemDoc[] = [];
  for (const item of rosterSnapshot) {
    if (
      item &&
      typeof item.studentUserId === "string" &&
      item.studentUserId.length > 0 &&
      !studentsWithMark.has(item.studentUserId)
    ) {
      studentsToMarkAbsent.push(item);
    }
  }

  // 4. Batch-create absent marks idempotently.
  const finalizedAtDate = new Date();
  const created: string[] = [];
  const alreadyHad: string[] = [];

  for (const item of studentsToMarkAbsent) {
    const studentUserId = item.studentUserId;
    alreadyHad.push(studentUserId);

    try {
      const result = await AttendanceMarkModel.findOneAndUpdate(
        { sessionId: sessionDoc._id, studentUserId },
        {
          $setOnInsert: {
            sessionId: sessionDoc._id,
            classId: sessionDoc.classId,
            studentUserId,
            status: "absent",
            recognizedAt: finalizedAtDate,
            source: "session_finalization",
          },
        },
        {
          upsert: true,
          new: false,
          includeResultMetadata: true,
        },
      );
      const metadata = result as unknown as {
        lastErrorObject?: { upserted?: unknown };
        value?: AttendanceMarkDoc | null;
      } | null;
      const wasUpserted =
        metadata?.lastErrorObject?.upserted !== undefined &&
        metadata?.lastErrorObject?.upserted !== null;
      if (wasUpserted) {
        created.push(studentUserId);
        // Remove from alreadyHad (they were newly created).
        const idx = alreadyHad.indexOf(studentUserId);
        if (idx !== -1) alreadyHad.splice(idx, 1);
      }
    } catch (err: unknown) {
      if (isAttendanceMarkDuplicateKeyError(err)) {
        // Race: another concurrent path wrote the mark first.
        // Idempotent success — do not add to created.
        continue;
      }
      if (err instanceof AttendanceMarkServiceError) throw err;
      if (err instanceof mongoose.Error.ValidationError) {
        throw new AttendanceMarkServiceError({
          code: ATTENDANCE_MARK_ERROR_CODES.ATTENDANCE_MARK_WRITE_FAILED,
          message: "Failed to record absent mark.",
        });
      }
      throw new AttendanceMarkServiceError({
        code: ATTENDANCE_MARK_ERROR_CODES.ATTENDANCE_MARK_WRITE_FAILED,
        message: "Failed to record absent mark.",
      });
    }
  }

  return {
    createdAbsent: created,
    alreadyHadMark: alreadyHad,
    finalizedAt: finalizedAtDate.toISOString(),
  };
}

/**
 * PHASE 6.6: Lists ALL attendance marks (present AND absent) for
 * a given session.
 *
 * Used by the final summary read model to compose the complete
 * attendance state. The function returns all marks regardless of
 * status.
 *
 * Ordering: deterministic — sorted by the roster snapshot order
 * (which is stable and set at session start). Marks are joined
 * with the roster snapshot so absent students also appear.
 *
 * The function never throws on an empty result set.
 */
export async function listAllAttendanceMarksForSession(
  sessionId: string | Types.ObjectId,
): Promise<
  Array<{
    studentUserId: string;
    status: string;
    recognizedAt: string;
  }>
> {
  await ensureConnection();

  // Load session to get roster snapshot order.
  const sessionDoc = await AttendanceSessionModel.findById(sessionId)
    .select({ rosterSnapshot: 1 })
    .lean<{
      rosterSnapshot: AttendanceRosterSnapshotItemDoc[];
    } | null>()
    .exec();

  if (!sessionDoc) {
    return [];
  }

  const rosterSnapshot = Array.isArray(sessionDoc.rosterSnapshot)
    ? sessionDoc.rosterSnapshot
    : [];

  // Build studentUserId → position map for stable ordering.
  const positionMap = new Map<string, number>();
  for (let i = 0; i < rosterSnapshot.length; i++) {
    const item = rosterSnapshot[i];
    if (item && typeof item.studentUserId === "string") {
      positionMap.set(item.studentUserId, i);
    }
  }

  // Load all marks.
  const marks = await AttendanceMarkModel.find({ sessionId })
    .select({ studentUserId: 1, status: 1, recognizedAt: 1 })
    .lean<
      Array<{
        studentUserId: string;
        status: string;
        recognizedAt: Date;
      }>
    >()
    .exec();

  // Sort by roster snapshot position.
  return [...marks]
    .map((m) => ({
      studentUserId: m.studentUserId,
      status: m.status,
      recognizedAt:
        m.recognizedAt instanceof Date
          ? m.recognizedAt.toISOString()
          : new Date(m.recognizedAt as unknown as string).toISOString(),
    }))
    .sort((a, b) => {
      const posA = positionMap.get(a.studentUserId) ?? Infinity;
      const posB = positionMap.get(b.studentUserId) ?? Infinity;
      return posA - posB;
    });
}
