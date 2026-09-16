/**
 * Server Action: join a Class as an authenticated Student.
 *
 * PHASE 5.1C — AUTHENTICATED STUDENT JOIN-CLASS ACTION.
 *
 * This module is the ONLY entry point that lets a student join a
 * class. It is a `"use server"` Server Action — Client Components
 * can import the function reference, but Next.js refuses to bundle
 * the body into the client build. Browser-side code can never
 * execute the underlying logic.
 *
 * ## Input contract (the only thing the browser may supply)
 *
 *   {
 *     classCode: string   // 7-char canonical code (case-insensitive)
 *     password:  string   // plain text, 4..128 chars, NOT trimmed
 *   }
 *
 * The browser MUST NOT supply:
 *
 *   - studentUserId / userId — derived from `session.user.id`.
 *   - role                  — derived from the Profile collection.
 *   - classId               — derived server-side from `classCode`.
 *   - status                — always "active" on a fresh membership.
 *   - joinedAt              — written server-side as `new Date()`.
 *   - membershipId / _id    — written by Mongoose.
 *   - passwordHash          — never accepted from the browser.
 *
 * Any unexpected keys are stripped by the Zod schema before any
 * service call, so a hand-crafted client cannot smuggle them
 * through the action signature.
 *
 * ## Identity / role source of truth
 *
 *   - Authentication  → Better Auth `getSession()` (server-only).
 *   - Onboarding      → `Profile.onboardingCompleted === true`.
 *   - Role            → `Profile.role === "student"`.
 *
 * The browser never names a student or chooses a role.
 *
 * ## Credential verification (canonical timing path)
 *
 * The action performs a single async PBKDF2 verification workload
 * on EVERY failure branch that would otherwise short-circuit:
 *
 *   - missing class                 → `await runDummyPasswordVerification(...)`
 *   - archived class                → `await runDummyPasswordVerification(...)`
 *   - malformed stored hash         → `await runDummyPasswordVerification(...)`
 *   - wrong password                → `await verifyClassPassword(password, storedHash)`
 *
 * The dummy verification uses the fixed, syntactically-valid
 * `DUMMY_CLASS_PASSWORD_HASH` constant from `class-service.ts`
 * (no runtime generation, no module-load work, no
 * `Math.random()`). On all four branches the action then returns
 * the SAME browser-safe code:
 *
 *   `INVALID_CLASS_CREDENTIALS`
 *
 * This is a deliberate timing-attack mitigation: an attacker
 * observing response latency cannot differentiate "wrong password"
 * from "missing class" / "archived class" / "malformed hash" by
 * less than the cost of one async PBKDF2 workload.
 *
 * Wall-clock timing tests are explicitly NOT used in this module's
 * test suite — the test contract asserts the BEHAVIOR (a single
 * `verifyClassPassword` call against either the stored hash or
 * the dummy hash) rather than the latency. Latency is
 * implementation-dependent and must not be locked in by tests.
 *
 * ## Membership duplicate classification (PHASE 5.1C idempotency)
 *
 * When `createMembership` collides on the compound unique index
 * `(classId, studentUserId)`, the service-layer classifier
 * `isMembershipDuplicateKeyError` returns `true` ONLY when the
 * Mongo error's `keyValue` (or `keyPattern`) identifies the
 * compound uniqueness. The action maps a positive classification
 * to an **idempotent success** with `alreadyJoined: true` and
 * NEVER retries the insert. The existing membership is fetched
 * via the server-only `getSafeMembership` primitive and projected
 * into the browser-safe shape — no second membership document is
 * written, no `ALREADY_JOINED` error code is surfaced. An
 * unrelated 11000 collision (e.g. a future `idempotencyKey`
 * index) maps to the generic `CLASS_JOIN_FAILED` code.
 *
 * ## Output contract (browser-safe discriminated union)
 *
 *   Success:
 *     {
 *       ok: true,
 *       membership: {
 *         id:           string   // Mongo _id.toString()
 *         classId:      string
 *         classCode:    string   // canonical uppercase, 7 chars
 *         joinedAt:     string   // ISO 8601
 *         status:       "active"
 *       },
 *       alreadyJoined: boolean  // false on fresh insert, true on idempotent re-join
 *     }
 *
 *   Error:
 *     {
 *       ok: false,
 *       code:
 *         | "UNAUTHENTICATED"
 *         | "PROFILE_INCOMPLETE"
 *         | "STUDENT_REQUIRED"
 *         | "INVALID_CLASS_CODE"
 *         | "INVALID_CLASS_PASSWORD"
 *         | "INVALID_CLASS_CREDENTIALS"
 *         | "CLASS_JOIN_FAILED",
 *       message: string,   // safe copy
 *       retryable: boolean // hint for future UI
 *     }
 *
 * `password`, `passwordHash`, raw Mongoose fields, raw stack
 * traces, Mongo error messages, `studentUserId`, `teacherUserId`,
 * and the raw `classId` ObjectId are NEVER returned.
 *
 * ## Scope guarantees
 *
 *   - Does NOT create / mutate `Class`.
 *   - Does NOT create / mutate `Profile`.
 *   - Does NOT create / mutate `FaceProfile`.
 *   - Does NOT call the Face Service.
 *   - Does NOT introduce a `/api/classes/join` route.
 *   - Does NOT introduce a join UI.
 *   - Does NOT implement attendance.
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
  type ClassJoinCredential,
  DUMMY_CLASS_PASSWORD_HASH,
  getClassJoinCredentialByCode,
  isClassCodeDuplicateKeyError,
  runDummyPasswordVerification,
} from "@/lib/classes/class-service";
import {
  createMembership,
  getSafeMembership,
  isMembershipDuplicateKeyError,
  MembershipServiceError,
  MEMBERSHIP_ERROR_CODES,
  type SafeMembershipDto,
} from "@/lib/classes/class-membership-service";
import { isValidPasswordHash, verifyClassPassword } from "@/lib/classes/class-password";

// =============================================================================
// Constants
// =============================================================================

/**
 * Canonical class code length. The join Server Action uses the
 * existing 5.1A constant indirectly by delegating normalization +
 * lookup to the service; this local mirror exists only so the Zod
 * schema can apply a length floor without importing a service
 * primitive.
 */
const CLASS_CODE_INPUT_LENGTH = 7;

// =============================================================================
// Validation schemas (server-authoritative)
// =============================================================================

/**
 * Class code validation.
 *
 * The schema accepts whatever the browser supplies and emits the
 * canonical uppercase form via `normalizeClassCode`. The schema
 * applies a length floor so a clearly malformed submission
 * (too short / too long) does NOT reach the service layer. The
 * underlying service still runs `normalizeClassCode` so case /
 * whitespace variations are handled correctly server-side even
 * when the browser bypasses the schema.
 *
 * The schema runs server-side; browser HTML validation is NOT a
 * security boundary.
 */
const ClassCodeSchema = z.preprocess(
  (value) =>
    typeof value === "string" ? value.trim().toUpperCase() : value,
  z
    .string({ error: "Class code is required." })
    .min(
      CLASS_CODE_INPUT_LENGTH,
      "Class code must be at least 7 characters.",
    )
    .max(
      CLASS_CODE_INPUT_LENGTH,
      "Class code must be at most 7 characters.",
    )
    // The canonical alphabet excludes O/0/I/1; reject any other
    // character at the schema boundary so the action surface
    // stays tight. The browser cannot bypass this check.
    .regex(
      /^[A-HJ-NP-Z2-9]+$/,
      "Class code must contain only uppercase letters (no I/O) and digits (no 0/1).",
    ),
);

/**
 * Class password validation.
 *
 * Deliberately restrained — mirrors the 5.1B create-class password
 * rules:
 *
 *   - must be a non-empty string,
 *   - must be at least 4 characters (a trivial floor that blocks
 *     accidental empty / single-character submissions),
 *   - must be at most 128 characters (an explicit cap that
 *     protects the async PBKDF2 path from pathological inputs).
 *
 * The password is NEVER trimmed or transformed by this action.
 * Whitespace, casing, and any other byte are preserved exactly so
 * that the student's choice is the persisted choice. This is a
 * deliberate documented rule — see the file header.
 */
const JoinClassPasswordSchema = z
  .string({ error: "Class password is required." })
  .min(4, "Class password must be at least 4 characters.")
  .max(128, "Class password must be at most 128 characters.");

/**
 * Browser-supplied input shape.
 *
 * Only `classCode` and `password` are accepted. The schema strips
 * any other keys via `.strict()`, so a hand-crafted client cannot
 * smuggle `studentUserId`, `classId`, `userId`, `role`,
 * `passwordHash`, `status`, `joinedAt`, or `_id` through this
 * action.
 */
const JoinClassInputSchema = z
  .object({
    classCode: ClassCodeSchema,
    password: JoinClassPasswordSchema,
  })
  .strict();

export type JoinClassBrowserInput = z.infer<typeof JoinClassInputSchema>;

// =============================================================================
// Browser-safe error codes
// =============================================================================

/**
 * Stable browser-facing error codes for the join-class Server
 * Action. These codes overlap with the project's documented
 * conventions (`docs/api.md`) and the existing class / membership
 * service error codes.
 *
 * PHASE 5.1C — duplicate membership is an IDEMPOTENT SUCCESS,
 * not an error. There is no `ALREADY_JOINED` error code in this
 * list. The action surfaces `ok: true, alreadyJoined: true` for
 * a valid re-join instead.
 */
export const JOIN_CLASS_ACTION_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
  STUDENT_REQUIRED: "STUDENT_REQUIRED",
  INVALID_CLASS_CODE: "INVALID_CLASS_CODE",
  INVALID_CLASS_PASSWORD: "INVALID_CLASS_PASSWORD",
  INVALID_CLASS_CREDENTIALS: "INVALID_CLASS_CREDENTIALS",
  CLASS_JOIN_FAILED: "CLASS_JOIN_FAILED",
} as const;

export type JoinClassActionErrorCode =
  (typeof JOIN_CLASS_ACTION_ERROR_CODES)[keyof typeof JOIN_CLASS_ACTION_ERROR_CODES];

/**
 * Restrained, browser-safe copy. No thresholds, no internals, no
 * `password`, no `passwordHash`, no `studentUserId`, no Mongo URI.
 */
const ERROR_MESSAGES: Readonly<Record<JoinClassActionErrorCode, string>> =
  {
    UNAUTHENTICATED: "You must be signed in to join a class.",
    PROFILE_INCOMPLETE: "Complete your profile before joining a class.",
    STUDENT_REQUIRED: "Only students can join classes.",
    INVALID_CLASS_CODE: "Class code is invalid.",
    INVALID_CLASS_PASSWORD: "Class password is invalid.",
    INVALID_CLASS_CREDENTIALS:
      "The class code or password is incorrect.",
    CLASS_JOIN_FAILED: "Could not join the class. Please try again.",
  };

/**
 * Retry hint for each failure mode. The future join-class UI may
 * use this flag to decide whether to render a "Try again"
 * affordance or a more conservative flow.
 */
const RETRYABLE: Readonly<Record<JoinClassActionErrorCode, boolean>> = {
  UNAUTHENTICATED: false,
  PROFILE_INCOMPLETE: false,
  STUDENT_REQUIRED: false,
  INVALID_CLASS_CODE: false,
  INVALID_CLASS_PASSWORD: false,
  INVALID_CLASS_CREDENTIALS: false,
  CLASS_JOIN_FAILED: true,
};

// =============================================================================
// Result types (discriminated union)
// =============================================================================

/**
 * Browser-safe success result. Contains ONLY fields the student
 * legitimately needs to see:
 *
 *   - id           — Mongo document id (string).
 *   - classId      — canonical ObjectId string.
 *   - classCode    — 7-char uppercase canonical code.
 *   - joinedAt     — ISO 8601 string for UI display.
 *   - status       — always "active" on a fresh join.
 *   - alreadyJoined — `false` on a fresh insert, `true` when the
 *                     server detected an existing membership via
 *                     the compound `(classId, studentUserId)`
 *                     unique index and surfaced an idempotent
 *                     success.
 *
 * `password`, `passwordHash`, `studentUserId`, `teacherUserId`,
 * Mongoose internals, and stack traces are NOT returned.
 */
export interface JoinClassActionSuccess {
  ok: true;
  membership: {
    id: string;
    classId: string;
    classCode: string;
    joinedAt: string;
    status: "active";
  };
  /**
   * Idempotency flag.
   *
   *   - `false` — a NEW membership was inserted for this student
   *               in this class.
   *   - `true`  — the membership already existed (compound unique
   *               collision on `(classId, studentUserId)`). The
   *               `membership` projection is the ALREADY-PERSISTED
   *               record, not a freshly-created one.
   *
   * In both cases the password was verified, the class was
   * confirmed joinable, and no second membership document was
   * written.
   */
  alreadyJoined: boolean;
}

/**
 * Browser-safe error result. The shape mirrors the project-wide
 * convention: `{ ok, code, message, retryable }`.
 *
 * The `code` is always one of the values in
 * `JOIN_CLASS_ACTION_ERROR_CODES`. The `message` is the safe
 * copy from `ERROR_MESSAGES`. The `retryable` flag is derived
 * from `RETRYABLE`.
 */
export interface JoinClassActionError {
  ok: false;
  code: JoinClassActionErrorCode;
  message: string;
  retryable: boolean;
}

export type JoinClassActionResult =
  | JoinClassActionSuccess
  | JoinClassActionError;

// =============================================================================
// Helpers
// =============================================================================

function buildError(
  code: JoinClassActionErrorCode,
): JoinClassActionError {
  return {
    ok: false,
    code,
    message: ERROR_MESSAGES[code],
    retryable: RETRYABLE[code],
  };
}

/**
 * Performs a single async PBKDF2 verification workload against
 * the dummy hash and discards the result.
 *
 * PHASE 5.1C canonical timing path. Used by the action on every
 * branch that would otherwise short-circuit (missing class,
 * archived class, malformed stored hash). The function NEVER
 * throws and ALWAYS performs the full async PBKDF2 workload
 * because `verifyClassPassword` only short-circuits on a
 * truly-empty rawPassword — and the schema enforces a 4..128
 * char floor so an empty submission never reaches this layer.
 */
async function runCanonicalTimingWorkload(
  rawPassword: string,
): Promise<void> {
  await runDummyPasswordVerification(rawPassword);
}

/**
 * Performs a single async PBKDF2 verification workload against
 * the REAL stored hash and returns whether the password matched.
 *
 * If the stored hash is malformed (fails
 * `isValidPasswordHash`), the function falls back to the dummy
 * hash so the timing surface still includes one async PBKDF2
 * workload before returning `false`. The branch returns
 * `verified: false` so the caller can surface
 * `INVALID_CLASS_CREDENTIALS`.
 *
 * The function NEVER throws. The internal `verifyClassPassword`
 * is total — it returns `false` for any malformed input.
 */
async function verifyAgainstStoredOrDummyHash(
  rawPassword: string,
  storedHash: string,
): Promise<{ verified: boolean }> {
  if (!isValidPasswordHash(storedHash)) {
    // Malformed stored hash — run the canonical dummy workload
    // and report `false`.
    await runCanonicalTimingWorkload(rawPassword);
    return { verified: false };
  }
  const verified = await verifyClassPassword(rawPassword, storedHash);
  return { verified };
}

// =============================================================================
// Public Server Action
// =============================================================================

/**
 * Joins an authenticated student to a class by code + password.
 *
 * ## Behavior
 *
 *   1. Derive the Better Auth session via `getSession()`. If no
 *      session exists, return `UNAUTHENTICATED`. No input is
 *      read from the browser before this check.
 *   2. Load the application `Profile` for `session.user.id` via
 *      the existing profile service. The Profile must exist,
 *      `onboardingCompleted === true`, and `role === "student"`.
 *      Any deviation produces `PROFILE_INCOMPLETE` or
 *      `STUDENT_REQUIRED`. No membership is persisted on these
 *      paths.
 *   3. Validate the browser-supplied `classCode` and `password`
 *      via `JoinClassInputSchema`. Any failure produces
 *      `INVALID_CLASS_CODE` or `INVALID_CLASS_PASSWORD`. No
 *      membership is persisted on these paths.
 *   4. Load the join-time credential via the server-only
 *      `getClassJoinCredentialByCode(...)` primitive. This
 *      primitive returns `null` when no class exists with the
 *      canonicalized code. On `null` the action runs ONE
 *      canonical dummy PBKDF2 workload before returning
 *      `INVALID_CLASS_CREDENTIALS`. The branch is
 *      timing-attack-mitigated.
 *   5. If the returned credential has `status === "archived"`,
 *      the action runs ONE canonical dummy PBKDF2 workload
 *      before returning `INVALID_CLASS_CREDENTIALS`. The
 *      legitimate error would be "class is archived", but we
 *      intentionally collapse this to the same code as
 *      "wrong password" so an attacker cannot enumerate which
 *      codes correspond to live classes.
 *   6. Verify the submitted password against the stored hash
 *      using `verifyClassPassword`. If the stored hash is
 *      malformed, the action runs ONE canonical dummy PBKDF2
 *      workload and returns `INVALID_CLASS_CREDENTIALS`. If the
 *      password does not match, the action returns
 *      `INVALID_CLASS_CREDENTIALS` (the regular path — the real
 *      verification workload has already been performed by
 *      `verifyClassPassword`).
 *   7. Create the membership via
 *      `createMembership({ classId, studentUserId })`. If the
 *      insert collides on the compound `(classId, studentUserId)`
 *      unique index — classified precisely via
 *      `isMembershipDuplicateKeyError` (or via the
 *      `MembershipServiceError(MEMBERSHIP_ALREADY_JOINED)` typed
 *      error from the service) — the action surfaces an
 *      **idempotent success** with `alreadyJoined: true` and the
 *      ALREADY-PERSISTED membership projected via
 *      `getSafeMembership(classId, studentUserId)`. Any other
 *      persistence failure maps to `CLASS_JOIN_FAILED`. The insert
 *      is NEVER retried. The duplicate path requires the supplied
 *      password to have already been verified — an existing
 *      membership MUST NOT allow bypassing the class password.
 *   8. Project the persisted `SafeMembershipDto` into the
 *      browser-safe success shape. `password`, `passwordHash`,
 *      `studentUserId`, `teacherUserId`, Mongoose internals, and
 *      stack traces are NEVER serialized.
 *
 * ## Identities (all derived server-side)
 *
 *   - `studentUserId` ← `session.user.id` (Better Auth).
 *   - `classId`       ← `getClassJoinCredentialByCode(...)`.
 *   - `passwordHash`  ← read once from the persisted Class
 *                        document; never serialized.
 *
 * ## No automatic browser-side retry
 *
 * The action does NOT internally retry on any failure. All
 * failure modes return a single, safe error result so the future
 * UI can decide whether to re-invoke the action. The action does
 * NOT internally retry on auth failure, validation failure,
 * wrong password, archived class, missing class, malformed hash,
 * duplicate membership, or generic DB error.
 */
export async function createJoinClassAction(
  input: unknown,
): Promise<JoinClassActionResult> {
  // 1. Authentication — identity comes from the Better Auth
  //    session only. No userId is accepted from the browser.
  const session = await getSession();
  if (!session) {
    return buildError("UNAUTHENTICATED");
  }
  const studentUserId = session.user.id;
  if (
    typeof studentUserId !== "string" ||
    studentUserId.length === 0
  ) {
    return buildError("UNAUTHENTICATED");
  }

  // 2. Profile gating — load the Profile and require a complete,
  //    student-role record. Missing profile / incomplete
  //    onboarding / wrong role are mapped to safe codes. The
  //    profile service is the authoritative loader; this action
  //    does NOT touch the Profile.
  let profile;
  try {
    profile = await getProfileByUserId(studentUserId);
  } catch {
    // Persistence failure during the profile lookup is treated
    // as a generic join failure. We never leak driver details.
    return buildError("CLASS_JOIN_FAILED");
  }
  if (!profile || !profile.onboardingCompleted) {
    return buildError("PROFILE_INCOMPLETE");
  }
  if (profile.role !== "student") {
    return buildError("STUDENT_REQUIRED");
  }

  // 3. Validate browser-supplied class code + password. The Zod
  //    schema strips any extra keys so the browser cannot smuggle
  //    `studentUserId`, `classId`, `role`, `passwordHash`, etc.
  //    through. The schema runs server-side; browser HTML
  //    validation is NOT a security boundary.
  const parsed = JoinClassInputSchema.safeParse(input);
  if (!parsed.success) {
    // Discriminate which field failed so the browser receives a
    // specific code. Zod's `flatten().fieldErrors` is the
    // canonical source for per-field errors.
    const fieldErrors = parsed.error.flatten().fieldErrors;
    if (
      fieldErrors.classCode &&
      fieldErrors.classCode.length > 0
    ) {
      return buildError("INVALID_CLASS_CODE");
    }
    if (
      fieldErrors.password &&
      fieldErrors.password.length > 0
    ) {
      return buildError("INVALID_CLASS_PASSWORD");
    }
    // Defensive fallback for `.strict()` violations — collapse to
    // the password code so the browser cannot probe the schema.
    return buildError("INVALID_CLASS_PASSWORD");
  }
  const browserInput: JoinClassBrowserInput = parsed.data;

  // 4-5. Load the join-time credential via the server-only
  //      primitive. The class code is re-normalized inside the
  //      service layer, so case / whitespace variations are
  //      handled correctly even when the schema bypassed them.
  let credential: ClassJoinCredential | null;
  try {
    credential = await getClassJoinCredentialByCode(
      browserInput.classCode,
    );
  } catch {
    // Persistence failure during the lookup is treated as a
    // generic join failure. We never leak driver details. We do
    // NOT run the canonical timing workload here because we
    // have no way to know whether the failure is a
    // missing-class branch or a real DB outage — surfacing
    // `INVALID_CLASS_CREDENTIALS` for a generic outage would
    // confuse the legitimate UI flow.
    return buildError("CLASS_JOIN_FAILED");
  }

  if (credential === null) {
    // Missing class. Run ONE canonical dummy PBKDF2 workload so
    // an attacker observing latency cannot differentiate
    // "missing class" from "wrong password".
    await runCanonicalTimingWorkload(browserInput.password);
    return buildError("INVALID_CLASS_CREDENTIALS");
  }

  if (credential.status === "archived") {
    // Archived class. Run ONE canonical dummy PBKDF2 workload
    // so an attacker observing latency cannot differentiate
    // "archived class" from "wrong password".
    await runCanonicalTimingWorkload(browserInput.password);
    return buildError("INVALID_CLASS_CREDENTIALS");
  }

  // 6. Verify the submitted password against the stored hash.
  //    The verification primitive handles malformed stored
  //    hashes by routing through the dummy hash so the timing
  //    surface stays uniform.
  const { verified } = await verifyAgainstStoredOrDummyHash(
    browserInput.password,
    credential.passwordHash,
  );
  if (!verified) {
    return buildError("INVALID_CLASS_CREDENTIALS");
  }

  // 7. Create the membership. The membership service uses the
  //    precise `isMembershipDuplicateKeyError` classifier
  //    internally; the action maps a precise compound-key
  //    collision to an idempotent success with
  //    `alreadyJoined: true`. The insert is NEVER retried.
  let safeMembership: SafeMembershipDto;
  try {
    safeMembership = await createMembership({
      classId: credential.classId,
      studentUserId,
    });
  } catch (err) {
    // PHASE 5.1C — canonical verification audit
    //
    // Exact compound-key collision maps to IDEMPOTENT SUCCESS.
    // The existing membership is fetched via the server-only
    // `getSafeMembership` primitive and projected into the
    // browser-safe shape with `alreadyJoined: true`. No retry,
    // no second insert, no `ok: false` error code for a
    // already-valid join.
    if (err instanceof MembershipServiceError) {
      if (
        err.code === MEMBERSHIP_ERROR_CODES.MEMBERSHIP_ALREADY_JOINED ||
        // Preserve legacy alias for pre-5.1C callers.
        err.code === MEMBERSHIP_ERROR_CODES.MEMBERSHIP_ALREADY_EXISTS
      ) {
        const existing = await getSafeMembership(
          credential.classId,
          studentUserId,
        );
        if (!existing) {
          // The compound index says the membership exists, but
          // a follow-up read returns null — collapse to the
          // generic failure code without leaking internals.
          return buildError("CLASS_JOIN_FAILED");
        }
        return {
          ok: true,
          membership: {
            id: existing.id,
            classId: existing.classId,
            classCode: credential.classCode,
            joinedAt: existing.joinedAt.toISOString(),
            status: "active",
          },
          alreadyJoined: true,
        };
      }
      // Any other typed membership error is treated as a generic
      // join failure.
      return buildError("CLASS_JOIN_FAILED");
    }
    // Defensive: classify any raw E11000 that escaped the
    // service (e.g. a future driver quirk) using the precise
    // predicate. Anything else collapses to the safe generic
    // failure code.
    if (isMembershipDuplicateKeyError(err)) {
      const existing = await getSafeMembership(
        credential.classId,
        studentUserId,
      );
      if (!existing) {
        return buildError("CLASS_JOIN_FAILED");
      }
      return {
        ok: true,
        membership: {
          id: existing.id,
          classId: existing.classId,
          classCode: credential.classCode,
          joinedAt: existing.joinedAt.toISOString(),
          status: "active",
        },
        alreadyJoined: true,
      };
    }
    if (isClassCodeDuplicateKeyError(err)) {
      // Membership writes do not touch `classCode` — this
      // branch should be unreachable. Surface the generic
      // failure code if it ever fires.
      return buildError("CLASS_JOIN_FAILED");
    }
    return buildError("CLASS_JOIN_FAILED");
  }

  // 8. Project the safe DTO into the browser-safe success shape.
  //    `password`, `passwordHash`, `studentUserId`, and
  //    `teacherUserId` are intentionally dropped — the caller
  //    already represents the authenticated student and there is
  //    no UI that needs any of those fields.
  return {
    ok: true,
    membership: {
      id: safeMembership.id,
      classId: safeMembership.classId,
      classCode: credential.classCode,
      joinedAt: safeMembership.joinedAt.toISOString(),
      status: "active",
    },
    alreadyJoined: false,
  };
}

// =============================================================================
// Exposed for tests
// =============================================================================

export const __testing = {
  JoinClassInputSchema,
  ClassCodeSchema,
  JoinClassPasswordSchema,
  JOIN_CLASS_ACTION_ERROR_CODES,
  ERROR_MESSAGES,
  RETRYABLE,
  buildError,
  runCanonicalTimingWorkload,
  verifyAgainstStoredOrDummyHash,
  // Internal helpers referenced by tests; their existence is
  // also asserted by static source-grep tests so future
  // refactors cannot accidentally drop them.
  __DUMMY_CLASS_PASSWORD_HASH: DUMMY_CLASS_PASSWORD_HASH,
  __CLASS_ERROR_CODES: CLASS_ERROR_CODES,
};
