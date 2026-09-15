/**
 * Class service layer.
 *
 * PHASE 5.1A — Class + Membership persistence foundation.
 *
 * Encapsulates all reads and writes against the `classes` collection.
 * Server Components, Server Actions, and Route Handlers call this module
 * instead of touching the Mongoose model directly.
 *
 * Key invariants:
 *   - `teacherUserId` comes from the authoritative server session — never
 *     from the request body.
 *   - `classCode` is normalized at write time; lookups always use the
 *     same normalization function.
 *   - The model stores only `passwordHash` — plaintext passwords are
 *     accepted only by `hashClassPassword()`, which returns a hash.
 *   - `getClassByCode` returns the internal persistence type; callers
 *     must convert to `SafeClassDto` before passing to the browser.
 *
 * This module is server-only.
 */

import "server-only";

import { getMongooseConnection } from "@/lib/mongoose";
import {
  ClassModel,
  type ClassAttrs,
  type SafeClassDto,
  toSafeClassDto,
} from "@/lib/classes/class-model";
import {
  generateClassCode,
  normalizeClassCode,
} from "@/lib/classes/class-code";
import { hashClassPassword } from "@/lib/classes/class-password";
import type { Types } from "mongoose";

// =============================================================================
// Connection
// =============================================================================

/**
 * Lazily ensures the Mongoose connection is ready before any model operation.
 */
async function ensureConnection(): Promise<void> {
  await getMongooseConnection();
}

// =============================================================================
// Service errors
// =============================================================================

/**
 * Application-level error codes for class operations.
 */
export const CLASS_ERROR_CODES = {
  CLASS_NOT_FOUND: "CLASS_NOT_FOUND",
  CLASS_CODE_ALREADY_EXISTS: "CLASS_CODE_ALREADY_EXISTS",
  CLASS_CREATE_FAILED: "CLASS_CREATE_FAILED",
} as const;

export type ClassErrorCode =
  (typeof CLASS_ERROR_CODES)[keyof typeof CLASS_ERROR_CODES];

export class ClassServiceError extends Error {
  readonly code: ClassErrorCode;

  constructor({ code, message }: { code: ClassErrorCode; message: string }) {
    super(message);
    this.name = "ClassServiceError";
    this.code = code;
  }
}

// =============================================================================
// Input types
// =============================================================================

/**
 * Input for creating a new class.
 *
 * `teacherUserId` is the authoritative Better Auth user ID supplied by the
 * server caller (e.g. from `session.user.id`). It is NOT accepted from
 * the browser.
 */
export interface CreateClassInput {
  name: string;
  teacherUserId: string;
  rawPassword: string;
  /** Optional pre-normalized class code. If not supplied, a new one is generated. */
  classCode?: string;
}

// =============================================================================
// Service functions
// =============================================================================

/**
 * Retrieves a class by its database `_id`.
 *
 * Returns `null` if no class exists with the given id.
 *
 * Authorization is the caller's responsibility.
 */
export async function getClassById(
  id: string | Types.ObjectId,
): Promise<ClassAttrs | null> {
  await ensureConnection();
  const doc = await ClassModel.findById(id)
    .lean<ClassAttrs>()
    .exec();
  return doc ?? null;
}

/**
 * Retrieves a class by its normalized `classCode`.
 *
 * The input `code` is normalized before the query so that case variations
 * and whitespace are handled correctly.
 *
 * Returns `null` if no class exists with the given code.
 */
export async function getClassByCode(code: string): Promise<ClassAttrs | null> {
  await ensureConnection();
  const normalized = normalizeClassCode(code);
  const doc = await ClassModel.findOne({ classCode: normalized })
    .lean<ClassAttrs>()
    .exec();
  return doc ?? null;
}

/**
 * Lists all classes owned by the given teacher.
 *
 * Returns classes sorted by `createdAt` descending (newest first).
 *
 * Authorization is the caller's responsibility.
 */
export async function listClassesByTeacherUserId(
  teacherUserId: string,
): Promise<ClassAttrs[]> {
  await ensureConnection();
  const docs = await ClassModel.find({ teacherUserId })
    .sort({ createdAt: -1 })
    .lean<ClassAttrs[]>()
    .exec();
  return docs as ClassAttrs[];
}

/**
 * Creates a new class.
 *
 * - Generates a unique class code if not provided.
 * - Hashes the password using PBKDF2.
 * - Normalizes the class code to canonical uppercase form.
 * - Throws `ClassServiceError` on duplicate class code (unique index violation).
 *
 * Returns the created class as a `SafeClassDto` (no passwordHash).
 *
 * Note: this function does NOT enforce teacher role. Future server
 * orchestration must verify the caller is a teacher before calling.
 */
export async function createClass(
  input: CreateClassInput,
): Promise<SafeClassDto> {
  await ensureConnection();

  // Generate or use provided code, then normalize.
  const rawCode = input.classCode ?? generateClassCode();
  const classCode = normalizeClassCode(rawCode);

  // Hash the password immediately. We never store the raw password.
  const passwordHash = await hashClassPassword(input.rawPassword);

  try {
    const doc = await ClassModel.create({
      name: input.name.trim(),
      teacherUserId: input.teacherUserId,
      classCode,
      passwordHash,
      status: "active",
    });

    return toSafeClassDto(doc);
  } catch (err: unknown) {
    // Handle MongoDB duplicate-key error on classCode.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: number }).code === 11000
    ) {
      throw new ClassServiceError({
        code: CLASS_ERROR_CODES.CLASS_CODE_ALREADY_EXISTS,
        message: "A class with this code already exists. Please try again.",
      });
    }
    // Re-throw ClassServiceError unchanged so specific codes are preserved.
    if (err instanceof ClassServiceError) throw err;
    throw new ClassServiceError({
      code: CLASS_ERROR_CODES.CLASS_CREATE_FAILED,
      message: "Failed to create class.",
    });
  }
}

// =============================================================================
// Public helpers
// =============================================================================

/**
 * Converts a Class document to a safe DTO for browser-facing code.
 *
 * Use this when passing class data out of the server layer.
 */
export { toSafeClassDto };

/** Re-export the safe DTO type for convenience. */
export type { SafeClassDto } from "@/lib/classes/class-model";
