/**
 * `EnrollmentSamplePanelWrapper` — client-side wrapper that provides
 * the reconciliation callback for `EnrollmentSamplePanel`.
 *
 * PHASE 4.5B4 — Progress + Recovery + Reload Resilience.
 *
 * This component exists because:
 *   1. `EnrollmentSamplePanel` is a "use client" component
 *   2. `router.refresh()` requires the `useRouter` hook from Next.js
 *   3. Server Components cannot use `useRouter` directly
 *
 * The wrapper:
 *   - Renders `EnrollmentSamplePanel` with the `onReconcile` prop
 *   - Calls `router.refresh()` when reconciliation is needed
 *   - Is itself a "use client" component so it can use the router
 *
 * The wrapper does NOT:
 *   - Perform any camera operations
 *   - Handle any submission logic
 *   - Manage any state other than the reconciliation callback
 *
 * Out of scope (deliberately deferred to later phases):
 *   - Finalization / FaceProfile creation
 *   - Re-enrollment / Face ID deletion
 *   - Liveness / anti-spoofing
 *   - Polling
 *   - localStorage/sessionStorage/IndexedDB persistence
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { EnrollmentSamplePanel } from "@/components/face-id-pages/enrollment-sample-panel";

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
 * Client wrapper that provides `router.refresh()` for server reconciliation.
 *
 * When the panel detects a state that requires server reconciliation
 * (conflict, limit reached, expired, not started, network uncertainty),
 * it calls `onReconcile`, which triggers `router.refresh()` to fetch
 * the latest server state.
 *
 * After refresh, the component receives new props from the server
 * and reconciles its local state accordingly.
 */
export function EnrollmentSamplePanelWrapper({
  initialAcceptedSamples,
  requiredSamples,
  initialComplete = false,
  expiresAt,
  generationId,
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
    <EnrollmentSamplePanel
      initialAcceptedSamples={initialAcceptedSamples}
      requiredSamples={requiredSamples}
      initialComplete={initialComplete}
      expiresAt={expiresAt}
      generationId={generationId}
      onReconcile={handleReconcile}
      className={className}
      fetchImpl={fetchImpl}
      captureImpl={captureImpl}
    />
  );
}
