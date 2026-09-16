/**
 * AttendanceSession Mongoose model.
 *
 * PHASE 6.1 — ATTENDANCE SESSION FOUNDATION (TEACHER START/STOP +
 * IMMUTABLE ROSTER SNAPSHOT).
 *
 * Collection: `attendance_sessions`
 *
 * Schema:
 *   - `classId`           — reference to `classes._id`. Required, indexed.
 *   - `status`            — `"active"` | `"closed"`. Required, indexed.
 *   - `startedAt`         — wall-clock start time (server-side).
 *   - `endedAt`           — wall-clock end time, `null` while active.
 *   - `startedByUserId`   — Better Auth `user._id` of the teacher who
 *                            started the session. Required.
 *   - `rosterSnapshot`    — immutable, server-built array of
 *                            `studentUserId` + `fullNameSnapshot` +
 *                            `identificationCodeSnapshot` items
 *                            captured at session start time.
 *   - `createdAt`, `updatedAt` — Mongoose timestamps.
 *
 * Indexes:
 *   - `classId` index supports per-class listing.
 *   - `status` index supports active-session filtering.
 *   - `startedAt` index supports chronological listing.
 *   - PARTIAL UNIQUE compound on `(classId, status)` WHERE
 *     `status === "active"` enforces at most one active session per
 *     class. The unique constraint is partial so that a class may have
 *     many CLOSED sessions but only ONE ACTIVE session at any time.
 *
 * Privacy posture:
 *   - `rosterSnapshot` carries `fullNameSnapshot` +
 *     `identificationCodeSnapshot` which are HISTORICAL values taken
 *     at session start. They are persistence data, NOT browser DTOs.
 *     The snapshot is intentionally NOT re-exported through any
 *     browser-facing Server Action result.
 *   - No `passwordHash`, no `embedding`, no `centroid`, no raw
 *     biometric / Better Auth data are stored on this collection.
 *
 * Better Auth collections (`user`, `account`, `session`, `verification`)
 * are NOT modified by this model.
 */

import "server-only";

import mongoose, {
  type HydratedDocument,
  type Model,
  Schema,
  type Types,
} from "mongoose";

/**
 * AttendanceSession status enum.
 *
 * `active` — session is currently running; teacher has not yet stopped it.
 * `closed` — session has been stopped by the teacher (or by an admin
 *            action in a later phase).
 *
 * Default: not used at the schema level. New sessions are always created
 * with `status: "active"` by the start Server Action.
 */
export const ATTENDANCE_SESSION_STATUSES = ["active", "closed"] as const;
export type AttendanceSessionStatus =
  (typeof ATTENDANCE_SESSION_STATUSES)[number];

/**
 * One immutable entry inside `AttendanceSession.rosterSnapshot`.
 *
 * The snapshot is persistence data only; it is NEVER projected into a
 * browser-facing Server Action result. The internal shape exists so
 * later attendance-recognition phases can correlate recognized faces
 * against the captured roster without re-querying Profile / Membership
 * (which may have changed since the session started).
 *
 * Fields:
 *   - `studentUserId`              — Better Auth `user._id` from the
 *                                    ClassMembership row at start time.
 *   - `fullNameSnapshot`           — `Profile.fullName` at start time.
 *   - `identificationCodeSnapshot` — `Profile.identificationCode` at
 *                                    start time.
 */
export interface AttendanceRosterSnapshotItemDoc {
  studentUserId: string;
  fullNameSnapshot: string;
  identificationCodeSnapshot: string;
}

/**
 * Plain TypeScript representation of an AttendanceSession document.
 *
 * Used internally by service functions that operate on persistence
 * documents. Consumer-facing code (Server Actions) should use the
 * safe DTO defined alongside the service functions, which strips
 * `startedByUserId` and the full `rosterSnapshot` payload.
 */
export interface AttendanceSessionAttrs {
  classId: Types.ObjectId;
  status: AttendanceSessionStatus;
  startedAt: Date;
  endedAt: Date | null;
  startedByUserId: string;
  rosterSnapshot: AttendanceRosterSnapshotItemDoc[];
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// Sub-schema: roster snapshot item
// =============================================================================

const AttendanceRosterSnapshotItemSchema =
  new Schema<AttendanceRosterSnapshotItemDoc>(
    {
      studentUserId: {
        type: String,
        required: [true, "rosterSnapshot.studentUserId is required."],
        trim: true,
        minlength: [
          1,
          "rosterSnapshot.studentUserId must be a non-empty string.",
        ],
      },
      fullNameSnapshot: {
        type: String,
        required: [true, "rosterSnapshot.fullNameSnapshot is required."],
        trim: true,
        minlength: [
          1,
          "rosterSnapshot.fullNameSnapshot must be a non-empty string.",
        ],
      },
      identificationCodeSnapshot: {
        type: String,
        required: [
          true,
          "rosterSnapshot.identificationCodeSnapshot is required.",
        ],
        trim: true,
        minlength: [
          1,
          "rosterSnapshot.identificationCodeSnapshot must be a non-empty string.",
        ],
      },
    },
    {
      _id: false,
    },
  );

// =============================================================================
// Main schema
// =============================================================================

const AttendanceSessionSchema = new Schema<AttendanceSessionAttrs>(
  {
    classId: {
      type: Schema.Types.ObjectId,
      ref: "Class",
      required: [true, "classId is required."],
    },
    status: {
      type: String,
      enum: {
        values: ATTENDANCE_SESSION_STATUSES,
        message:
          "status must be one of: active, closed.",
      },
      required: true,
      default: "active",
    },
    startedAt: {
      type: Date,
      required: [true, "startedAt is required."],
      default: () => new Date(),
    },
    endedAt: {
      type: Date,
      required: false,
      default: null,
    },
    startedByUserId: {
      type: String,
      required: [true, "startedByUserId is required."],
      trim: true,
      minlength: [1, "startedByUserId must be a non-empty string."],
    },
    rosterSnapshot: {
      type: [AttendanceRosterSnapshotItemSchema],
      required: true,
      default: [],
    },
  },
  {
    timestamps: true,
    collection: "attendance_sessions",
  },
);

// =============================================================================
// Indexes
// =============================================================================

/**
 * Index on `classId`.
 * Supports per-class chronological listing
 * (`find({ classId }).sort({ startedAt: -1 })`).
 *
 * The partial unique index below also starts with `classId`, so a
 * separate index on `classId` alone is REDUNDANT for the
 * active-session-uniqueness lookup. We still declare it because the
 * existing query pattern ("list sessions by class, newest first")
 * filters on `classId` only — Mongo will reuse the partial index,
 * but a plain `classId` index is cheaper to maintain and read for
 * non-active status filters.
 */
AttendanceSessionSchema.index({ classId: 1 });

/**
 * Index on `status`.
 * Supports the active-session lookup
 * (`find({ classId, status: "active" })`).
 *
 * The partial unique index below is the actual enforcement
 * primitive; this plain index exists so non-active queries
 * (e.g. dashboard filtering) do not have to scan the whole
 * collection.
 */
AttendanceSessionSchema.index({ status: 1 });

/**
 * Index on `startedAt`.
 * Supports chronological session listings. A future attendance
 * UI / history page will likely query
 * `find({ classId }).sort({ startedAt: -1 })`.
 */
AttendanceSessionSchema.index({ startedAt: -1 });

/**
 * PARTIAL UNIQUE compound index on `(classId, status)` WHERE
 * `status === "active"`.
 *
 * Enforces at most ONE active AttendanceSession per class at the
 * database layer. Two concurrent `start` requests cannot both
 * insert an active session — the second insert loses the unique
 * race with a MongoDB `E11000` error, which the service layer
 * recognizes precisely and folds into a safe idempotent success.
 *
 * Closed sessions are intentionally NOT subject to this constraint
 * (the partial filter excludes them), so a class may accumulate
 * any number of historical CLOSED sessions.
 *
 * Index naming is explicit so the index is observable in `db.attendance_sessions.getIndexes()`.
 */
AttendanceSessionSchema.index(
  { classId: 1, status: 1 },
  {
    unique: true,
    partialFilterExpression: { status: "active" },
    name: "classId_status_active_unique",
  },
);

// =============================================================================
// Model reuse (hot-reload safe)
// =============================================================================

const modelKey = "AttendanceSession";
export const AttendanceSessionModel: Model<AttendanceSessionAttrs> =
  (mongoose.models[modelKey] as Model<AttendanceSessionAttrs> | undefined) ||
  mongoose.model<AttendanceSessionAttrs>(modelKey, AttendanceSessionSchema);

/**
 * Mongoose document type with full Mongoose semantics.
 */
export type AttendanceSessionDoc =
  HydratedDocument<AttendanceSessionAttrs>;
