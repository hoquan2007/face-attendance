/**
 * /onboarding route.
 *
 * Server Component.
 *
 * Guard chain:
 *   - no session        -> redirect /login
 *   - profile complete  -> redirect /dashboard
 *   - otherwise        -> render the multi-step onboarding form
 *
 * Source of truth: Better Auth session (`getSession()`) and the
 * application `profiles` collection via `isOnboardingComplete()`.
 */

import { redirect } from "next/navigation";

import { getSession } from "@/lib/session";
import { isOnboardingComplete } from "@/lib/profile-service";
import { decideOnboarding } from "@/lib/route-guards";
import { OnboardingForm } from "@/components/OnboardingForm";

export const metadata = {
  title: "Welcome",
};

export default async function OnboardingPage() {
  const session = await getSession();
  const onboardingComplete = session
    ? await isOnboardingComplete(session.user.id)
    : false;

  const decision = decideOnboarding({
    isAuthenticated: session !== null,
    isOnboardingComplete: onboardingComplete,
  });

  if (decision.redirectTo) {
    redirect(decision.redirectTo);
  }

  const user = session!.user;

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        {/* Page header */}
        <div className="mb-8 flex flex-col gap-2 text-center">
          <h1 className="text-[28px] leading-[36px] font-semibold tracking-tight text-foreground">
            Welcome to Face Attendance
          </h1>
          <p className="text-sm leading-[21px] text-muted-foreground">
            Set up your profile in two steps. You can update your name,
            identification code, and phone later from your profile page.
          </p>
        </div>

        {/* Onboarding card */}
        <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
          <OnboardingForm
            email={user.email}
            fullName={user.name}
            avatarUrl={user.image}
          />
        </div>

        <p className="mt-4 text-center text-xs text-muted-foreground">
          Your Google email is used to identify your account and is never
          shown to other users.
        </p>
      </div>
    </div>
  );
}
