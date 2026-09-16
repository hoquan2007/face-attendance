/**
 * `/classes` — authenticated class list page.
 *
 * PHASE 5.1E1 — SERVER-RENDERED /classes PAGE AND CLASS LIST UI.
 * PHASE 5.1E2 — TEACHER "CREATE CLASS" CTA.
 * PHASE 5.1E3 — STUDENT "JOIN CLASS" CTA.
 *
 * Server Component.
 *
 * Reads the canonical `getVisibleClassesForCurrentUser()` server-only
 * read model from `apps/web/src/lib/classes/class-read-service.ts`
 * (PHASE 5.1D1). The function:
 *
 *   - accepts NO arguments;
 *   - derives identity exclusively from the Better Auth session;
 *   - branches on the server-side `Profile.role` (teacher | student);
 *   - projects ONLY safe DTO fields
 *     ({ id, name, classCode, status, createdAt });
 *   - never reads `passwordHash`, `teacherUserId`, `studentUserId`,
 *     membership internal ids, or biometric state.
 *
 * No client-side class fetching. No `useEffect`. No SWR / React Query.
 * No `/api/classes` route is introduced.
 *
 * The page is intentionally render-only for the list. It does NOT
 * create, edit, or join classes; the Create class CTA only links
 * to the `/classes/new` route where the actual Server Action lives.
 * It does NOT render a roster, class detail, attendance UI, or
 * Face ID status. Those belong to PHASE 5.1E4 and the attendance
 * phases.
 *
 * Teacher-only "Create class" CTA (PHASE 5.1E2):
 *
 *   - The CTA is rendered ONLY when `role === "teacher"`. The
 *     role comes from the server-authoritative read result — it
 *     is NEVER inferred client-side from the number of classes
 *     or from any browser-supplied argument.
 *   - The CTA links to `/classes/new` where the page-level
 *     teacher guard performs defense-in-depth access gating.
 *
 * Student-only "Join class" CTA (PHASE 5.1E3):
 *
 *   - The CTA is rendered ONLY when `role === "student"`. The
 *     role comes from the server-authoritative read result — it
 *     is NEVER inferred client-side from the number of classes
 *     or from any browser-supplied argument.
 *   - The CTA links to `/classes/join` where the page-level
 *     student guard performs defense-in-depth access gating.
 *   - Teachers see NO "Join class" CTA.
 *
 * Guard chain:
 *   - no session        → redirect /login
 *   - profile incomplete→ redirect /onboarding
 *   - read failure      → render a calm, restrained error block
 *   - success           → role-aware list
 */

import Link from "next/link";
import { Plus, UserPlus } from "lucide-react";

import { redirect } from "next/navigation";
import { Users2 } from "lucide-react";

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import {
  getVisibleClassesForCurrentUser,
  CLASS_READ_ERROR_CODES,
  type SafeClassSummary,
} from "@/lib/classes/class-read-service";
import { PageContainer } from "@/components/layout/PageContainer";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/layout/EmptyState";
import { StatusBadge } from "@/components/layout/StatusBadge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
} from "@/components/ui/card";

export const metadata = {
  title: "Classes",
};

/**
 * Sub-copy shown below the page heading.
 *
 * Teacher sees: "Classes you manage."
 * Student sees: "Classes you've joined."
 *
 * The role comes from the server-authoritative read result — it is
 * NEVER inferred from the number of classes, ownership, or any
 * client-side state.
 */
function roleDescription(role: "teacher" | "student"): string {
  return role === "teacher"
    ? "Classes you manage."
    : "Classes you've joined.";
}

/**
 * Restrained, locale-stable, ISO-based date formatter.
 *
 * The page is server-rendered; the same formatter is used in tests
 * so the rendered text is deterministic and there is no
 * hydration mismatch between server and client.
 *
 * No third-party date library is introduced.
 */
function formatCreatedDate(iso: string): string {
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
 * Renders a single class row inside the classes list.
 *
 * Intentionally non-interactive (no link to `/classes/[classId]`
 * because that route does not exist yet — it belongs to
 * PHASE 5.1E4). The row is a semantic `<li>` with a heading,
 * the `classCode` in monospace, a `StatusBadge`, and a created
 * date. No biometric fields, no student names, no roster,
 * no attendance metrics.
 */
function ClassListItem({ item }: { item: SafeClassSummary }) {
  const statusTone = item.status === "archived" ? "pending" : "active";
  const statusLabel = item.status === "archived" ? "Archived" : "Active";
  return (
    <li className="list-none">
      <article
        aria-label={item.name}
        className="flex flex-col gap-3 rounded-xl border border-border bg-card px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
      >
        <div className="flex min-w-0 flex-col gap-1.5">
          <h3 className="truncate text-base font-semibold leading-tight text-foreground">
            {item.name}
          </h3>
          <dl className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
            <div className="flex items-center gap-2">
              <dt className="sr-only">Class code</dt>
              <dd className="font-mono text-foreground">{item.classCode}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="text-muted-foreground">Created</dt>
              <dd className="text-foreground">
                {formatCreatedDate(item.createdAt)}
              </dd>
            </div>
          </dl>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <StatusBadge tone={statusTone} label={statusLabel} />
        </div>
      </article>
    </li>
  );
}

/**
 * Restrained empty-state copy with role-aware CTA.
 *
 * PHASE 5.1E2 — Teacher empty state includes a "Create class" CTA.
 * PHASE 5.1E3 — Student empty state includes a "Join class" CTA.
 */
function ClassesEmptyState({ role }: { role: "teacher" | "student" }) {
  if (role === "teacher") {
    return (
      <div className="flex flex-col gap-5">
        <EmptyState
          icon={<Users2 className="h-5 w-5" aria-hidden="true" />}
          title="No classes yet"
          description="Classes you create will appear here."
          tone="muted"
        />
        <div>
          <CreateClassCta />
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-5">
      <EmptyState
        icon={<Users2 className="h-5 w-5" aria-hidden="true" />}
        title="No classes yet"
        description="Classes you join will appear here."
        tone="muted"
      />
      <div>
        <JoinClassCta />
      </div>
    </div>
  );
}

/**
 * PHASE 5.1E2 — Teacher-only "Create class" CTA.
 *
 * A single, calm Button that links to `/classes/new`. The link
 * carries NO query parameters, NO class data, and NO identity
 * fields. The page-level teacher guard at `/classes/new` is the
 * authoritative access boundary.
 *
 * The CTA is rendered ONLY when the server-authoritative role is
 * `"teacher"`. Students never see this component — the page's
 * outer JSX branches on the server-returned `role`.
 */
function CreateClassCta() {
  return (
    <Button
      asChild
      variant="primary"
      data-component="create-class-cta"
      aria-label="Create class"
    >
      <Link href="/classes/new" className="inline-flex items-center gap-2">
        <Plus className="h-4 w-4" aria-hidden="true" />
        <span>Create class</span>
      </Link>
    </Button>
  );
}

/**
 * PHASE 5.1E3 — Student-only "Join class" CTA.
 *
 * A single, calm Button that links to `/classes/join`. The link
 * carries NO query parameters, NO class data, and NO identity
 * fields. The page-level student guard at `/classes/join` is the
 * authoritative access boundary.
 *
 * The CTA is rendered ONLY when the server-authoritative role is
 * `"student"`. Teachers never see this component — the page's
 * outer JSX branches on the server-returned `role`.
 */
function JoinClassCta() {
  return (
    <Button
      asChild
      variant="primary"
      data-component="join-class-cta"
      aria-label="Join class"
    >
      <Link href="/classes/join" className="inline-flex items-center gap-2">
        <UserPlus className="h-4 w-4" aria-hidden="true" />
        <span>Join class</span>
      </Link>
    </Button>
  );
}

/**
 * Calm, restrained error block for `CLASS_READ_FAILED`.
 *
 * The page never renders a raw error string, a stack trace, a
 * Mongo detail, or the failure cause. The user sees a single,
 * short message and is invited to retry by reloading the page.
 * This mirrors the project's "calm error state" pattern from
 * `docs/frontend-design.md` (`Error State` — "Clear title + short
 * explanation + retry/back action where appropriate. Never expose
 * raw error messages to end users.").
 */
function ReadFailureState() {
  return (
    <Card>
      <CardContent>
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-5 py-6"
        >
          <h2 className="text-base font-semibold text-foreground">
            Could not load your classes
          </h2>
          <p className="text-sm leading-[21px] text-muted-foreground">
            We couldn&apos;t load your classes right now. Please try again
            in a moment.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default async function ClassesPage() {
  // 1. Authentication — identity comes from the Better Auth session.
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  // 2. Profile gating — required for the class list to have a role
  //    and for the read model to know the viewer's role.
  const profile = await getProfileByUserId(session.user.id);
  if (!profile || !profile.onboardingCompleted) {
    redirect("/onboarding");
  }

  // 3. Read the canonical visible-classes model. The function is the
  //    ONLY sanctioned read boundary; the page does not query
  //    `ClassModel` or `ClassMembershipModel` directly, does not
  //    accept a browser-supplied `userId`, and does not infer the
  //    viewer role client-side.
  const result = await getVisibleClassesForCurrentUser();

  // 4. Map the canonical error codes to the established auth /
  //    onboarding flows. Unexpected read failures render through the
  //    project's restrained server error pattern (no raw exception
  //    text).
  if (!result.ok) {
    if (result.code === CLASS_READ_ERROR_CODES.UNAUTHENTICATED) {
      redirect("/login");
    }
    if (result.code === CLASS_READ_ERROR_CODES.PROFILE_INCOMPLETE) {
      redirect("/onboarding");
    }
    // CLASS_READ_FAILED — render a calm error block; never leak
    // the raw error message, a stack trace, or driver internals.
    return (
      <PageContainer size="default">
        <PageHeader
          title="Classes"
          description={roleDescription(
            profile.role === "teacher" ? "teacher" : "student",
          )}
          as="h1"
        />
        <div className="mt-8">
          <ReadFailureState />
        </div>
      </PageContainer>
    );
  }

  const { role, classes } = result.result;

  return (
    <PageContainer size="default">
      <PageHeader
        title="Classes"
        description={roleDescription(role)}
        actions={
          role === "teacher" ? (
            <CreateClassCta />
          ) : role === "student" ? (
            <JoinClassCta />
          ) : undefined
        }
        as="h1"
      />

      <div className="mt-8 flex flex-col gap-5">
        {classes.length === 0 ? (
          <ClassesEmptyState role={role} />
        ) : (
          // The list uses a semantic <ul>/<li> structure so
          // assistive technology can enumerate the entries. The
          // list preserves the D1 deterministic ordering (createdAt
          // DESC) — the page does NOT resort.
          <ul
            aria-label={role === "teacher" ? "Classes you manage" : "Classes you've joined"}
            className="flex flex-col gap-3"
          >
            {classes.map((item) => (
              <ClassListItem key={item.id} item={item} />
            ))}
          </ul>
        )}
      </div>
    </PageContainer>
  );
}