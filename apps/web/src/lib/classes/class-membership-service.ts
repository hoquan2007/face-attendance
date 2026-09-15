/**
 * ClassMembership service layer.
 *
 * PHASE 5.1A — Class + Membership persistence foundation.
 *
 * Encapsulates all reads and writes against the `class_memberships`
 * collection. Server Components, Server Actions, and Route Handlers call
 * this module instead of touching the Mongoose model directly.
 *
 * Key invariants:
 *   - `studentUserId` comes from the authoritative server session — never
 *     from the request body.
 *   - The unique compound index `(classId, studentUserId)` is the
 *     authoritative guard against duplicate memberships.
 *   - No role enforcement happens here. Future phases will verify student
 *     role before `createMembership` is called.
 *
 * This module is server-only.
 */

import "server-only";

import { getMongooseConnection } from "@/lib/mongoose";
import {
  ClassMembershipModel,
  type ClassMembershipAttrs,
  type SafeMembershipDto,
  toSafeMembershipDto,
} from "@/lib/classes/class-membership-model";
import { Types } from "mongoose";

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
 * Application-level error codes for membership operations.
 */
export const MEMBERSHIP_ERROR_CODES = {
  MEMBERSHIP_NOT_FOUND: "MEMBERSHIP_NOT_FOUND",
  MEMBERSHIP_ALREADY_EXISTS: "MEMBERSHIP_ALREADY_EXISTS",
  MEMBERSHIP_CREATE_FAILED: "MEMBERSHIP_CREATE_FAILED",
} as const;

export type MembershipErrorCode =
  (typeof MEMBERSHIP_ERROR_CODES)[keyof typeof MEMBERSHIP_ERROR_CODES];

export class MembershipServiceError extends Error {
  readonly code: MembershipErrorCode;

  constructor({ code, message }: { code: MembershipErrorCode; message: string }) {
    super(message);
    this.name = "MembershipServiceError";
    this.code = code;
  }
}

// =============================================================================
// Input types
// =============================================================================

/**
 * Input for creating a new membership.
 *
 * `studentUserId` is the authoritative Better Auth user ID supplied by the
 * server caller. It is NOT accepted from the browser.
 */
export interface CreateMembershipInput {
  classId: string | Types.ObjectId;
  studentUserId: string;
}

// =============================================================================
// Service functions
// =============================================================================

/**
 * Retrieves a membership by its database `_id`.
 *
 * Returns `null` if no membership exists with the given id.
 */
export async function getMembershipById(
  id: string | Types.ObjectId,
): Promise<ClassMembershipAttrs | null> {
  await ensureConnection();
  const doc = await ClassMembershipModel.findById(id)
    .lean<ClassMembershipAttrs>()
    .exec();
  return doc ?? null;
}

/**
 * Retrieves the membership for a specific student in a specific class.
 *
 * Returns `null` if no such membership exists.
 */
export async function getMembership(
  classId: string | Types.ObjectId,
  studentUserId: string,
): Promise<ClassMembershipAttrs | null> {
  await ensureConnection();
  const doc = await ClassMembershipModel.findOne({
    classId: new Types.ObjectId(classId.toString()),
    studentUserId,
  })
    .lean<ClassMembershipAttrs>()
    .exec();
  return doc ?? null;
}

/**
 * Lists all memberships for a given student.
 *
 * Returns memberships sorted by `joinedAt` descending.
 */
export async function listMembershipsByStudentUserId(
  studentUserId: string,
): Promise<ClassMembershipAttrs[]> {
  await ensureConnection();
  const docs = await ClassMembershipModel.find({ studentUserId })
    .sort({ joinedAt: -1 })
    .lean<ClassMembershipAttrs[]>()
    .exec();
  return docs as ClassMembershipAttrs[];
}

/**
 * Lists all memberships for a given class.
 *
 * Returns memberships sorted by `joinedAt` descending.
 */
export async function listMembershipsByClassId(
  classId: string | Types.ObjectId,
): Promise<ClassMembershipAttrs[]> {
  await ensureConnection();
  const docs = await ClassMembershipModel.find({
    classId: new Types.ObjectId(classId.toString()),
  })
    .sort({ joinedAt: -1 })
    .lean<ClassMembershipAttrs[]>()
    .exec();
  return docs as ClassMembershipAttrs[];
}

/**
 * Creates a new class membership.
 *
 * - Checks are not performed here — the unique compound index is the
 *   authoritative guard against duplicates.
 * - Throws `MembershipServiceError` on duplicate membership (index violation).
 *
 * Returns the created membership as a `SafeMembershipDto`.
 *
 * Note: this function does NOT enforce student role or verify the class
 * password. Future server orchestration must perform those checks before
 * calling `createMembership`.
 */
export async function createMembership(
  input: CreateMembershipInput,
): Promise<SafeMembershipDto> {
  await ensureConnection();

  try {
    const doc = await ClassMembershipModel.create({
      classId: new Types.ObjectId(input.classId.toString()),
      studentUserId: input.studentUserId,
      joinedAt: new Date(),
      status: "active",
    });

    return toSafeMembershipDto(doc);
  } catch (err: unknown) {
    // Handle MongoDB duplicate-key error on (classId, studentUserId).
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: number }).code === 11000
    ) {
      throw new MembershipServiceError({
        code: MEMBERSHIP_ERROR_CODES.MEMBERSHIP_ALREADY_EXISTS,
        message: "You are already a member of this class.",
      });
    }
    // Re-throw MembershipServiceError unchanged so the test error code
    // assertion (e.g. ALREADY_EXISTS via test setup) is preserved.
    if (err instanceof MembershipServiceError) throw err;
    throw new MembershipServiceError({
      code: MEMBERSHIP_ERROR_CODES.MEMBERSHIP_CREATE_FAILED,
      message: "Failed to create membership.",
    });
  }
}

// =============================================================================
// Public helpers
// =============================================================================

/**
 * Converts a ClassMembership document to a safe DTO for browser-facing code.
 *
 * Use this when passing membership data out of the server layer.
 */
export { toSafeMembershipDto };

/** Re-export the safe DTO type for convenience. */
export type { SafeMembershipDto } from "@/lib/classes/class-membership-model";
