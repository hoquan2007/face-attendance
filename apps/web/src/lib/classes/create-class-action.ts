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

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import {
  CLASS_ERROR_CODES,
  ClassServiceError,
  createClass,
} from "@/lib/classes/class-service";
import type {
  CreateClassActionResult,
} from "./create-class-action-types";
import {
  CreateClassInputSchema,
  type CreateClassBrowserInput,
} from "./create-class-action-schemas";

// =============================================================================
// Constants
// =============================================================================

/**
 * Maximum number of attempts allowed by the unique-index race
 * model. Mirrored as a runtime guard against future regressions
 * that accidentally raise the constant.
 */
const MAX_CLASS_CODE_ATTEMPTS = 5;

import {
  assertAttemptsCeiling,
  buildError,
  toSafeError,
} from "./create-class-action-helpers";

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
//
// PHASE 5.1E2 — split out into a non-`"use server"` module so the
// `"use server"` action file is limited to `async` exports. The
// test-only exports live in `create-class-action-testing.ts`.
// =============================================================================