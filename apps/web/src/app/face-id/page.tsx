/**
 * `/face-id` — Face ID overview page.
 *
 * PHASE 4.5B1 — Face ID Page Shell.
 *
 * Server Component.
 *
 * Guard chain:
 *   - no session          → redirect /login
 *   - profile incomplete  → redirect /onboarding
 *   - otherwise           → render safe overview based on status
 *
 * Only safe information is displayed:
 *   - Whether Face ID is configured
 *   - If configured: enrolledAt + sampleCount
 *   - If an enrollment session is active: progress and expiry
 *
 * NEVER displayed:
 *   - Embeddings, ciphertext, IV, authTag
 *   - Model metadata (modelIdentity, modelName, embeddingDimension)
 *   - Quality summaries
 *   - Centroids
 *   - userId / email
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import { ScanFace } from "lucide-react";

import { getFaceIdStatus, REQUIRED_SAMPLES } from "@/lib/biometrics/face-id-status-service";
import { PageContainer } from "@/components/layout/PageContainer";
import { PageHeader } from "@/components/layout/PageHeader";
import { StatusBadge } from "@/components/layout/StatusBadge";
import { Card, CardContent, CardSection } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { EnrollmentStartButton } from "@/components/face-id-pages/enrollment-start-button";

export const metadata = {
  title: "Face ID",
};

/**
 * Formats a timestamp as a short, locale-friendly date.
 */
function formatEnrolledAt(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export default async function FaceIdPage() {
  const result = await getFaceIdStatus();

  if (!result.isAuthenticated) {
    redirect("/login");
  }

  if (!result.isOnboardingComplete) {
    redirect("/onboarding");
  }

  const status = result.status!;

  return (
    <PageContainer size="default">
      <PageHeader
        title="Face ID"
        description="Use face recognition for attendance after setup is complete."
        as="h1"
      />

      <div className="mt-8 flex flex-col gap-5">
        {/* Status Card */}
        <Card>
          <CardSection>
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <ScanFace className="h-5 w-5" aria-hidden="true" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  Face ID status
                </h2>
                <p className="text-sm text-muted-foreground">
                  Manage your face recognition enrollment.
                </p>
              </div>
            </div>
          </CardSection>

          <CardContent>
            {status.configured ? (
              <ConfiguredState
                enrolledAt={status.faceId!.enrolledAt}
                sampleCount={status.faceId!.sampleCount}
              />
            ) : status.enrollment.active ? (
              <InProgressState
                acceptedSamples={status.enrollment.acceptedSamples}
                requiredSamples={
                  status.enrollment.requiredSamples || REQUIRED_SAMPLES
                }
                expiresAt={status.enrollment.expiresAt!}
              />
            ) : (
              <NotConfiguredState />
            )}
          </CardContent>
        </Card>

        {/* Privacy note */}
        <Card>
          <CardSection>
            <h2 className="text-base font-semibold text-foreground">
              Privacy
            </h2>
          </CardSection>
          <CardContent>
            <p className="text-sm leading-[21px] text-muted-foreground">
              Face setup uses camera samples to create an encrypted biometric
              template. Raw camera images are not retained by the application.
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
 * State A: Not configured and no active enrollment.
 */
function NotConfiguredState() {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="pending" label="Not configured" />
      </div>
      <p className="text-sm leading-[21px] text-muted-foreground">
        Face ID hasn&apos;t been set up yet. Set it up to enable face
        recognition for attendance.
      </p>
      <div className="flex flex-wrap gap-2">
        <EnrollmentStartButton label="Set up Face ID" />
      </div>
    </div>
  );
}

/**
 * State B: Enrollment is in progress.
 */
function InProgressState({
  acceptedSamples,
  requiredSamples,
  expiresAt,
}: {
  acceptedSamples: number;
  requiredSamples: number;
  expiresAt: string;
}) {
  const expiryText = formatExpiry(expiresAt);
  const isComplete = acceptedSamples >= requiredSamples;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge
          tone={isComplete ? "success" : "info"}
          label={isComplete ? "Setup complete" : "Setup in progress"}
        />
      </div>
      <p className="text-sm leading-[21px] text-muted-foreground">
        {acceptedSamples} of {requiredSamples} samples collected.
        {isComplete
          ? " Final setup has not been completed yet."
          : ""}
      </p>
      <p className="text-xs leading-[18px] text-muted-foreground">
        Session {expiryText}.
        {isComplete
          ? " Start final setup to activate Face ID."
          : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button asChild>
          <Link href="/face-id/setup">Continue setup</Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * State C: Configured.
 */
function ConfiguredState({
  enrolledAt,
  sampleCount,
}: {
  enrolledAt: string;
  sampleCount: number;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone="success" label="Configured" />
      </div>
      <dl className="flex flex-col gap-3 text-sm">
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">Enrolled</dt>
          <dd className="font-medium text-foreground">
            {formatEnrolledAt(enrolledAt)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-3">
          <dt className="text-muted-foreground">Sample count</dt>
          <dd className="font-medium text-foreground">{sampleCount}</dd>
        </div>
      </dl>
      <p className="text-xs leading-[18px] text-muted-foreground">
        Face ID is set up.
      </p>
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
