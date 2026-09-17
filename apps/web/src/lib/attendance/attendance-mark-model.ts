/**
 * AttendanceMark Mongoose model.
 *
 * PHASE 6.4 — IDEMPOTENT PRESENT ATTENDANCE MARKS.
 *
 * Collection: `attendance_marks`.
 *
 * This module introduces the FIRST per-student attendance
 * persistence artifact in the project. The collection stores one
 * PRESENT mark per `(sessionId, studentUserId)` pair, created
 * automatically by the authenticated face-recognition pipeline
 * (`POST /api/attendance/recognize`) when a Face Service match
 * passes the server-side `FACE_MATCH_THRESHOLD`.
 *
 * Schema:
 *
 *   - `_id`             — Mongoose-managed ObjectId.
 *   - `sessionId`       — reference to `attendance_sessions._id`.
 *                         Required, indexed.
 *   - `classId`         — reference to `classes._id`. Required,
 *                         indexed (kept for fast per-class
 *                         queries; the unique compound index
 *                         uses sessionId, not classId).
 *   - `studentUserId`   — Better Auth `user._id` from the
 *                         AttendanceSession's immutable
 *                         `rosterSnapshot`. Required.
 *   - `status`          — enum `"present"` only. The MVP writes
 *                         one present state per session per
 *                         student; absent / late / excused are
 *                         deliberately NOT represented here.
 *   - `recognizedAt`    — server-side wall-clock time of the
 *                         FIRST accepted recognition for this
 *                         `(sessionId, studentUserId)`. Repeated
 *                         recognition preserves this timestamp
 *                         — the first recognition wins.
 *   - `source`          — enum `"face_recognition"` only.
 *                         PHASE 6.4 introduces ONE source; later
 *                         phases may add additional values, but
 *                         manual override / teacher mark / absent
 *                         are deliberately NOT added.
 *   - `createdAt`,
 *     `updatedAt`       — Mongoose timestamps.
 *
 * Indexes:
 *
 *   1. `sessionId` index — supports per-session listing.
 *   2. `classId` index — supports per-class queries.
 *   3. PARTIAL UNIQUE compound on `(sessionId, studentUserId)`
 *      — enforces ONE mark per student per session at the
 *      database layer. This is the authoritative idempotency
 *      guard.
 *
 * Privacy posture:
 *
 *   - This collection stores PERSISTENCE DATA ONLY. The
 *     `studentUserId` value is INTERNAL persistence data and is
 *     NEVER exposed through browser DTOs.
 *   - No raw images, no embeddings, no centroids, no biometric
 *     ciphertext, no FaceProfile references are stored here.
 *   - No teacherUserId / startedByUserId is stored on the mark —
 *     teacher identity is recoverable through the linked session
 *     document when needed, but the mark itself is intentionally
 *     agnostic.
 *
 * Better Auth collections (`user`, `account`, `session`,
 * `verification`) are NOT modified by this model.
 */

import "server-only";

import mongoose, {
  type HydratedDocument,
  type Model,
  Schema,
  type Types,
} from "mongoose";

/**
 * AttendanceMark status enum.
 *
 * PHASE 6.4 introduces ONLY the `"present"` value. Absent / late /
 * excused / manual override are deliberate non-features in this
 * phase — they belong to a later phase.
 */
export const ATTENDANCE_MARK_STATUSES = ["present"] as const;
export type AttendanceMarkStatus =
  (typeof ATTENDANCE_MARK_STATUSES)[number];

/**
 * AttendanceMark source enum.
 *
 * PHASE 6.4 introduces ONLY the `"face_recognition"` value. The
 * only path that creates marks is the authenticated, server-side
 * face recognition pipeline after `FACE_MATCH_THRESHOLD` has
 * been satisfied by the Face Service.
 */
export const ATTENDANCE_MARK_SOURCES = ["face_recognition"] as const;
export type AttendanceMarkSource =
  (typeof ATTENDANCE_MARK_SOURCES)[number];

/**
 * Plain TypeScript representation of an AttendanceMark document.
 *
 * Used internally by service functions that operate on persistence
 * documents. Browser-facing code MUST use the safe DTO defined
 * alongside the service functions (which strips `studentUserId`
 * and the Mongo `_id`).
 */
export interface AttendanceMarkAttrs {
  sessionId: Types.ObjectId;
  classId: Types.ObjectId;
  studentUserId: string;
  status: AttendanceMarkStatus;
  recognizedAt: Date;
  source: AttendanceMarkSource;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// Main schema
// =============================================================================

const AttendanceMarkSchema = new Schema<AttendanceMarkAttrs>(
  {
    sessionId: {
      type: Schema.Types.ObjectId,
      ref: "AttendanceSession",
      required: [true, "sessionId is required."],
    },
    classId: {
      type: Schema.Types.ObjectId,
      ref: "Class",
      required: [true, "classId is required."],
    },
    studentUserId: {
      type: String,
      required: [true, "studentUserId is required."],
      trim: true,
      minlength: [
        1,
        "studentUserId must be a non-empty string.",
      ],
    },
    status: {
      type: String,
      enum: {
        values: ATTENDANCE_MARK_STATUSES,
        message:
          "status must be one of: present.",
      },
      required: true,
      default: "present",
    },
    recognizedAt: {
      type: Date,
      required: [true, "recognizedAt is required."],
      default: () => new Date(),
    },
    source: {
      type: String,
      enum: {
        values: ATTENDANCE_MARK_SOURCES,
        message:
          "source must be one of: face_recognition.",
      },
      required: true,
      default: "face_recognition",
    },
  },
  {
    timestamps: true,
    collection: "attendance_marks",
  },
);

// =============================================================================
// Indexes
// =============================================================================

/**
 * Plain index on `sessionId`.
 *
 * Supports per-session listing of marks. The unique compound
 * index below ALSO starts with `sessionId`, so this index is
 * technically redundant for that specific lookup pattern, but
 * it remains cheap and explicit so MongoDB can serve simple
 * per-session range queries without consulting the unique
 * index's filter expression.
 */
AttendanceMarkSchema.index({ sessionId: 1 });

/**
 * Plain index on `classId`.
 *
 * Supports per-class aggregation queries (e.g. "how many present
 * marks exist for class X"). The unique compound index below
 * uses `(sessionId, studentUserId)` and therefore does not
 * cover classId-only lookups.
 */
AttendanceMarkSchema.index({ classId: 1 });

/**
 * COMPOUND UNIQUE index on `(sessionId, studentUserId)`.
 *
 * This is the authoritative database-level enforcement of the
 * "one student = max one mark per session" rule. A repeated
 * recognition of the same student surfaces as an E11000 duplicate
 * key error which the service layer classifies precisely and
 * folds into a safe idempotent success — the existing
 * `recognizedAt` timestamp is preserved verbatim (first accepted
 * recognition wins) and no second mark is created.
 *
 * Different `sessionId` values are allowed to share the same
 * `studentUserId` (a student may be marked present across many
 * historical sessions).
 *
 * Index naming is explicit so the index is observable in
 * `db.attendance_marks.getIndexes()`.
 */
AttendanceMarkSchema.index(
  { sessionId: 1, studentUserId: 1 },
  {
    unique: true,
    name: "sessionId_studentUserId_unique",
  },
);

// =============================================================================
// Model reuse (hot-reload safe)
// =============================================================================

const modelKey = "AttendanceMark";
export const AttendanceMarkModel: Model<AttendanceMarkAttrs> =
  (mongoose.models[modelKey] as Model<AttendanceMarkAttrs> | undefined) ||
  mongoose.model<AttendanceMarkAttrs>(modelKey, AttendanceMarkSchema);

/**
 * Mongoose document type with full Mongoose semantics.
 */
export type AttendanceMarkDoc = HydratedDocument<AttendanceMarkAttrs>;
