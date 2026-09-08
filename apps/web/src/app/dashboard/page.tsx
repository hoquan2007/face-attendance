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
 * No fake attendance numbers or classroom statistics. Empty-state cards
 * are role-aware but explicitly empty.
 */

import Link from "next/link";
import { redirect } from "next/navigation";

import { CalendarCheck2, ScanFace } from "lucide-react";

import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import { decideProtected } from "@/lib/route-guards";
import { PageContainer } from "@/components/layout/PageContainer";
import { PageHeader } from "@/components/layout/PageHeader";
import { EmptyState } from "@/components/layout/EmptyState";
import { StatusBadge } from "@/components/layout/StatusBadge";
import { Card, CardContent, CardSection } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";

export const metadata = {
  title: "Dashboard",
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
  const isTeacher = p.role === "teacher";

  return (
    <PageContainer size="default">
      {/* Page header */}
      <PageHeader
        title={`Welcome back, ${p.fullName}`}
        description={user.email}
        as="h1"
      />

      <div className="mt-8 flex flex-col gap-5">
        {/* Profile summary card */}
        <Card>
          <CardSection className="flex flex-col gap-5 sm:flex-row sm:items-start">
            <Avatar
              src={user.image ?? undefined}
              name={p.fullName}
              alt={p.fullName}
              size="xl"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-base font-semibold text-foreground">
                  {p.fullName}
                </h2>
                <StatusBadge
                  tone="info"
                  label={isTeacher ? "Teacher" : "Student"}
                />
              </div>
              <dl className="flex flex-col gap-1 text-sm text-muted-foreground">
                <div className="flex items-center gap-2">
                  <dt className="w-32 shrink-0 text-muted-foreground">Email</dt>
                  <dd className="truncate text-foreground">{user.email}</dd>
                </div>
                <div className="flex items-center gap-2">
                  <dt className="w-32 shrink-0 text-muted-foreground">
                    Identification
                  </dt>
                  <dd className="truncate font-mono text-foreground">
                    {p.identificationCode}
                  </dd>
                </div>
                {p.phone ? (
                  <div className="flex items-center gap-2">
                    <dt className="w-32 shrink-0 text-muted-foreground">Phone</dt>
                    <dd className="truncate text-foreground">{p.phone}</dd>
                  </div>
                ) : null}
              </dl>
            </div>
            <div className="shrink-0">
              <Button variant="outline" size="sm" asChild>
                <Link href="/profile">Edit profile</Link>
              </Button>
            </div>
          </CardSection>
        </Card>

        {/* Classes / workspace card */}
        <Card>
          <CardSection>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <CalendarCheck2 className="h-[18px] w-[18px]" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  {isTeacher ? "Classes" : "My Classes"}
                </h2>
                <p className="text-sm text-muted-foreground">
                  {isTeacher
                    ? "You haven't created any classes yet."
                    : "You haven't joined any classes yet."}
                </p>
              </div>
            </div>
          </CardSection>
          <CardContent>
            <EmptyState
              title={
                isTeacher ? "No classes yet" : "No classes yet"
              }
              description={
                isTeacher
                  ? "Create your first class to start taking attendance."
                  : "Join a class using a class code shared by your teacher."
              }
              tone="muted"
            />
          </CardContent>
        </Card>

        {/* Face ID status card */}
        <Card>
          <CardSection>
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <ScanFace className="h-[18px] w-[18px]" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  Face ID
                </h2>
                <p className="text-sm text-muted-foreground">
                  Status:{" "}
                  <span className="font-medium text-muted-foreground">
                    Not configured
                  </span>
                </p>
              </div>
            </div>
          </CardSection>
          <CardContent>
            <p className="text-xs leading-[18px] text-muted-foreground">
              Face enrollment arrives in a later phase. No camera access is
              requested on this page.
            </p>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
