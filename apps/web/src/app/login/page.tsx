/**
 * /login page.
 *
 * Server Component:
 *   - Not authenticated                -> render the Google sign-in
 *                                          form.
 *   - Authenticated + incomplete       -> redirect /onboarding
 *   - Authenticated + complete         -> redirect /dashboard
 *
 * Phase 2 update: authenticated users are routed through the
 * onboarding gate so they cannot get stuck on `/login` after a
 * successful Google sign-in.
 *
 * The Google OAuth callback URL is set to `/dashboard` so that the
 * post-login guard at `/dashboard` handles the redirect to
 * `/onboarding` for first-time users.
 */

import { redirect } from "next/navigation";

import { getSession } from "@/lib/session";
import { isOnboardingComplete } from "@/lib/profile-service";
import { decideLogin } from "@/lib/route-guards";
import { GoogleSignInButton } from "@/components/GoogleSignInButton";

export const metadata = {
  title: "Sign in — Face Attendance",
};

export default async function LoginPage() {
  const session = await getSession();
  let onboardingCompleteFlag = false;
  if (session) {
    onboardingCompleteFlag = await isOnboardingComplete(session.user.id);
  }

  const decision = decideLogin({
    isAuthenticated: session !== null,
    isOnboardingComplete: onboardingCompleteFlag,
  });

  if (decision.redirectTo) {
    redirect(decision.redirectTo);
  }

  return (
    <main className="mx-auto flex max-w-md flex-col gap-6 px-6 py-16">
      <header className="flex flex-col gap-2 text-center">
        <h1 className="text-3xl font-semibold tracking-tight">
          Sign in to Face Attendance
        </h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Use your Google account to continue. We only access your basic
          profile information (name, email, profile picture).
        </p>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <GoogleSignInButton callbackURL="/dashboard" />
      </section>

      <footer className="text-center text-xs text-slate-500 dark:text-slate-500">
        By continuing, you agree that this application stores basic
        identity information for attendance purposes.
      </footer>
    </main>
  );
}