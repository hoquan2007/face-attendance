/**
 * `RosterPanel` — focused Server Component for PHASE 5.1E4B.
 *
 * The teacher-owner active-student roster panel rendered on the
 * `/classes/[classId]` class detail page. The component receives
 * the safe roster projection from the canonical
 * `getClassRosterForCurrentTeacher(classId)` read boundary
 * (PHASE 5.1D2B) and renders ONLY the safe fields:
 *
 *   - `fullName`
 *   - `identificationCode`
 *   - `joinedAt`
 *
 * The component:
 *
 *   - Renders a calm "Students" section heading.
 *   - Renders an empty-state copy when the roster is empty.
 *   - Renders a calm roster-failure message when the safe roster
 *     read returns a safe failure — no raw exception text, no
 *     stack traces, no Mongo detail, no user IDs, no
 *     ownership / class-id leak.
 *   - Renders the rows in the server-supplied order
 *     (`joinedAt ASC`). The component does NOT resort client-
 *     side; the deterministic order is preserved as a rendered
 *     property.
 *   - Uses semantic HTML (`<table>` / `<thead>` / `<tbody>` /
 *     `<tr>` / `<th>` / `<td>`) for assistive technology.
 *   - Never surfaces `studentUserId`, `membershipId`, `classId`,
 *     `emailSnapshot`, `phone`, `FaceProfile`, embedding,
 *     centroid, or any biometric / attendance data.
 *
 * The component receives ONLY the safe DTO. There is no `useEffect`,
 * no SWR / React Query, no `fetch`, no `localStorage`,
 * `sessionStorage`, or IndexedDB access. The render is purely
 * server-side.
 *
 * Privacy guarantees:
 *
 *   - DOM NEVER contains `password`, `passwordHash`,
 *     `teacherUserId`, `studentUserId`, `membershipId`,
 *     `emailSnapshot`, `phone`, `FaceProfile`, `embedding`, or
 *     `centroid`.
 *   - No biometric data, no attendance data, no Face Service
 *     call.
 *   - The "View class" / "Back to classes" navigation is the
 *     caller's responsibility — this component does NOT render
 *     any navigation.
 */

import { Card, CardContent, CardSection } from "@/components/ui/card";
import { EmptyState } from "@/components/layout/EmptyState";

/**
 * The minimal safe roster row the panel renders.
 *
 * Mirrors the `SafeRosterItem` shape from
 * `apps/web/src/lib/classes/class-read-service.ts`. The panel
 * accepts ONLY this shape; identity-bearing fields like
 * `studentUserId` or `membershipId` are NEVER accepted.
 */
export interface RosterPanelItem {
  fullName: string;
  identificationCode: string;
  joinedAt: string;
}

/**
 * A safe roster read failure marker.
 *
 * The page wraps the canonical D2B error code in this shape.
 * The panel ALWAYS renders the hardcoded safe copy
 * `Student list could not be loaded.`; the page does NOT
 * forward the backend `message` to the panel — the backend
 * `message` is intentionally NOT exposed in the rendered
 * DOM. This protects against any future roster boundary that
 * might accidentally surface a raw `E11000`, `mongodb://`,
 * or stack-trace string through the `message` field.
 */
export interface RosterPanelFailure {
  status: "failure";
}

/**
 * The panel's input state.
 *
 *   - `status: "success"`     — the safe roster DTO is available
 *                                and rendered as a populated or
 *                                empty table.
 *   - `status: "failure"`     — the read failed with a safe
 *                                message; the panel renders a
 *                                calm error block.
 *   - `status: "absent"`      — the caller intentionally did not
 *                                perform the roster read (e.g.
 *                                student viewer path). The panel
 *                                renders NOTHING — no section, no
 *                                heading, no copy.
 */
export type RosterPanelState =
  | { status: "success"; students: RosterPanelItem[] }
  | RosterPanelFailure
  | { status: "absent" };

export interface RosterPanelProps {
  state: RosterPanelState;
}

/**
 * Locale-stable, ISO-based date formatter for `joinedAt`.
 *
 * Mirrors the helper used on `/classes` and `/classes/[classId]`
 * so the rendered text is deterministic across server / client
 * and across rows.
 */
function formatJoinedDate(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return iso;
  }
}

/**
 * Restrained, calm failure block for the roster-local error path.
 *
 * The block NEVER surfaces a raw error string, a stack trace, a
 * Mongo detail, an ownership copy, a user id, a membership id,
 * the failure cause, or any backend message. The user sees a
 * single, short, hardcoded copy and is invited to refresh the
 * page. No automatic retry is triggered.
 *
 * The copy is intentionally constant so a future backend
 * regression that surfaces a raw `E11000` / `mongodb://` /
 * stack-trace through the roster failure message can NEVER
 * leak into the rendered DOM through this surface.
 */
function RosterFailureBlock() {
  return (
    <Card>
      <CardContent>
        <div
          role="status"
          aria-live="polite"
          className="flex flex-col gap-1.5 rounded-xl border border-border bg-surface px-5 py-5"
        >
          <p className="text-sm font-medium text-foreground">
            Student list could not be loaded.
          </p>
          <p className="text-sm leading-[21px] text-muted-foreground">
            Please refresh the page in a moment.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Restrained empty state for the teacher roster.
 *
 * The teacher's class is real; there is simply no active member
 * yet. The copy is calm and accurate — no fake count, no fake
 * student row. The wording intentionally matches the project
 * "Never display only 'No data'" rule by giving a short title
 * + a one-sentence description.
 */
function RosterEmptyState() {
  return (
    <EmptyState
      title="No students yet"
      description="No students have joined this class yet."
      tone="muted"
    />
  );
}

/**
 * Roster row markup.
 *
 * Renders ONLY the safe fields: `fullName`, `identificationCode`,
 * and the formatted `joinedAt`. The hidden `<td>` cells
 * (`studentUserId`, `membershipId`, etc.) are NEVER rendered;
 * the data is NEVER received by this component.
 */
function RosterRow({ student }: { student: RosterPanelItem }) {
  return (
    <tr className="border-t border-border align-top">
      <td className="px-4 py-3 text-sm font-medium text-foreground">
        {student.fullName}
      </td>
      <td className="px-4 py-3 font-mono text-sm text-foreground">
        {student.identificationCode}
      </td>
      <td className="px-4 py-3 text-sm text-foreground">
        {formatJoinedDate(student.joinedAt)}
      </td>
    </tr>
  );
}

/**
 * `RosterPanel` — the teacher roster section.
 *
 * Renders a calm "Students" Card. The card title is hidden when
 * the panel renders nothing (`status === "absent"`) so the
 * caller can opt OUT of the roster entirely (e.g. student viewer
 * path) by passing `{ status: "absent" }`.
 *
 * Populated state renders the safe fields in the server-supplied
 * `joinedAt ASC` order. Empty state renders the calm empty
 * placeholder. Failure state renders the local failure block
 * (no raw internal error, no user IDs).
 */
export function RosterPanel({ state }: RosterPanelProps) {
  if (state.status === "absent") {
    return null;
  }

  return (
    <Card>
      <CardSection>
        <h2 className="text-base font-semibold text-foreground">
          Students
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Active members of this class.
        </p>
      </CardSection>
      {state.status === "failure" ? (
        <CardContent>
          <RosterFailureBlock />
        </CardContent>
      ) : state.students.length === 0 ? (
        <CardContent>
          <RosterEmptyState />
        </CardContent>
      ) : (
        <CardContent className="px-0 pb-0">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr>
                  <th
                    scope="col"
                    className="border-b border-border bg-muted px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    Student
                  </th>
                  <th
                    scope="col"
                    className="border-b border-border bg-muted px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    Student ID
                  </th>
                  <th
                    scope="col"
                    className="border-b border-border bg-muted px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                  >
                    Joined
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* Server-supplied joinedAt ASC order is preserved
                    — the panel does NOT resort client-side. */}
                {state.students.map((student, index) => (
                  <RosterRow
                    key={`${student.identificationCode}-${index}`}
                    student={student}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      )}
    </Card>
  );
}