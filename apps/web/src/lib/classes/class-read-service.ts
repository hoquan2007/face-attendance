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
 *
 * PHASE 5.1D2A additionally ships the server-only
 * `getClassDetailForCurrentUser(classId)` primitive on top of
 * this module — an authorized detail read for a single class.
 * The same architectural invariants apply: it is READ-ONLY,
 * server-only, and derives identity from the Better Auth
 * session + Profile. No roster, no UI, no public API route.
 *
 * PHASE 5.1D2B additionally ships the server-only
 * `getClassRosterForCurrentTeacher(classId)` primitive — the
 * teacher-owner active-student roster read model. The function
 * accepts ONLY `classId`; identity and role come from the
 * Better Auth session + Profile; class ownership is encoded
 * directly in the database query; only ACTIVE memberships are
 * surfaced; only `fullName`, `identificationCode`, and
 * `joinedAt` are projected; Profile lookup is a single
 * batched query (no N+1); orphaned / incomplete / non-student
 * Profile references are skipped silently. No UI, no public
 * API route, no attendance data, no biometric state, no
 * Better Auth user lookup, no write operations.
 */

import "server-only";

import { Types } from "mongoose";

import { getSession } from "@/lib/session";
import {
  getProfileByUserId,
  getStudentProfilesByUserIds,
} from "@/lib/profile-service";
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

// =============================================================================
// PHASE 5.1D2A — Authorized class detail read model
// =============================================================================

/**
 * Browser-safe class DETAIL projection.
 *
 * Extends the `SafeClassSummary` shape with `updatedAt` so a
 * future detail UI can render the freshness of the class record.
 * Internal / sensitive fields are NEVER projected:
 *
 *   - `passwordHash`            → never included.
 *   - `teacherUserId`           → never included (the viewer
 *                                 derives that identity from
 *                                 the session; the safe detail
 *                                 does not echo it back).
 *   - `studentUserId`           → never included.
 *   - membership internal id    → never included.
 *   - `__v` (Mongoose internal) → never included.
 *   - biometric fields          → never included (Class has
 *                                 none, but the type guard
 *                                 prevents accidental leakage).
 *   - rosters, students,
 *     identificationCode        → never included (roster
 *                                 belongs to PHASE 5.1D2B).
 */
export interface SafeClassDetail {
  id: string;
  name: string;
  classCode: string;
  status: ClassStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Authorized class detail result.
 *
 * `role` is the server-authoritative viewer role (derived from
 * `Profile.role`); `class` is the safe detail projection. The
 * role is NEVER inferred from class ownership or membership
 * status — it is always sourced from the persisted Profile.
 */
export interface AccessibleClassDetail {
  role: "teacher" | "student";
  class: SafeClassDetail;
}

/**
 * Discriminated union for the class detail read boundary.
 *
 * The shape mirrors the project-wide Server Action convention
 * (`{ ok, … }` plus a small, browser-safe `code`/`message` on
 * failure) so a future Server Component / Route Handler can
 * surface the same codes without inventing a parallel error
 * contract.
 *
 * `UNAUTHENTICATED`        — no Better Auth session.
 * `PROFILE_INCOMPLETE`     — missing or incomplete Profile.
 * `CLASS_NOT_ACCESSIBLE`   — the generic safe boundary that
 *                            covers malformed id, missing class,
 *                            wrong teacher, no membership, and
 *                            inactive membership (the failure
 *                            modes are intentionally
 *                            indistinguishable from the
 *                            browser's perspective).
 * `CLASS_READ_FAILED`      — unexpected DB / read failure.
 */
export type GetAccessibleClassDetailResult =
  | { ok: true; result: AccessibleClassDetail }
  | {
      ok: false;
      code: GetAccessibleClassDetailErrorCode;
      message: string;
    };

/**
 * Stable error codes for the class detail read boundary.
 *
 * `CLASS_NOT_ACCESSIBLE` is intentionally the SINGLE outward-
 * facing code for every "the class does not exist for this
 * viewer" condition:
 *
 *   - malformed classId
 *   - class does not exist
 *   - teacher does not own the class
 *   - student has no active membership
 *
 * A future UI may map every one of these branches to a generic
 * 404 / not-accessible affordance.
 */
export const CLASS_DETAIL_READ_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
  CLASS_NOT_ACCESSIBLE: "CLASS_NOT_ACCESSIBLE",
  CLASS_READ_FAILED: "CLASS_READ_FAILED",
} as const;

export type GetAccessibleClassDetailErrorCode =
  (typeof CLASS_DETAIL_READ_ERROR_CODES)[keyof typeof CLASS_DETAIL_READ_ERROR_CODES];

/**
 * Restrained, browser-safe copy.
 *
 * No Mongo URI, no raw class id, no driver internals, no Cast
 * Error details. The messages never identify which kind of
 * inaccessibility failed.
 */
const DETAIL_ERROR_MESSAGES: Readonly<
  Record<GetAccessibleClassDetailErrorCode, string>
> = {
  UNAUTHENTICATED: "You must be signed in to view this class.",
  PROFILE_INCOMPLETE:
    "Complete your profile before viewing class details.",
  CLASS_NOT_ACCESSIBLE:
    "This class is not available.",
  CLASS_READ_FAILED:
    "Could not load the class. Please try again.",
};

/**
 * Builds a typed error result for the detail boundary.
 *
 * Local to this module — never exported. The message is the
 * browser-safe copy from `DETAIL_ERROR_MESSAGES`; raw thrown
 * values are NEVER serialized.
 */
function buildDetailError(
  code: GetAccessibleClassDetailErrorCode,
): Extract<GetAccessibleClassDetailResult, { ok: false }> {
  return {
    ok: false,
    code,
    message: DETAIL_ERROR_MESSAGES[code],
  };
}

/**
 * Validates that `classId` is a syntactically-valid Mongo
 * ObjectId string. Returns `true` for a 24-character
 * hexadecimal string (Mongoose's `Types.ObjectId.isValid`
 * accepts the canonical hex form).
 *
 * The function NEVER throws. A malformed input collapses to
 * `false` so the caller can route to the safe inaccessible
 * boundary without exposing the `CastError` raised by an
 * unguarded `findById`.
 */
function isSyntacticallyValidClassId(
  classId: string,
): boolean {
  if (typeof classId !== "string" || classId.length === 0) {
    return false;
  }
  // `Types.ObjectId.isValid` accepts any 12-byte input (including
  // a 24-character hex string). We additionally require the
  // canonical 24-hex shape so the check is consistent with what
  // a future `/classes/[classId]` route will produce. The
  // canonical hex-only check prevents non-canonical strings
  // (e.g. arbitrary 12-byte buffers) from reaching the database.
  if (classId.length !== 24) return false;
  return /^[0-9a-fA-F]{24}$/.test(classId);
}

/**
 * Projects a Class persistence document into the browser-safe
 * DETAIL DTO.
 *
 * `passwordHash`, `teacherUserId`, `__v`, and any future
 * sensitive field are NOT projected — this function is the
 * ONLY projection point. The function is total and never throws
 * — any missing required field collapses to an empty string for
 * `id` / `classCode` / `name` and the project's default for
 * `status`. Date fields are converted to ISO 8601 strings so
 * the result is `JSON.stringify`-safe.
 */
function toSafeClassDetail(doc: ClassAttrs): SafeClassDetail {
  const idSource = (doc as unknown as {
    _id?: Types.ObjectId | string;
  })._id;
  const id =
    idSource !== undefined && idSource !== null
      ? String(idSource)
      : "";
  const name = typeof doc.name === "string" ? doc.name : "";
  const classCode =
    typeof doc.classCode === "string" ? doc.classCode : "";
  const status: ClassStatus =
    doc.status === "archived" ? "archived" : "active";
  const createdAtRaw = (doc as unknown as { createdAt?: Date }).createdAt;
  const updatedAtRaw = (doc as unknown as { updatedAt?: Date }).updatedAt;
  const createdAtIso =
    createdAtRaw instanceof Date
      ? createdAtRaw.toISOString()
      : new Date(createdAtRaw as unknown as string).toISOString();
  const updatedAtIso =
    updatedAtRaw instanceof Date
      ? updatedAtRaw.toISOString()
      : new Date(updatedAtRaw as unknown as string).toISOString();
  return {
    id,
    name,
    classCode,
    status,
    createdAt: createdAtIso,
    updatedAt: updatedAtIso,
  };
}

// =============================================================================
// Teacher detail path
// =============================================================================

/**
 * Finds the class OWNED BY `teacherUserId` whose `_id` equals
 * `classId`. Returns `null` when:
 *
 *   - the class does not exist;
 *   - the class exists but is owned by a different teacher.
 *
 * The query ENCODES the authorization constraint directly:
 * `_id = classId AND teacherUserId = teacherUserId`. This is
 * deliberately stricter than "fetch the class, then compare
 * owner" — the database itself refuses to surface a class the
 * teacher does not own.
 *
 * The function NEVER throws on a missing class. A malformed
 * `classId` that survives `isSyntacticallyValidClassId` still
 * cannot crash the query: Mongoose's `findOne` returns `null`
 * for an unmatched filter rather than throwing a CastError,
 * because the `_id` is paired with the literal `classId` in a
 * single equality match.
 */
async function findOwnedClassForTeacher(
  classId: string,
  teacherUserId: string,
): Promise<ClassAttrs | null> {
  const docs = await ClassModel.findOne({
    _id: classId,
    teacherUserId,
  })
    // Project the safe fields only — `passwordHash` is excluded
    // explicitly so the hash is never even read from the driver
    // buffer.
    .select({
      _id: 1,
      name: 1,
      classCode: 1,
      status: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    .lean<ClassAttrs | null>()
    .exec();
  return docs ?? null;
}

// =============================================================================
// Student detail path
// =============================================================================

/**
 * Returns the ACTIVE membership row for
 * `(classId, studentUserId)`, or `null` when none exists or
 * the row's `status !== "active"`.
 *
 * The function ENCODES the authorization constraint directly:
 * `classId = input AND studentUserId = input AND status = active`.
 * No application-memory filter is performed — the database
 * refuses to surface an inactive or non-existent membership.
 *
 * The membership is loaded ONLY as authorization proof. It is
 * NEVER projected into the safe detail result.
 */
async function findActiveMembershipForStudent(
  classId: string,
  studentUserId: string,
): Promise<ClassMembershipAttrs | null> {
  const doc = await ClassMembershipModel.findOne({
    classId: new Types.ObjectId(classId),
    studentUserId,
    status: "active",
  })
    // Projection: we only need the existence proof; no internal
    // fields are read. `passwordHash` does not exist on the
    // membership schema, but the projection still excludes
    // every non-essential field for clarity.
    .select({ _id: 1, classId: 1, studentUserId: 1, status: 1 })
    .lean<ClassMembershipAttrs | null>()
    .exec();
  return doc ?? null;
}

/**
 * Loads a class document by `_id`. Used by the student detail
 * path AFTER the active membership has been verified.
 *
 * The query ENCODES the authorization constraint indirectly:
 * the caller has already proved membership, so a single
 * `_id = classId` match is sufficient. A non-existent or
 * mismatched id collapses to `null` (no CastError leak).
 */
async function findClassById(
  classId: string,
): Promise<ClassAttrs | null> {
  const doc = await ClassModel.findById(classId)
    .select({
      _id: 1,
      name: 1,
      classCode: 1,
      status: 1,
      createdAt: 1,
      updatedAt: 1,
    })
    .lean<ClassAttrs | null>()
    .exec();
  return doc ?? null;
}

// =============================================================================
// Public detail function
// =============================================================================

/**
 * Returns the safe detail for the Class identified by `classId`
 * when the currently authenticated user is authorized to read
 * it.
 *
 * The function accepts ONLY `classId` (the resource identifier).
 * It does NOT accept `userId`, `teacherUserId`, `studentUserId`,
 * `role`, or `membershipId` — those are all derived exclusively
 * from the Better Auth server session and the persisted Profile.
 *
 * ## Behavior
 *
 *   1. Derive the Better Auth session via `getSession()`. If no
 *      session exists, return `UNAUTHENTICATED`. No class /
 *      membership query is performed on this branch.
 *   2. Load the application `Profile` for `session.user.id`.
 *      The profile must exist and `onboardingCompleted` must
 *      be `true`. Otherwise return `PROFILE_INCOMPLETE`. No
 *      class / membership query is performed on this branch.
 *   3. Validate the `classId` syntax. A malformed id (not a
 *      canonical 24-hex string) collapses to the safe
 *      `CLASS_NOT_ACCESSIBLE` boundary so an attacker cannot
 *      use the error path to differentiate "malformed syntax"
 *      from "missing class" / "wrong teacher" / "no membership".
 *   4. Branch on `profile.role`:
 *
 *        - `"teacher"` → `ClassModel.findOne({ _id: classId,
 *          teacherUserId: session.user.id })`. The query itself
 *          enforces ownership. A `null` result collapses to
 *          `CLASS_NOT_ACCESSIBLE` — there is intentionally NO
 *          separate `NOT_CLASS_OWNER` code.
 *
 *        - `"student"` → `ClassMembershipModel.findOne({
 *          classId, studentUserId: session.user.id, status:
 *          "active" })`. A `null` result collapses to
 *          `CLASS_NOT_ACCESSIBLE` — there is intentionally NO
 *          separate `NOT_CLASS_MEMBER` code. On a positive
 *          match, the class is loaded via
 *          `ClassModel.findById(classId)` and projected into
 *          the safe detail DTO. If the class has been deleted
 *          between the membership write and the class load
 *          (corrupt data), the read collapses to
 *          `CLASS_NOT_ACCESSIBLE`.
 *
 *   5. Project the loaded class into `SafeClassDetail`. The
 *      DTO excludes `passwordHash`, `teacherUserId`,
 *      `studentUserId`, Mongoose internals, biometric fields,
 *      and any roster / membership identifier.
 *   6. Wrap the projection in an `AccessibleClassDetail`
 *      carrying the viewer role (derived from `Profile.role`).
 *   7. Any unexpected DB / read failure → `CLASS_READ_FAILED`.
 *      Mongo error messages, raw stacks, the connection
 *      string, and the collection name are NEVER returned.
 *
 * ## Authorization query shape
 *
 * The teacher path encodes the authorization constraint
 * directly (`_id = classId AND teacherUserId = session.user.id`).
 * It does NOT fetch an arbitrary class and compare the owner
 * client-side.
 *
 * The student path encodes the authorization constraint on the
 * membership row (`classId = input AND studentUserId =
 * session.user.id AND status = "active"`). It does NOT fetch
 * every membership and does NOT fetch every class.
 *
 * ## Archive behavior
 *
 * Archived does NOT automatically mean inaccessible:
 *
 *   - The teacher owner may still read an archived class
 *     detail via the same `findOne` query — `status` is part
 *     of the safe projection, NOT part of the authorization
 *     filter.
 *   - A student with an active membership may still read an
 *     archived class detail via the same membership + class
 *     lookup chain.
 *
 * The result exposes `status: "archived"` safely.
 *
 * ## No roster
 *
 * The safe detail NEVER contains:
 *
 *   - `students`
 *   - `members`
 *   - student count
 *   - student names / emails / identificationCodes
 *   - any `Profile` payload
 *
 * Roster belongs to PHASE 5.1D2B.
 *
 * ## Read-only
 *
 * The function NEVER writes a `Class`, a `ClassMembership`, or
 * a `Profile`. It NEVER calls the Face Service. It NEVER reads
 * `passwordHash`. It NEVER verifies a class password.
 */
export async function getClassDetailForCurrentUser(
  classId: string,
): Promise<GetAccessibleClassDetailResult> {
  // 1. Authentication — identity comes from the Better Auth
  //    session only. No userId is accepted from the browser.
  const session = await getSession();
  if (!session) {
    return buildDetailError(CLASS_DETAIL_READ_ERROR_CODES.UNAUTHENTICATED);
  }
  const userId = session.user.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return buildDetailError(CLASS_DETAIL_READ_ERROR_CODES.UNAUTHENTICATED);
  }

  // 2. Profile gating — load the Profile and require a complete
  //    record. Missing / incomplete → `PROFILE_INCOMPLETE`. No
  //    class / membership query is performed on this branch.
  let profile;
  try {
    profile = await getProfileByUserId(userId);
  } catch {
    return buildDetailError(
      CLASS_DETAIL_READ_ERROR_CODES.CLASS_READ_FAILED,
    );
  }
  if (!profile || !profile.onboardingCompleted) {
    return buildDetailError(
      CLASS_DETAIL_READ_ERROR_CODES.PROFILE_INCOMPLETE,
    );
  }

  // 3. classId syntax validation. A malformed id collapses to the
  //    safe inaccessible boundary so the browser cannot enumerate
  //    valid vs. invalid ids via the error path.
  if (!isSyntacticallyValidClassId(classId)) {
    return buildDetailError(
      CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
    );
  }

  // 4. Branch on the server-authoritative viewer role. The role
  //    is NEVER accepted from the browser — it comes from the
  //    Profile.
  const role = profile.role;
  if (role !== "teacher" && role !== "student") {
    // Defensive — the Profile schema constrains `role` to the
    // documented enum, but a legacy document with an unknown
    // role must NOT silently produce a partial read. Collapse to
    // the generic failure without leaking the unknown value.
    return buildDetailError(
      CLASS_DETAIL_READ_ERROR_CODES.CLASS_READ_FAILED,
    );
  }

  // 5. Authorization-encoded read.
  let classDoc: ClassAttrs | null;
  try {
    if (role === "teacher") {
      classDoc = await findOwnedClassForTeacher(classId, userId);
    } else {
      // Student path: prove membership first, THEN load the class.
      const membership = await findActiveMembershipForStudent(
        classId,
        userId,
      );
      if (!membership) {
        // No active membership — collapse to the safe boundary.
        return buildDetailError(
          CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
        );
      }
      classDoc = await findClassById(classId);
    }
  } catch {
    // Unexpected DB / read failure — generic, safe code.
    return buildDetailError(
      CLASS_DETAIL_READ_ERROR_CODES.CLASS_READ_FAILED,
    );
  }

  if (!classDoc) {
    // Class does not exist OR the teacher path's encoded filter
    // returned `null` (which already encodes "not yours" — there
    // is intentionally NO separate `NOT_CLASS_OWNER` code).
    return buildDetailError(
      CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
    );
  }

  return {
    ok: true,
    result: {
      role,
      class: toSafeClassDetail(classDoc),
    },
  };
}

// =============================================================================
// PHASE 5.1D2B — Teacher-owner roster read model
// =============================================================================

/**
 * Browser-safe roster entry.
 *
 * Exposes ONLY the fields a future Server Component (or any other
 * server-rendered surface) needs to render a roster row:
 *
 *   - `fullName`           — student's full name from `Profile`.
 *   - `identificationCode` — student's identificationCode from
 *                            `Profile`.
 *   - `joinedAt`           — ISO 8601 timestamp from
 *                            `ClassMembership.joinedAt` (oldest
 *                            member first per the deterministic
 *                            ordering rule).
 *
 * The following fields are NEVER projected:
 *
 *   - `studentUserId`      — Better Auth user id (the teacher does
 *                             not need it; the browser does not
 *                             need it).
 *   - `membershipId`       — Mongo `_id` of the membership row.
 *   - `classId`            — the request id (the row already lives
 *                             inside the per-class roster payload).
 *   - `emailSnapshot`      — Profile contains it; the roster does
 *                             NOT surface it.
 *   - `phone`              — Profile contains it; the roster does
 *                             NOT surface it.
 *   - `email`              — Better Auth user collection; never
 *                             read.
 *   - `passwordHash`       — the Class document owns it; the
 *                             roster does not.
 *   - `teacherUserId`      — Class document; never projected.
 *   - biometric state      — never read.
 */
export interface SafeRosterItem {
  fullName: string;
  identificationCode: string;
  joinedAt: string;
}

/**
 * Browser-safe roster result.
 *
 * `class` is the safe detail projection (id, name, classCode,
 * status); `students` is the deterministic, batch-loaded, ordered
 * list of active members.
 *
 * The roster contains NO `passwordHash`, NO `teacherUserId`, NO
 * student / membership user ids, NO email / phone / Better Auth
 * user identifiers, NO biometric fields, and NO attendance data.
 */
export interface SafeClassRoster {
  class: SafeClassDetail;
  students: SafeRosterItem[];
}

/**
 * Discriminated union for the teacher-owner roster read boundary.
 *
 * `UNAUTHENTICATED`        — no Better Auth session.
 * `PROFILE_INCOMPLETE`     — missing or incomplete Profile.
 * `TEACHER_REQUIRED`       — authenticated student (or any non-
 *                            teacher role) trying to read a
 *                            roster.
 * `CLASS_NOT_ACCESSIBLE`   — malformed id / missing class / wrong
 *                            teacher. Collapsed to one code so the
 *                            browser cannot enumerate live classes
 *                            by error code.
 * `CLASS_READ_FAILED`      — unexpected DB / read failure.
 */
export type GetClassRosterResult =
  | { ok: true; result: SafeClassRoster }
  | {
      ok: false;
      code: GetClassRosterErrorCode;
      message: string;
    };

/**
 * Stable error codes for the teacher-owner roster read boundary.
 *
 * `CLASS_NOT_ACCESSIBLE` is the SINGLE outward-facing code for
 * every "the class does not exist for this viewer" condition:
 *
 *   - malformed classId,
 *   - class does not exist,
 *   - teacher does not own the class.
 *
 * A future UI may map every one of these branches to a generic
 * 404 / not-accessible affordance.
 */
export const CLASS_ROSTER_READ_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
  TEACHER_REQUIRED: "TEACHER_REQUIRED",
  CLASS_NOT_ACCESSIBLE: "CLASS_NOT_ACCESSIBLE",
  CLASS_READ_FAILED: "CLASS_READ_FAILED",
} as const;

export type GetClassRosterErrorCode =
  (typeof CLASS_ROSTER_READ_ERROR_CODES)[keyof typeof CLASS_ROSTER_READ_ERROR_CODES];

/**
 * Restrained, browser-safe copy.
 *
 * No Mongo URI, no raw class id, no driver internals, no Cast
 * Error details. The messages never identify which kind of
 * inaccessibility failed.
 */
const ROSTER_ERROR_MESSAGES: Readonly<
  Record<GetClassRosterErrorCode, string>
> = {
  UNAUTHENTICATED: "You must be signed in to view this roster.",
  PROFILE_INCOMPLETE:
    "Complete your profile before viewing a roster.",
  TEACHER_REQUIRED: "Only teachers can view a class roster.",
  CLASS_NOT_ACCESSIBLE: "This class is not available.",
  CLASS_READ_FAILED:
    "Could not load the roster. Please try again.",
};

/**
 * Builds a typed error result for the roster boundary.
 *
 * Local to this module — never exported. The message is the
 * browser-safe copy from `ROSTER_ERROR_MESSAGES`; raw thrown
 * values are NEVER serialized.
 */
function buildRosterError(
  code: GetClassRosterErrorCode,
): Extract<GetClassRosterResult, { ok: false }> {
  return {
    ok: false,
    code,
    message: ROSTER_ERROR_MESSAGES[code],
  };
}

/**
 * Composes a single `SafeRosterItem` from a sorted membership
 * row and its correlated `SafeStudentProfileProjection`.
 *
 * The function is total: a missing / malformed `joinedAt`
 * collapses to the current timestamp's ISO string so the result
 * is always serializable. Empty `fullName` / `identificationCode`
 * values are coerced to empty strings so the result shape is
 * stable — the caller already filtered out non-student /
 * incomplete Profiles so the empty-string branch is defensive
 * only.
 */
function toSafeRosterItem(
  membership: ClassMembershipAttrs,
  profile: {
    fullName: string;
    identificationCode: string;
  },
): SafeRosterItem {
  const joinedAtRaw = (membership as unknown as { joinedAt?: Date })
    .joinedAt;
  const joinedAtIso =
    joinedAtRaw instanceof Date
      ? joinedAtRaw.toISOString()
      : new Date(joinedAtRaw as unknown as string).toISOString();
  return {
    fullName: profile.fullName,
    identificationCode: profile.identificationCode,
    joinedAt: joinedAtIso,
  };
}

// =============================================================================
// Teacher roster path — internal helpers
// =============================================================================

/**
 * Lists the ACTIVE memberships for a given class.
 *
 * The query ENCODES the authorization constraint directly: the
 * caller has already proved the teacher owns the class. The
 * `status: "active"` filter ensures that future statuses (e.g.
 * `removed`) cannot leak into the roster.
 *
 * Memberships are sorted `joinedAt` ASCENDING (oldest member
 * first). The query projects ONLY the fields required for
 * roster composition so the membership `_id`, `classId`,
 * `studentUserId`, and `status` do NOT reach application memory.
 */
async function listActiveMembershipsByClassId(
  classId: string,
): Promise<ClassMembershipAttrs[]> {
  const docs = await ClassMembershipModel.find({
    classId: new Types.ObjectId(classId),
    status: "active",
  })
    // Project ONLY the fields the roster needs: `studentUserId`
    // (for Profile correlation) and `joinedAt` (for ordering and
    // projection). `_id`, `classId`, `status`, timestamps, and
    // any future field are intentionally omitted.
    .select({ studentUserId: 1, joinedAt: 1 })
    .sort({ joinedAt: 1 })
    .lean<ClassMembershipAttrs[]>()
    .exec();
  return docs;
}

/**
 * Composes the teacher-owner roster.
 *
 *   1. Load ACTIVE memberships for `classId` (sorted joinedAt ASC).
 *   2. Collect, deduplicate, and filter out empty / malformed
 *      `studentUserId` values. Duplicate corrupt rows (same
 *      `studentUserId` appearing more than once) collapse to the
 *      EARLIEST joinedAt — the deterministic order rule says
 *      "oldest member first".
 *   3. Batch-fetch Profiles in ONE query via the server-only
 *      `getStudentProfilesByUserIds` primitive — NO application
 *      memory scan over `profiles`, NO N+1 loop.
 *   4. Build the server-side `studentUserId → projection` map.
 *   5. Iterate the already-sorted + deduped membership list.
 *      For each row:
 *        - if the Profile is absent (corrupt membership, missing
 *          Profile), skip the entry silently;
 *        - if the Profile is not a `student` or is incomplete,
 *          skip the entry silently;
 *        - otherwise project a `SafeRosterItem` (joinedAt from the
 *          membership, fullName + identificationCode from the
 *          Profile).
 *
 * The function NEVER throws on membership / Profile lookup failure.
 * The caller (the public roster function) maps unexpected DB
 * failures to `CLASS_READ_FAILED`.
 */
async function composeTeacherRoster(
  classId: string,
): Promise<SafeRosterItem[]> {
  const memberships = await listActiveMembershipsByClassId(classId);
  if (memberships.length === 0) return [];

  // Defensive deduplication by `studentUserId`. The compound
  // unique index on `(classId, studentUserId)` makes duplicates
  // a physical impossibility for fresh data, but a corrupt
  // legacy dataset could carry them. Empty / malformed
  // studentUserId values are filtered out — they cannot be
  // correlated to a Profile and must not enter the batch
  // lookup. The EARLIEST joinedAt row wins (deterministic
  // ordering: oldest member first).
  const dedupedByStudentUserId = new Map<
    string,
    ClassMembershipAttrs
  >();
  for (const m of memberships) {
    const id = m.studentUserId;
    if (typeof id !== "string" || id.length === 0) continue;
    const existing = dedupedByStudentUserId.get(id);
    if (!existing) {
      dedupedByStudentUserId.set(id, m);
      continue;
    }
    // Pick the EARLIER joinedAt. Both rows are assumed valid;
    // the union unique index normally prevents this branch.
    const existingJoinedAt = (
      existing as unknown as { joinedAt?: Date }
    ).joinedAt;
    const candidateJoinedAt = (
      m as unknown as { joinedAt?: Date }
    ).joinedAt;
    if (
      existingJoinedAt instanceof Date &&
      candidateJoinedAt instanceof Date &&
      candidateJoinedAt.getTime() < existingJoinedAt.getTime()
    ) {
      dedupedByStudentUserId.set(id, m);
    }
  }
  if (dedupedByStudentUserId.size === 0) return [];

  // The order MUST match the membership iteration order
  // (joinedAt ASC). The membership query is already sorted
  // joinedAt ASC; iterate the result in that order and pick the
  // first row per studentUserId to preserve that order.
  const seen = new Set<string>();
  const orderedMemberships: ClassMembershipAttrs[] = [];
  for (const m of memberships) {
    const id = m.studentUserId;
    if (typeof id !== "string" || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    orderedMemberships.push(
      dedupedByStudentUserId.get(id) as ClassMembershipAttrs,
    );
  }
  if (orderedMemberships.length === 0) return [];

  const studentUserIds = orderedMemberships.map(
    (m) => m.studentUserId,
  );

  // SINGLE batched Profile query — the established batch
  // primitive.
  const profileMap = await getStudentProfilesByUserIds(
    studentUserIds,
  );

  // Iterate the ALREADY-SORTED + DEDUPED membership list so the
  // final roster ordering is membership-driven (joinedAt ASC),
  // NOT Profile-query driven.
  const items: SafeRosterItem[] = [];
  for (const m of orderedMemberships) {
    const studentUserId = m.studentUserId;
    if (typeof studentUserId !== "string" || studentUserId.length === 0) {
      continue;
    }
    const profile = profileMap.get(studentUserId);
    if (!profile) {
      // Corrupt / orphaned membership → skipped silently. The
      // read path NEVER mutates the membership, NEVER surfaces
      // its id or studentUserId, and NEVER logs a warning.
      continue;
    }
    items.push(toSafeRosterItem(m, profile));
  }
  return items;
}

// =============================================================================
// Public roster function
// =============================================================================

/**
 * Returns the active student roster of ONE class ONLY when the
 * currently authenticated user is the teacher who owns the class.
 *
 * The function accepts ONLY `classId` (the resource identifier).
 * It does NOT accept `userId`, `teacherUserId`, `studentUserId`,
 * `role`, or `membershipId` — those are all derived exclusively
 * from the Better Auth server session and the persisted Profile.
 *
 * ## Behavior
 *
 *   1. Derive the Better Auth session via `getSession()`. If no
 *      session exists, return `UNAUTHENTICATED`. No class /
 *      membership / Profile query is performed on this branch.
 *   2. Load the application `Profile` for `session.user.id`.
 *      The profile must exist and `onboardingCompleted` must be
 *     `true`. Otherwise return `PROFILE_INCOMPLETE`. No class /
 *      membership query is performed on this branch.
 *   3. Require `profile.role === "teacher"`. An authenticated
 *      student (or any non-teacher role) returns `TEACHER_REQUIRED`
 *      WITHOUT performing any class / membership / roster query.
 *      The roster boundary is teacher-only; a student must not be
 *      able to probe the existence of a class.
 *   4. Validate the `classId` syntax. A malformed id (not a
 *      canonical 24-hex string) collapses to the safe
 *      `CLASS_NOT_ACCESSIBLE` boundary so an attacker cannot
 *      use the error path to differentiate "malformed syntax"
 *      from "missing class" / "not yours".
 *   5. Encode the authorization constraint directly in the
 *      database query: `ClassModel.findOne({ _id: classId,
 *      teacherUserId: session.user.id })`. The database itself
 *      refuses to surface a class the teacher does not own.
 *      A `null` result collapses to `CLASS_NOT_ACCESSIBLE` —
 *      there is intentionally NO separate `NOT_CLASS_OWNER`
 *      code.
 *   6. List ACTIVE memberships for the class, sorted
 *      `joinedAt` ASC. Memberships for any other class are
 *      excluded by the `classId` filter.
 *   7. Batch-fetch the referenced Profiles in ONE
 *      `getStudentProfilesByUserIds(...)` call. NO N+1.
 *   8. Iterate the already-sorted membership list. Build the
 *      safe roster by joining membership `joinedAt` to
 *      Profile `fullName` + `identificationCode`. Corrupt /
 *      orphaned / non-student / incomplete Profile rows are
 *      skipped silently (the roster is read-only; no mutation
 *      is performed).
 *   9. Wrap the projection in a `SafeClassRoster` carrying the
 *      safe class DTO and the safe roster items. `passwordHash`,
 *      `teacherUserId`, `studentUserId`, membership internal
 *      ids, `emailSnapshot`, `phone`, Better Auth user data,
 *      biometric fields, and attendance data are NEVER
 *      serialized.
 *  10. Any unexpected DB / read failure → `CLASS_READ_FAILED`.
 *      Mongo error messages, raw stacks, the connection
 *      string, and the collection name are NEVER returned.
 *
 * ## Archived class behavior
 *
 * Archived does NOT automatically mean inaccessible. The owner
 * teacher may still read the roster of an archived class — the
 * safe class DTO exposes `status: "archived"`. No archive
 * controls are implemented in this phase.
 *
 * ## No FaceProfile / attendance
 *
 * The roster does NOT query `FaceProfile`, does NOT return
 * biometric state, embeddings, centroids, or enrollment state,
 * and does NOT return attendance data. Attendance readiness
 * belongs to a later phase.
 *
 * ## Read-only
 *
 * The function NEVER writes a `Class`, a `ClassMembership`, or a
 * `Profile`. It NEVER calls the Face Service. It NEVER reads
 * `passwordHash`. It NEVER verifies a class password. It NEVER
 * queries the Better Auth `user` collection.
 */
export async function getClassRosterForCurrentTeacher(
  classId: string,
): Promise<GetClassRosterResult> {
  // 1. Authentication — identity comes from the Better Auth
  //    session only. No userId is accepted from the browser.
  const session = await getSession();
  if (!session) {
    return buildRosterError(CLASS_ROSTER_READ_ERROR_CODES.UNAUTHENTICATED);
  }
  const userId = session.user.id;
  if (typeof userId !== "string" || userId.length === 0) {
    return buildRosterError(CLASS_ROSTER_READ_ERROR_CODES.UNAUTHENTICATED);
  }

  // 2. Profile gating — load the Profile and require a complete
  //    record. Missing / incomplete → `PROFILE_INCOMPLETE`. No
  //    class / membership query is performed on this branch.
  let profile;
  try {
    profile = await getProfileByUserId(userId);
  } catch {
    return buildRosterError(
      CLASS_ROSTER_READ_ERROR_CODES.CLASS_READ_FAILED,
    );
  }
  if (!profile || !profile.onboardingCompleted) {
    return buildRosterError(
      CLASS_ROSTER_READ_ERROR_CODES.PROFILE_INCOMPLETE,
    );
  }

  // 3. Role gating — the roster is TEACHER-ONLY. Any documented
  //    student role returns `TEACHER_REQUIRED`. Truly unknown
  //    role values collapse to CLASS_READ_FAILED so a legacy
  //    Profile cannot leak the unknown value through the
  //    failure path. Both branches are evaluated BEFORE any
  //    class / membership / roster query is performed.
  if (profile.role !== "teacher" && profile.role !== "student") {
    // Defensive — the Profile schema constrains `role` to the
    // documented enum, but a legacy document with an unknown
    // role must NOT silently produce a partial read.
    return buildRosterError(
      CLASS_ROSTER_READ_ERROR_CODES.CLASS_READ_FAILED,
    );
  }
  if (profile.role !== "teacher") {
    return buildRosterError(
      CLASS_ROSTER_READ_ERROR_CODES.TEACHER_REQUIRED,
    );
  }

  // 4. classId syntax validation. A malformed id collapses to
  //    the safe inaccessible boundary so the browser cannot
  //    enumerate valid vs. invalid ids via the error path.
  if (!isSyntacticallyValidClassId(classId)) {
    return buildRosterError(
      CLASS_ROSTER_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
    );
  }

  // 5. Authorization-encoded class lookup. The teacherUserId
  //    filter is part of the query so the database refuses to
  //    surface a class the teacher does not own.
  let classDoc: ClassAttrs | null;
  try {
    classDoc = await findOwnedClassForTeacher(classId, userId);
  } catch {
    return buildRosterError(
      CLASS_ROSTER_READ_ERROR_CODES.CLASS_READ_FAILED,
    );
  }
  if (!classDoc) {
    // Missing class OR non-owner teacher. There is intentionally
    // NO separate `NOT_CLASS_OWNER` outward-facing code.
    return buildRosterError(
      CLASS_ROSTER_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
    );
  }

  // 6–9. Active membership query + batched Profile lookup +
  //      deterministic roster composition.
  let roster: SafeRosterItem[];
  try {
    roster = await composeTeacherRoster(classId);
  } catch {
    return buildRosterError(
      CLASS_ROSTER_READ_ERROR_CODES.CLASS_READ_FAILED,
    );
  }

  return {
    ok: true,
    result: {
      class: toSafeClassDetail(classDoc),
      students: roster,
    },
  };
}