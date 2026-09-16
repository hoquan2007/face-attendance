/**
 * `/classes/join` — authenticated student-only "Join class" page.
 *
 * PHASE 5.1E3 — STUDENT JOIN CLASS UI.
 *
 * Server Component.
 *
 * Defense-in-depth guard chain:
 *   - no session            → redirect /login
 *   - profile incomplete    → redirect /onboarding
 *   - role !== "student"   → redirect /classes (teacher path)
 *   - otherwise             → render the `JoinClassForm`
 *
 * The page performs server-side access gating BEFORE rendering the
 * client form. This is the FIRST of two defense-in-depth gates; the
 * `createJoinClassAction` Server Action performs its own identical gate
 * a second time. The action is the authoritative boundary — a
 * stale cached client tree cannot bypass it.
 *
 * Privacy posture:
 *
 *   - The page does NOT receive or render any identity fields.
 *     `studentUserId` / `userId` / `role` are derived exclusively
 *     from the Better Auth server session and the persisted
 *     Profile.
 *   - The page does NOT query `ClassModel` or `ClassMembershipModel`
 *     directly — only the Profile collection is read (for role
 *     gating).
 *   - The page does NOT pre-populate the form with any persisted
 *     state (no draft, no localStorage hydration).
 *
 * What this page does NOT do:
 *
 *   - No class detail UI (PHASE 5.1E4).
 *   - No roster UI.
 *   - No attendance UI.
 *   - No public API route. The Server Action is the only entry
 *     point.
 */

import { redirect } from "next/navigation";
import { UserPlus } from "lucide-react";

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import { PageContainer } from "@/components/layout/PageContainer";
import { PageHeader } from "@/components/layout/PageHeader";
import { JoinClassForm } from "@/components/classes/join-class-form";

export const metadata = {
  title: "Join class",
};

export default async function JoinClassPage() {
  // 1. Authentication — identity comes exclusively from the
  //    Better Auth server session. No `userId` is accepted from
  //    any browser-supplied argument.
  const session = await getSession();
  if (!session) {
    redirect("/login");
  }

  // 2. Profile gating — required for the page to know the
  //    viewer's role. Missing / incomplete Profile follows the
  //    established onboarding redirect.
  const profile = await getProfileByUserId(session.user.id);
  if (!profile || !profile.onboardingCompleted) {
    redirect("/onboarding");
  }

  // 3. Role gating — student-only. An authenticated teacher
  //    visiting `/classes/join` is redirected back to `/classes`
  //    using the project's established safe navigation convention.
  //    We do not leak a separate student-only error page because
  //    project conventions do not include one.
  if (profile.role !== "student") {
    redirect("/classes");
  }

  // 4. Render the calm join-class shell with the
  //    identity-free Client Component.
  return (
    <PageContainer size="default">
      <PageHeader
        title="Join class"
        description="Enter the class code and password shared by your teacher."
        as="h1"
      />

      <div className="mt-8 flex flex-col gap-5">
        <div
          aria-hidden="true"
          className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground"
        >
          <UserPlus className="h-5 w-5" />
        </div>

        <JoinClassForm />
      </div>
    </PageContainer>
  );
}
