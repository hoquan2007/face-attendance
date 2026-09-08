/**
 * App-wide shell.
 *
 * Server Component that:
 *   - Fetches the current session (server-side).
 *   - Renders a header with auth-aware and role-aware navigation.
 *   - Children render below the header.
 *
 * Navigation policy:
 *   - The role-aware navigation is rendered ONLY when the user is
 *     authenticated AND has completed onboarding. Before that, we
 *     show minimal chrome (Dashboard + Profile + Sign out) so the
 *     user is never dropped into a navigation set pointing to
 *     not-yet-implemented pages.
 *   - Routes for classes / attendance are intentionally omitted in
 *     Phase 2 — they belong to later phases. We do NOT render fake
 *     links that lead to non-existent pages.
 *   - The "Face ID" link is rendered as a disabled item marked
 *     "Coming soon". No camera permission is requested.
 */

import Link from "next/link";
import type { ReactNode } from "react";

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import { SignOutButton } from "@/components/SignOutButton";

export async function AppShell({ children }: { children: ReactNode }) {
  const session = await getSession();
  const profile = session
    ? await getProfileByUserId(session.user.id)
    : null;

  const isAuthenticated = session !== null;
  const onboardingComplete = Boolean(profile?.onboardingCompleted);
  const showRoleNav = isAuthenticated && onboardingComplete && profile;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white/70 backdrop-blur dark:border-slate-800 dark:bg-slate-950/70">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-6 py-3 sm:flex-row sm:items-center sm:justify-between">
          <Link
            href={isAuthenticated && onboardingComplete ? "/dashboard" : "/"}
            className="text-sm font-semibold tracking-tight text-slate-900 hover:text-slate-700 dark:text-slate-50 dark:hover:text-slate-200"
          >
            Face Attendance
          </Link>
          <nav className="flex flex-wrap items-center gap-1 text-xs text-slate-500">
            {!isAuthenticated ? (
              <Link
                href="/login"
                className="rounded-md px-2 py-1 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-50"
              >
                Sign in
              </Link>
            ) : (
              <>
                <Link
                  href="/dashboard"
                  className="rounded-md px-2 py-1 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-50"
                >
                  Dashboard
                </Link>
                {showRoleNav ? <RoleNav role={profile.role} /> : null}
                <Link
                  href="/profile"
                  className="rounded-md px-2 py-1 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-50"
                >
                  Profile
                </Link>
                <span
                  aria-disabled="true"
                  title="Face enrollment arrives in a later phase"
                  className="cursor-not-allowed rounded-md px-2 py-1 text-slate-400 dark:text-slate-600"
                >
                  Face ID (coming soon)
                </span>
                <SignOutButton />
              </>
            )}
          </nav>
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}

/**
 * Role-aware navigation items.
 *
 * Both teacher and student lists deliberately omit destination links
 * for features that are not yet implemented (classes, attendance,
 * history). They are listed here only as a placeholder for visual
 * completeness — they render as disabled "coming soon" items so we
 * never produce a navigation set that points to fake pages.
 */
function RoleNav({ role }: { role: "student" | "teacher" }) {
  const items =
    role === "teacher"
      ? ["Classes", "Attendance", "History", "Settings"]
      : ["My Classes", "Join Class", "History", "Settings"];

  return (
    <>
      {items.map((label) => (
        <span
          key={label}
          aria-disabled="true"
          title={`${label} arrives in a later phase`}
          className="cursor-not-allowed rounded-md px-2 py-1 text-slate-400 dark:text-slate-600"
        >
          {label} (coming soon)
        </span>
      ))}
    </>
  );
}