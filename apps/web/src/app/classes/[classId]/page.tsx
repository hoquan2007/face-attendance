/**
 * `/classes/[classId]` — authenticated, authorized class detail page.
 *
 * PHASE 5.1E4A — AUTHORIZED CLASS DETAIL UI.
 *
 * Server Component.
 *
 * Reads the canonical `getClassDetailForCurrentUser(classId)` server-only
 * read model from `apps/web/src/lib/classes/class-read-service.ts`
 * (PHASE 5.1D2A). The function:
 *
 *   - accepts ONLY the resource identifier `classId`;
 *   - derives identity exclusively from the Better Auth session;
 *   - branches on the server-side `Profile.role` (teacher | student);
 *   - encodes the authorization constraint directly into the DB
 *     filter for the teacher path
 *     (`{ _id: classId, teacherUserId: session.user.id }`);
 *   - proves an ACTIVE membership FIRST, THEN loads the class
 *     (`ClassMembershipModel.findOne({ classId, studentUserId,
 *     session.user.id, status: "active" })`) for the student path;
 *   - projects ONLY safe DTO fields
 *     ({ id, name, classCode, status, createdAt, updatedAt, role });
 *   - collapses malformed classId, missing class, wrong teacher, no
 *     membership, and inactive membership to ONE single safe
 *     outward-facing code (`CLASS_NOT_ACCESSIBLE`) so the browser
 *     cannot enumerate live classes by error code;
 *   - never reads `passwordHash`, `teacherUserId`, `studentUserId`,
 *     membership internal ids, or biometric state.
 *
 * No client-side class fetching. No `useEffect`. No SWR / React Query.
 * No `/api/classes/[classId]` route is introduced.
 *
 * Next.js 16.3.4 dynamic-route signature:
 *
 *   The `params` prop is a `Promise<{ classId: string }>`. The page
 *   MUST `await params` to read the resource identifier. The legacy
 *   sync params pattern is removed.
 *
 * Guard chain:
 *   - no session        → redirect /login
 *   - profile incomplete→ redirect /onboarding
 *   - CLASS_NOT_ACCESSIBLE (malformed id / missing class /
 *     unauthorized teacher / non-member student / inactive
 *     membership) → `notFound()` so the failure is INDISTINGUISHABLE
 *     from any other missing-resource 404 — there is intentionally
 *     no "Class does not exist", "You do not own this class", "You
 *     are not a member", or "Invalid class ID" outcome.
 *   - CLASS_READ_FAILED → render a calm, restrained error block.
 *
 * What this page does NOT do:
 *
 *   - No roster read (`getClassRosterForCurrentTeacher`).
 *   - No roster UI (students / members / identificationCode /
 *     joinedAt).
 *   - No class editing / archive / delete controls.
 *   - No attendance UI.
 *   - No Face ID state / biometric enrollment state.
 *   - No public detail API.
 *   - No password / passwordHash / teacherUserId / studentUserId /
 *     membershipId / email / phone / FaceProfile / embedding /
 *     centroid in the rendered DOM.
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import {
  getClassDetailForCurrentUser,
  CLASS_DETAIL_READ_ERROR_CODES,
} from "@/lib/classes/class-read-service";
import { PageContainer } from "@/components/layout/PageContainer";
import { PageHeader } from "@/components/layout/PageHeader";
import { StatusBadge } from "@/components/layout/StatusBadge";
import { Card, CardContent, CardSection } from "@/components/ui/card";

export const metadata = {
  title: "Class",
};

/**
 * Locale-stable, ISO-based date formatter for `createdAt` /
 * `updatedAt`.
 *
 * Mirrors the helpers on `/classes` and `/classes/new` so the
 * rendered text is deterministic across server / client.
 */
function formatIsoDate(iso: string): string {
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
 * Role-aware, restrained sub-copy shown below the page heading.
 *
 * Mirrors the sub-copy on `/classes`:
 *   - teacher → "Class you manage."
 *   - student → "Class you've joined."
 *
 * The role comes from the server-authoritative D2A read result —
 * it is NEVER inferred client-side from class ownership or
 * membership status.
 */
function detailRoleDescription(role: "teacher" | "student"): string {
  return role === "teacher"
    ? "Class you manage."
    : "Class you've joined.";
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
function DetailReadFailureState() {
  return (
    <Card>
      <CardContent>
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-5 py-6"
        >
          <h2 className="text-base font-semibold text-foreground">
            Could not load the class
          </h2>
          <p className="text-sm leading-[21px] text-muted-foreground">
            We couldn&apos;t load this class right now. Please try again
            in a moment.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

export default async function ClassDetailPage({
  params,
}: {
  params: Promise<{ classId: string }>;
}) {
  // Next.js 16.3.4 dynamic-route signature: `params` is a Promise.
  // The resource identifier is the ONLY argument the page accepts;
  // no `userId` / `teacherUserId` / `studentUserId` / `role` /
  // `membershipId` is consulted.
  const { classId } = await params;

  // 1. Authentication — identity comes from the Better Auth session.
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  // 2. Profile gating — required for the D2A read model to know the
  //    viewer's role. The page does NOT infer the viewer role from
  //    ownership or membership status.
  const profile = await getProfileByUserId(session.user.id);
  if (!profile || !profile.onboardingCompleted) {
    redirect("/onboarding");
  }

  // 3. Read the canonical authorized class-detail boundary. The
  //    function is the ONLY sanctioned read path; the page does NOT
  //    query `ClassModel` or `ClassMembershipModel` directly.
  const result = await getClassDetailForCurrentUser(classId);

  // 4. Map the canonical error codes to the established auth /
  //    onboarding flows. Inaccessible boundary collapses to
  //    `notFound()` so malformed / missing / unauthorized all share
  //    the same safe 404 affordance — there is intentionally no
  //    distinguishable UI for the four failure modes.
  if (!result.ok) {
    if (result.code === CLASS_DETAIL_READ_ERROR_CODES.UNAUTHENTICATED) {
      redirect("/login");
    }
    if (
      result.code === CLASS_DETAIL_READ_ERROR_CODES.PROFILE_INCOMPLETE
    ) {
      redirect("/onboarding");
    }
    if (
      result.code === CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE
    ) {
      // Indistinguishable 404 boundary — same UI for malformed id,
      // missing class, unauthorized teacher, non-member student,
      // and inactive membership.
      notFound();
    }
    // CLASS_READ_FAILED — render a calm error block; never leak
    // the raw error message, a stack trace, or driver internals.
    return (
      <PageContainer size="default">
        <PageHeader title="Class" as="h1" />
        <div className="mt-8">
          <DetailReadFailureState />
        </div>
      </PageContainer>
    );
  }

  const { role, class: classDetail } = result.result;

  const statusTone =
    classDetail.status === "archived" ? "pending" : "active";
  const statusLabel =
    classDetail.status === "archived" ? "Archived" : "Active";

  return (
    <PageContainer size="default">
      <PageHeader
        title={classDetail.name}
        description={detailRoleDescription(role)}
        as="h1"
      />

      <div className="mt-8 flex flex-col gap-5">
        <Card>
          <CardSection>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-base font-semibold text-foreground">
                Class details
              </h2>
              <StatusBadge tone={statusTone} label={statusLabel} />
            </div>
          </CardSection>
          <CardContent>
            <dl className="flex flex-col gap-4">
              <div className="flex flex-col gap-1.5">
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Class code
                </dt>
                <dd className="select-all font-mono text-2xl font-semibold leading-tight text-foreground">
                  {classDetail.classCode}
                </dd>
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border pt-4 text-sm">
                <div className="flex items-center gap-2">
                  <dt className="text-muted-foreground">Created</dt>
                  <dd className="text-foreground">
                    {formatIsoDate(classDetail.createdAt)}
                  </dd>
                </div>
                <div className="flex items-center gap-2">
                  <dt className="text-muted-foreground">Updated</dt>
                  <dd className="text-foreground">
                    {formatIsoDate(classDetail.updatedAt)}
                  </dd>
                </div>
              </div>
            </dl>
          </CardContent>
        </Card>

        <div className="flex justify-start">
          <Link
            href="/classes"
            className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background rounded-sm"
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            <span>Back to classes</span>
          </Link>
        </div>
      </div>
    </PageContainer>
  );
}
