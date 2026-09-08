/**
 * /onboarding route.
 *
 * Server Component.
 *
 * Guard chain:
 *   - no session        -> redirect /login
 *   - profile complete  -> redirect /dashboard
 *   - otherwise         -> render the multi-step onboarding form
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
  title: "Welcome — Face Attendance",
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
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-6 py-12">
      <header className="flex flex-col gap-2 text-center">
        <p className="text-sm font-medium uppercase tracking-widest text-slate-500">
          Phase 2 — Onboarding
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">
          Welcome to Face Attendance
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Tell us how you will use the app. You can update your name,
          identification code, and phone later from your profile page.
        </p>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <OnboardingForm
          email={user.email}
          fullName={user.name}
          avatarUrl={user.image}
        />
      </section>
    </main>
  );
}