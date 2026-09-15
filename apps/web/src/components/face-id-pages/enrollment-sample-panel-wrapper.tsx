/**
 * `EnrollmentSamplePanelWrapper` — client-side wrapper that composes
 * the camera/sample panel and the PHASE 4.6B3B explicit
 * `Finish setup` action.
 *
 * PHASE 4.6B3B — Finish Setup UI.
 *
 * This wrapper exists for three reasons:
 *
 *   1. `EnrollmentSamplePanel` is a `"use client"` component and so
 *      is `EnrollmentFinishButton`. Both are composed here in a
 *      single client boundary.
 *
 *   2. `router.refresh()` / `router.replace()` require the
 *      `useRouter` hook from Next.js; Server Components cannot use
 *      it directly.
 *
 *   3. The setup page renders both controls side-by-side once the
 *      enrollment is complete (5/5). Keeping the composition here
 *      avoids bloating `enrollment-sample-panel.tsx` (which is
 *      already large) and avoids putting a button + a server-action
 *      call into a Server Component.
 *
 * The wrapper does NOT:
 *   - Perform any camera operations
 *   - Handle any submission logic
 *   - Manage any state other than the router callbacks
 *   - Read or write `localStorage`, `sessionStorage`, or
 *     `IndexedDB`
 *
 * Out of scope (deliberately deferred to later phases):
 *   - Re-enrollment / Face ID delete
 *   - Liveness / anti-spoofing
 *   - Polling
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { EnrollmentSamplePanel } from "@/components/face-id-pages/enrollment-sample-panel";
import { EnrollmentFinishButton } from "@/components/face-id-pages/enrollment-finish-button";

export interface EnrollmentSamplePanelWrapperProps {
  /** Initial server-derived `acceptedSamples` count. */
  initialAcceptedSamples: number;
  /** Required sample count (typically 5). */
  requiredSamples: number;
  /**
   * Optional initial `complete` flag.
   */
  initialComplete?: boolean;
  /**
   * Optional session expiry timestamp from the server.
   */
  expiresAt?: string | null;
  /**
   * Stable server-generated UUID for the current enrollment generation.
   * Used as the primary multi-tab / reload-resilience discriminator.
   */
  generationId?: string | null;
  /**
   * Server-authoritative flag for whether the enrollment is in the
   * "complete" 5/5 state. The browser never fabricates this.
   */
  canFinish?: boolean;
  /**
   * Server-authoritative flag for whether a durable `FaceProfile`
   * already exists. When `true`, the Finish setup button is hidden.
   */
  faceProfileConfigured?: boolean;
  /** Optional className for the outer wrapper. */
  className?: string;
  /**
   * Test seam — override the global fetch. Production callers leave
   * this undefined.
   */
  fetchImpl?: typeof fetch;
  /**
   * Test seam — override `captureVideoFrame`.
   */
  captureImpl?: Parameters<typeof EnrollmentSamplePanel>[0]["captureImpl"];
}

/**
 * Client wrapper that composes the sample panel and the explicit
 * Finish setup action.
 *
 * When the panel detects a state that requires server reconciliation
 * (conflict, limit reached, expired, not started, network uncertainty),
 * it calls `onReconcile`, which triggers `router.refresh()` to fetch
 * the latest server state.
 *
 * After refresh, the component receives new props from the server
 * and reconciles its local state accordingly. The Finish setup button
 * is re-evaluated on every render against `canFinish` /
 * `faceProfileConfigured`.
 */
export function EnrollmentSamplePanelWrapper({
  initialAcceptedSamples,
  requiredSamples,
  initialComplete = false,
  expiresAt,
  generationId,
  canFinish = false,
  faceProfileConfigured = false,
  className,
  fetchImpl,
  captureImpl,
}: EnrollmentSamplePanelWrapperProps) {
  const router = useRouter();

  /**
   * Called when the panel detects a reconciliation-required error.
   * Triggers a server-side state refresh.
   *
   * The router.refresh() causes Next.js to re-render this Server
   * Component (and its parent), fetching fresh status from the
   * database. The refreshed page will have updated `initialAcceptedSamples`,
   * `requiredSamples`, and `initialComplete` props.
   */
  const handleReconcile = React.useCallback((): void => {
    router.refresh();
  }, [router]);

  return (
    <div className={className}>
      <EnrollmentSamplePanel
        initialAcceptedSamples={initialAcceptedSamples}
        requiredSamples={requiredSamples}
        initialComplete={initialComplete}
        expiresAt={expiresAt}
        generationId={generationId}
        onReconcile={handleReconcile}
        fetchImpl={fetchImpl}
        captureImpl={captureImpl}
      />

      {/*
        Finish setup — PHASE 4.6B3B. The button receives only the
        server-derived flags it needs. It does NOT receive userId,
        generationId, claimToken, centroid, samples, or any model
        metadata. Visibility is server-authoritative: the button is
        only rendered when `canFinish === true` AND
        `faceProfileConfigured === false`. The component itself
        never invokes `finishFaceEnrollment()` automatically.
      */}
      <div className="mt-3">
        <EnrollmentFinishButton
          canFinish={canFinish}
          faceProfileConfigured={faceProfileConfigured}
        />
      </div>
    </div>
  );
}