/**
 * Root landing page.
 *
 * Phase 2 update: when the user is authenticated but has not yet
 * completed onboarding, send them straight to `/onboarding` to avoid
 * the "logged-in but stuck on landing" dead-end.
 *
 *   - Not authenticated                -> render landing page.
 *   - Authenticated + incomplete       -> redirect /onboarding
 *   - Authenticated + complete       -> redirect /dashboard
 */

import Link from "next/link";
import { redirect } from "next/navigation";

import { getSession } from "@/lib/session";
import { isOnboardingComplete } from "@/lib/profile-service";
import { decideRoot } from "@/lib/route-guards";
import { Button } from "@/components/ui/button";

export const metadata = {
  title: "Face Attendance",
};

export default async function HomePage() {
  const session = await getSession();
  let onboardingCompleteFlag: boolean = false;
  if (session !== null) {
    const profileStatus: Promise<boolean> = isOnboardingComplete(session.user.id);
    onboardingCompleteFlag = await profileStatus;
  }

  const decision = decideRoot({
    isAuthenticated: session !== null,
    isOnboardingComplete: onboardingCompleteFlag,
  });

  if (decision.redirectTo) {
    redirect(decision.redirectTo);
  }

  return (
    <div className="flex min-h-screen flex-col">
      {/* Top bar */}
      <header className="flex h-14 items-center justify-between border-b border-border px-6 lg:px-8">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground"
          >
            <BrandMark />
          </span>
          <span className="text-base font-semibold tracking-tight text-foreground">
            Face Attendance
          </span>
        </div>
        <Button variant="outline" size="sm" asChild>
          <Link href="/login">Sign in</Link>
        </Button>
      </header>

      {/* Hero */}
      <main className="flex flex-1 flex-col items-center justify-center px-6 py-20 text-center">
        <div className="max-w-xl">
          <p className="mb-4 text-sm font-medium uppercase tracking-widest text-primary">
            Phase 2 — Authentication &amp; profiles
          </p>
          <h1 className="text-[36px] leading-[44px] font-semibold tracking-tight text-foreground">
            Attendance, powered by facial recognition
          </h1>
          <p className="mt-4 text-base leading-[24px] text-muted-foreground">
            Join a class and your presence is confirmed automatically — no
            manual roll calls, no sign-in sheets. Teachers create sessions,
            students are recognized, attendance is recorded.
          </p>
          <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
            <Button size="lg" asChild>
              <Link href="/login">Get started</Link>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <Link href="/login">Sign in</Link>
            </Button>
          </div>
        </div>
      </main>

      {/* Feature strip */}
      <section className="border-t border-border bg-muted/40 px-6 py-10 lg:px-8">
        <div className="mx-auto grid max-w-3xl gap-8 sm:grid-cols-3">
          <Feature
            title="Automatic"
            description="Join a class once. Attendance is confirmed as you walk in."
          />
          <Feature
            title="Private"
            description="Your face is processed locally. Only a secure embedding is stored."
          />
          <Feature
            title="Fast"
            description="Multiple faces recognized in seconds. No queues, no waiting."
          />
        </div>
      </section>

      {/* Phase plan */}
      <section className="border-t border-border px-6 py-12 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <h2 className="text-[18px] font-semibold tracking-tight text-foreground">
            Phase plan
          </h2>
          <ol className="mt-4 list-decimal space-y-1.5 pl-5 text-sm text-muted-foreground">
            <li>
              <span className="text-foreground">Phase 0–0.6</span> — Repository, docs, deployment
            </li>
            <li>
              <span className="text-foreground">Phase 1</span> — Google OAuth + Better Auth
            </li>
            <li>
              <span className="text-foreground">Phase 2</span> — Profile onboarding &amp; role selection
            </li>
            <li>
              <span className="text-foreground">Phase 3</span> — FastAPI + InsightFace recognition service
            </li>
            <li>
              <span className="text-foreground">Phase 4</span> — Face enrollment
            </li>
            <li>
              <span className="text-foreground">Phase 5</span> — Classroom creation and join-by-code
            </li>
            <li>
              <span className="text-foreground">Phase 6</span> — Attendance session lifecycle
            </li>
            <li>
              <span className="text-foreground">Phase 7</span> — Multi-face recognition + temporal confirmation
            </li>
            <li>
              <span className="text-foreground">Phase 8</span> — History + Excel export
            </li>
            <li>
              <span className="text-foreground">Phase 9</span> — Liveness / anti-spoofing
            </li>
            <li>
              <span className="text-foreground">Phase 10</span> — Testing, calibration, hardening
            </li>
          </ol>
        </div>
      </section>

      <footer className="border-t border-border px-6 py-6 lg:px-8">
        <div className="mx-auto flex max-w-3xl flex-wrap gap-x-6 gap-y-2 text-xs text-muted-foreground">
          <Link href="/docs/architecture.md" className="underline hover:text-foreground">
            Architecture
          </Link>
          <Link href="/docs/privacy-security.md" className="underline hover:text-foreground">
            Privacy &amp; security
          </Link>
          <Link href="/docs/model-license.md" className="underline hover:text-foreground">
            Model license
          </Link>
        </div>
      </footer>
    </div>
  );
}

function Feature({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="flex flex-col gap-1.5 text-center">
      <h3 className="text-sm font-semibold text-foreground">{title}</h3>
      <p className="text-sm leading-[21px] text-muted-foreground">{description}</p>
    </div>
  );
}

function BrandMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="h-4 w-4"
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
