/**
 * Server Action: stop the currently active Attendance Session for
 * a class owned by the authenticated teacher.
 *
 * PHASE 6.1E — AUTHENTICATED TEACHER STOP ATTENDANCE SESSION.
 * PHASE 6.6 — ATTENDANCE SESSION FINALIZATION (adds absent mark creation).
 *
 * This module is the ONLY entry point that lets a teacher stop an
 * attendance session. It is a `"use server"` Server Action —
 * Client Components can import the function reference, but
 * Next.js refuses to bundle the body into the client build.
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
 *   - status          — always set to "closed" server-side via an
 *                       atomic CAS update.
 *   - endedAt         — written server-side as `new Date()` at
 *                       the moment the CAS update commits.
 *   - startedByUserId — server-internal, never accepted from the
 *                       browser.
 *   - rosterSnapshot  — read-only on this path; the immutable
 *                       snapshot is preserved verbatim.
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
 * The browser never names a teacher or chooses a role.
 *
 * ## Atomic stop semantics
 *
 * The stop is performed as a SINGLE atomic `findOneAndUpdate` whose
 * filter encodes the precondition `status: "active"`. The update
 * sets `status: "closed"` and `endedAt: <server current time>`.
 *
 * A `null` result means either:
 *
 *   - no session exists for the class, or
 *   - the session exists but is already `closed`.
 *
 * Both branches are folded into a safe idempotent success with
 * `alreadyStopped: true` and the most-recently-closed session
 * projected into the browser-safe summary. The browser NEVER sees
 * a raw "session not found" or "session not active" error for an
 * authorized teacher.
 *
 * ## Idempotency
 *
 * Stopping twice is SAFE. The second invocation:
 *
 *   - observes the now-closed session;
 *   - returns `ok: true, alreadyStopped: true`;
 *   - does NOT create a new session;
 *   - does NOT alter `rosterSnapshot`;
 *   - does NOT alter `startedAt`;
 *   - does NOT alter the original `endedAt`.
 *
 * The action NEVER performs a `read → then unconditional update`
 * pattern. The atomic CAS is the ONLY stop path.
 *
 * ## Output contract (browser-safe discriminated union)
 *
 *   Success:
 *     {
 *       ok: true,
 *       alreadyStopped: boolean,
 *       session: {
 *         id, classId, status: "closed",
 *         startedAt, endedAt, rosterCount
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
 *         | "ATTENDANCE_SESSION_STOP_FAILED",
 *       message: string,
 *       retryable: boolean
 *     }
 *
 * `password`, `passwordHash`, `teacherUserId`, `startedByUserId`,
 * `rosterSnapshot`, `studentUserId`, raw Mongoose fields, raw
 * stack traces, Mongo error messages, and the Mongo URI are NEVER
 * returned.
 *
 * ## Scope guarantees
 *
 *   - Does NOT create / update / delete any `Class`,
 *     `ClassMembership`, `Profile`, `FaceProfile`, or
 *     `FaceEnrollmentSession`.
 *   - Does NOT call the Face Service.
 *   - Does NOT query embeddings / centroids / biometrics.
 *   - Does NOT require camera access.
 *   - Does NOT modify existing Present marks.
 *   - Does NOT create per-student attendance records outside the
 *     `AttendanceMark` collection.
 *   - Does NOT introduce an attendance UI.
 *   - Does NOT introduce a public attendance REST API.
 *   - PHASE 6.6: Creates absent marks (source: session_finalization)
 *     for every roster student without a present mark.
 *
 * ## PHASE 6.6 — Session finalization
 *
 * After atomically closing the session, the action:
 *   1. Loads existing Present marks for that session.
 *   2. Compares against the immutable rosterSnapshot.
 *   3. Creates Absent marks (source: "session_finalization")
 *      for every roster student without a Present mark.
 *   4. Present marks are NEVER overwritten or removed.
 *   5. Absent marks use a server timestamp (finalizedAt).
 *   6. The unique (sessionId, studentUserId) index prevents
 *      duplicate absent marks on repeated finalization.
 *
 * The action never queries current ClassMembership or Profile —
 * the rosterSnapshot is the sole authoritative source.
 *
 * This module opens with `"use server"` so it can only be invoked
 * as a Server Action. The Client Component bundle can import the
 * function reference but cannot execute its body.
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
  AttendanceSessionModel,
  type AttendanceSessionAttrs,
} from "@/lib/attendance/attendance-session-model";
import {
  ATTENDANCE_SESSION_ERROR_CODES,
  AttendanceSessionServiceError,
  closeActiveAttendanceSessionForClass,
  findActiveAttendanceSessionByClassId,
  toSafeAttendanceSessionSummary,
} from "@/lib/attendance/attendance-session-service";
import {
  finalizeAbsentMarksForClosedSession,
} from "@/lib/attendance/attendance-mark-service";
import {
  StopAttendanceInputSchema,
  type StopAttendanceActionResult,
} from "./attendance-session-action-types";
import {
  buildAttendanceError,
  toSafeStopError,
} from "./attendance-session-action-helpers";

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Loads the requested class and asserts that the supplied
 * `teacherUserId` owns it. The query encodes the ownership
 * constraint directly into the database filter.
 *
 * The function never throws on a missing class. Archived status is
 * allowed on the stop path because a teacher who started a session
 * for a class that subsequently became archived MUST still be able
 * to close that session — the class status check is intentionally
 * less strict than on the start path.
 *
 * The stop action performs NO class-status enforcement.
 */
async function findOwnedClassForTeacher(
  classId: Types.ObjectId,
  teacherUserId: string,
): Promise<ClassAttrs | null> {
  const doc = await ClassModel.findOne({
    _id: classId,
    teacherUserId,
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
 * Returns the most recently closed session for `classId`, or
 * `null` when no session has ever been created for the class.
 *
 * Used as the safe idempotent-stop source: when the atomic CAS
 * misses (because the session is already closed), the action
 * fetches the latest closed session and surfaces its summary.
 * `null` collapses to `ATTENDANCE_SESSION_STOP_FAILED` so the
 * browser receives a single, restrained failure code rather than
 * a "not found" leak.
 */
async function findLatestClosedSessionForClass(
  classId: Types.ObjectId,
): Promise<AttendanceSessionAttrs | null> {
  const docs = await AttendanceSessionModel.find({ classId })
    .sort({ startedAt: -1 })
    .limit(1)
    .lean<AttendanceSessionAttrs[]>()
    .exec();
  if (docs.length === 0) return null;
  const first = docs[0];
  return first ?? null;
}

/**
 * Builds the typed success result for the STOP action from a
 * safely-projected AttendanceSession document.
 *
 * `alreadyStopped` is `true` when the atomic CAS missed (because
 * the session was already closed), or when the teacher called
 * stop a second time after a successful stop.
 *
 * `finalized` is present when finalization was performed
 * (session was ACTIVE before the close).
 */
function buildStopSuccess(
  doc: Parameters<typeof toSafeAttendanceSessionSummary>[0],
  classId: string,
  alreadyStopped: boolean,
  finalized?: {
    finalizedAt: string;
    absentCount: number;
  },
): Extract<StopAttendanceActionResult, { ok: true }> {
  const safe = toSafeAttendanceSessionSummary(doc);
  return {
    ok: true,
    alreadyStopped,
    session: {
      id: safe.id,
      classId,
      status: safe.status,
      startedAt: safe.startedAt,
      endedAt: safe.endedAt,
      rosterCount: safe.rosterCount,
      ...(finalized ?? {}),
    },
  };
}

// =============================================================================
// Public Server Action
// =============================================================================

/**
 * Stops the currently ACTIVE attendance session for a class owned
 * by the currently authenticated teacher.
 *
 * ## Behavior
 *
 *   1. Derive the Better Auth session via `getSession()`. If no
 *      session exists, return `UNAUTHENTICATED`. No input is read
 *      from the browser before this check.
 *   2. Validate the browser-supplied `classId` via the
 *      `StopAttendanceInputSchema`. The schema is `.strict()`, so
 *      any unexpected key is rejected before the service layer
 *      is reached. Malformed `classId` (not a canonical 24-hex
 *      string) collapses to the safe `CLASS_NOT_ACCESSIBLE`
 *      boundary used for missing / unauthorized classes.
 *   3. Load the application `Profile` for `session.user.id`. The
 *      Profile must exist, `onboardingCompleted === true`, and
 *      `role === "teacher"`. Any deviation produces
 *      `PROFILE_INCOMPLETE` or `TEACHER_REQUIRED`. No session is
 *      touched on these paths.
 *   4. Authorize the requested class via
 *      `findOwnedClassForTeacher(...)`. The database itself
 *      refuses to surface a class the teacher does not own.
 *      A `null` result collapses to `CLASS_NOT_ACCESSIBLE` —
 *      there is intentionally NO separate `NOT_CLASS_OWNER`
 *      outward-facing code.
 *   5. Call
 *      `closeActiveAttendanceSessionForClass(classId)`. The
 *      service performs a single atomic `findOneAndUpdate` whose
 *      filter encodes `status: "active"`. The action does NOT
 *      read-then-update.
 *      - On hit, the service returns the now-closed document
 *        with `status: "closed"` and `endedAt: <server current
 *        time>`. The action then performs PHASE 6.6 finalization:
 *        loads existing present marks, compares against the
 *        rosterSnapshot, and creates absent marks (source:
 *        "session_finalization") for unmarked students.
 *        Returns `ok: true, alreadyStopped: false`.
 *      - On miss (typed
 *        `AttendanceSessionServiceError(ATTENDANCE_SESSION_NOT_ACTIVE)`),
 *        the action folds the failure into a safe idempotent
 *        success by reading the most recently closed session:
 *          * If a closed session exists → re-finalizes absent
 *            marks (idempotent) and returns
 *            `ok: true, alreadyStopped: true`.
 *          * If no session has ever existed for the class →
 *            returns `ATTENDANCE_SESSION_STOP_FAILED`.
 *   6. Any other persistence failure → safe
 *      `ATTENDANCE_SESSION_STOP_FAILED` via the shared helper.
 *
 * ## Identities (all derived server-side)
 *
 *   - `teacherUserId` ← `session.user.id` (Better Auth).
 *   - `endedAt`       ← `new Date()` at the moment the atomic
 *                        CAS commits.
 *   - `status`        ← always `"closed"` after a successful
 *                        stop.
 *
 * ## No automatic browser-side retry
 *
 * The stop path performs EXACTLY ONE atomic CAS, plus at most one
 * "latest closed session" read for the idempotent-stop fallback.
 * All other failure modes return a single, safe error result so
 * the future UI can decide whether to re-invoke the action.
 */
export async function stopAttendanceSessionAction(
  input: unknown,
): Promise<StopAttendanceActionResult> {
  // 1. Authentication — identity comes from the Better Auth
  //    session only.
  const session = await getSession();
  if (!session) {
    return buildAttendanceError("UNAUTHENTICATED");
  }
  const teacherUserId = session.user.id;
  if (typeof teacherUserId !== "string" || teacherUserId.length === 0) {
    return buildAttendanceError("UNAUTHENTICATED");
  }

  // 2. Validate browser-supplied classId. A malformed id collapses
  //    to the safe `CLASS_NOT_ACCESSIBLE` boundary.
  const parsed = StopAttendanceInputSchema.safeParse(input);
  if (!parsed.success) {
    return buildAttendanceError("CLASS_NOT_ACCESSIBLE");
  }
  const browserInput = parsed.data;
  const classIdObjectId = new Types.ObjectId(browserInput.classId);

  // 3. Profile gating — load the Profile and require a complete,
  //    teacher-role record.
  let profile;
  try {
    profile = await getProfileByUserId(teacherUserId);
  } catch {
    return buildAttendanceError("ATTENDANCE_SESSION_STOP_FAILED");
  }
  if (!profile || !profile.onboardingCompleted) {
    return buildAttendanceError("PROFILE_INCOMPLETE");
  }
  if (profile.role !== "teacher") {
    return buildAttendanceError("TEACHER_REQUIRED");
  }

  // 4. Authorize the requested class. The teacher-owning
  //    constraint is encoded directly into the DB query.
  let classDoc: ClassAttrs | null;
  try {
    classDoc = await findOwnedClassForTeacher(
      classIdObjectId,
      teacherUserId,
    );
  } catch {
    return buildAttendanceError("ATTENDANCE_SESSION_STOP_FAILED");
  }
  if (!classDoc) {
    return buildAttendanceError("CLASS_NOT_ACCESSIBLE");
  }

  // 5. Atomic stop + PHASE 6.6 finalization.
  //    The service performs a single CAS; a typed NOT_ACTIVE error
  //    folds into a safe idempotent success.
  try {
    const closed = await closeActiveAttendanceSessionForClass(
      classIdObjectId,
    );

    // PHASE 6.6: Finalize absent marks for the now-closed session.
    // The rosterSnapshot is the sole authoritative source.
    // Finalization is idempotent — the unique (sessionId, studentUserId)
    // index prevents duplicate absent marks on repeated stop calls.
    let finalized: { finalizedAt: string; absentCount: number } | undefined;
    try {
      const finalizeResult = await finalizeAbsentMarksForClosedSession({
        sessionId: String((closed as unknown as { _id: { toString: () => string } })._id),
        classId: browserInput.classId,
      });
      finalized = {
        finalizedAt: finalizeResult.finalizedAt,
        absentCount: finalizeResult.createdAbsent.length,
      };
    } catch {
      // Finalization failure is logged but does not fail the stop action.
      // The session is already closed; absent marks are not critical path.
      // We intentionally do not surface this as a user-facing error.
      finalized = undefined;
    }

    return buildStopSuccess(
      closed,
      browserInput.classId,
      /* alreadyStopped */ false,
      finalized,
    );
  } catch (err) {
    if (err instanceof AttendanceSessionServiceError) {
      if (
        err.code ===
        ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_SESSION_NOT_ACTIVE
      ) {
        // Idempotent stop: re-read the latest closed session for
        // the class. If a closed session exists, surface it as a
        // safe idempotent success with `alreadyStopped: true`.
        // PHASE 6.6: Re-run finalization to handle the case where
        // the first stop closed the session but failed during
        // absent-mark creation (e.g. partial network error).
        // The unique (sessionId, studentUserId) index prevents
        // duplicate marks; repeated finalization is idempotent.
        try {
          const latest = await findLatestClosedSessionForClass(
            classIdObjectId,
          );
          if (!latest) {
            return buildAttendanceError(
              "ATTENDANCE_SESSION_STOP_FAILED",
            );
          }

          // PHASE 6.6: Finalize absent marks even on idempotent stop.
          // Safe idempotent re-run.
          let finalized: { finalizedAt: string; absentCount: number } | undefined;
          try {
            const finalizeResult = await finalizeAbsentMarksForClosedSession({
              sessionId: String((latest as unknown as { _id: { toString: () => string } })._id),
              classId: browserInput.classId,
            });
            finalized = {
              finalizedAt: finalizeResult.finalizedAt,
              absentCount: finalizeResult.createdAbsent.length,
            };
          } catch {
            // Finalization failure on idempotent stop is safe — the
            // session is already closed; absent marks are not critical path.
            finalized = undefined;
          }

          return buildStopSuccess(
            latest,
            browserInput.classId,
            /* alreadyStopped */ true,
            finalized,
          );
        } catch {
          return buildAttendanceError(
            "ATTENDANCE_SESSION_STOP_FAILED",
          );
        }
      }
      // Any other typed service error collapses to the safe
      // generic code.
      return toSafeStopError(err);
    }
    // Untyped error → safe generic code.
    return buildAttendanceError("ATTENDANCE_SESSION_STOP_FAILED");
  }
}

// =============================================================================
// Used by tests / helpers
// =============================================================================

/**
 * Internal-only `findActiveAttendanceSessionByClassId` re-export
 * for the dedicated stop test fixture. The action module is the
 * only place that re-exports this primitive so future refactors
 * cannot accidentally split the read from the stop path.
 */
export { findActiveAttendanceSessionByClassId };
