/**
 * ClassMembership Mongoose model.
 *
 * PHASE 5.1A — Class + Membership persistence foundation.
 *
 * Collection: `class_memberships`
 *
 * Schema:
 *   - `classId`        — reference to `classes._id`. Required, indexed.
 *   - `studentUserId` — Better Auth user who joined. Required, indexed.
 *   - `joinedAt`      — when the student joined. Required.
 *   - `status`        — membership status. Defaults to `active`.
 *
 * Indexes:
 *   - Compound unique on `(classId, studentUserId)` — enforces at most one
 *     membership per student per class at the database layer.
 *   - Index on `studentUserId` for "list memberships by student" queries.
 *   - Index on `classId` is covered by the compound index (MongoDB can
 *     use it for "list memberships by class" queries).
 *
 * Privacy posture:
 *   - No biometric fields are present.
 *   - No attendance fields are present (those belong to later phases).
 *   - No FaceProfile or centroid references.
 *
 * Better Auth collections (`user`, `account`, `session`, `verification`)
 * are NOT modified by this model.
 */

import mongoose, {
  type HydratedDocument,
  type Model,
  Schema,
  type Types,
} from "mongoose";

/**
 * Membership status enum.
 *
 * `active` — student is an active member of the class.
 *
 * Future statuses (e.g. `removed`) may be added in later phases
 * when a teacher can kick a student or a student can leave.
 */
export const MEMBERSHIP_STATUSES = ["active"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/**
 * Plain TypeScript representation of a ClassMembership document.
 *
 * Used internally by service functions that operate on persistence documents.
 */
export interface ClassMembershipAttrs {
  classId: Types.ObjectId;
  studentUserId: string;
  joinedAt: Date;
  status: MembershipStatus;
}

// =============================================================================
// Schema
// =============================================================================

const ClassMembershipSchema = new Schema<ClassMembershipAttrs>(
  {
    classId: {
      type: Schema.Types.ObjectId,
      ref: "Class",
      required: [true, "classId is required."],
      index: true,
    },
    studentUserId: {
      type: String,
      required: [true, "studentUserId is required."],
      index: true,
    },
    joinedAt: {
      type: Date,
      required: true,
      default: () => new Date(),
    },
    status: {
      type: String,
      enum: {
        values: MEMBERSHIP_STATUSES,
        message: "status must be one of: active.",
      },
      required: true,
      default: "active",
    },
  },
  {
    timestamps: true, // adds createdAt, updatedAt
    collection: "class_memberships",
  },
);

// =============================================================================
// Indexes
// =============================================================================

/**
 * Compound unique index on `(classId, studentUserId)`.
 * This is the authoritative guard against duplicate memberships.
 * A student may belong to a given class at most once.
 *
 * Note: The unique compound index also implicitly creates an index on
 * `classId` (the first field), so a separate index on `classId` is
 * not needed for class-first queries.
 */
ClassMembershipSchema.index(
  { classId: 1, studentUserId: 1 },
  { unique: true },
);

// =============================================================================
// Model reuse (hot-reload safe)
// =============================================================================

const modelKey = "ClassMembership";
export const ClassMembershipModel: Model<ClassMembershipAttrs> =
  (mongoose.models[modelKey] as Model<ClassMembershipAttrs> | undefined) ||
  mongoose.model<ClassMembershipAttrs>(modelKey, ClassMembershipSchema);

/**
 * Mongoose document type with full Mongoose semantics.
 */
export type ClassMembershipDoc = HydratedDocument<ClassMembershipAttrs>;

/**
 * Safe DTO for membership information exposed to browser-facing code.
 *
 * Uses string `classId` instead of ObjectId.
 */
export interface SafeMembershipDto {
  id: string;
  classId: string;
  studentUserId: string;
  joinedAt: Date;
  status: MembershipStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Converts a ClassMembership document to a safe DTO.
 */
export function toSafeMembershipDto(doc: ClassMembershipDoc): SafeMembershipDto {
  const d = doc as ClassMembershipDoc & {
    createdAt?: Date;
    updatedAt?: Date;
  };
  return {
    id: doc._id.toString(),
    classId: doc.classId.toString(),
    studentUserId: doc.studentUserId,
    joinedAt: doc.joinedAt,
    status: doc.status,
    createdAt: d.createdAt ?? doc.joinedAt,
    updatedAt: d.updatedAt ?? doc.joinedAt,
  };
}
