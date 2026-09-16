/**
 * Server Action: create a new Class as an authenticated Teacher.
 *
 * PHASE 5.1B — AUTHENTICATED TEACHER CREATE CLASS ACTION.
 *
 * This module is the ONLY entry point that lets a teacher create a
 * class. It is a `"use server"` Server Action — Client Components
 * can import the function reference, but Next.js refuses to bundle
 * the body into the client build. Browser-side code can never
 * execute the underlying logic.
 *
 * ## Input contract (the only thing the browser may supply)
 *
 *   {
 *     name:     string    // trimmed, 1..200 chars after trim
 *     password: string    // plain text, 4..128 chars, NOT trimmed
 *   }
 *
 * The browser MUST NOT supply:
 *
 *   - teacherUserId   — derived from `session.user.id`.
 *   - userId          — same.
 *   - role            — derived from the Profile collection.
 *   - classCode       — generated server-side via the canonical
 *                       7-char crypto-random generator.
 *   - passwordHash    — produced by the async PBKDF2 primitive.
 *   - status          — always "active" on a fresh class.
 *   - createdAt       — written by Mongoose timestamps.
 *   - _id             — written by Mongoose.
 *
 * Any unexpected keys are stripped by the Zod schema before any
 * service call, so a hand-crafted client cannot smuggle them
 * through the action signature.
 *
 * ## Identity / role source of truth
 *
 *   - Authentication  → Better Auth `getSession()` (server-only).
 *   - Onboarding      → `Profile.onboardingCompleted === true`.
 *   - Role            → `Profile.role === "teacher"`.
 *
 * The browser never names a teacher or chooses a role.
 *
 * ## Class code generation
 *
 * A fresh 7-character canonical code is generated for each insert
 * attempt via the existing 5.1A `generateClassCode()` primitive.
 * The MongoDB unique index on `classCode` is the authoritative
 * uniqueness guard; the action performs a BOUNDED internal retry
 * (at most `MAX_CLASS_CODE_ATTEMPTS` attempts) ONLY when the
 * service throws a duplicate-key error that the precise
 * `isClassCodeDuplicateKeyError` classifier confirms is on
 * `classCode`. Any other persistence error stops the loop
 * immediately and surfaces `CLASS_CREATION_FAILED`.
 *
 * ## Password handling
 *
 * The plaintext password is accepted once (only by this action and
 * only by the `hashClassPassword` primitive). It is:
 *
 *   - never trimmed or transformed (no `String#trim`, no
 *     lowercase, no whitespace removal),
 *   - never logged, never returned, never serialized,
 *   - discarded immediately after `await hashClassPassword(...)`
 *     returns. Only `passwordHash` (PBKDF2-SHA256) is persisted.
 *
 * ## Output contract (browser-safe discriminated union)
 *
 *   Success:
 *     {
 *       ok: true,
 *       class: {
 *         id:        string   // Mongo _id.toString()
 *         name:      string   // canonical trimmed
 *         classCode: string   // canonical uppercase, 7 chars
 *         status:    "active"
 *         createdAt: string    // ISO 8601
 *       }
 *     }
 *
 *   Error:
 *     {
 *       ok: false,
 *       code:
 *         | "UNAUTHENTICATED"
 *         | "PROFILE_INCOMPLETE"
 *         | "TEACHER_REQUIRED"
 *         | "INVALID_CLASS_NAME"
 *         | "INVALID_CLASS_PASSWORD"
 *         | "CLASS_CODE_GENERATION_FAILED"
 *         | "CLASS_CREATION_FAILED",
 *       message: string,   // safe copy
 *       retryable: boolean // hint for future UI
 *     }
 *
 * `password`, `passwordHash`, raw Mongoose fields, raw stack traces,
 * Mongo error messages, and `teacherUserId` are NEVER returned.
 *
 * ## Scope guarantees
 *
 *   - Does NOT create `ClassMembership`, attendance sessions,
 *     `FaceProfile`, or any other domain record.
 *   - Does NOT modify the `Profile` document.
 *   - Does NOT call the Face Service.
 *   - Does NOT introduce a `/api/classes` route.
 *   - Does NOT introduce a create-class UI.
 *   - Does NOT implement student join or attendance.
 *
 * This module opens with `"use server"` so it can only be invoked
 * as a Server Action from a Client Component, a Server Component,
 * a Route Handler, or another Server Action. The Client Component
 * bundle can import the function reference but cannot execute its
 * body (Next.js enforces this at build time).
 */

"use server";

import { z } from "zod";

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import {
  CLASS_ERROR_CODES,
  ClassServiceError,
  createClass,
} from "@/lib/classes/class-service";

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum number of insert attempts the action will perform for a
 * single teacher invocation. The first attempt is unconditional;
 * the remaining `MAX_CLASS_CODE_ATTEMPTS - 1` slots are reserved
 * for retried `classCode` collisions only.
 *
 * The unique index on `classCode` plus the 32-symbol alphabet make
 * collisions astronomically unlikely (≈1 in 32⁷ ≈ 1 in 3.4×10¹⁰),
 * so this small ceiling is more than enough headroom. If every
 * attempt collides we surface `CLASS_CODE_GENERATION_FAILED` —
 * the loop is intentionally bounded and never unbounded.
 */
export const MAX_CLASS_CODE_ATTEMPTS = 5;

/**
 * Maximum number of attempts allowed by the unique-index race model.
 * Mirrored as a runtime guard against future regressions that
 * accidentally raise the constant.
 */
const HARD_MAX_ATTEMPTS = 10;

// =============================================================================
// Validation schemas (server-authoritative)
// =============================================================================

/**
 * Class name validation.
 *
 * Mirrors the model-level constraints (trim + 1..200 chars). The
 * schema accepts whatever the browser supplies and emits the
 * canonical trimmed representation to the service. The browser
 * cannot bypass the trim because the schema runs `trim` first via
 * `z.preprocess`.
 */
const ClassNameSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z
    .string({ error: "Class name is required." })
    .min(1, "Class name must not be empty.")
    .max(200, "Class name must be at most 200 characters."),
);

/**
 * Class password validation.
 *
 * Deliberately restrained:
 *
 *   - must be a non-empty string,
 *   - must be at least 4 characters (a trivial floor that blocks
 *     accidental empty / single-character submissions; the
 *     cryptography is bounded by PBKDF2 not by length),
 *   - must be at most 128 characters (an explicit cap that
 *     protects the async PBKDF2 path from pathological inputs).
 *
 * The password is NEVER trimmed or transformed by this action.
 * Whitespace, casing, and any other byte are preserved exactly so
 * that the teacher's choice is the persisted choice. This is a
 * deliberate documented rule — see the file header.
 */
const ClassPasswordSchema = z
  .string({ error: "Class password is required." })
  .min(4, "Class password must be at least 4 characters.")
  .max(128, "Class password must be at most 128 characters.");

/**
 * Browser-supplied input shape.
 *
 * Only `name` and `password` are accepted. The schema strips any
 * other keys via `.strict()`, so a hand-crafted client cannot
 * smuggle `teacherUserId`, `classCode`, `role`, `passwordHash`,
 * `status`, `createdAt`, or `_id` through this action.
 */
const CreateClassInputSchema = z
  .object({
    name: ClassNameSchema,
    password: ClassPasswordSchema,
  })
  .strict();

export type CreateClassBrowserInput = z.infer<typeof CreateClassInputSchema>;

// =============================================================================
// Browser-safe error codes
// =============================================================================

/**
 * Stable browser-facing error codes for the create-class Server
 * Action. These codes overlap with the project's documented
 * conventions (`docs/api.md`) and the existing class service
 * error codes.
 */
export const CREATE_CLASS_ACTION_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
  TEACHER_REQUIRED: "TEACHER_REQUIRED",
  INVALID_CLASS_NAME: "INVALID_CLASS_NAME",
  INVALID_CLASS_PASSWORD: "INVALID_CLASS_PASSWORD",
  CLASS_CODE_GENERATION_FAILED: "CLASS_CODE_GENERATION_FAILED",
  CLASS_CREATION_FAILED: "CLASS_CREATION_FAILED",
} as const;

export type CreateClassActionErrorCode =
  (typeof CREATE_CLASS_ACTION_ERROR_CODES)[keyof typeof CREATE_CLASS_ACTION_ERROR_CODES];

/**
 * Restrained, browser-safe copy. No thresholds, no internals, no
 * `password`, no `passwordHash`, no `teacherUserId`, no Mongo URI.
 */
const ERROR_MESSAGES: Readonly<Record<CreateClassActionErrorCode, string>> =
  {
    UNAUTHENTICATED: "You must be signed in to create a class.",
    PROFILE_INCOMPLETE: "Complete your profile before creating a class.",
    TEACHER_REQUIRED: "Only teachers can create classes.",
    INVALID_CLASS_NAME: "Class name is invalid.",
    INVALID_CLASS_PASSWORD: "Class password is invalid.",
    CLASS_CODE_GENERATION_FAILED:
      "Could not generate a unique class code. Please try again.",
    CLASS_CREATION_FAILED: "Could not create the class. Please try again.",
  };

/**
 * Retry hint for each failure mode. The future create-class UI
 * (PHASE 5.1B+UI) may use this flag to decide whether to render a
 * "Try again" affordance or a more conservative flow.
 */
const RETRYABLE: Readonly<Record<CreateClassActionErrorCode, boolean>> = {
  UNAUTHENTICATED: false,
  PROFILE_INCOMPLETE: false,
  TEACHER_REQUIRED: false,
  INVALID_CLASS_NAME: false,
  INVALID_CLASS_PASSWORD: false,
  CLASS_CODE_GENERATION_FAILED: true,
  CLASS_CREATION_FAILED: true,
};

// =============================================================================
// Result types (discriminated union)
// =============================================================================

/**
 * Browser-safe success result. Contains ONLY fields the teacher
 * legitimately needs to see and share:
 *
 *   - id        — Mongo document id (string).
 *   - name      — canonical trimmed class name.
 *   - classCode — 7-char uppercase canonical code (the only
 *                 join-time identifier students will need).
 *   - status    — always "active" on a fresh create.
 *   - createdAt — ISO 8601 string for UI display.
 *
 * `password`, `passwordHash`, and `teacherUserId` are NOT
 * returned — the caller already represents the authenticated
 * teacher and there is no UI that needs any of those fields.
 */
export interface CreateClassActionSuccess {
  ok: true;
  class: {
    id: string;
    name: string;
    classCode: string;
    status: "active";
    createdAt: string;
  };
}

/**
 * Browser-safe error result. The shape mirrors the project-wide
 * convention: `{ ok, code, message, retryable }`.
 *
 * The `code` is always one of the values in
 * `CREATE_CLASS_ACTION_ERROR_CODES`. The `message` is the safe
 * copy from `ERROR_MESSAGES`. The `retryable` flag is derived
 * from `RETRYABLE`.
 */
export interface CreateClassActionError {
  ok: false;
  code: CreateClassActionErrorCode;
  message: string;
  retryable: boolean;
}

export type CreateClassActionResult =
  | CreateClassActionSuccess
  | CreateClassActionError;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Defensive guard around the retry ceiling constant. Catches
 * future accidental raises without changing the call site.
 */
function assertAttemptsCeiling(): void {
  if (
    !Number.isInteger(MAX_CLASS_CODE_ATTEMPTS) ||
    MAX_CLASS_CODE_ATTEMPTS < 1 ||
    MAX_CLASS_CODE_ATTEMPTS > HARD_MAX_ATTEMPTS
  ) {
    // Surface the configuration problem as a generic creation
    // failure. We never leak the constant value or the harness
    // details to the browser.
    throw new ClassServiceError({
      code: CLASS_ERROR_CODES.CLASS_CREATE_FAILED,
      message: "Failed to create class.",
    });
  }
}

/**
 * Wraps an unknown thrown value into the browser-safe error
 * result. Only typed service errors receive a specific code; any
 * other error collapses to `CLASS_CREATION_FAILED` with a safe
 * generic message. Raw stacks, Mongo error codes, and connection
 * details are NEVER returned.
 */
function toSafeError(err: unknown): CreateClassActionError {
  // A `ClassServiceError(CLASS_CODE_ALREADY_EXISTS)` after the retry
  // loop has been exhausted means we generated MAX_CLASS_CODE_ATTEMPTS
  // fresh codes and every one collided on the unique index. Map to a
  // dedicated, browser-safe code.
  if (err instanceof ClassServiceError) {
    if (err.code === CLASS_ERROR_CODES.CLASS_CODE_ALREADY_EXISTS) {
      return buildError("CLASS_CODE_GENERATION_FAILED");
    }
    return buildError("CLASS_CREATION_FAILED");
  }
  return buildError("CLASS_CREATION_FAILED");
}

function buildError(
  code: CreateClassActionErrorCode,
): CreateClassActionError {
  return {
    ok: false,
    code,
    message: ERROR_MESSAGES[code],
    retryable: RETRYABLE[code],
  };
}

// =============================================================================
// Public Server Action
// =============================================================================

/**
 * Creates a new Class owned by the currently authenticated teacher.
 *
 * ## Behavior
 *
 *   1. Derive the Better Auth session via `getSession()`. If no
 *      session exists, return `UNAUTHENTICATED`. No input is
 *      read from the browser before this check.
 *   2. Load the application `Profile` for `session.user.id` via
 *      the existing profile service. The Profile must exist,
 *      `onboardingCompleted === true`, and `role === "teacher"`.
 *      Any deviation produces `PROFILE_INCOMPLETE` or
 *      `TEACHER_REQUIRED`. No class is persisted on these paths.
 *   3. Validate the browser-supplied `name` and `password` via
 *      `CreateClassInputSchema`. Any failure produces
 *      `INVALID_CLASS_NAME` or `INVALID_CLASS_PASSWORD`. No class
 *      is persisted on these paths.
 *   4. Run a BOUNDED internal retry loop. For each attempt, call
 *      `createClass({...})` with a freshly generated `classCode`
 *      (the service always generates its own code when not
 *      provided; we never supply a classCode here). If the
 *      service throws `ClassServiceError(CLASS_CODE_ALREADY_EXISTS)`
 *      — which the service produces ONLY when the precise
 *      `isClassCodeDuplicateKeyError` classifier confirms the
 *      collision was on `classCode` — retry with a NEW generated
 *      code. Any other thrown value stops the loop immediately
 *      and surfaces `CLASS_CREATION_FAILED`. After
 *      `MAX_CLASS_CODE_ATTEMPTS` collisions the loop stops and
 *      surfaces `CLASS_CODE_GENERATION_FAILED`.
 *   5. Project the persisted `SafeClassDto` into the browser-safe
 *      success shape. `password`, `passwordHash`, `teacherUserId`,
 *      Mongoose internals, and stack traces are NEVER serialized.
 *
 * ## Identities (all derived server-side)
 *
 *   - `teacherUserId` ← `session.user.id` (Better Auth).
 *   - `classCode`     ← canonical 7-char generator.
 *   - `passwordHash`  ← `await hashClassPassword(rawPassword)` inside
 *                        the service (PBKDF2-SHA256, async).
 *
 * ## No automatic browser-side retry
 *
 * The bounded retry above is INTERNAL to this action and is
 * triggered only by a precise classCode uniqueness collision.
 * All other failure modes return a single, safe error result so
 * the future UI can decide whether to re-invoke the action.
 */
export async function createClassAction(
  input: unknown,
): Promise<CreateClassActionResult> {
  // 0. Defensive guard against future regression on the retry
  //    ceiling. Cheap and runs only at the top of each invocation.
  try {
    assertAttemptsCeiling();
  } catch {
    return buildError("CLASS_CREATION_FAILED");
  }

  // 1. Authentication — identity comes from the Better Auth
  //    session only. No userId is accepted from the browser.
  const session = await getSession();
  if (!session) {
    return buildError("UNAUTHENTICATED");
  }
  const userId = session.user.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return buildError("UNAUTHENTICATED");
  }

  // 2. Profile gating — load the Profile and require a complete,
  //    teacher-role record. Missing profile / incomplete
  //    onboarding / wrong role are mapped to safe codes. The
  //    profile service is the authoritative loader; this action
  //    does NOT touch the Profile.
  let profile;
  try {
    profile = await getProfileByUserId(userId);
  } catch {
    // Persistence failure during the profile lookup is treated as
    // a generic creation failure. We never leak driver details.
    return buildError("CLASS_CREATION_FAILED");
  }
  if (!profile || !profile.onboardingCompleted) {
    return buildError("PROFILE_INCOMPLETE");
  }
  if (profile.role !== "teacher") {
    return buildError("TEACHER_REQUIRED");
  }

  // 3. Validate browser-supplied class name + password. The Zod
  //    schema strips any extra keys so the browser cannot smuggle
  //    `teacherUserId`, `classCode`, `role`, `passwordHash`, etc.
  //    through. The schema runs server-side; browser HTML
  //    validation is NOT a security boundary.
  const parsed = CreateClassInputSchema.safeParse(input);
  if (!parsed.success) {
    // Discriminate which field failed so the browser receives a
    // specific code. Zod's `flatten().fieldErrors` is the
    // canonical source for per-field errors.
    const fieldErrors = parsed.error.flatten().fieldErrors;
    if (fieldErrors.name && fieldErrors.name.length > 0) {
      return buildError("INVALID_CLASS_NAME");
    }
    if (fieldErrors.password && fieldErrors.password.length > 0) {
      return buildError("INVALID_CLASS_PASSWORD");
    }
    // Defensive fallback for `.strict()` violations — collapse to
    // the password code so the browser cannot probe the schema.
    return buildError("INVALID_CLASS_PASSWORD");
  }
  const browserInput: CreateClassBrowserInput = parsed.data;

  // 4. Bounded internal retry loop. The class code is generated
  //    INSIDE `createClass` on every attempt; we never supply
  //    one. Each attempt is a fresh, atomic, single-document
  //    MongoDB write.
  let lastError: unknown = null;
  for (
    let attempt = 0;
    attempt < MAX_CLASS_CODE_ATTEMPTS;
    attempt++
  ) {
    try {
      const safe = await createClass({
        name: browserInput.name,
        teacherUserId: userId,
        rawPassword: browserInput.password,
        // classCode intentionally omitted — the service generates
        // a fresh canonical code on every attempt.
      });
      // 5. Project the safe DTO into the browser-safe success
      //    shape. `password`, `passwordHash`, and `teacherUserId`
      //    are intentionally dropped — the caller already
      //    represents the authenticated teacher.
      return {
        ok: true,
        class: {
          id: safe.id,
          name: safe.name,
          classCode: safe.classCode,
          status: "active",
          createdAt: safe.createdAt.toISOString(),
        },
      };
    } catch (err) {
      lastError = err;
      if (
        err instanceof ClassServiceError &&
        err.code === CLASS_ERROR_CODES.CLASS_CODE_ALREADY_EXISTS
      ) {
        // Precise classCode collision — retry with a freshly
        // generated code. The service produced this code ONLY
        // because `isClassCodeDuplicateKeyError` confirmed the
        // collided key was `classCode`.
        continue;
      }
      // Any other thrown value (including unrelated duplicate-key
      // errors, validation errors that slipped past Zod, or driver
      // failures) stops the loop immediately. We never retry
      // generic DB errors.
      return toSafeError(err);
    }
  }

  // Loop exited without success — only happens after
  // MAX_CLASS_CODE_ATTEMPTS consecutive classCode collisions.
  // Surface the safe generation failure.
  void lastError; // lastError is intentionally not serialized.
  return buildError("CLASS_CODE_GENERATION_FAILED");
}

// =============================================================================
// Exposed for tests
// =============================================================================

export const __testing = {
  CreateClassInputSchema,
  ClassNameSchema,
  ClassPasswordSchema,
  MAX_CLASS_CODE_ATTEMPTS,
  ERROR_MESSAGES,
  RETRYABLE,
  buildError,
  toSafeError,
  assertAttemptsCeiling,
};