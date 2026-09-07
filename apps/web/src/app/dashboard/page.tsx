/**
 * /dashboard page.
 *
 * Server Component — protected by server-side session validation.
 *
 * If the user is not authenticated, redirect to /login.
 * If authenticated, display real Google profile data (name, email, avatar).
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { SignOutButton } from "@/components/SignOutButton";

export const metadata = {
  title: "Dashboard — Face Attendance",
};

export default async function DashboardPage() {
  const session = await getSession();

  if (!session) {
    redirect("/login");
  }

  const { user } = session;

  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-12">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium uppercase tracking-widest text-slate-500">
            Dashboard
          </p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            Welcome, {user.name}
          </h1>
        </div>
        <SignOutButton />
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-lg font-semibold">Profile</h2>
        <div className="mt-4 flex items-center gap-4">
          {user.image ? (
            <img
              src={user.image}
              alt={`${user.name} avatar`}
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
              {user.name.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="flex flex-col">
            <span className="text-base font-medium text-slate-900 dark:text-slate-50">
              {user.name}
            </span>
            <span className="text-sm text-slate-600 dark:text-slate-400">
              {user.email}
            </span>
            <span className="mt-1 text-xs text-slate-400 dark:text-slate-500">
              User ID: {user.id}
            </span>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-lg font-semibold">Phase 1 scope</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
          <li>You are authenticated with Google.</li>
          <li>Your session is persisted in MongoDB Atlas by Better Auth.</li>
          <li>No profile onboarding, classes, or attendance features yet.</li>
          <li>Future phases will add classrooms, face enrollment, and attendance.</li>
        </ul>
      </section>
    </main>
  );
}
