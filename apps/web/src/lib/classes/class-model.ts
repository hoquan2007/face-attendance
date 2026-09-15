/**
 * Class Mongoose model.
 *
 * PHASE 5.1A — Class + Membership persistence foundation.
 *
 * Collection: `classes`
 *
 * Schema:
 *   - `name`           — user-facing class name, trimmed, bounded length.
 *   - `teacherUserId`  — Better Auth user who owns the class. Required, indexed.
 *   - `classCode`      — unique, human-enterable code for joining. Required, unique index.
 *   - `passwordHash`   — one-way PBKDF2 hash of the join password. Required.
 *   - `status`         — `active` or `archived`. Defaults to `active`.
 *   - `createdAt`, `updatedAt` — Mongoose timestamps.
 *
 * Indexes:
 *   - `classCode` unique
 *   - `teacherUserId` index (for listing a teacher's classes)
 *
 * Privacy posture:
 *   - The model NEVER stores plaintext passwords.
 *   - `passwordHash` must never be serialized into browser-facing DTOs.
 *   - No biometric fields are present.
 *
 * Better Auth collections (`user`, `account`, `session`, `verification`)
 * are NOT modified by this model.
 */

import mongoose, {
  type HydratedDocument,
  type Model,
  Schema,
} from "mongoose";

/**
 * Class status enum.
 *
 * `active`   — class is open for students to join.
 * `archived` — class is no longer active; join is not allowed.
 *
 * Default: `active`.
 */
export const CLASS_STATUSES = ["active", "archived"] as const;
export type ClassStatus = (typeof CLASS_STATUSES)[number];

/**
 * Plain TypeScript representation of a Class document.
 *
 * Used internally by service functions that operate on persistence documents.
 * Consumer-facing code (pages, Server Actions) should use a safe DTO that
 * excludes `passwordHash`.
 */
export interface ClassAttrs {
  name: string;
  teacherUserId: string;
  classCode: string;
  passwordHash: string;
  status: ClassStatus;
  createdAt: Date;
  updatedAt: Date;
}

// =============================================================================
// Schema
// =============================================================================

const ClassSchema = new Schema<ClassAttrs>(
  {
    name: {
      type: String,
      required: [true, "Class name is required."],
      trim: true,
      minlength: [1, "Class name must not be empty."],
      maxlength: [200, "Class name must be at most 200 characters."],
    },
    teacherUserId: {
      type: String,
      required: [true, "teacherUserId is required."],
      index: true,
    },
    classCode: {
      type: String,
      required: [true, "classCode is required."],
      trim: true,
      minlength: [1, "classCode must not be empty."],
      maxlength: [20, "classCode must be at most 20 characters."],
      // unique index is added after schema definition
    },
    passwordHash: {
      type: String,
      required: [true, "passwordHash is required."],
    },
    status: {
      type: String,
      enum: {
        values: CLASS_STATUSES,
        message: "status must be one of: active, archived.",
      },
      required: true,
      default: "active",
    },
  },
  {
    timestamps: true,
    collection: "classes",
  },
);

// =============================================================================
// Indexes
// =============================================================================

/**
 * Unique index on `classCode`.
 * Enforces at most one class per canonical code.
 * Case-insensitivity is enforced by normalization at write time.
 */
ClassSchema.index({ classCode: 1 }, { unique: true });

/**
 * Index on `teacherUserId` for efficient "list classes by teacher" queries.
 */
ClassSchema.index({ teacherUserId: 1 });

/**
 * Compound index on `(teacherUserId, status)` is NOT added in PHASE 5.1A.
 * Future listing queries (e.g. "active classes only") can add it when
 * the actual query pattern is confirmed. Avoid speculative indexes.
 */

// =============================================================================
// Model reuse (hot-reload safe)
// =============================================================================

const modelKey = "Class";
export const ClassModel: Model<ClassAttrs> =
  (mongoose.models[modelKey] as Model<ClassAttrs> | undefined) ||
  mongoose.model<ClassAttrs>(modelKey, ClassSchema);

/**
 * Mongoose document type with full Mongoose semantics.
 */
export type ClassDoc = HydratedDocument<ClassAttrs>;

/**
 * Safe DTO for class information exposed to browser-facing code.
 *
 * Excludes `passwordHash` entirely.
 *
 * Used by Server Components and Server Actions that need to return
 * class data to the client.
 */
export interface SafeClassDto {
  id: string;
  name: string;
  teacherUserId: string;
  classCode: string;
  status: ClassStatus;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Converts a Class document to a safe DTO without passwordHash.
 *
 * This function must be used when passing class data to browser code.
 * Never spread the document directly into a response.
 */
export function toSafeClassDto(doc: ClassDoc): SafeClassDto {
  return {
    id: doc._id.toString(),
    name: doc.name,
    teacherUserId: doc.teacherUserId,
    classCode: doc.classCode,
    status: doc.status,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
