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
  type ClassMembershipDoc,
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
 *
 * PHASE 5.1C introduces `MEMBERSHIP_ALREADY_JOINED` for the
 * server-only "this student has already joined this class" case.
 * The legacy coarse `MEMBERSHIP_ALREADY_EXISTS` constant is
 * preserved as an alias so callers that pre-date 5.1C continue to
 * work. New code MUST use `MEMBERSHIP_ALREADY_JOINED`.
 */
export const MEMBERSHIP_ERROR_CODES = {
  MEMBERSHIP_NOT_FOUND: "MEMBERSHIP_NOT_FOUND",
  MEMBERSHIP_ALREADY_EXISTS: "MEMBERSHIP_ALREADY_EXISTS",
  MEMBERSHIP_ALREADY_JOINED: "MEMBERSHIP_ALREADY_JOINED",
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
// PHASE 5.1C — Precise duplicate-key classifier
// =============================================================================

/**
 * Returns `true` ONLY when the supplied thrown value matches the
 * canonical Mongo / Mongoose duplicate-key error shape AND the
 * collided index is the compound `(classId, studentUserId)`
 * uniqueness guard on the `class_memberships` collection.
 *
 * PHASE 5.1C — this classifier is the AUTHORITATIVE
 * "already joined" predicate. The join Server Action does NOT
 * retry on a positive classification; it surfaces the typed
 * `MEMBERSHIP_ALREADY_JOINED` error so the action can map it to
 * an idempotent success with `alreadyJoined: true`.
 *
 * The function is total and never throws. It accepts these error
 * shapes (any of which Mongo / Mongoose may emit depending on
 * driver version):
 *
 *   1. `{ code: 11000, keyValue: { classId, studentUserId } }`
 *   2. `{ code: 11000, keyValue: { classId: "...", studentUserId: "..." } }`
 *      (stringified ObjectIds are accepted)
 *   3. `{ code: 11000, keyPattern: { classId: 1, studentUserId: 1 } }`
 *   4. `{ code: 11000, keyValue: { ... }, keyPattern: { ... } }`
 *
 * Any other error — including a future unique index, a non-11000
 * error, or a 11000 error whose `keyValue` / `keyPattern` does not
 * identify the compound `(classId, studentUserId)` uniqueness —
 * returns `false`. The caller must map `false` to the generic
 * `MEMBERSHIP_CREATE_FAILED` code so an unrelated uniqueness
 * collision (e.g. a future `idempotencyKey` index) is NOT silently
 * reported as "already joined".
 *
 * The function is total and never throws.
 */
export function isMembershipDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { code?: unknown }).code !== 11000) return false;

  // 1. Compound identification via `keyValue` (the modern Mongo /
  //    Mongoose shape). Both fields must be present on the
  //    `keyValue` object.
  const keyValue = (err as { keyValue?: unknown }).keyValue;
  if (keyValue && typeof keyValue === "object") {
    const kv = keyValue as Record<string, unknown>;
    if (
      "classId" in kv &&
      "studentUserId" in kv &&
      // Belt-and-braces: explicitly reject any unrelated value type
      // so a `null` / `undefined` / etc. cannot accidentally match.
      kv["classId"] !== null &&
      kv["classId"] !== undefined &&
      kv["studentUserId"] !== null &&
      kv["studentUserId"] !== undefined
    ) {
      return true;
    }
  }

  // 2. Compound identification via `keyPattern` (some driver
  //    versions emit the index keys instead of the values).
  const keyPattern = (err as { keyPattern?: unknown }).keyPattern;
  if (keyPattern && typeof keyPattern === "object") {
    const kp = keyPattern as Record<string, unknown>;
    if ("classId" in kp && "studentUserId" in kp) {
      return true;
    }
  }

  return false;
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
 * Retrieves the safe `SafeMembershipDto` projection for a specific
 * (classId, studentUserId) pair.
 *
 * PHASE 5.1C — the duplicate-path lookup primitive for the join
 * Server Action. When `createMembership` collides on the compound
 * unique index, the action calls this primitive to project the
 * ALREADY-PERSISTED membership into the browser-safe shape and
 * return `ok: true, alreadyJoined: true`.
 *
 * Returns `null` when no membership exists. The function NEVER
 * throws on lookup failure — the action maps `null` to the
 * generic `CLASS_JOIN_FAILED` code so an attacker cannot learn
 * whether a membership exists out of band.
 */
export async function getSafeMembership(
  classId: string | Types.ObjectId,
  studentUserId: string,
): Promise<SafeMembershipDto | null> {
  await ensureConnection();
  // Mongoose `.lean()` returns plain objects that include the
  // Mongo-managed `_id` and timestamps. We cast to a slightly
  // richer shape so the existing `toSafeMembershipDto` can be
  // reused without duplicating the projection logic.
  const doc = await ClassMembershipModel.findOne({
    classId: new Types.ObjectId(classId.toString()),
    studentUserId,
  })
    .lean<
      ClassMembershipAttrs & {
        _id: Types.ObjectId;
        createdAt: Date;
        updatedAt: Date;
      }
    >()
    .exec();
  if (!doc) return null;
  return toSafeMembershipDto(doc as unknown as ClassMembershipDoc);
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
 * - Throws `MembershipServiceError` on duplicate membership (index
 *   violation) classified via the precise
 *   `isMembershipDuplicateKeyError` predicate.
 * - Throws `MembershipServiceError(MEMBERSHIP_CREATE_FAILED)` on any
 *   other persistence failure. Unrelated 11000 collisions (e.g. a
 *   future `idempotencyKey` unique index) MUST NOT be remapped to
 *   the "already joined" code — the caller would otherwise mask a
 *   real persistence bug.
 * - The function NEVER retries the insert. Duplicate classification
 *   is purely a label for the failure mode; the join Server
 *   Action surfaces the safe code to the browser and lets the UI
 *   decide.
 *
 * Returns the created membership as a `SafeMembershipDto`.
 *
 * Note: this function does NOT enforce student role or verify the
 * class password. Future server orchestration must perform those
 * checks before calling `createMembership`.
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
    // PHASE 5.1C — precise duplicate-key classification.
    // The classifier accepts the compound `(classId, studentUserId)`
    // collision ONLY. Unrelated E11000 collisions (a future unique
    // index, a typo'd index name, a driver quirk) fall through to
    // `MEMBERSHIP_CREATE_FAILED`. The function NEVER retries.
    if (isMembershipDuplicateKeyError(err)) {
      throw new MembershipServiceError({
        code: MEMBERSHIP_ERROR_CODES.MEMBERSHIP_ALREADY_JOINED,
        message: "You have already joined this class.",
      });
    }
    // Re-throw MembershipServiceError unchanged so the test error
    // code assertion (e.g. ALREADY_JOINED via test setup) is
    // preserved.
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
