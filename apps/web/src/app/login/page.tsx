/**
 * /login page.
 *
 * Server Component:
 * - If user is already authenticated, redirect to /dashboard.
 * - Otherwise, render the Continue with Google button.
 *
 * Authentication is the only path. No email/password UI.
 */

import { redirect } from "next/navigation";
import { getSession } from "@/lib/session";
import { GoogleSignInButton } from "@/components/GoogleSignInButton";

export const metadata = {
  title: "Sign in — Face Attendance",
};

export default async function LoginPage() {
  const session = await getSession();

  if (session) {
    redirect("/dashboard");
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
