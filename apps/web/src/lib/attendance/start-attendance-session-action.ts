/**
 * Server Action: start a new Attendance Session as the
 * authenticated teacher who owns the class.
 *
 * PHASE 6.1E — AUTHENTICATED TEACHER START ATTENDANCE SESSION.
 *
 * This module is the ONLY entry point that lets a teacher start
 * an attendance session. It is a `"use server"` Server Action —
 * Client Components can import the function reference, but
 * Next.js refuses to bundle the body into the client build.
 * Browser-side code can never execute the underlying logic.
 *
 * ## Input contract (the only thing the browser may supply)
 *
 *   {
 *     classId: string   // canonical 24-hex Mongo ObjectId
 *   }
 *
 * The browser MUST NOT supply:
 *
 *   - teacherUserId   — derived from `session.user.id`.
 *   - userId          — same.
 *   - role            — derived from the Profile collection.
 *   - status          — always "active" on a fresh session.
 *   - startedAt       — written server-side as `new Date()`.
 *   - startedByUserId — written server-side from the session.
 *   - endedAt         — always null on a fresh session.
 *   - rosterSnapshot  — built server-side from ACTIVE memberships
 *                       and Profile projections. The browser
 *                       cannot supply, choose, or override it.
 *   - studentUserId   — server-built, never accepted.
 *
 * Any unexpected keys are stripped by the Zod schema before any
 * service call so a hand-crafted client cannot smuggle them
 * through the action signature.
 *
 * ## Identity / role source of truth
 *
 *   - Authentication  → Better Auth `getSession()` (server-only).
 *   - Onboarding      → `Profile.onboardingCompleted === true`.
 *   - Role            → `Profile.role === "teacher"`.
 *
 * The browser never names a teacher, chooses a role, or supplies a
 * roster.
 *
 * ## Roster snapshot
 *
 * The roster is captured AT START TIME from the class's ACTIVE
 * `ClassMembership` rows (`status === "active"`) and a single
 * batched `ProfileModel.find({ userId: { $in: [...] } })` lookup.
 * The snapshot is IMMUTABLE: future membership changes or future
 * Profile edits do not retroactively modify it.
 *
 * An invalid roster (any active membership pointing at a missing,
 * incomplete, or non-student Profile) returns
 * `ATTENDANCE_ROSTER_INVALID`. The session is NEVER created in
 * this case. The corrupt memberships are NEVER mutated by this
 * path.
 *
 * ## Active-session uniqueness
 *
 * The Mongo partial unique index on `(classId, status) WHERE status
 * === "active"` is the authoritative guard. Two concurrent start
 * requests cannot both insert an active session — the second loses
 * the unique race with a MongoDB E11000 error, which the service
 * classifies precisely via
 * `isAttendanceSessionActiveDuplicateKeyError(...)` and surfaces as
 * a safe idempotent success (`ok: true, alreadyActive: true`).
 * The browser NEVER sees a raw `E11000` / collection name / Mongo
 * stack.
 *
 * ## Output contract (browser-safe discriminated union)
 *
 *   Success:
 *     {
 *       ok: true,
 *       alreadyActive: boolean,
 *       session: {
 *         id, classId, status: "active", startedAt, rosterCount
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
 *         | "CLASS_NOT_ACCESSIBLE"
 *         | "CLASS_NOT_ACTIVE"
 *         | "ATTENDANCE_ROSTER_INVALID"
 *         | "ATTENDANCE_SESSION_CREATE_FAILED",
 *       message: string,   // safe copy
 *       retryable: boolean // hint for future UI
 *     }
 *
 * `password`, `passwordHash`, `teacherUserId`, `startedByUserId`,
 * `rosterSnapshot`, `studentUserId`, raw Mongoose fields, raw
 * stack traces, Mongo error messages, and the Mongo URI are
 * NEVER returned.
 *
 * ## Scope guarantees
 *
 *   - Does NOT create / update / delete any `Class`,
 *     `ClassMembership`, `Profile`, `FaceProfile`, or
 *     `FaceEnrollmentSession`.
 *   - Does NOT call the Face Service.
 *   - Does NOT query embeddings / centroids / biometrics.
 *   - Does NOT require camera access.
 *   - Does NOT mark any student as present / absent / late.
 *   - Does NOT create any `AttendanceRecord` / per-student record.
 *   - Does NOT introduce an attendance UI.
 *   - Does NOT introduce a public attendance REST API.
 *
 * This module opens with `"use server"` so it can only be invoked
 * as a Server Action from a Client Component, a Server Component,
 * a Route Handler, or another Server Action. The Client Component
 * bundle can import the function reference but cannot execute its
 * body (Next.js enforces this at build time).
 */

"use server";

import { Types } from "mongoose";

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import {
  ClassModel,
  type ClassAttrs,
} from "@/lib/classes/class-model";
import {
  createAttendanceSession,
  findActiveAttendanceSessionByClassId,
  toSafeAttendanceSessionSummary,
  AttendanceSessionServiceError,
  ATTENDANCE_SESSION_ERROR_CODES,
} from "@/lib/attendance/attendance-session-service";
import {
  StartAttendanceInputSchema,
  type StartAttendanceActionResult,
} from "./attendance-session-action-types";
import {
  buildAttendanceError,
  toSafeStartError,
} from "./attendance-session-action-helpers";

// =============================================================================
// Constants
// =============================================================================

/**
 * Bounded retry budget for the unique-index race. Mirrors the
 * established PHASE 5.1B pattern (see `MAX_CLASS_CODE_ATTEMPTS`).
 *
 * Two concurrent start requests for the same class would normally
 * have only ONE surviving insert (the partial unique index rejects
 * the second). The single retry resolves the race to the existing
 * active session; no further retries are meaningful.
 */
const MAX_START_RACE_RETRIES = 2;

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Loads the requested class and asserts that the supplied
 * `teacherUserId` owns it AND that its status is `active`.
 *
 * The query encodes the ownership constraint directly into the
 * database filter, so the database itself refuses to surface a
 * class the teacher does not own. The `status` constraint is
 * applied via projection so the result still surfaces the class
 * when its `status` is `archived` — the projection does NOT
 * preclude archived reads in the detail path; only the START path
 * adds the active-status check on top.
 *
 * The function never throws on a missing class.
 */
async function findOwnedActiveClassForTeacher(
  classId: Types.ObjectId,
  teacherUserId: string,
): Promise<ClassAttrs | null> {
  const doc = await ClassModel.findOne({
    _id: classId,
    teacherUserId,
    status: "active",
  })
    .select({
      _id: 1,
      name: 1,
      classCode: 1,
      status: 1,
      teacherUserId: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    .lean<ClassAttrs | null>()
    .exec();
  return doc ?? null;
}

/**
 * Builds the typed success result for the START action from a
 * safely-projected AttendanceSession document.
 *
 * `alreadyActive` distinguishes a fresh insert from a duplicate-
 * race idempotent success. `classId` is included so the browser
 * can correlate the session id with its own known class id
 * without making a separate read.
 */
function buildStartSuccess(
  doc: Parameters<typeof toSafeAttendanceSessionSummary>[0],
  classId: string,
  alreadyActive: boolean,
): Extract<StartAttendanceActionResult, { ok: true }> {
  const safe = toSafeAttendanceSessionSummary(doc);
  return {
    ok: true,
    alreadyActive,
    session: {
      id: safe.id,
      classId,
      status: safe.status,
      startedAt: safe.startedAt,
      rosterCount: safe.rosterCount,
    },
  };
}

// =============================================================================
// Public Server Action
// =============================================================================

/**
 * Starts a new attendance session for an ACTIVE class owned by the
 * currently authenticated teacher.
 *
 * ## Behavior
 *
 *   1. Derive the Better Auth session via `getSession()`. If no
 *      session exists, return `UNAUTHENTICATED`. No input is read
 *      from the browser before this check.
 *   2. Validate the browser-supplied `classId` via the
 *      `StartAttendanceInputSchema`. The schema is `.strict()`,
 *      so any unexpected key is rejected before the service layer
 *      is reached. Malformed `classId` (not a canonical 24-hex
 *      string) collapses to the same safe `CLASS_NOT_ACCESSIBLE`
 *      boundary used for missing / unauthorized classes.
 *   3. Load the application `Profile` for `session.user.id` via
 *      the existing profile service. The Profile must exist,
 *      `onboardingCompleted === true`, and `role === "teacher"`.
 *      Any deviation produces `PROFILE_INCOMPLETE` or
 *      `TEACHER_REQUIRED`. No class / session is touched on these
 *      paths.
 *   4. Authorize the requested class via the
 *      `findOwnedActiveClassForTeacher(...)` primitive. The
 *      database itself refuses to surface a class the teacher
 *      does not own — there is intentionally NO separate
 *      `NOT_CLASS_OWNER` outward-facing code. A `null` result
 *      collapses to `CLASS_NOT_ACCESSIBLE` (malformed id,
 *      missing class, wrong teacher). A non-active class is
 *      filtered directly by the database query and therefore also
 *      collapses to the safe `CLASS_NOT_ACCESSIBLE` boundary —
 *      the difference between "archived" and "not yours" is
 *      intentionally not exposed.
 *   5. Check whether an active session already exists for the
 *      class. A `null` result is the normal path (proceed to
 *      create). A non-null result means a fresh explicit start is
 *      requested while a session is already active — the action
 *      returns a safe idempotent success with
 *      `alreadyActive: true` and the existing session projected
 *      into the browser-safe summary. No new session is created.
 *   6. Call `createAttendanceSession({ classId, startedByUserId })`.
 *      The service:
 *        - builds the immutable roster snapshot from the class's
 *          ACTIVE memberships + a single batched Profile lookup;
 *        - inserts the document with `status: "active"` and
 *          `startedAt: now()` server-side;
 *        - classifies a precise `(classId, status) WHERE status
 *          === "active"` duplicate-key collision as
 *          `AttendanceSessionServiceError(ATTENDANCE_SESSION_ALREADY_ACTIVE)`
 *          and surfaces a safe idempotent success.
 *      Any other persistence failure → `ATTENDANCE_SESSION_CREATE_FAILED`.
 *   7. On success, project the persisted document into the
 *      browser-safe `SafeAttendanceSessionSummary` shape. The
 *      `rosterSnapshot` payload is NEVER projected — only
 *      `rosterCount`.
 *
 * ## Identities (all derived server-side)
 *
 *   - `startedByUserId` ← `session.user.id` (Better Auth).
 *   - `startedAt`       ← `new Date()` at insert time.
 *   - `status`          ← always `"active"` on the start path.
 *   - `endedAt`         ← always `null` on the start path.
 *   - `rosterSnapshot`  ← server-built from ACTIVE memberships +
 *                         single batched Profile lookup.
 *
 * ## No automatic browser-side retry
 *
 * The bounded retry above is INTERNAL to this action and is
 * triggered only by a precise `(classId, status) WHERE status ===
 * "active"` uniqueness collision (i.e. a concurrent start lost the
 * race). All other failure modes return a single, safe error
 * result so the future UI can decide whether to re-invoke the
 * action.
 */
export async function startAttendanceSessionAction(
  input: unknown,
): Promise<StartAttendanceActionResult> {
  // 1. Authentication — identity comes from the Better Auth
  //    session only. No userId is accepted from the browser.
  const session = await getSession();
  if (!session) {
    return buildAttendanceError("UNAUTHENTICATED");
  }
  const teacherUserId = session.user.id;
  if (typeof teacherUserId !== "string" || teacherUserId.length === 0) {
    return buildAttendanceError("UNAUTHENTICATED");
  }

  // 2. Validate browser-supplied classId. The Zod schema is
  //    `.strict()`, so any unexpected key is rejected before the
  //    service layer is reached. A malformed id (not a 24-hex
  //    string) collapses to the safe `CLASS_NOT_ACCESSIBLE`
  //    boundary.
  const parsed = StartAttendanceInputSchema.safeParse(input);
  if (!parsed.success) {
    // `.strict()` violations or malformed id collapse to the safe
    // inaccessible boundary so the browser cannot probe the
    // schema. We never expose a separate "invalid id" code.
    return buildAttendanceError("CLASS_NOT_ACCESSIBLE");
  }
  const browserInput = parsed.data;
  const classIdObjectId = new Types.ObjectId(browserInput.classId);

  // 3. Profile gating — load the Profile and require a complete,
  //    teacher-role record. Missing profile / incomplete
  //    onboarding / wrong role are mapped to safe codes. The
  //    profile service is the authoritative loader; this action
  //    does NOT touch the Profile.
  let profile;
  try {
    profile = await getProfileByUserId(teacherUserId);
  } catch {
    // Persistence failure during the profile lookup is treated
    // as a generic attendance-session failure. We never leak
    // driver details.
    return buildAttendanceError("ATTENDANCE_SESSION_CREATE_FAILED");
  }
  if (!profile || !profile.onboardingCompleted) {
    return buildAttendanceError("PROFILE_INCOMPLETE");
  }
  if (profile.role !== "teacher") {
    return buildAttendanceError("TEACHER_REQUIRED");
  }

  // 4. Authorize the requested class. The database itself refuses
  //    to surface a class the teacher does not own OR an
  //    archived class for the START path.
  let classDoc: ClassAttrs | null;
  try {
    classDoc = await findOwnedActiveClassForTeacher(
      classIdObjectId,
      teacherUserId,
    );
  } catch {
    return buildAttendanceError("ATTENDANCE_SESSION_CREATE_FAILED");
  }
  if (!classDoc) {
    return buildAttendanceError("CLASS_NOT_ACCESSIBLE");
  }

  // 5. Pre-check for an existing active session. A non-null result
  //    folds into a safe idempotent success with
  //    `alreadyActive: true`. We avoid an unnecessary write attempt
  //    on the common "teacher clicked Start twice" case.
  try {
    const existing = await findActiveAttendanceSessionByClassId(
      classIdObjectId,
    );
    if (existing) {
      return buildStartSuccess(
        existing,
        browserInput.classId,
        /* alreadyActive */ true,
      );
    }
  } catch {
    return buildAttendanceError("ATTENDANCE_SESSION_CREATE_FAILED");
  }

  // 6. Create the session. The service builds the immutable
  //    roster snapshot, inserts with `status: "active"`, and
  //    surfaces a typed `ATTENDANCE_SESSION_ALREADY_ACTIVE` on a
  //    concurrent unique collision.
  let createdDoc;
  try {
    createdDoc = await createAttendanceSession({
      classId: classIdObjectId,
      startedByUserId: teacherUserId,
    });
  } catch (err) {
    if (err instanceof AttendanceSessionServiceError) {
      // Precise active-session uniqueness collision — concurrent
      // start lost the race. Re-read the now-active session and
      // surface a safe idempotent success with `alreadyActive:
      // true`. The browser NEVER sees `E11000` / collection name
      // / Mongo URI.
      if (
        err.code ===
        ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_SESSION_ALREADY_ACTIVE
      ) {
        // Bounded internal retry: re-read up to
        // MAX_START_RACE_RETRIES times. In practice the second
        // read resolves on the first iteration; the budget exists
        // only to defend against a pathological driver latency
        // spike between the loser's insert and the winner's
        // commit. If even the second read returns `null` we
        // collapse to the safe generic failure.
        for (let i = 0; i < MAX_START_RACE_RETRIES; i++) {
          try {
            const existing = await findActiveAttendanceSessionByClassId(
              classIdObjectId,
            );
            if (existing) {
              return buildStartSuccess(
                existing,
                browserInput.classId,
                /* alreadyActive */ true,
              );
            }
          } catch {
            // Fall through to the next iteration or the safe
            // generic failure below.
          }
        }
        return buildAttendanceError("ATTENDANCE_SESSION_CREATE_FAILED");
      }
      // Specific typed service errors are mapped to specific
      // browser-safe codes.
      if (
        err.code ===
        ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_ROSTER_INVALID
      ) {
        return buildAttendanceError("ATTENDANCE_ROSTER_INVALID");
      }
      // Any other typed service error collapses to the safe
      // generic code via the shared helper.
      return toSafeStartError(err);
    }
    // Any non-typed thrown value collapses to the safe generic
    // failure.
    return buildAttendanceError("ATTENDANCE_SESSION_CREATE_FAILED");
  }

  return buildStartSuccess(
    createdDoc,
    browserInput.classId,
    /* alreadyActive */ false,
  );
}
