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
import { hashClassPassword, verifyClassPassword } from "@/lib/classes/class-password";
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
// PHASE 5.1C — Join-time credential primitive (server-only, internal)
// =============================================================================

/**
 * Server-only credential lookup result for class join orchestration.
 *
 * `passwordHash` is intentionally exposed on this INTERNAL shape so the
 * join Server Action (PHASE 5.1C) can verify a submitted password
 * against the stored PBKDF2 hash via `verifyClassPassword()`. This
 * shape MUST NEVER be re-exported through the public `index.ts`
 * barrel nor surfaced into any browser-facing DTO. `SafeClassDto`
 * continues to exclude `passwordHash`.
 *
 * `classId` is a string (canonical `ObjectId.toString()`) for easy
 * forwarding into the membership write without leaking Mongoose
 * internals.
 *
 * `status` is required so the join orchestration can refuse an
 * `archived` class without first attempting to verify a password
 * hash (the canonical malformed-credential timing path still runs
 * a single async PBKDF2 workload against the dummy hash for
 * archived classes — see `getClassJoinCredentialByCode` for the
 * invariant).
 */
export interface ClassJoinCredential {
  classId: string;
  classCode: string;
  passwordHash: string;
  status: "active" | "archived";
}

/**
 * Fixed, syntactically-valid PBKDF2 encoded hash used purely to force
 * ONE asynchronous PBKDF2 workload on credential-state branches that
 * would otherwise short-circuit (missing class / archived class /
 * malformed stored hash). It is NOT a real credential and verifies
 * against essentially nothing.
 *
 * Architectural invariants (PHASE 5.1C lockdown):
 *
 *   1. The constant is a single literal string — it is NEVER
 *      generated at module load via `hashClassPassword()`,
 *      `pbkdf2`, `randomBytes`, top-level `await`, or any
 *      other runtime primitive. Module evaluation is therefore
 *      synchronous and side-effect-free.
 *   2. The shape matches the existing encoded format exactly:
 *      `pbkdf2-sha256$<iter>$<saltHex>$<keyHex>` with a valid
 *      32-byte salt and a valid 32-byte derived key (so
 *      `verifyClassPassword` accepts the value and runs the
 *      full async PBKDF2 path against it).
 *   3. The salt and derived key below are random-looking
 *      placeholders — they are NOT derived from any user
 *      data and verifying any real password against this
 *      hash returns `false`.
 *
 * The salt bytes are all-`0x01` and the key bytes are all-`0x02`:
 * they parse as valid hex, are exactly 32 bytes each, and have
 * no special meaning. The important property is purely
 * STRUCTURAL — the value must look identical to a real hash to
 * `parseEncodedHash` so `verifyClassPassword` performs the full
 * async PBKDF2 workload and returns `false`.
 */
export const DUMMY_CLASS_PASSWORD_HASH =
  "pbkdf2-sha256$100000$" +
  "0101010101010101010101010101010101010101010101010101010101010101$" +
  "0202020202020202020202020202020202020202020202020202020202020202";

/**
 * Returns the join-time credential record for a class matching the
 * normalized `code`, or `null` when no class exists with that code.
 *
 * PHASE 5.1C server-only primitive. This function is the ONLY
 * sanctioned entry point for join orchestration to access
 * `passwordHash`. Its return type (`ClassJoinCredential`) is NOT
 * exposed through the `index.ts` barrel — the barrel re-exports
 * only `SafeClassDto` so a hand-crafted import cannot smuggle
 * `passwordHash` into a browser-facing payload.
 *
 * The returned record preserves `status` so the join Server Action
 * can route an `archived` class through the canonical
 * `INVALID_CLASS_CREDENTIALS` path. The action handles the archived
 * branch by performing a single async `verifyClassPassword` call
 * against `DUMMY_CLASS_PASSWORD_HASH` before returning the safe
 * code, so the timing surface is identical to the
 * wrong-password / malformed-hash paths.
 *
 * The function performs ZERO cryptographic work itself; it is a
 * plain read.
 */
export async function getClassJoinCredentialByCode(
  code: string,
): Promise<ClassJoinCredential | null> {
  await ensureConnection();
  const normalized = normalizeClassCode(code);
  const doc = await ClassModel.findOne({ classCode: normalized })
    .select({ _id: 1, classCode: 1, passwordHash: 1, status: 1 })
    .lean<{
      _id: Types.ObjectId;
      classCode: string;
      passwordHash: string;
      status: "active" | "archived";
    }>()
    .exec();
  if (!doc) return null;
  return {
    classId: doc._id.toString(),
    classCode: doc.classCode,
    passwordHash: doc.passwordHash,
    status: doc.status,
  };
}

/**
 * Performs ONE async PBKDF2 verification workload against
 * `DUMMY_CLASS_PASSWORD_HASH` and discards the result.
 *
 * This is the canonical "shape the timing surface" primitive used
 * by the join Server Action whenever the credential state would
 * otherwise short-circuit:
 *
 *   - missing class
 *   - archived class
 *   - malformed stored hash
 *
 * On all three branches the action MUST run exactly one async
 * `verifyClassPassword(input.password, DUMMY_CLASS_PASSWORD_HASH)`
 * call before returning the safe error code. This is purely a
 * timing-attack mitigation — it forces an attacker observing
 * response latency to differentiate "wrong password" from
 * "missing class" / "archived class" / "malformed hash" by at
 * least the cost of a single async PBKDF2 workload.
 *
 * The function returns `void`. It NEVER throws. The internal
 * `verifyClassPassword` returns `false` for any real password
 * against the dummy hash; that result is intentionally
 * discarded.
 */
export async function runDummyPasswordVerification(
  rawPassword: string,
): Promise<void> {
  await verifyClassPassword(rawPassword, DUMMY_CLASS_PASSWORD_HASH);
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

/**
 * Returns `true` only when the supplied thrown value matches the
 * exact shape of a Mongo / Mongoose duplicate-key error whose
 * collided key is `classCode`.
 *
 * The unique index on `classCode` is the authoritative uniqueness
 * guard. A retry loop in the caller (PHASE 5.1B) is allowed only
 * when this predicate returns `true` — any other duplicate-key
 * collision (a future index, a teacher-userId unique guard, …)
 * must NOT trigger a silent retry.
 *
 * The function is total and never throws.
 */
export function isClassCodeDuplicateKeyError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  if ((err as { code?: unknown }).code !== 11000) return false;
  const keyValue = (err as { keyValue?: unknown }).keyValue;
  if (!keyValue || typeof keyValue !== "object") return false;
  return "classCode" in (keyValue as Record<string, unknown>);
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
    // Handle MongoDB duplicate-key error ONLY when the collided key is
    // `classCode`. Any other duplicate-key collision (e.g. a future
    // unique index on `teacherUserId`) must NOT be re-mapped to a
    // `CLASS_CODE_ALREADY_EXISTS` code — the caller (PHASE 5.1B) would
    // otherwise retry with a freshly generated code that does not
    // actually collide on `classCode`, masking the real failure.
    if (isClassCodeDuplicateKeyError(err)) {
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
