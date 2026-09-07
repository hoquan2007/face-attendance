import type { ReactNode } from "react";
import Link from "next/link";
import { getSession } from "@/lib/session";
import { SignOutButton } from "@/components/SignOutButton";

/**
 * App-wide shell.
 *
 * Server Component that:
 * - Fetches the current session (server-side).
 * - Renders a header with auth-aware navigation.
 * - Children render below the header.
 */
export async function AppShell({ children }: { children: ReactNode }) {
  const session = await getSession();
  const isAuthenticated = session !== null;

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-slate-200 bg-white/70 backdrop-blur dark:border-slate-800 dark:bg-slate-950/70">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-3">
          <Link
            href={isAuthenticated ? "/dashboard" : "/"}
            className="text-sm font-semibold tracking-tight text-slate-900 hover:text-slate-700 dark:text-slate-50 dark:hover:text-slate-200"
          >
            Face Attendance
          </Link>
          <nav className="flex items-center gap-3 text-xs text-slate-500">
            {isAuthenticated ? (
              <>
                <Link
                  href="/dashboard"
                  className="rounded-md px-2 py-1 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-50"
                >
                  Dashboard
                </Link>
                <SignOutButton />
              </>
            ) : (
              <Link
                href="/login"
                className="rounded-md px-2 py-1 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-50"
              >
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>
      <div className="flex-1">{children}</div>
    </div>
  );
}