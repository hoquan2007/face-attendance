import Link from "next/link";

export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-3xl flex-col gap-8 px-6 py-16">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium uppercase tracking-widest text-slate-500">
          Phase 1 — Better Auth + Google OAuth
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">Face Attendance System</h1>
        <p className="text-base text-slate-600 dark:text-slate-300">
          Authentication is live. Sign in with Google to access your dashboard.
        </p>
      </header>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-lg font-semibold">Get started</h2>
        <div className="mt-3 flex gap-3 text-sm">
          <Link
            href="/login"
            className="inline-flex items-center justify-center rounded-md bg-slate-900 px-4 py-2 font-medium text-white shadow-sm transition hover:bg-slate-700 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
          >
            Sign in with Google
          </Link>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
        <h2 className="text-lg font-semibold">Phase plan</h2>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-slate-700 dark:text-slate-300">
          <li>Phase 0 — repository skeleton</li>
          <li>Phase 0.5 — dependency modernization</li>
          <li>Phase 0.6 — Vercel deployment readiness</li>
          <li>Phase 1 — Google OAuth + Better Auth (current)</li>
          <li>Phase 2 — profile onboarding</li>
          <li>Phase 3 — FastAPI + InsightFace Face Service</li>
          <li>Phase 4 — face enrollment</li>
          <li>Phase 5 — classrooms</li>
          <li>Phase 6 — attendance sessions</li>
          <li>Phase 7 — multi-face recognition + temporal confirmation</li>
          <li>Phase 8 — history + Excel export</li>
          <li>Phase 9 — liveness / anti-spoofing</li>
          <li>Phase 10 — testing, calibration, hardening</li>
        </ol>
      </section>

      <footer className="flex gap-4 text-sm text-slate-600 dark:text-slate-400">
        <Link className="underline hover:text-slate-900 dark:hover:text-white" href="/docs/architecture.md">
          Architecture
        </Link>
        <Link className="underline hover:text-slate-900 dark:hover:text-white" href="/docs/privacy-security.md">
          Privacy &amp; security
        </Link>
        <Link className="underline hover:text-slate-900 dark:hover:text-white" href="/docs/model-license.md">
          Model license
        </Link>
      </footer>
    </main>
  );
}