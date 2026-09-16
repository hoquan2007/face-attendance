/**
 * AttendanceSession service layer + roster snapshot builder.
 *
 * PHASE 6.1 — ATTENDANCE SESSION FOUNDATION (TEACHER START/STOP +
 * IMMUTABLE ROSTER SNAPSHOT).
 *
 * Encapsulates all reads and writes against the `attendance_sessions`
 * collection. Server Actions, Server Components, and Route Handlers
 * call this module instead of touching the Mongoose model directly.
 *
 * Key invariants:
 *
 *   - `startedByUserId` comes from the authoritative server session —
 *     never from the request body.
 *   - The partial unique index `(classId, status) WHERE status =
 *     "active"` is the authoritative guard against creating more
 *     than ONE active session per class. The service folds a
 *     duplicate-key collision into a typed "already active" error
 *     so the start action can map it to a safe idempotent success.
 *   - The roster snapshot is built FROM ACTIVE MEMBERSHIPS only and
 *     is captured IN A SINGLE BATCHED Profile lookup (no N+1).
 *   - The roster snapshot is IMMUTABLE — once written, it does not
 *     change merely because a student joins / leaves the class
 *     later or because a Profile's `fullName` /
 *     `identificationCode` is updated. This phase does not
 *     implement a roster refresh path.
 *   - Orphaned / incomplete / non-student Profile references are
 *     rejected with a typed `ATTENDANCE_ROSTER_INVALID` error.
 *     The start action surfaces the failure; corrupt memberships
 *     are NEVER silently carried into an attendance roster.
 *   - The service is server-only.
 *
 * This module opens with `import "server-only"` and is INTENTIONALLY
 * NOT re-exported through the public `index.ts` barrel of any other
 * module. Browser-facing code can never import the persistence
 * model directly.
 */

import "server-only";

import mongoose, { Types } from "mongoose";

import { getMongooseConnection } from "@/lib/mongoose";
import {
  AttendanceSessionModel,
  type AttendanceRosterSnapshotItemDoc,
  type AttendanceSessionAttrs,
  type AttendanceSessionStatus,
} from "@/lib/attendance/attendance-session-model";
import {
  ClassMembershipModel,
  type ClassMembershipAttrs,
} from "@/lib/classes/class-membership-model";
import {
  getStudentProfilesByUserIds,
  type SafeStudentProfileProjection,
} from "@/lib/profile-service";

// =============================================================================
// Connection
// =============================================================================

/**
 * Lazily ensures the Mongoose connection is ready before any model
 * operation. Cheap (subsequent calls are O(1)) and safe to invoke
 * at the top of every public function.
 */
async function ensureConnection(): Promise<void> {
  await getMongooseConnection();
}

// =============================================================================
// Service errors
// =============================================================================

/**
 * Application-level error codes for attendance-session operations.
 *
 * Phase 6.1 surface — mirrors the project-wide Server Action
 * convention so a future Server Component / Route Handler can
 * surface the same codes to the UI without inventing a parallel
 * error contract.
 */
export const ATTENDANCE_SESSION_ERROR_CODES = {
  ATTENDANCE_SESSION_NOT_FOUND: "ATTENDANCE_SESSION_NOT_FOUND",
  ATTENDANCE_SESSION_ALREADY_ACTIVE: "ATTENDANCE_SESSION_ALREADY_ACTIVE",
  ATTENDANCE_SESSION_NOT_ACTIVE: "ATTENDANCE_SESSION_NOT_ACTIVE",
  ATTENDANCE_ROSTER_INVALID: "ATTENDANCE_ROSTER_INVALID",
  ATTENDANCE_SESSION_CREATE_FAILED: "ATTENDANCE_SESSION_CREATE_FAILED",
  ATTENDANCE_SESSION_STOP_FAILED: "ATTENDANCE_SESSION_STOP_FAILED",
} as const;

export type AttendanceSessionErrorCode =
  (typeof ATTENDANCE_SESSION_ERROR_CODES)[keyof typeof ATTENDANCE_SESSION_ERROR_CODES];

export class AttendanceSessionServiceError extends Error {
  readonly code: AttendanceSessionErrorCode;

  constructor({
    code,
    message,
  }: {
    code: AttendanceSessionErrorCode;
    message: string;
  }) {
    super(message);
    this.name = "AttendanceSessionServiceError";
    this.code = code;
  }
}

// =============================================================================
// PHASE 6.1 — Partial unique classifier
// =============================================================================

/**
 * Returns `true` ONLY when the supplied thrown value matches the
 * canonical Mongo / Mongoose duplicate-key error shape AND the
 * collided index is the `(classId, status)` partial unique
 * constraint where `status === "active"`.
 *
 * The predicate is total and never throws. It accepts the same
 * driver shapes the project's other classifiers accept:
 *
 *   1. `{ code: 11000, keyValue: { classId, status: "active" } }`
 *   2. `{ code: 11000, keyPattern: { classId: 1, status: 1 } }`
 *   3. `{ code: 11000, keyValue: { ... }, keyPattern: { ... } }`
 *
 * Any other error — including a future unique index on
 * `attendance_sessions`, a non-11000 error, or a 11000 error
 * whose `keyValue` / `keyPattern` does not identify the active-
 * session uniqueness guard — returns `false`. The caller maps
 * `false` to the generic `ATTENDANCE_SESSION_CREATE_FAILED`
 * code so an unrelated uniqueness collision (e.g. a future
 * `idempotencyKey` index) is NOT silently reported as "an
 * active session already exists".
 *
 * The function is total and never throws.
 */
export function isAttendanceSessionActiveDuplicateKeyError(
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
      "classId" in kv &&
      "status" in kv &&
      kv["classId"] !== null &&
      kv["classId"] !== undefined &&
      kv["status"] === "active"
    ) {
      return true;
    }
  }

  // 2. Compound identification via `keyPattern`.
  const keyPattern = (err as { keyPattern?: unknown }).keyPattern;
  if (keyPattern && typeof keyPattern === "object") {
    const kp = keyPattern as Record<string, unknown>;
    if ("classId" in kp && "status" in kp) {
      return true;
    }
  }

  return false;
}

// =============================================================================
// Internal query primitives
// =============================================================================

/**
 * Lists ACTIVE memberships for `classId`. Sorted by `joinedAt` ASC
 * (oldest-first) so the resulting roster has a stable, deterministic
 * order that matches the existing teacher-roster convention.
 *
 * The function is server-only. Returns an empty array when no
 * memberships match (an empty class roster is a valid state for an
 * attendance session).
 */
async function listActiveMembershipsByClassId(
  classId: Types.ObjectId,
): Promise<ClassMembershipAttrs[]> {
  const docs = await ClassMembershipModel.find({
    classId,
    status: "active",
  })
    .select({ studentUserId: 1, joinedAt: 1 })
    .sort({ joinedAt: 1 })
    .lean<ClassMembershipAttrs[]>()
    .exec();
  return docs;
}

/**
 * Builds the deterministic, deduplicated, ordered list of
 * `studentUserId` values for `classId`.
 *
 * Empty / malformed `studentUserId` values are filtered out. If
 * the same `studentUserId` appears multiple times (corrupt legacy
 * data; the compound unique index makes this impossible for fresh
 * data), the EARLIEST `joinedAt` is kept — matching the
 * "oldest member first" convention.
 *
 * The function is total and never throws.
 */
function collectActiveStudentUserIds(
  memberships: ClassMembershipAttrs[],
): { orderedStudentUserIds: string[]; dedupedCount: number } {
  const dedupedByStudentUserId = new Map<string, ClassMembershipAttrs>();
  for (const m of memberships) {
    const id = m.studentUserId;
    if (typeof id !== "string" || id.length === 0) continue;
    const existing = dedupedByStudentUserId.get(id);
    if (!existing) {
      dedupedByStudentUserId.set(id, m);
      continue;
    }
    const existingJoinedAt = (
      existing as unknown as { joinedAt?: Date }
    ).joinedAt;
    const candidateJoinedAt = (m as unknown as { joinedAt?: Date }).joinedAt;
    if (
      existingJoinedAt instanceof Date &&
      candidateJoinedAt instanceof Date &&
      candidateJoinedAt.getTime() < existingJoinedAt.getTime()
    ) {
      dedupedByStudentUserId.set(id, m);
    }
  }
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const m of memberships) {
    const id = m.studentUserId;
    if (typeof id !== "string" || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const winner = dedupedByStudentUserId.get(id);
    if (winner) ordered.push(id);
  }
  return {
    orderedStudentUserIds: ordered,
    dedupedCount: ordered.length,
  };
}

// =============================================================================
// Roster snapshot builder
// =============================================================================

/**
 * Builds an immutable roster snapshot for the requested class.
 *
 * The function:
 *
 *   1. Lists ACTIVE `ClassMembership` rows for the class,
 *      sorted `joinedAt` ASC (oldest-first).
 *   2. Deduplicates by `studentUserId`, keeping the earliest row.
 *   3. Batch-loads the referenced `Profile` documents in ONE
 *      `getStudentProfilesByUserIds(...)` query — no N+1, no
 *      application-memory scan.
 *   4. Composes the snapshot items in `joinedAt` ASC order. Each
 *      item contains `studentUserId`, `fullNameSnapshot`, and
 *      `identificationCodeSnapshot`.
 *
 * Failure modes:
 *
 *   - Empty roster → returns `[]`. An empty valid class roster
 *     is allowed.
 *   - Any active membership that cannot be resolved to a valid
 *     COMPLETED student Profile throws
 *     `AttendanceSessionServiceError(ATTENDANCE_ROSTER_INVALID)`.
 *     The start Server Action surfaces the failure; corrupt
 *     memberships are NEVER silently carried into the attendance
 *     roster. The read/start path NEVER mutates / deletes the
 *     corrupt membership.
 *   - `ProfileModel.find({...})` / lookup failure → throws
 *     `AttendanceSessionServiceError(ATTENDANCE_SESSION_CREATE_FAILED)`.
 *
 * The function is server-only.
 */
export async function buildAttendanceRosterSnapshot(
  classId: Types.ObjectId,
): Promise<AttendanceRosterSnapshotItemDoc[]> {
  await ensureConnection();

  // 1. List active memberships.
  const memberships = await listActiveMembershipsByClassId(classId);

  // 2. Deterministic, deduplicated, ordered studentUserId list.
  const { orderedStudentUserIds } = collectActiveStudentUserIds(memberships);
  if (orderedStudentUserIds.length === 0) {
    return [];
  }

  // 3. Single batched Profile lookup.
  const profileMap: Map<string, SafeStudentProfileProjection> =
    await getStudentProfilesByUserIds(orderedStudentUserIds);

  // 4. Compose snapshot in joinedAt ASC order. Reject the entire
  //    snapshot if ANY active membership cannot be resolved to a
  //    valid completed student Profile.
  const items: AttendanceRosterSnapshotItemDoc[] = [];
  for (const studentUserId of orderedStudentUserIds) {
    const profile = profileMap.get(studentUserId);
    if (!profile) {
      throw new AttendanceSessionServiceError({
        code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_ROSTER_INVALID,
        message:
          "Cannot start attendance: an active membership points at a missing, incomplete, or non-student Profile.",
      });
    }
    items.push({
      studentUserId: profile.userId,
      fullNameSnapshot: profile.fullName,
      identificationCodeSnapshot: profile.identificationCode,
    });
  }
  return items;
}

// =============================================================================
// Input types
// =============================================================================

/**
 * Input for creating an AttendanceSession via the service layer.
 *
 * `startedByUserId` is the authoritative Better Auth user ID supplied
 * by the server caller (e.g. from `session.user.id`). It is NOT
 * accepted from the browser.
 */
export interface CreateAttendanceSessionInput {
  classId: Types.ObjectId;
  startedByUserId: string;
}

// =============================================================================
// Service functions
// =============================================================================

/**
 * Returns the single ACTIVE attendance session for `classId`, or
 * `null` when no active session exists.
 *
 * The query uses the partial unique index — at most one
 * `status: "active"` document exists per classId at any time.
 * The function never throws on a missing session.
 */
export async function findActiveAttendanceSessionByClassId(
  classId: Types.ObjectId,
): Promise<AttendanceSessionAttrs | null> {
  await ensureConnection();
  const doc = await AttendanceSessionModel.findOne({
    classId,
    status: "active",
  })
    .lean<AttendanceSessionAttrs | null>()
    .exec();
  return doc ?? null;
}

/**
 * Retrieves an AttendanceSession by its database `_id`.
 *
 * Returns `null` if no session exists with the given id. Never
 * throws on a missing document.
 */
export async function findAttendanceSessionById(
  id: Types.ObjectId | string,
): Promise<AttendanceSessionAttrs | null> {
  await ensureConnection();
  const doc = await AttendanceSessionModel.findById(id)
    .lean<AttendanceSessionAttrs | null>()
    .exec();
  return doc ?? null;
}

/**
 * Lists attendance sessions for `classId`, sorted by `startedAt`
 * DESCENDING (newest first). Returns an empty array when no
 * sessions match.
 */
export async function listAttendanceSessionsByClassId(
  classId: Types.ObjectId,
): Promise<AttendanceSessionAttrs[]> {
  await ensureConnection();
  const docs = await AttendanceSessionModel.find({ classId })
    .sort({ startedAt: -1 })
    .lean<AttendanceSessionAttrs[]>()
    .exec();
  return docs;
}

/**
 * Creates a new AttendanceSession with `status: "active"`.
 *
 * Behavior:
 *
 *   1. The caller MUST have already verified authorization
 *      (teacher owns the class, class is `active`). This function
 *      performs NO auth / role / class-status check — those are
 *      the start Server Action's responsibility.
 *   2. The function builds the immutable roster snapshot
 *      server-side via `buildAttendanceRosterSnapshot(classId)`.
 *      The roster is NEVER accepted from the caller.
 *   3. The function inserts the document with `status: "active"`.
 *      A MongoDB `E11000` collision on the partial unique
 *      `(classId, status) WHERE status === "active"` index is
 *      classified precisely via
 *      `isAttendanceSessionActiveDuplicateKeyError` and mapped
 *      to `AttendanceSessionServiceError(ATTENDANCE_SESSION_ALREADY_ACTIVE)`.
 *      The start Server Action surfaces the typed error as a safe
 *      idempotent success.
 *   4. Any other persistence failure → typed
 *      `AttendanceSessionServiceError(ATTENDANCE_SESSION_CREATE_FAILED)`.
 *
 * Returns the created document (without the persisted
 * `rosterSnapshot` payload — callers must not surface the snapshot
 * to the browser).
 */
export async function createAttendanceSession(
  input: CreateAttendanceSessionInput,
): Promise<AttendanceSessionAttrs> {
  await ensureConnection();

  const rosterSnapshot = await buildAttendanceRosterSnapshot(input.classId);

  try {
    const doc = await AttendanceSessionModel.create({
      classId: input.classId,
      status: "active",
      startedAt: new Date(),
      endedAt: null,
      startedByUserId: input.startedByUserId,
      rosterSnapshot,
    });
    return doc.toObject() as AttendanceSessionAttrs;
  } catch (err: unknown) {
    if (isAttendanceSessionActiveDuplicateKeyError(err)) {
      throw new AttendanceSessionServiceError({
        code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_SESSION_ALREADY_ACTIVE,
        message:
          "An active attendance session already exists for this class.",
      });
    }
    if (err instanceof AttendanceSessionServiceError) throw err;
    if (err instanceof mongoose.Error.ValidationError) {
      throw new AttendanceSessionServiceError({
        code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_ROSTER_INVALID,
        message: "Cannot start attendance: the roster is invalid.",
      });
    }
    throw new AttendanceSessionServiceError({
      code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_SESSION_CREATE_FAILED,
      message: "Failed to create attendance session.",
    });
  }
}

/**
 * Atomically closes the ACTIVE attendance session for `classId`.
 *
 * The update is a single atomic `findOneAndUpdate` whose filter
 * encodes the precondition `status: "active"`. A `null` result
 * means either:
 *
 *   - no session exists for the class, or
 *   - the session exists but is already `closed`.
 *
 * The function maps a `null` result to typed
 * `AttendanceSessionServiceError(ATTENDANCE_SESSION_NOT_ACTIVE)`.
 * The start/stop Server Action surfaces the typed error as a safe
 * idempotent stop.
 *
 * On success the function returns the updated document with
 * `status: "closed"` and `endedAt: <server current time>`. The
 * `rosterSnapshot` is preserved verbatim — closing never mutates
 * the immutable snapshot.
 */
export async function closeActiveAttendanceSessionForClass(
  classId: Types.ObjectId,
): Promise<AttendanceSessionAttrs> {
  await ensureConnection();

  const now = new Date();
  const updated = await AttendanceSessionModel.findOneAndUpdate(
    { classId, status: "active" },
    { $set: { status: "closed", endedAt: now } },
    { new: true },
  )
    .lean<AttendanceSessionAttrs | null>()
    .exec();

  if (!updated) {
    throw new AttendanceSessionServiceError({
      code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_SESSION_NOT_ACTIVE,
      message:
        "There is no active attendance session for this class to close.",
    });
  }
  return updated;
}

/**
 * Browser-safe summary projection of an AttendanceSession.
 *
 * The projection deliberately omits:
 *
 *   - `startedByUserId` — the teacher id is server-internal.
 *   - `rosterSnapshot`  — the snapshot is persistence data, NOT a
 *                          browser DTO. The start / stop Server
 *                          Actions surface only `rosterCount`.
 *   - `classId`         — already known by the caller from the
 *                          Server Action input.
 *   - Mongoose internals (`__v`).
 *
 * `id` is the canonical Mongo `_id.toString()` value so the
 * browser can correlate a session with later server reads without
 * ever receiving a raw ObjectId or a Mongoose document.
 */
export interface SafeAttendanceSessionSummary {
  id: string;
  status: AttendanceSessionStatus;
  startedAt: string;
  endedAt: string | null;
  rosterCount: number;
}

/**
 * Projects an AttendanceSession persistence document into the
 * browser-safe summary DTO.
 *
 * The function is total: missing / malformed fields collapse to
 * safe defaults rather than throwing. Date fields are converted
 * to ISO 8601 strings so the result is `JSON.stringify`-safe.
 */
export function toSafeAttendanceSessionSummary(
  doc: AttendanceSessionAttrs,
): SafeAttendanceSessionSummary {
  const idSource = (doc as unknown as { _id?: Types.ObjectId | string })._id;
  const id =
    idSource !== undefined && idSource !== null ? String(idSource) : "";
  const status: AttendanceSessionStatus =
    doc.status === "closed" ? "closed" : "active";
  const startedAtRaw = (doc as unknown as { startedAt?: Date }).startedAt;
  const startedAt =
    startedAtRaw instanceof Date
      ? startedAtRaw.toISOString()
      : new Date(startedAtRaw as unknown as string).toISOString();
  const endedAtRaw = (doc as unknown as { endedAt?: Date | null }).endedAt;
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
