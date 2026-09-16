/**
 * Server-only authenticated class list read model.
 *
 * PHASE 5.1D1 — AUTHENTICATED CLASS LIST READ MODELS.
 *
 * Encapsulates the server-side read boundary that returns the classes
 * visible to the currently authenticated user. This module is the
 * canonical, READ-ONLY entry point for future Server Components and
 * other server-rendered surfaces that need to list the caller's
 * classes.
 *
 * This module is **NOT** a Server Action. It is a server-only read
 * primitive intentionally written as a plain `async` function so a
 * future Server Component can `import` and `await` it directly. It
 * is **NOT** exposed as a REST route.
 *
 * ## Architectural invariants
 *
 *   - `import "server-only"` is the very first import. The Next.js
 *     bundler refuses to compile this module into a Client Component
 *     bundle, so a hand-crafted browser cannot smuggle it.
 *   - The function signature accepts **NO** userId argument. Identity
 *     and role come exclusively from the Better Auth server session
 *     and the persisted Profile.
 *   - The branch on teacher-vs-student visibility is decided inside
 *     this module from `profile.role`. The browser never supplies a
 *     role.
 *   - This module is READ-ONLY. It does NOT create / update /
 *     delete a `Class`, a `ClassMembership`, or a `Profile`. It does
 *     NOT call the Face Service. It does NOT touch `FaceProfile`.
 *     It does NOT call any class-password primitive.
 *   - Membership status filtering honors the current model: only
 *     `active` memberships grant visibility. The shape of the
 *     membership status filter is forward-compatible with future
 *     status values (`removed`, etc.) — the predicate asks for the
 *     specific `active` value rather than implicitly accepting
 *     everything that is not in a hypothetical negative set.
 *   - Missing referenced classes are skipped safely — corrupt data
 *     cannot crash the read.
 *   - Ordering is deterministic: `createdAt` descending (newest
 *     first) for both teacher and student branches, mirroring the
 *     existing service-layer convention.
 *   - The output shape is a small, browser-safe DTO. It NEVER
 *     includes `passwordHash`, `teacherUserId`, `studentUserId`,
 *     membership internal ids, Mongoose internals, biometric
 *     fields, or credential helpers.
 *
 * ## Failure-mode invariants
 *
 *   - No Better Auth session          → `UNAUTHENTICATED`.
 *   - Missing / incomplete Profile    → `PROFILE_INCOMPLETE`.
 *   - `profile.role === "teacher"`     → teacher read path
 *                                        (`Class.teacherUserId === session.user.id`).
 *   - `profile.role === "student"`     → student read path
 *                                        (`ClassMembership.studentUserId === session.user.id`,
 *                                         `status === "active"`).
 *   - Any unexpected DB / read failure → `CLASS_READ_FAILED`.
 *
 * `MongoError`, raw stack traces, the connection string, and the
 * collection name are NEVER serialized.
 *
 * ## Privacy posture
 *
 *   - Identity, role, and class membership are derived exclusively
 *     from server-authoritative state (`session.user.id`,
 *     `Profile.role`, `ClassMembership.studentUserId`).
 *   - `passwordHash`, `Class.teacherUserId`, and
 *     `ClassMembership.studentUserId` are NEVER projected into the
 *     result. The teacher sees their own classes via a server-side
 *     filter (`teacherUserId === session.user.id`) — the teacher's
 *     own id does not appear in the result because the result is
 *     about classes, not about the viewer.
 *   - `viewerRole` is included as a hint for future UI, derived
 *     from `Profile.role`. It is never inferred from Class
 *     ownership or membership status.
 *   - No biometric fields, no Face Service call, no FaceProfile
 *     read.
 *
 * ## DO NOT DO HERE
 *
 *   - Do NOT create / mutate any persisted document.
 *   - Do NOT call `verifyClassPassword` or any password primitive.
 *   - Do NOT read `passwordHash`. The teacher path queries the
 *     `ClassModel` projection excludes `passwordHash`; the student
 *     path never queries a class credential at all.
 *   - Do NOT add a `/api/classes` route.
 *   - Do NOT add UI.
 *   - Do NOT implement class detail, roster, or attendance.
 */

import "server-only";

import { Types } from "mongoose";

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import {
  ClassModel,
  type ClassAttrs,
  type ClassStatus,
} from "@/lib/classes/class-model";
import {
  ClassMembershipModel,
  type ClassMembershipAttrs,
} from "@/lib/classes/class-membership-model";

// =============================================================================
// Safe DTOs
// =============================================================================

/**
 * Browser-safe class summary projected from a Class document.
 *
 * Only the fields a future Server Component (or any other
 * server-rendered surface) actually needs to render a class tile
 * are included. Internal / sensitive fields are NEVER projected:
 *
 *   - `passwordHash`            → never included.
 *   - `teacherUserId`           → never included (the teacher
 *                                 already represents themselves in
 *                                 the session; the student sees a
 *                                 class they already joined, not
 *                                 the teacher's id).
 *   - `studentUserId`           → never included (no class-level
 *                                 student userId exists; the
 *                                 membership service owns the
 *                                 join table).
 *   - membership internal id    → never included.
 *   - `__v` (Mongoose internal) → never included.
 *   - biometric fields          → never included (Class has none,
 *                                 but the type guard also
 *                                 prevents accidental leakage).
 */
export interface SafeClassSummary {
  id: string;
  name: string;
  classCode: string;
  status: ClassStatus;
  createdAt: string;
}

/**
 * The authenticated read result.
 *
 * `role` is the server-authoritative viewer role (derived from
 * `Profile.role`). `classes` is the deterministic, deduplicated,
 * server-projected list.
 *
 * `role` is NEVER inferred from Class ownership / membership.
 */
export interface VisibleClassesResult {
  role: "teacher" | "student";
  classes: SafeClassSummary[];
}

/**
 * Discriminated union for the read boundary.
 *
 * Each failure mode has a stable, browser-safe code. The shape
 * mirrors the project-wide Server Action convention so a future
 * Server Component can surface the same code to the UI without
 * inventing a parallel error contract.
 *
 * `UNAUTHENTICATED`     — no Better Auth session.
 * `PROFILE_INCOMPLETE`  — missing or incomplete Profile.
 * `CLASS_READ_FAILED`   — unexpected DB / read failure.
 *
 * There is intentionally NO `CLASS_LIST_EMPTY` code — an empty
 * list is a successful read with `classes: []`.
 */
export type GetVisibleClassesResult =
  | { ok: true; result: VisibleClassesResult }
  | { ok: false; code: GetVisibleClassesErrorCode; message: string };

/**
 * Stable error codes for the class-list read boundary.
 *
 * Kept in sync with the project's `docs/api.md` Server Action
 * convention so a future UI surface can render the same codes.
 */
export const CLASS_READ_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
  CLASS_READ_FAILED: "CLASS_READ_FAILED",
} as const;

export type GetVisibleClassesErrorCode =
  (typeof CLASS_READ_ERROR_CODES)[keyof typeof CLASS_READ_ERROR_CODES];

/**
 * Restrained, browser-safe copy.
 *
 * No thresholds, no Mongo URI, no raw class code, no internal
 * field names. The messages never identify which kind of
 * persistence failure occurred.
 */
const ERROR_MESSAGES: Readonly<Record<GetVisibleClassesErrorCode, string>> = {
  UNAUTHENTICATED: "You must be signed in to view your classes.",
  PROFILE_INCOMPLETE: "Complete your profile before viewing classes.",
  CLASS_READ_FAILED: "Could not load your classes. Please try again.",
};

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Builds a typed error result with the canonical message.
 *
 * Local to this module — never exported. The message is the
 * browser-safe copy from `ERROR_MESSAGES`; raw thrown values are
 * NEVER serialized.
 */
function buildError(
  code: GetVisibleClassesErrorCode,
): Extract<GetVisibleClassesResult, { ok: false }> {
  return {
    ok: false,
    code,
    message: ERROR_MESSAGES[code],
  };
}

/**
 * Projects a Class persistence document into the browser-safe
 * summary DTO.
 *
 * `passwordHash`, `teacherUserId`, `__v`, and any future
 * sensitive field are NOT projected — this function is the ONLY
 * projection point. The function is total and never throws: any
 * missing required field collapses to an empty string for `id` /
 * `classCode` / `name` and the project's default for `status`.
 *
 * `createdAt` is converted to an ISO 8601 string at the boundary
 * so the result is `JSON.stringify`-safe.
 */
function toSafeClassSummary(doc: ClassAttrs): SafeClassSummary {
  // Defensive string coercion. Mongoose `.lean()` returns plain
  // objects; in practice every field is present. We collapse any
  // unexpected `undefined` / `null` to an empty string rather
  // than propagating `null` into the browser payload.
  const id =
    (doc as unknown as { _id?: Types.ObjectId | string })._id !== undefined
      ? String(
          (doc as unknown as { _id: Types.ObjectId | string })._id,
        )
      : "";
  const name = typeof doc.name === "string" ? doc.name : "";
  const classCode =
    typeof doc.classCode === "string" ? doc.classCode : "";
  const status: ClassStatus =
    doc.status === "archived" ? "archived" : "active";
  const createdAtIso =
    doc.createdAt instanceof Date
      ? doc.createdAt.toISOString()
      : new Date(doc.createdAt as unknown as string | Date).toISOString();

  return {
    id,
    name,
    classCode,
    status,
    createdAt: createdAtIso,
  };
}

/**
 * Deduplicates a list of class summaries by `id`, preserving the
 * first occurrence (i.e. the newest, because the input is sorted
 * `createdAt` DESC upstream).
 *
 * The student read path collects classes from active memberships.
 * In the (theoretical) event of duplicate `classId`s across
 * multiple membership rows for the same `(studentUserId, classId)`
 * pair, the compound unique index on `class_memberships` makes
 * this physically impossible. The function is defensive: it
 * collapses duplicates anyway so a corrupt legacy dataset cannot
 * produce a duplicated summary.
 */
function dedupeById(items: SafeClassSummary[]): SafeClassSummary[] {
  const seen = new Set<string>();
  const out: SafeClassSummary[] = [];
  for (const item of items) {
    if (item.id.length === 0) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

// =============================================================================
// Teacher read path
// =============================================================================

/**
 * Lists the classes owned by `teacherUserId`.
 *
 * Returns an empty array when the teacher has no classes. The
 * underlying `ClassModel.find({ teacherUserId })` is the
 * authoritative teacher-scoped query; the existing
 * `teacherUserId` index supports it efficiently.
 *
 * The returned documents are projected through
 * `toSafeClassSummary(...)` so `passwordHash` and `teacherUserId`
 * are NEVER serialized. The query projection explicitly excludes
 * `passwordHash` so the hash is never even read from the driver
 * buffer.
 */
async function listOwnedClasses(
  teacherUserId: string,
): Promise<SafeClassSummary[]> {
  const docs = await ClassModel.find({ teacherUserId })
    // Project the safe fields only — `passwordHash` is excluded
    // explicitly so a corrupt document containing an unexpected
    // field cannot leak it through the read path.
    .select({ _id: 1, name: 1, classCode: 1, status: 1, createdAt: 1 })
    .sort({ createdAt: -1 })
    .lean<ClassAttrs[]>()
    .exec();
  return docs.map((doc) => toSafeClassSummary(doc));
}

// =============================================================================
// Student read path
// =============================================================================

/**
 * Lists the active membership rows for `studentUserId`.
 *
 * The query asks for `status === "active"` explicitly. The current
 * model only allows `active`, so this is forward-compatible: when
 * future statuses (e.g. `removed`) are added, inactive memberships
 * will simply not grant visibility. An inactive or future-removed
 * membership is NOT visibility authority.
 *
 * Returns an empty array when the student has no active
 * memberships.
 */
async function listActiveMembershipsForStudent(
  studentUserId: string,
): Promise<ClassMembershipAttrs[]> {
  const docs = await ClassMembershipModel.find({
    studentUserId,
    status: "active",
  })
    .select({ classId: 1, studentUserId: 1, status: 1 })
    .lean<ClassMembershipAttrs[]>()
    .exec();
  return docs;
}

/**
 * Looks up classes by their `_id` in a single batched query.
 *
 * This is the multi-id lookup primitive requested by the PHASE
 * 5.1D1 specification: the student read path uses it to avoid the
 * obvious N+1 of one `ClassModel.findById(...)` per membership.
 *
 * Input:
 *   - `classIds` — array of Mongo ObjectId strings (the
 *     `ClassMembership.classId` values for the active memberships
 *     of the current student).
 *
 * Output:
 *   - An array of `SafeClassSummary` for the classes that exist.
 *     References to non-existent class ids (corrupt data) are
 *     skipped safely — the summary is omitted from the output
 *     rather than throwing.
 *   - The output is sorted `createdAt` DESC (newest first) to
 *     match the teacher path ordering.
 *
 * The query projection excludes `passwordHash` so the hash is
 * never read from the driver buffer even by accident.
 */
async function listClassesByIds(
  classIds: ReadonlyArray<Types.ObjectId | string>,
): Promise<SafeClassSummary[]> {
  // Defensive: an empty input short-circuits to an empty list.
  if (classIds.length === 0) return [];

  // Mongoose accepts stringified ObjectIds in `$in`. We coerce to
  // strings so any input shape the membership rows produce is
  // handled uniformly.
  const idStrings = classIds
    .map((id) => (typeof id === "string" ? id : id.toString()))
    .filter((id) => id.length > 0);
  if (idStrings.length === 0) return [];

  const docs = await ClassModel.find({ _id: { $in: idStrings } })
    // Project the safe fields only.
    .select({ _id: 1, name: 1, classCode: 1, status: 1, createdAt: 1 })
    .sort({ createdAt: -1 })
    .lean<ClassAttrs[]>()
    .exec();
  return docs.map((doc) => toSafeClassSummary(doc));
}

/**
 * Composes the student read path:
 *
 *   1. List the student's active memberships (server-side
 *      `studentUserId` filter; status `active` only).
 *   2. Batch-fetch the referenced classes in a single query.
 *   3. Project each class into the safe summary DTO.
 *   4. Skip any class id that no longer exists (corrupt data).
 *   5. Deduplicate by class id (compound unique index makes this
 *      a defensive no-op, but we keep the step so a future
 *      corruption cannot duplicate the summary).
 *
 * The function does NOT scan the entire `classes` collection and
 * does NOT filter in application memory.
 */
async function listJoinedClasses(
  studentUserId: string,
): Promise<SafeClassSummary[]> {
  const memberships = await listActiveMembershipsForStudent(studentUserId);
  if (memberships.length === 0) return [];

  const classIds = memberships
    .map((m) => m.classId)
    .filter((id): id is Types.ObjectId => id !== null && id !== undefined);

  const summaries = await listClassesByIds(classIds);
  return dedupeById(summaries);
}

// =============================================================================
// Public read function
// =============================================================================

/**
 * Returns the classes visible to the currently authenticated user.
 *
 * The function accepts NO arguments. Identity and role come
 * exclusively from the Better Auth server session and the
 * persisted Profile. The browser cannot select another user, a
 * different role, or an arbitrary teacher/student id.
 *
 * ## Behavior
 *
 *   1. Derive the Better Auth session via `getSession()`. If no
 *      session exists, return `UNAUTHENTICATED`. The function
 *      performs NO class query on this branch.
 *   2. Load the application `Profile` for `session.user.id`. The
 *      profile must exist and `onboardingCompleted` must be
 *      `true`. Otherwise return `PROFILE_INCOMPLETE`. No class
 *      query is performed on this branch.
 *   3. Branch on `profile.role`:
 *
 *        - `"teacher"` → list the classes where
 *          `Class.teacherUserId === session.user.id` via the
 *          existing `ClassModel.find({ teacherUserId })` query
 *          path, sorted `createdAt` DESC.
 *        - `"student"` → list the student's active memberships
 *          via the existing
 *          `ClassMembershipModel.find({ studentUserId, status: "active" })`
 *          query path; then batch-fetch the referenced classes
 *          via the new `listClassesByIds(...)` primitive; skip
 *          missing references safely; sort the final list
 *          `createdAt` DESC.
 *
 *   4. Project every class into a `SafeClassSummary` DTO.
 *      `passwordHash`, `teacherUserId`, `studentUserId`,
 *      membership ids, Mongoose internals, biometric fields are
 *      NEVER serialized.
 *   5. Wrap the projected list in a `VisibleClassesResult`
 *      carrying the viewer role (`teacher` / `student` from
 *      `profile.role`). The role is never inferred from class
 *      ownership or membership.
 *   6. Any unexpected DB / read failure → `CLASS_READ_FAILED`.
 *      Mongo error messages, raw stacks, the connection string,
 *      and the collection name are NEVER returned.
 *
 * ## Determinism
 *
 *   - Both branches sort `createdAt` DESC.
 *   - Both branches project through the same DTO.
 *   - The student branch deduplicates by class id (defensive —
 *     the compound unique index makes this a no-op for fresh
 *     data).
 *
 * ## Read-only
 *
 * The function NEVER writes a `Class`, a `ClassMembership`, or a
 * `Profile`. It NEVER calls the Face Service. It NEVER reads
 * `passwordHash`. It NEVER verifies a class password.
 */
export async function getVisibleClassesForCurrentUser(): Promise<GetVisibleClassesResult> {
  // 1. Authentication — identity comes from the Better Auth
  //    session only. No userId is accepted from the browser.
  const session = await getSession();
  if (!session) {
    // No class query is performed on this branch.
    return buildError(CLASS_READ_ERROR_CODES.UNAUTHENTICATED);
  }
  const userId = session.user.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return buildError(CLASS_READ_ERROR_CODES.UNAUTHENTICATED);
  }

  // 2. Profile gating — load the Profile and require a complete
  //    record. Missing / incomplete → `PROFILE_INCOMPLETE`. No
  //    class query is performed on this branch.
  let profile;
  try {
    profile = await getProfileByUserId(userId);
  } catch {
    // Persistence failure during the profile lookup is treated
    // as a generic read failure. The raw error is NOT
    // serialized.
    return buildError(CLASS_READ_ERROR_CODES.CLASS_READ_FAILED);
  }
  if (!profile || !profile.onboardingCompleted) {
    return buildError(CLASS_READ_ERROR_CODES.PROFILE_INCOMPLETE);
  }

  // 3. Branch on the server-authoritative viewer role. The role
  //    is NEVER accepted from the browser — it comes from the
  //    Profile.
  const role = profile.role;
  if (role !== "teacher" && role !== "student") {
    // Defensive — the Profile schema constrains `role` to the
    // documented enum, but a legacy document with an unknown
    // role must NOT silently produce a partial read. Collapse to
    // the generic failure without leaking the unknown value.
    return buildError(CLASS_READ_ERROR_CODES.CLASS_READ_FAILED);
  }

  let classes: SafeClassSummary[];
  try {
    if (role === "teacher") {
      classes = await listOwnedClasses(userId);
    } else {
      classes = await listJoinedClasses(userId);
    }
  } catch {
    // Unexpected DB / read failure — generic, safe code.
    return buildError(CLASS_READ_ERROR_CODES.CLASS_READ_FAILED);
  }

  return {
    ok: true,
    result: {
      role,
      classes,
    },
  };
}

// =============================================================================
// Public helper — multi-id class lookup primitive
// =============================================================================

/**
 * Server-only batch class lookup primitive.
 *
 * `getClassesByIds(classIds)` returns the safe `SafeClassSummary`
 * DTOs for the requested class ids, in `createdAt` DESC order.
 * References to non-existent class ids are skipped safely.
 *
 * The primitive is the multi-id lookup the PHASE 5.1D1
 * specification asked for. It is intentionally exposed (NOT a
 * `_internal` symbol) so a future detail phase can reuse it
 * without duplicating the projection logic.
 *
 * The function performs NO authentication / role / profile check.
 * Authorization is the caller's responsibility — callers MUST only
 * pass class ids the caller is authorized to see. (The student
 * read path passes ids derived from the caller's own active
 * memberships.)
 */
export async function getClassesByIds(
  classIds: ReadonlyArray<Types.ObjectId | string>,
): Promise<SafeClassSummary[]> {
  return listClassesByIds(classIds);
}