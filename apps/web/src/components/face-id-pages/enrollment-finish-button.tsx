/**
 * `EnrollmentFinishButton` — explicit "Finish setup" Client Component
 * for PHASE 4.6B3B.
 *
 * Finalizes the temporary Face ID enrollment session into a durable
 * `FaceProfile` by calling the PHASE 4.6B3A
 * `finishFaceEnrollment()` Server Action. The button is the ONLY
 * browser-side trigger: it never auto-runs from a useEffect, route
 * refresh, progress update, or camera callback.
 *
 * Visibility contract:
 *   - Renders ONLY when:
 *       - `canFinish === true` (server-authoritative progress + state)
 *       - `faceProfileConfigured === false`
 *         (a durable profile already in place hides the button)
 *   - Hidden otherwise.
 *
 * Action contract:
 *   - Calls `finishFaceEnrollment()` with ZERO arguments.
 *   - Uses a synchronous `finishInFlightRef` guard so two rapid
 *     clicks collapse into exactly ONE Server Action invocation.
 *   - On success: navigates to `/face-id` via `router.replace(...)`
 *     so the Back button cannot return the user to the completion
 *     screen. No biometric data is written into the URL.
 *   - On error: surfaces the safe `code` / `message` / `retryable`
 *     from B3A. Does NOT auto-retry. Does NOT navigate away for
 *     retryable errors.
 *   - Reconciliation (expired / generation-changed / not-found /
 *     incomplete) is performed through a React `useTransition`
 *     so the guard observes the true → false lifecycle of
 *     `isRefreshPending` and only frees when the refreshed Server
 *     Component tree has actually committed back to the client.
 *
 * Next.js refresh-transition guard (PHASE 4.6B3B.2 + 4.6B3B.3):
 *   - The installed `AppRouterInstance.refresh()` returns `void`,
 *     not a Promise. Awaiting it does NOT provide a reliable
 *     completion boundary.
 *   - We therefore drive reconciliation inside `useTransition()`:
 *       const [isRefreshPending, startRefreshTransition] =
 *         useTransition();
 *   - The `startRefreshTransition(() => { router.refresh(); })`
 *     call sets `isRefreshPending` to `true` for the duration of
 *     the Server Component re-render, then back to `false`.
 *   - We track this `false → true → false` transition through
 *     `observedRefreshPendingRef` and only release the in-flight
 *     guard (and `pending` state) after a genuine
 *     `isRefreshPending === true` has been observed and resolved.
 *   - PHASE 4.6B3B.3 removed the prior `queueMicrotask` fallback.
 *     No `setTimeout`, `requestAnimationFrame`, `Promise.resolve`,
 *     polling, or other timing heuristic may decide that
 *     `router.refresh()` has completed. A microtask is NOT a real
 *     Next.js refresh completion signal — releasing the guard on a
 *     microtask could free `finishInFlightRef` / `pending` /
 *     `reconciling` BEFORE the refreshed Server Component payload
 *     has actually reconciled.
 *   - If the refreshed Server Component tree removes/unmounts this
 *     button (e.g. the user is now configured), the cleanup is
 *     harmless because the unmounted instance no longer has a
 *     user-visible UI to mutate.
 *   - Normal retryable errors (FACE_SERVICE_TIMEOUT etc.) still
 *     release the guard synchronously so a later EXPLICIT retry
 *     can run. No automatic retry. No timeout. No polling.
 *
 * Privacy contract:
 *   - This component receives NO `userId`, `generationId`,
 *     `claimToken`, `centroid`, sample array, or model identity.
 *   - It never reads or writes `localStorage`, `sessionStorage`,
 *     `IndexedDB`, or the `Cache` API.
 *   - It never issues `fetch()` to the Face Service.
 *   - It never restarts the camera, requests `getUserMedia`, or
 *     captures another frame.
 */

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  finishFaceEnrollment,
  FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES,
  type FaceEnrollmentCompletionActionResult,
} from "@/lib/biometrics/enrollment-completion-action";

// =============================================================================
// Public props
// =============================================================================

export interface EnrollmentFinishButtonProps {
  /**
   * Server-authoritative visibility gate. The button is rendered
   * ONLY when `canFinish` is `true` AND `faceProfileConfigured` is
   * `false`. The server is the source of truth — the browser never
   * fabricates a "ready" state.
   */
  canFinish: boolean;
  /**
   * Whether a durable `FaceProfile` already exists for this user.
   * When `true`, the Finish setup button is hidden (the user must
   * not re-finalise an already-configured account).
   */
  faceProfileConfigured: boolean;
  /**
   * Optional className for the outer wrapper.
   */
  className?: string;
}

// =============================================================================
// Internal error mapping
// =============================================================================

/**
 * Maps a B3A safe error code into a human-readable, restrained
 * heading / body pair. The mapping never references internal
 * thresholds, model identifiers, or service URLs.
 *
 * A small set of codes can trigger a one-shot `router.refresh()`
 * reconciliation so the server-rendered setup shell re-renders
 * authoritative state. The reconciliation runs inside a React
 * transition so the browser can observe the true → false lifecycle
 * of `isRefreshPending` before releasing the in-flight guard.
 */
function classifyFinishError(code: string): {
  heading: string;
  body: string;
  /** Whether a transition-wrapped `router.refresh()` is appropriate. */
  reconcile: boolean;
  /** Whether the user is kept on the 5/5 setup state (retryable). */
  retryable: boolean;
} {
  switch (code) {
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.UNAUTHENTICATED:
      return {
        heading: "Sign-in required",
        body: "Please sign in again.",
        reconcile: false,
        retryable: false,
      };
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.PROFILE_INCOMPLETE:
      return {
        heading: "Complete your profile",
        body: "Complete your profile before finishing Face ID setup.",
        reconcile: false,
        retryable: false,
      };
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.ENROLLMENT_SESSION_NOT_FOUND:
      return {
        heading: "Setup session not found",
        body: "Start Face ID setup again to continue.",
        reconcile: true,
        retryable: false,
      };
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.ENROLLMENT_SESSION_EXPIRED:
      return {
        heading: "Setup session expired",
        body: "This setup session expired. Start setup again to continue.",
        reconcile: true,
        retryable: false,
      };
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.ENROLLMENT_INCOMPLETE:
      return {
        heading: "More samples needed",
        body: "Collect all required face samples before finishing setup.",
        reconcile: true,
        retryable: false,
      };
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.INCONSISTENT_FACE_SAMPLES:
      return {
        heading: "Samples were not consistent enough",
        body: "Start setup again and capture new samples.",
        reconcile: false,
        retryable: false,
      };
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.MODEL_MISMATCH:
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.ENROLLMENT_SAMPLE_DECRYPTION_FAILED:
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.ENROLLMENT_SAMPLE_VECTOR_INVALID:
      return {
        heading: "Setup session invalid",
        body: "This setup session can no longer be completed. Start setup again.",
        reconcile: false,
        retryable: false,
      };
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.ENROLLMENT_GENERATION_CHANGED:
      return {
        heading: "Setup session changed",
        body: "This setup session was changed in another tab. The page will refresh.",
        reconcile: true,
        retryable: false,
      };
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.ENROLLMENT_FINALIZATION_ALREADY_CLAIMED:
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.ENROLLMENT_FINALIZATION_IN_PROGRESS:
      return {
        heading: "Already finishing setup",
        body: "Face setup is already being finished. Please wait a moment and try again.",
        reconcile: false,
        retryable: true,
      };
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.FACE_PROFILE_ALREADY_EXISTS:
      return {
        heading: "Already configured",
        body: "Face ID is already configured for your account.",
        reconcile: false,
        retryable: false,
      };
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.FACE_SERVICE_TIMEOUT:
      return {
        heading: "Face processing timed out",
        body: "Face processing is temporarily unavailable. Try again in a moment.",
        reconcile: false,
        retryable: true,
      };
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.FACE_SERVICE_UNAVAILABLE:
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.FACE_SERVICE_UNAUTHORIZED:
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE:
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.BIOMETRIC_ENCRYPTION_UNAVAILABLE:
    case FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.ENROLLMENT_COMPLETION_FAILED:
      return {
        heading: "Face processing unavailable",
        body: "Face processing is temporarily unavailable. Try again later.",
        reconcile: false,
        retryable: true,
      };
    default:
      return {
        heading: "Face setup could not be finished",
        body: "Please try again later.",
        reconcile: false,
        retryable: false,
      };
  }
}

// =============================================================================
// Component
// =============================================================================

/**
 * "Finish setup" button — explicit client trigger for the B3A
 * completion Server Action.
 *
 * Render this component BELOW the camera/sample panel. The
 * server-derived props determine visibility — the component itself
 * never auto-runs the action and never observes biometric state.
 */
export function EnrollmentFinishButton({
  canFinish,
  faceProfileConfigured,
  className,
}: EnrollmentFinishButtonProps) {
  const router = useRouter();

  // Local UI state. The button is the ONLY trigger for the action.
  const [pending, setPending] = React.useState<boolean>(false);
  const [error, setError] = React.useState<
    | {
        heading: string;
        body: string;
        code: string;
        retryable: boolean;
        reconcile: boolean;
      }
    | null
  >(null);

  // React transition that wraps the router.refresh() reconciliation.
  // `router.refresh()` in Next.js 16.3.4 returns `void`, not a
  // Promise, so we cannot `await` it. The transition exposes
  // `isRefreshPending` which goes `false → true → false` across the
  // reconciliation lifecycle.
  const [isRefreshPending, startRefreshTransition] = React.useTransition();

  // True while the button is in the middle of a transition-wrapped
  // reconciliation. This is exposed to the render path so the
  // button can stay disabled even after the synchronous action
  // result has been processed.
  const [reconciling, setReconciling] = React.useState<boolean>(false);

  // Synchronous in-flight guard. React's `pending` state alone does
  // NOT block two clicks that land in the same React dispatch tick.
  // We must inspect / set this ref BEFORE the first `await` so the
  // second click observes the guard immediately.
  const finishInFlightRef = React.useRef<boolean>(false);

  // Tracks whether the current reconciliation transition has been
  // observed pending (i.e. `isRefreshPending` has gone from `false`
  // to `true`). We MUST NOT release the guard merely because
  // `isRefreshPending` is initially `false` — at the moment of
  // scheduling, React may not have flipped it yet. We require the
  // transition to be observably started before we will accept its
  // completion.
  const observedRefreshPendingRef = React.useRef<boolean>(false);

  // Reconciliation latch: at most ONE router.refresh() per visible
  // error. After refresh, the server either routes the user to a
  // valid state (configured / restart) or shows the button again.
  const refreshedForErrorRef = React.useRef<string | null>(null);

  // Observe `isRefreshPending` rising and falling. We only release
  // the in-flight guard after we have seen `true` (the transition
  // is genuinely in flight) and then `false` again (the transition
  // has committed). This survives the case where React schedules
  // the transition and immediately marks it pending, or where the
  // component unmounts before the transition starts.
  //
  // PHASE 4.6B3B.3 — NO TIMING FALLBACK:
  //   We deliberately do NOT use queueMicrotask / setTimeout /
  //   Promise.resolve / polling to release the guard. A microtask
  //   is NOT a real Next.js refresh completion signal — it could
  //   release the in-flight guard BEFORE the refreshed Server
  //   Component payload has actually reconciled. The guard is
  //   released only on the genuine false → true → false lifecycle
  //   of `isRefreshPending`. If the refreshed Server Component
  //   tree removes/unmounts this button, the cleanup is harmless
  //   because the unmounted instance has no UI to mutate.
  React.useEffect(() => {
    if (isRefreshPending) {
      // We have observed the transition actually starting. Mark
      // the latch so the next false will release the guard.
      observedRefreshPendingRef.current = true;
      return;
    }
    // Transition went back to false. Only release if we previously
      // observed a true (latch) and we are still reconciling /
      // guarded. An initial false must NEVER release the guard.
    if (
      observedRefreshPendingRef.current &&
      reconciling &&
      finishInFlightRef.current
    ) {
      observedRefreshPendingRef.current = false;
      finishInFlightRef.current = false;
      setPending(false);
      setReconciling(false);
    }
  }, [isRefreshPending, reconciling]);

  // Guard variables are captured in the handler closure. The
  // synchronous guard is `finishInFlightRef.current` — this ref is
  // always current and never stale, unlike React state. We also
  // check `reconciling` to block clicks while the transition
  // guard is active. We deliberately do NOT check `pending` here
  // because useCallback captures `pending` as a stale closure value
  // after the first render; relying on it would allow a second
  // click to bypass the guard before React commits the re-render.
  const handleClick = React.useCallback(async (): Promise<void> => {
    // Synchronous guard — must run BEFORE any await.
    if (finishInFlightRef.current) return;
    if (reconciling) return;
    finishInFlightRef.current = true;
    setPending(true);
    setError(null);

    let result: FaceEnrollmentCompletionActionResult;
    try {
      // ZERO-ARGUMENT Server Action. No userId, generationId,
      // claimToken, sample count, or model metadata is forwarded.
      result = await finishFaceEnrollment();
    } catch {
      // Defensive: any uncaught throw is rendered as a generic,
      // safe completion failure. Never leak the raw error.
      finishInFlightRef.current = false;
      setPending(false);
      setError({
        heading: "Face setup could not be finished",
        body: "Please try again later.",
        code: "ENROLLMENT_COMPLETION_FAILED",
        retryable: true,
        reconcile: false,
      });
      return;
    }

    if (result.ok) {
      // SUCCESS. No biometric fields are rendered. No local
      // persistence. Navigate to /face-id using replace so Back
      // does not return to the completion screen. The URL never
      // receives biometric values.
      finishInFlightRef.current = false;
      // We deliberately leave `pending` true during navigation so
      // a stray click cannot start a duplicate in-flight call while
      // the router transition is in flight.
      router.replace("/face-id");
      return;
    }

    // FAILURE. Map the safe B3A code into UI copy.
    const mapped = classifyFinishError(result.code);
    const errorView = {
      heading: mapped.heading,
      body: mapped.body,
      code: result.code,
      retryable: mapped.retryable,
      reconcile: mapped.reconcile,
    };
    setError(errorView);

    // One-shot reconciliation for states where the temporary session
    // is no longer actionable (expired / generation-changed /
    // not-found / incomplete). Refresh exactly once per visible
    // error code so the server-rendered setup shell can present a
    // valid next step. We never re-invoke the action here.
    //
    // PHASE 4.6B3B.2/3 — REAL Next.js refresh-transition guard:
    //   - `router.refresh()` returns `void` in Next.js 16.3.4.
    //     Awaiting it is a no-op and would release the guard
    //     synchronously, defeating the purpose of the guard.
    //   - Instead we wrap the call in a React transition via
    //     `useTransition()` and observe `isRefreshPending`
    //     through the effect above. The guard is released only
    //     after a genuine `false → true → false` transition has
    //     been observed.
    //   - PHASE 4.6B3B.3 removed the prior `queueMicrotask`
    //     fallback. No timing heuristic may decide that
    //     `router.refresh()` has completed.
    //   - We do NOT re-invoke the action here. We do NOT call
    //     `router.replace`. We do NOT mutate camera / sample
    //     state. The refreshed Server Component tree is the
    //     authoritative next state.
    if (mapped.reconcile && refreshedForErrorRef.current !== result.code) {
      refreshedForErrorRef.current = result.code;
      // Mark that we are now reconciling. The effect above will
      // observe `isRefreshPending` flipping to `true` and then
      // back to `false`, then release the guard.
      setReconciling(true);
      // Reset the "observed pending" latch for this transition.
      observedRefreshPendingRef.current = false;
      startRefreshTransition(() => {
        router.refresh();
      });
      // We deliberately do NOT release the synchronous guard here.
      // The effect will do so once the transition has actually
      // completed. If the refreshed Server Component tree
      // removes/unmounts this button, the cleanup is harmless.
      return;
    }

    // Release the guard so the user may retry explicitly when the
    // contract allows it. Normal retryable errors (e.g.
    // FACE_SERVICE_TIMEOUT) do NOT require router.refresh and
    // therefore release the guard synchronously.
    finishInFlightRef.current = false;
    setPending(false);
  }, [reconciling, router, startRefreshTransition]);

  // Visibility: never render the button when the server says
  // "not yet" OR when a durable profile is already in place.
  if (!canFinish) return null;
  if (faceProfileConfigured) return null;

  // The button stays disabled while either:
  //   - `pending` is true (the synchronous Server Action is running),
  //   - OR `isRefreshPending` is true (the transition-wrapped
  //     `router.refresh()` reconciliation is in flight).
  // The synchronous `finishInFlightRef` ALSO blocks clicks even if
  // a state update has not yet propagated through React.
  const buttonDisabled = pending || isRefreshPending || reconciling;

  return (
    <div
      data-component="enrollment-finish-button"
      data-reconciling={reconciling ? "true" : undefined}
      data-refresh-pending={isRefreshPending ? "true" : undefined}
      className={cn("flex flex-col gap-3", className)}
    >
      <Button
        type="button"
        variant="primary"
        onClick={handleClick}
        disabled={buttonDisabled}
        loading={pending || isRefreshPending || reconciling}
        aria-busy={
          pending || isRefreshPending || reconciling || undefined
        }
        aria-label={
          pending || isRefreshPending || reconciling
            ? "Finishing setup"
            : "Finish setup"
        }
      >
        {pending || isRefreshPending || reconciling
          ? "Finishing setup…"
          : "Finish setup"}
      </Button>

      {error ? (
        <div
          role="alert"
          aria-live={error.retryable ? "polite" : "assertive"}
          data-tone="warning"
          data-error-code={error.code}
          className={cn(
            "rounded-md border border-warning/30 bg-warning-soft",
            "px-3 py-2.5 text-sm text-warning",
          )}
        >
          <p className="font-medium">{error.heading}</p>
          <p className="mt-0.5">{error.body}</p>
        </div>
      ) : null}
    </div>
  );
}