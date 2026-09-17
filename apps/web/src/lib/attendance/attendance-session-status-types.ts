/**
 * Browser-safe AttendanceSession summary types.
 *
 * PHASE 6.2 — TEACHER ATTENDANCE CONTROL UI.
 *
 * The shape the teacher class detail panel consumes when rendering
 * the attendance lifecycle controls. This is the ONLY projection
 * the teacher attendance read model surfaces to the browser — it
 * intentionally omits every identity-bearing persistence field so
 * a hand-crafted client cannot lift them through the read.
 *
 * Privacy posture:
 *
 *   - `id`           — canonical Mongo `_id.toString()`. Required to
 *                       correlate with later reads and Server Action
 *                       calls.
 *   - `status`       — `"active"` or `"closed"`.
 *   - `startedAt`    — ISO 8601 string (server-side wall clock).
 *   - `endedAt`      — ISO 8601 string OR `null` while still active.
 *   - `rosterCount`  — the IMMUTABLE snapshot size captured at
 *                       session start. NOT recomputed from current
 *                       class membership.
 *
 * The following fields are NEVER projected:
 *
 *   - `rosterSnapshot`
 *   - `studentUserId`
 *   - `startedByUserId`
 *   - `teacherUserId`
 *   - any Profile id
 *   - biometric fields, embeddings, centroids
 */

/**
 * Browser-safe projection of a single AttendanceSession document.
 *
 * The projection deliberately mirrors the canonical
 * `SafeAttendanceSessionSummary` shape defined inside
 * `attendance-session-service.ts`, but is duplicated here as the
 * browser-facing DTO so this module has no server-only
 * dependency (it is intended to be importable from any module
 * that needs the type, including Server Components that cannot
 * reach the `"server-only"` service module directly during type
 * erasure).
 */
export interface AttendanceSessionStatusSessionDto {
  id: string;
  status: "active" | "closed";
  startedAt: string;
  endedAt: string | null;
  rosterCount: number;
}

/**
 * Browser-safe AttendanceSession status read result.
 *
 *   - `state`   — the canonical lifecycle state derived from the
 *                 attendance read:
 *                   - `"none"`    — no session has ever existed
 *                                   for this class.
 *                   - `"active"`  — an ACTIVE session exists
 *                                   (active always wins over
 *                                   closed).
 *                   - `"closed"`  — the LATEST closed session is
 *                                   returned (no active session
 *                                   exists).
 *   - `session` — the safe projection of the surfaced session, or
 *                 `null` when `state === "none"`.
 *
 * `rosterSnapshot`, `studentUserId`, `startedByUserId`,
 * `teacherUserId`, profile ids are NEVER projected.
 */
export type AttendanceSessionStatusState = "none" | "active" | "closed";

export interface AttendanceSessionStatusDto {
  state: AttendanceSessionStatusState;
  session: AttendanceSessionStatusSessionDto | null;
}