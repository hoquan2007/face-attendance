/**
 * `/face-id/setup` — Face ID enrollment shell.
 *
 * PHASE 4.5B4 — Progress + Recovery + Reload Resilience.
 *
 * Server Component.
 *
 * Guard chain:
 *   - no session               → redirect /login
 *   - profile incomplete       → redirect /onboarding
 *   - face profile configured  → redirect /face-id (replace mode not implemented)
 *   - otherwise                → render Capture/Submit panel + start action
 *
 * Important constraints:
 *   - This page does NOT auto-start enrollment.
 *   - This page does NOT auto-request camera permission.
 *   - The user must explicitly press "Start setup" or "Restart setup".
 *   - If an active enrollment session already exists, the page uses it
 *     directly without restarting.
 *   - If an enrollment session is expired, the page shows the Start
 *     action again.
 *
 * PHASE 4.5B4 adds server-authoritative progress and reconciliation:
 *   - Initial progress comes from the server-side status service.
 *   - On reload, the server page state determines the displayed count.
 *   - On conflict/expired/limit errors, the panel triggers a
 *     router.refresh() to reconcile with the server.
 *
 * Out of scope (deliberately deferred to later phases):
 *   - Finalization / FaceProfile creation
 *   - Re-enrollment / Face ID deletion
 *   - Liveness / anti-spoofing
 *   - Sample index bookkeeping in the browser
 */

import { redirect } from "next/navigation";

import {
  getFaceIdStatus,
  REQUIRED_SAMPLES,
} from "@/lib/biometrics/face-id-status-service";
import { PageContainer } from "@/components/layout/PageContainer";
import { PageHeader } from "@/components/layout/PageHeader";
import { StatusBadge } from "@/components/layout/StatusBadge";
import { Card, CardContent, CardSection } from "@/components/ui/card";
import { EnrollmentStartButton } from "@/components/face-id-pages/enrollment-start-button";
import { EnrollmentSamplePanelWrapper } from "@/components/face-id-pages/enrollment-sample-panel-wrapper";

export const metadata = {
  title: "Set up Face ID",
};

export default async function FaceIdSetupPage() {
  const result = await getFaceIdStatus();

  if (!result.isAuthenticated) {
    redirect("/login");
  }

  if (!result.isOnboardingComplete) {
    redirect("/onboarding");
  }

  const status = result.status!;

  // If Face ID is already configured, redirect to overview.
  // Replace mode is not implemented in PHASE 4.5B.
  if (status.configured) {
    redirect("/face-id");
  }

  const activeSession = status.enrollment.active
    ? {
        acceptedSamples: status.enrollment.acceptedSamples,
        requiredSamples:
          status.enrollment.requiredSamples || REQUIRED_SAMPLES,
        expiresAt: status.enrollment.expiresAt,
        generationId: status.enrollment.generationId,
      }
    : null;

  return (
    <PageContainer size="default">
      <PageHeader
        title="Set up Face ID"
        description="A few camera samples will create your encrypted biometric template."
        as="h1"
      />

      <div className="mt-8 flex flex-col gap-5">
        {/* Progress card */}
        <Card>
          <CardSection>
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge tone="info" label="Enrollment" />
            </div>
          </CardSection>
          <CardContent>
            {activeSession ? (
              <ActiveSessionProgress
                acceptedSamples={activeSession.acceptedSamples}
                requiredSamples={activeSession.requiredSamples}
                expiresAt={activeSession.expiresAt}
              />
            ) : (
              <InactiveSessionState />
            )}
          </CardContent>
        </Card>

        {/* Sample capture card — only shown when an active session exists. */}
        {activeSession ? (
          <Card>
            <CardSection>
              <h2 className="text-base font-semibold text-foreground">
                Camera setup
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Position your face in the frame, turn on the camera, and
                capture one sample at a time.
              </p>
            </CardSection>
            <CardContent>
              {/*
                EnrollmentSamplePanelWrapper encapsulates:
                  - router.refresh() for server reconciliation
                  - The EnrollmentSamplePanel component

                Initial progress comes from the server-side status service
                so the panel never fabricates counts.
              */}
              <EnrollmentSamplePanelWrapper
                initialAcceptedSamples={activeSession.acceptedSamples}
                requiredSamples={activeSession.requiredSamples}
                expiresAt={activeSession.expiresAt}
                generationId={activeSession.generationId}
              />
            </CardContent>
          </Card>
        ) : null}

        {/* Privacy acknowledgement card */}
        <Card>
          <CardSection>
            <h2 className="text-base font-semibold text-foreground">
              How Face ID works
            </h2>
          </CardSection>
          <CardContent>
            <p className="text-sm leading-[21px] text-muted-foreground">
              Face setup will use several camera samples to create an
              encrypted biometric template.
            </p>
            <p className="mt-3 text-sm leading-[21px] text-muted-foreground">
              Each sample you choose to capture is sent securely to the
              application for face analysis. Raw camera images are not
              kept by the application.
            </p>
            <p className="mt-3 text-xs leading-[18px] text-muted-foreground">
              Liveness and anti-spoofing are not enabled in this preview.
            </p>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}

/**
 * Renders the "active session" progress block with sample counts and expiry.
 */
function ActiveSessionProgress({
  acceptedSamples,
  requiredSamples,
  expiresAt,
}: {
  acceptedSamples: number;
  requiredSamples: number;
  expiresAt: string | null;
}) {
  const expiryText = expiresAt ? formatExpiry(expiresAt) : null;
  return (
    <div className="flex flex-col gap-3">
      <p
        aria-live="polite"
        className="text-sm font-medium text-foreground"
      >
        {acceptedSamples} of {requiredSamples} samples
      </p>
      {expiryText ? (
        <p className="text-xs leading-[18px] text-muted-foreground">
          Session {expiryText}.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Renders the "no active session" block with the start action.
 */
function InactiveSessionState() {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-[21px] text-muted-foreground">
        Start the enrollment session when you&apos;re ready. Camera access
        is only requested after you turn it on.
      </p>
      <div>
        <EnrollmentStartButton label="Start setup" />
      </div>
    </div>
  );
}

/**
 * Formats an ISO expiry timestamp into a short human-readable string.
 */
function formatExpiry(iso: string): string {
  try {
    const date = new Date(iso);
    return `expires ${date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    })}`;
  } catch {
    return "will expire soon";
  }
}
