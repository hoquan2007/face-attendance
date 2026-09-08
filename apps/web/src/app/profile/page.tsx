/**
 * /profile route.
 *
 * Server Component.
 *
 * Guard chain:
 *   - no session               -> redirect /login
 *   - profile incomplete       -> redirect /onboarding
 *   - otherwise                -> render the read-only summary and
 *                                 edit form
 *
 * The profile role is rendered read-only. Role mutation is intentionally
 * not supported in Phase 2; changing the role must go through a
 * dedicated controlled flow that does not exist yet.
 */

import { redirect } from "next/navigation";

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import { decideProtected } from "@/lib/route-guards";
import { ProfileEditForm } from "@/components/ProfileEditForm";

export const metadata = {
  title: "Profile — Face Attendance",
};

export default async function ProfilePage() {
  const session = await getSession();
  const profile = session
    ? await getProfileByUserId(session.user.id)
    : null;

  const decision = decideProtected({
    isAuthenticated: session !== null,
    isOnboardingComplete: Boolean(profile?.onboardingCompleted),
  });

  if (decision.redirectTo) {
    redirect(decision.redirectTo);
  }

  const user = session!.user;
  const p = profile!;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium uppercase tracking-widest text-slate-500">
          Profile
        </p>
        <h1 className="text-3xl font-semibold tracking-tight">Your profile</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          Update your name, identification code, and phone. Your role is
          set during onboarding and cannot be changed here.
        </p>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <ProfileEditForm
          email={user.email}
          fullName={p.fullName}
          role={p.role}
          identificationCode={p.identificationCode}
          phone={p.phone ?? null}
          avatarUrl={user.image}
        />
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-base font-semibold">Face ID</h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Not configured.
        </p>
        <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
          Face enrollment arrives in a later phase. No camera access is
          requested on this page.
        </p>
      </section>
    </main>
  );
}