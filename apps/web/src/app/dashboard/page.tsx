/**
 * /dashboard page.
 *
 * Server Component — protected.
 *
 * Phase 2:
 *   - Source of truth: Better Auth session + the `profiles` collection.
 *   - No session                -> redirect /login
 *   - Incomplete profile        -> redirect /onboarding
 *   - Completed profile         -> render dashboard with real profile
 *                                  data and role-aware empty states.
 *
 * This page deliberately shows real profile data only — no fake
 * attendance numbers or classroom statistics. Empty-state cards are
 * role-aware but explicitly empty.
 */

import Link from "next/link";
import { redirect } from "next/navigation";

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import { decideProtected } from "@/lib/route-guards";
import { SignOutButton } from "@/components/SignOutButton";

export const metadata = {
  title: "Dashboard — Face Attendance",
};

export default async function DashboardPage() {
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
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-widest text-slate-500">
            Dashboard
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            Welcome, {p.fullName}
          </h1>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
            Signed in as <span className="font-medium">{user.email}</span>
          </p>
        </div>
        <SignOutButton />
      </header>

      <section
        aria-labelledby="profile-summary"
        className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <h2
          id="profile-summary"
          className="text-lg font-semibold"
        >
          Your profile
        </h2>
        <div className="mt-4 flex items-center gap-4">
          {user.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.image}
              alt={`${p.fullName} avatar`}
              width={64}
              height={64}
              className="h-16 w-16 rounded-full border border-slate-200 object-cover dark:border-slate-700"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div
              aria-hidden="true"
              className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-200 text-xl font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300"
            >
              {p.fullName.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="flex flex-col gap-1 text-sm">
            <span className="text-base font-medium text-slate-900 dark:text-slate-50">
              {p.fullName}
            </span>
            <span className="text-slate-600 dark:text-slate-400">
              {user.email}
            </span>
            <span className="text-slate-500 dark:text-slate-400">
              Role:{" "}
              <span className="font-medium text-slate-700 dark:text-slate-300">
                {p.role}
              </span>
            </span>
            <span className="text-slate-500 dark:text-slate-400">
              Identification code:{" "}
              <span className="font-medium text-slate-700 dark:text-slate-300">
                {p.identificationCode}
              </span>
            </span>
            {p.phone ? (
              <span className="text-slate-500 dark:text-slate-400">
                Phone:{" "}
                <span className="font-medium text-slate-700 dark:text-slate-300">
                  {p.phone}
                </span>
              </span>
            ) : null}
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Link
            href="/profile"
            className="text-sm font-medium text-slate-700 underline hover:text-slate-900 dark:text-slate-300 dark:hover:text-white"
          >
            Edit profile
          </Link>
        </div>
      </section>

      <section
        aria-labelledby="empty-state"
        className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center shadow-sm dark:border-slate-700 dark:bg-slate-900"
      >
        <h2 id="empty-state" className="text-base font-semibold">
          {p.role === "teacher" ? "No classes yet" : "You haven't joined any classes yet"}
        </h2>
        <p className="mt-2 text-sm text-slate-600 dark:text-slate-400">
          {p.role === "teacher"
            ? "Classroom creation arrives in a later phase."
            : "Joining a class by code arrives in a later phase."}
        </p>
      </section>

      <section
        aria-labelledby="face-status"
        className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900"
      >
        <h2 id="face-status" className="text-base font-semibold">
          Face ID
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          Status:{" "}
          <span className="font-medium text-slate-800 dark:text-slate-200">
            Not configured
          </span>
        </p>
        <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
          Face enrollment arrives in a later phase. No camera access is
          requested on this page.
        </p>
      </section>
    </main>
  );
}