/**
 * /login page.
 *
 * Server Component:
 *   - Not authenticated                -> render the Google sign-in
 *                                          form.
 *   - Authenticated + incomplete       -> redirect /onboarding
 *   - Authenticated + complete         -> redirect /dashboard
 *
 * Visual design (Phase 2.5 — Quiet Precision):
 *   Desktop: two-column split layout.
 *     LEFT  — restrained brand panel with product statement.
 *             No stock imagery, no AI gradient, no glowing face.
 *     RIGHT — focused login form.
 *   Mobile: single-column, left panel is hidden.
 */

import { redirect } from "next/navigation";

import { getSession } from "@/lib/session";
import { isOnboardingComplete } from "@/lib/profile-service";
import { decideLogin } from "@/lib/route-guards";
import { GoogleSignInButton } from "@/components/GoogleSignInButton";

export const metadata = {
  title: "Sign in",
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
    <div className="flex min-h-screen">
      {/* LEFT — Brand panel (hidden on mobile) */}
      <div
        aria-hidden="true"
        className="hidden w-1/2 flex-col items-center justify-center bg-surface p-12 lg:flex"
      >
        <BrandPanel />
      </div>

      {/* RIGHT — Login form */}
      <main className="flex w-full flex-col items-center justify-center px-6 py-12 lg:w-1/2">
        <div className="w-full max-w-sm">
          {/* Wordmark */}
          <div className="mb-10 flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <BrandMark />
            </span>
            <span className="text-lg font-semibold tracking-tight text-foreground">
              Face Attendance
            </span>
          </div>

          <div className="flex flex-col gap-2">
            <h1 className="text-[28px] leading-[36px] font-semibold tracking-tight text-foreground">
              Welcome back
            </h1>
            <p className="text-sm leading-[21px] text-muted-foreground">
              Sign in with your Google account to access your dashboard.
            </p>
          </div>

          <div className="mt-8">
            <GoogleSignInButton callbackURL="/dashboard" />
          </div>

          <p className="mt-6 text-center text-xs leading-[18px] text-muted-foreground">
            By continuing, you agree that this application stores basic
            identity information for attendance purposes. We only access
            your name, email, and profile picture from Google.
          </p>
        </div>
      </main>
    </div>
  );
}

function BrandPanel() {
  return (
    <div className="flex max-w-80 flex-col items-center gap-8 text-center">
      {/* Geometric brand mark */}
      <div className="relative flex h-20 w-20 items-center justify-center rounded-2xl border border-border bg-surface shadow-sm">
        <BrandMark size={40} />
        {/* Subtle attendance grid */}
        <svg
          className="absolute inset-0 -z-10 opacity-20"
          width="80"
          height="80"
          viewBox="0 0 80 80"
          fill="none"
          aria-hidden="true"
        >
          <rect x="1" y="1" width="78" height="78" rx="12" stroke="currentColor" strokeWidth="1.5" strokeDasharray="4 4" />
          <circle cx="40" cy="40" r="16" stroke="currentColor" strokeWidth="1.5" />
          <line x1="40" y1="24" x2="40" y2="8" stroke="currentColor" strokeWidth="1.5" />
          <line x1="40" y1="56" x2="40" y2="72" stroke="currentColor" strokeWidth="1.5" />
          <line x1="24" y1="40" x2="8" y2="40" stroke="currentColor" strokeWidth="1.5" />
          <line x1="56" y1="40" x2="72" y2="40" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      </div>

      <div className="flex flex-col gap-3">
        <h2 className="text-[22px] leading-[30px] font-semibold tracking-tight text-foreground">
          Face Attendance
        </h2>
        <p className="text-sm leading-[21px] text-muted-foreground">
          Attendance powered by facial recognition. Join a class, and your
          presence is confirmed automatically — no manual roll calls.
        </p>
      </div>

      <div className="grid w-full grid-cols-3 gap-4 text-center">
        <FeaturePill icon={<CheckIcon />} label="Automatic" />
        <FeaturePill icon={<CheckIcon />} label="Private" />
        <FeaturePill icon={<CheckIcon />} label="Fast" />
      </div>
    </div>
  );
}

function FeaturePill({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-2.5">
      <span className="text-muted-foreground" aria-hidden="true">
        {icon}
      </span>
      <span className="text-[11px] font-medium text-foreground">{label}</span>
    </div>
  );
}

function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      width={size}
      height={size}
    >
      <path
        d="M4 8.5C4 6.01 6.01 4 8.5 4H10v3H8.5A1.5 1.5 0 0 0 7 8.5V10H4V8.5Z"
        fill="currentColor"
      />
      <path
        d="M20 8.5V10h-3V8.5A1.5 1.5 0 0 0 15.5 7H14V4h1.5C17.99 4 20 6.01 20 8.5Z"
        fill="currentColor"
      />
      <path
        d="M15.5 20H14v-3h1.5a1.5 1.5 0 0 0 1.5-1.5V14h3v1.5c0 2.49-2.01 4.5-4.5 4.5Z"
        fill="currentColor"
      />
      <path
        d="M4 14h3v1.5A1.5 1.5 0 0 0 8.5 17H10v3H8.5C6.01 20 4 17.99 4 15.5V14Z"
        fill="currentColor"
      />
      <circle cx="12" cy="11.5" r="2.25" fill="currentColor" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}
