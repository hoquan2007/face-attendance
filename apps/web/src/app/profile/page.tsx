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
import { PageContainer } from "@/components/layout/PageContainer";
import { PageHeader } from "@/components/layout/PageHeader";
import { ScanFace } from "lucide-react";
import { Card, CardContent, CardSection } from "@/components/ui/card";

export const metadata = {
  title: "Profile",
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
    <PageContainer size="narrow">
      <PageHeader
        title="Your profile"
        description="Manage your personal information."
        as="h1"
      />

      <div className="mt-6 flex flex-col gap-5">
        {/* Edit form */}
        <Card>
          <CardSection>
            <h2 className="text-base font-semibold text-foreground">
              General information
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Update your name, identification code, and phone.
            </p>
          </CardSection>
          <CardContent>
            <ProfileEditForm
              email={user.email}
              fullName={p.fullName}
              role={p.role}
              identificationCode={p.identificationCode}
              phone={p.phone ?? null}
              avatarUrl={user.image}
            />
          </CardContent>
        </Card>

        {/* Account info */}
        <Card>
          <CardSection>
            <h2 className="text-base font-semibold text-foreground">
              Account
            </h2>
          </CardSection>
          <CardContent>
            <dl className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <dt className="text-sm text-muted-foreground">Sign-in method</dt>
                <dd className="text-sm font-medium text-foreground">Google</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-sm text-muted-foreground">Role</dt>
                <dd className="text-sm font-medium text-foreground capitalize">
                  {p.role}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-sm text-muted-foreground">Identification code</dt>
                <dd className="font-mono text-sm text-foreground">
                  {p.identificationCode}
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-xs leading-[18px] text-muted-foreground">
              Your role is set during onboarding and cannot be changed here.
              Your Google account is used for authentication.
            </p>
          </CardContent>
        </Card>

        {/* Face ID */}
        <Card>
          <CardSection>
            <h2 className="text-base font-semibold text-foreground">
              Face ID
            </h2>
          </CardSection>
          <CardContent>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-dashed border-border bg-muted text-muted-foreground">
                <ScanFace className="h-5 w-5" aria-hidden="true" />
              </div>
              <div className="flex flex-col gap-0.5">
                <p className="text-sm font-medium text-foreground">Not configured</p>
                <p className="text-xs text-muted-foreground">
                  Face enrollment arrives in a later phase.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
