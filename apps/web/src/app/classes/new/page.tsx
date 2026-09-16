/**
 * `/classes/new` — authenticated teacher-only "Create class" page.
 *
 * PHASE 5.1E2 — TEACHER CREATE CLASS UI.
 *
 * Server Component.
 *
 * Defense-in-depth guard chain:
 *   - no session            → redirect /login
 *   - profile incomplete    → redirect /onboarding
 *   - role !== "teacher"    → redirect /classes (student path)
 *   - otherwise             → render the `CreateClassForm`
 *
 * The page performs server-side access gating BEFORE rendering the
 * client form. This is the FIRST of two defense-in-depth gates; the
 * `createClassAction` Server Action performs its own identical gate
 * a second time. The action is the authoritative boundary — a
 * stale cached client tree cannot bypass it.
 *
 * Privacy posture:
 *
 *   - The page does NOT receive or render any identity fields.
 *     `teacherUserId` / `userId` / `role` are derived exclusively
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
 *   - No student join UI (PHASE 5.1E3).
 *   - No class detail UI (PHASE 5.1E4).
 *   - No roster UI.
 *   - No attendance UI.
 *   - No public API route. The Server Action is the only entry
 *     point.
 */

import { redirect } from "next/navigation";
import { Plus } from "lucide-react";

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import { PageContainer } from "@/components/layout/PageContainer";
import { PageHeader } from "@/components/layout/PageHeader";
import { CreateClassForm } from "@/components/classes/create-class-form";

export const metadata = {
  title: "Create class",
};

/**
 * Restrained, locale-friendly, ISO-based date formatter for the
 * success-state createdAt label. Mirrors the form-side helper so
 * the rendered text is deterministic across server / client.
 */
function formatCreatedAt(iso: string): string {
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

export default async function NewClassPage() {
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

  // 3. Role gating — teacher-only. An authenticated student
  //    visiting `/classes/new` is redirected back to `/classes`
  //    using the project's established safe navigation convention.
  //    We do not leak a separate teacher-only error page because
  //    project conventions do not include one.
  if (profile.role !== "teacher") {
    redirect("/classes");
  }

  // 4. Render the calm create-class shell with the
  //    identity-free Client Component.
  return (
    <PageContainer size="default">
      <PageHeader
        title="Create class"
        description="Set a name and a class password. A class code is generated for you."
        as="h1"
      />

      <div className="mt-8 flex flex-col gap-5">
        <div
          aria-hidden="true"
          className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground"
        >
          <Plus className="h-5 w-5" />
        </div>

        <CreateClassForm />
      </div>
    </PageContainer>
  );
}

/**
 * `formatCreatedAt` is exported so the form-side success state
 * can use the SAME formatter if a future phase ever inlines the
 * success block into the page. The form currently ships its own
 * formatter to keep the Client Component self-contained.
 */
export const __testing = {
  formatCreatedAt,
};
