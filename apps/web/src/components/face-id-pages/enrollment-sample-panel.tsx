/**
 * `EnrollmentSamplePanel` — capture + submit + quality feedback for
 * Face ID enrollment.
 *
 * PHASE 4.5B4 — Progress + Recovery + Reload Resilience.
 *
 * Architectural notes:
 *   - This component composes the SAME camera foundation as the
 *     existing `CameraPreview` (`useFaceCamera`). It does NOT introduce
 *     a second `getUserMedia` call.
 *   - It reuses the SAME `captureVideoFrame` utility that PHASE 4.5B2
 *     shipped. No second capture implementation.
 *   - It POSTs the JPEG `Blob` to the same Next.js sample endpoint
 *     that already exists. No direct Face Service access.
 *   - Server-authoritative progress: the component NEVER fabricates
 *     counts. All progress comes from server responses.
 *   - Conflict reconciliation: on ENROLLMENT_SAMPLE_CONFLICT, the
 *     component triggers server reconciliation via the provided
 *     `onReconcile` callback.
 *   - Reload resilience: initial progress is seeded from server props.
 *     On reload, the server page state determines the displayed count.
 *
 * Out of scope (deliberately deferred to later phases):
 *   - Finalization / FaceProfile creation
 *   - Re-enrollment / Face ID delete
 *   - Liveness / anti-spoofing
 *   - Automatic capture
 *   - Captured preview / object URL
 *   - Blob persistence in React state or storage
 *
 * Submission concurrency:
 *   - React's pending state is not enough to block two synchronous
 *     clicks. A `useRef` synchronous guard guarantees at most one
 *     capture/submission operation is active at any time.
 *
 * PHASE 4.5B4 Non-goals:
 *   - No biometric data fields (embedding, ciphertext, authTag, etc.)
 *   - No localStorage/sessionStorage/IndexedDB persistence
 *   - No polling
 *   - No automatic POST retry
 *   - No camera auto-restart after recovery
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { CAMERA_ERROR_MESSAGES } from "@/components/face-id/camera-constants";
import { cn } from "@/lib/utils";
import { useFaceCamera } from "@/components/face-id/use-face-camera";
import {
  captureVideoFrame,
  CAPTURE_ERROR_CODES,
  CAPTURE_ERROR_MESSAGES,
  type CaptureErrorShape,
} from "@/components/face-id/capture-video-frame";
import {
  QUALITY_REJECTION_CODES,
  SAMPLE_CLIENT_ERROR_CODES,
  requiresReconciliation,
  submitFaceEnrollmentSample,
  type QualityRejectionCode,
  type SampleProgress,
} from "@/components/face-id/enrollment-sample-client";

// =============================================================================
// Public types
// =============================================================================

export interface EnrollmentSamplePanelProps {
  /** Initial server-derived `acceptedSamples` count. */
  initialAcceptedSamples: number;
  /** Required sample count (typically 5). */
  requiredSamples: number;
  /**
   * Optional initial `complete` flag. The component always treats
   * the server response as authoritative; this is only used for the
   * very first render until a server response arrives.
   */
  initialComplete?: boolean;
  /**
   * Optional session expiry timestamp from the server. Used for
   * informational display only ("Session expires at [time]"); it is
   * NOT the multi-tab / reload-resilience primary discriminator.
   * The primary discriminator is `generationId` below.
   */
  expiresAt?: string | null;
  /**
   * Stable, server-generated UUID identifying the current
   * enrollment generation. The browser uses this as the primary
   * discriminator to detect that the server has emitted a freshly
   * created / reset enrollment session (e.g. multi-tab reset).
   *
   * When the value observed in a new render differs from the
   * previously-known value, the panel MUST yield to the server even
   * when the accepted-sample count decreases. The previous browser
   * progress belongs to the OLD session and must not leak into the
   * NEW one.
   *
   * `null` / `undefined` (no active generation) is a valid initial
   * state. Once the server assigns a generationId (via the start
   * action or the lazy backfill on a legacy session), subsequent
   * rerenders MUST observe that same identifier until the server
   * resets it.
   */
  generationId?: string | null;
  /**
   * Callback invoked when the component detects a state that requires
   * server-side reconciliation (conflict, limit reached, expired,
   * not started, model mismatch, network uncertainty).
   *
   * The parent page should call `router.refresh()` in response to
   * trigger a fresh server-render with authoritative progress.
   *
   * This callback is the B4 reconciliation seam — it replaces the
   * pattern of local state mutation after any error.
   *
   * Test seam: override this prop in unit tests.
   */
  onReconcile?: () => void;
  /** Optional override for the panel-level privacy note. */
  privacyNote?: string;
  /** Optional override for the camera-side privacy note. */
  cameraPrivacyNote?: string;
  /** Optional className for the outer wrapper. */
  className?: string;
  /**
   * Test seam — override the global fetch. Production callers leave
   * this undefined.
   */
  fetchImpl?: typeof fetch;
  /**
   * Test seam — override `captureVideoFrame`. Defaults to the
   * production PHASE 4.5B2 capture utility.
   */
  captureImpl?: typeof captureVideoFrame;
}

// =============================================================================
// Internal view model
// =============================================================================

/**
 * UI-level submission state. Kept separate from "submission result"
 * so the panel can distinguish "never submitted" from "submitting"
 * from "got a result".
 *
 * B4 additions:
 *   - `conflict` — another sample won the atomic race; reconcile
 *   - `limitReached` — 5/5 reached; reconcile
 *   - `expired` — session expired; reconcile and disable capture
 *   - `notStarted` — no active session; reconcile and disable capture
 *   - `modelMismatch` — session model incompatible; disable capture
 */
type PanelStatus =
  | "idle"
  | "submitting"
  | "accepted"
  | "rejected"
  | "complete"
  | "conflict"
  | "limitReached"
  | "expired"
  | "notStarted"
  | "modelMismatch"
  | "recovering"
  | "error";

interface PanelFeedback {
  status: PanelStatus;
  /**
   * Quality rejection reasons from a SUCCESSFUL 200 OK response with
   * `accepted=false`. Always `[]` for non-quality errors.
   */
  rejectionReasons: readonly QualityRejectionCode[];
  /**
   * Stable server error code for non-quality / non-success outcomes.
   * Used by the friendly mapping below.
   */
  errorCode: string | null;
  /**
   * Mirror of the server-authoritative progress block as of the last
   * response. Updated only on server responses — never incremented
   * locally.
   */
  progress: SampleProgress;
}

// =============================================================================
// Friendly copy maps
// =============================================================================

const LABELS = {
  turnOn: "Turn on camera",
  stop: "Stop camera",
  starting: "Starting camera…",
  capture: "Capture sample",
  processing: "Processing…",
  previewTitle: "Camera preview",
  acceptedHeading: "Sample accepted",
  completeHeading: "All required samples collected",
  completeBody:
    "Final setup has not been completed yet. Closing this page will discard the temporary session.",
  rejectedHeading: "Sample not accepted",
  rejectedBody:
    "Recapture will be available as soon as the camera is ready.",
  errorHeading: "Face processing is temporarily unavailable",
  errorBody:
    "Please try again in a moment. If the problem continues, contact support.",
  noFaceHeading: "No face was detected",
  noFaceBody:
    "Make sure your face is clearly visible to the camera and try again.",
  multipleFacesHeading: "Only one person should be visible",
  multipleFacesBody:
    "Recapture will be available once the camera is ready.",
  captureErrorHeading: "Could not capture the frame",
  conflictHeading: "Sample conflict",
  conflictBody:
    "Another sample was saved first. Progress has been refreshed.",
  limitReachedHeading: "Sample limit reached",
  limitReachedBody:
    "All required samples have been collected. Progress has been refreshed.",
  expiredHeading: "Session expired",
  expiredBody:
    "This setup session expired. Start setup again to continue.",
  notStartedHeading: "Setup session not found",
  notStartedBody:
    "Start setup again to continue.",
  modelMismatchHeading: "Setup session invalid",
  modelMismatchBody:
    "This setup session can no longer continue. Restart setup to continue.",
  recoveringHeading: "Refreshing progress",
  recoveringBody:
    "Synchronizing with the server…",
} as const;

/**
 * Maps a quality rejection code to friendly user-facing text. Stable
 * ordering is provided by `enrollment-sample-client.ts` so the UI
 * always renders the list in the same order.
 */
const QUALITY_REJECTION_COPY: Record<QualityRejectionCode, string> = {
  [QUALITY_REJECTION_CODES.LOW_DETECTION_CONFIDENCE]: "We couldn't get a clear view of your face. Try again.",
  [QUALITY_REJECTION_CODES.FACE_TOO_SMALL]: "Move a little closer to the camera.",
  [QUALITY_REJECTION_CODES.FACE_TOO_LARGE]: "Move a little farther from the camera.",
  [QUALITY_REJECTION_CODES.TOO_BLURRY]: "Hold still and try again.",
  [QUALITY_REJECTION_CODES.TOO_DARK]: "Move to a brighter area.",
  [QUALITY_REJECTION_CODES.TOO_BRIGHT]: "Reduce strong light on your face.",
  [QUALITY_REJECTION_CODES.FACE_NEAR_EDGE]: "Center your face in the camera.",
};

/**
 * Maps a recoverable NO_FACE / MULTIPLE_FACES route error code to a
 * user-facing heading. The body comes from the same constants block.
 */
function recoverableDomainHeading(code: string): {
  heading: string;
  body: string;
} {
  if (code === SAMPLE_CLIENT_ERROR_CODES.NO_FACE) {
    return { heading: LABELS.noFaceHeading, body: LABELS.noFaceBody };
  }
  if (code === SAMPLE_CLIENT_ERROR_CODES.MULTIPLE_FACES) {
    return {
      heading: LABELS.multipleFacesHeading,
      body: LABELS.multipleFacesBody,
    };
  }
  return { heading: LABELS.rejectedHeading, body: LABELS.rejectedBody };
}

/**
 * Progress string of the form "2 of 5 samples". Used for both the
 * initial server-derived state and the post-response state.
 */
function formatProgress(p: SampleProgress): string {
  return `${p.acceptedSamples} of ${p.requiredSamples} samples`;
}

// =============================================================================
// Component
// =============================================================================

export function EnrollmentSamplePanel({
  initialAcceptedSamples,
  requiredSamples,
  initialComplete = false,
  expiresAt,
  generationId,
  onReconcile,
  privacyNote,
  cameraPrivacyNote,
  className,
  fetchImpl,
  captureImpl,
}: EnrollmentSamplePanelProps) {
  const {
    videoRef,
    status: cameraStatus,
    error: cameraError,
    isReady: cameraIsReady,
    startCamera,
    stopCamera,
  } = useFaceCamera();

  // Server-authoritative progress. Updated only by the parsed
  // server response — local feedback never increments this counter.
  // On prop change (e.g. after router.refresh), this state is
  // synchronized via the useEffect below.
  const [progress, setProgress] = React.useState<SampleProgress>({
    acceptedSamples: initialAcceptedSamples,
    requiredSamples,
    complete: initialComplete,
  });

  // Track the last server-acknowledged progress to detect stale props.
  // Used to determine when to reconcile on conflict/limit.
  const lastServerProgressRef = React.useRef<SampleProgress>({
    acceptedSamples: initialAcceptedSamples,
    requiredSamples,
    complete: initialComplete,
  });

  // PHASE 4.5B4.3 — Server-authoritative generation discriminator.
  //
  // `generationId` is the stable, server-generated UUID stamped on the
  // enrollment session every time it is created or reset. When the
  // browser receives a new `generationId` from the server, it represents
  // a NEW server enrollment generation:
  //   - A different user started a fresh session, OR
  //   - The same user explicitly reset the session from another
  //     tab/device via `createOrResetEnrollmentSession`.
  //
  // In either case, the incoming props describe a NEW server
  // generation. The browser MUST yield to the server even if the
  // new accepted-sample count is lower than what we previously
  // acknowledged — because the old `acceptedSamples` belong to the
  // OLD session that has just been replaced.
  //
  // `expiresAt` is no longer the primary discriminator. It is still
  // used for the informational display text ("Session expires at ...")
  // but it MUST NOT gate the reconciliation decision.
  //
  // Browser-side persistence is intentionally forbidden: this ref
  // is purely a UI reconciliation signal. The browser never sends
  // `generationId` to the server and never derives identity from it.
  const lastGenerationIdRef = React.useRef<string | null | undefined>(
    generationId,
  );

  // Submission state machine. We keep this state separate from the
  // capture button's `disabled` flag so the panel can render richer
  // pending UI.
  const [pending, setPending] = React.useState<boolean>(false);
  const [feedback, setFeedback] = React.useState<PanelFeedback>({
    status: initialComplete ? "complete" : "idle",
    rejectionReasons: [],
    errorCode: null,
    progress,
  });

  // Effective `complete` flag. Either `true` at first render OR after
  // a server response that contains `complete: true`. While `true`
  // the Capture button is disabled.
  const isComplete = progress.complete;

  // Session invalid flag: when true, capture is permanently disabled
  // for this session (expired, not started, model mismatch).
  const [sessionInvalid, setSessionInvalid] = React.useState<boolean>(
    initialComplete,
  );

  // Synchronous in-flight guard. Catches two clicks fired in the same
  // microtask before React schedules the state update from the first
  // click. Required by the PHASE 4.5B3 contract.
  const submissionInFlightRef = React.useRef<boolean>(false);

  // Latest camera error message, if any.
  const cameraErrorMessage = cameraError
    ? CAMERA_ERROR_MESSAGES[cameraError.code]
    : null;

  // ── Prop reconciliation ───────────────────────────────────────────
  //
  // After a server-side state change (e.g. after router.refresh()),
  // the component receives new props. We synchronize the local state
  // to match the new authoritative props.
  //
  // PHASE 4.5B4.3 — Server-authoritative generation discriminator.
  //
  // We accept new props under TWO distinct conditions:
  //
  // (A) SAME-GENERATION ADVANCE
  //     `generationId` is unchanged AND the server has advanced
  //     beyond our last acknowledged count, OR the session is
  //     complete, OR the session was invalidated (5/5 → 0/5
  //     within the same session). This is the original B4 stale-
  //     prop guard.
  //
  // (B) NEW-GENERATION REPLACEMENT
  //     `generationId` differs from our last-known value. This means
  //     the server has just emitted a freshly created / reset
  //     enrollment session. The incoming props replace ALL local
  //     progress and transient panel state — even when the count
  //     decreases. The previous browser progress belongs to the
  //     OLD session and must not leak into the NEW one.
  //
  // `expiresAt` is no longer the reconciliation gate. It remains
  // in the informational display text but MUST NOT gate the
  // reconciliation decision.
  //
  // No global `Math.max()` is used. Lower counts are honored ONLY
  // across a generation boundary.
  //
  // This effect runs after the first render with new props. The
  // functional updater pattern is NOT used because we want to
  // detect actual changes, not blindly overwrite.
  React.useEffect(() => {
    const newProgress: SampleProgress = {
      acceptedSamples: initialAcceptedSamples,
      requiredSamples,
      complete: initialComplete,
    };

    // (B) NEW-GENERATION detection — the server has emitted a
    // different `generationId` than the one we last acknowledged.
    // Treat this as a freshly created / reset session and accept
    // the incoming props unconditionally. This is the multi-tab
    // resilience path: Tab A (3/5, generationId=A) reconciles after
    // Tab B reset the session (0/5, generationId=B).
    const isNewGeneration =
      lastGenerationIdRef.current !== generationId;

    if (isNewGeneration) {
      // Adopt the new server generation as the authoritative
      // baseline. All transient UI artefacts (rejection feedback,
      // conflict copy, model-mismatch banner, accepted feedback)
      // belong to the OLD session and are reset here so they
      // cannot leak into the NEW session.
      lastGenerationIdRef.current = generationId;
      lastServerProgressRef.current = newProgress;
      setProgress(newProgress);
      setSessionInvalid(newProgress.complete);
      setFeedback({
        status: newProgress.complete ? "complete" : "idle",
        rejectionReasons: [],
        errorCode: null,
        progress: newProgress,
      });
      return;
    }

    // (A) SAME-GENERATION — apply the original B4 stale-prop guard.
    // Accept the new server progress if:
    //   1. Server has advanced beyond our last acknowledged state
    //   2. Session is complete
    //   3. Session was invalidated (progress went to 0 from complete)
    const serverAdvanced =
      newProgress.acceptedSamples > lastServerProgressRef.current.acceptedSamples;
    const serverComplete = newProgress.complete;
    const serverInvalid =
      newProgress.acceptedSamples === 0 &&
      lastServerProgressRef.current.complete &&
      !newProgress.complete;

    if (serverAdvanced || serverComplete || serverInvalid) {
      setProgress(newProgress);
      lastServerProgressRef.current = newProgress;
      setSessionInvalid(serverComplete);
      setFeedback((prev) => ({
        ...prev,
        status: serverComplete ? "complete" : "idle",
        progress: newProgress,
      }));
    }
  }, [initialAcceptedSamples, requiredSamples, initialComplete, generationId]);

  // ── Camera controls ──────────────────────────────────────────────
  const handleTurnOn = React.useCallback((): void => {
    // Explicit user gesture is the ONLY trigger for getUserMedia.
    void startCamera();
  }, [startCamera]);

  const handleStop = React.useCallback((): void => {
    stopCamera();
  }, [stopCamera]);

  // ── Reconciliation trigger ────────────────────────────────────────
  //
  // Called when the component detects a state that requires
  // server-side reconciliation. The callback is provided by the
  // parent page component.
  //
  // For persistent terminal states (conflict, expired, limitReached,
  // notStarted, modelMismatch) and for the most recent error/feedback
  // state, the feedback message MUST stay visible — replacing it
  // with "recovering" would hide a critical user-facing explanation.
  // Only the bare idle state (no prior feedback) gets the
  // "recovering" overlay.
  const handleReconcile = React.useCallback((): void => {
    if (onReconcile) {
      setFeedback((prev) => {
        const hasFeedback =
          prev.status === "conflict" ||
          prev.status === "expired" ||
          prev.status === "limitReached" ||
          prev.status === "notStarted" ||
          prev.status === "modelMismatch" ||
          prev.status === "error" ||
          prev.status === "rejected" ||
          prev.status === "accepted";
        // Preserve any meaningful feedback message. Only the bare
        // idle state gets the "recovering" overlay.
        if (hasFeedback) {
          return prev;
        }
        return {
          ...prev,
          status: "recovering",
          rejectionReasons: [],
          errorCode: null,
          progress: prev.progress,
        };
      });
      onReconcile();
    }
  }, [onReconcile]);

  // ── Capture sample ───────────────────────────────────────────────
  //
  // Submission flow:
  //   1. Synchronous in-flight guard: protects against two rapid
  //      clicks landing in the same React dispatch before
  //      `setPending(true)` commits.
  //   2. Wait for the existing capture utility to produce a JPEG
  //      Blob — no second capture implementation.
  //   3. Submit via `submitFaceEnrollmentSample(blob)`. The helper
  //      performs exactly one fetch; we never retry.
  //   4. Apply the result through functional state setters so the
  //      callback never goes stale.
  //   5. On reconciliation-required errors, trigger onReconcile.
  const handleCapture = React.useCallback(async (): Promise<void> => {
    // (1) Synchronous guard.
    if (submissionInFlightRef.current) return;
    if (isComplete) return;
    if (sessionInvalid) return;
    if (!cameraIsReady) return;
    const video = videoRef.current;
    if (!video) return;

    submissionInFlightRef.current = true;
    setPending(true);

    // Clear stale feedback BEFORE awaiting. The user must not see
    // "Move closer" while the next request is processing.
    setFeedback((prev) => ({
      status: "submitting",
      rejectionReasons: [],
      errorCode: null,
      progress: prev.progress,
    }));

    try {
      // (2) Capture one frame. The capture utility throws a
      // `CaptureErrorShape` (typed) on failure — we catch and
      // surface it through the same feedback map.
      let captured: {
        blob: Blob;
        mimeType: "image/jpeg";
        width: number;
        height: number;
        size: number;
      };
      try {
        const impl = captureImpl ?? captureVideoFrame;
        captured = await impl(video);
      } catch (captureErr) {
        const captureError = captureErr as CaptureErrorShape;
        const safeCode =
          captureError && typeof captureError === "object" && "code" in captureError
            ? String((captureError as { code: unknown }).code)
            : CAPTURE_ERROR_CODES.FRAME_ENCODING_FAILED;
        setFeedback({
          status: "error",
          rejectionReasons: [],
          errorCode: safeCode,
          progress: {
            acceptedSamples: initialAcceptedSamples,
            requiredSamples,
            complete: initialComplete,
          },
        });
        return;
      }

      // (3) Submit. The helper performs exactly ONE fetch. The blob
      // stays in this local closure — never enters React state.
      const result = await submitFaceEnrollmentSample(
        captured.blob,
        fetchImpl ? { fetchImpl } : {},
      );

      // (4) Apply the result through functional setters. The server
      // response is the ONLY source of truth for progress.
      if (result.ok) {
        const nextProgress = result.progress;

        // Detect a "race-loss" conflict: the server returned a count
        // that did NOT advance past our last acknowledged server
        // count. Capture the previous ref BEFORE updating it.
        const previousServerCount =
          lastServerProgressRef.current.acceptedSamples;
        // Update server-acknowledged progress tracker
        lastServerProgressRef.current = nextProgress;
        setProgress(nextProgress);

        // Determine if this is a conflict case: server count did not
        // advance past what we last acknowledged.
        const conflictDetected =
          nextProgress.acceptedSamples < previousServerCount;

        if (conflictDetected) {
          // Another request saved a sample first. Reconcile with server.
          setFeedback({
            status: "conflict",
            rejectionReasons: [],
            errorCode: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_CONFLICT,
            progress: nextProgress,
          });
          handleReconcile();
          return;
        }

        if (nextProgress.complete) {
          setFeedback({
            status: "complete",
            rejectionReasons: [],
            errorCode: null,
            progress: nextProgress,
          });
          return;
        }

        setFeedback({
          status: result.accepted ? "accepted" : "rejected",
          rejectionReasons: result.rejectionReasons,
          errorCode: null,
          progress: nextProgress,
        });
        return;
      }

      // (5) Failure path. Check if reconciliation is required.
      const needsReconciliation = requiresReconciliation(result.code);

      if (needsReconciliation) {
        // Update the server progress tracker with current state
        // (we don't know the new state until reconciliation)
        lastServerProgressRef.current = {
          acceptedSamples: progress.acceptedSamples,
          requiredSamples: progress.requiredSamples,
          complete: progress.complete,
        };

        // Determine specific error states
        if (
          result.code === SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_CONFLICT
        ) {
          setFeedback({
            status: "conflict",
            rejectionReasons: [],
            errorCode: result.code,
            progress: progress,
          });
          handleReconcile();
          return;
        }

        if (
          result.code ===
          SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_LIMIT_REACHED
        ) {
          setFeedback({
            status: "limitReached",
            rejectionReasons: [],
            errorCode: result.code,
            progress: progress,
          });
          // Stop camera: 5/5 reached, no more captures.
          if (cameraIsReady) {
            stopCamera();
          }
          handleReconcile();
          return;
        }

        if (result.code === SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_EXPIRED) {
          setSessionInvalid(true);
          setFeedback({
            status: "expired",
            rejectionReasons: [],
            errorCode: result.code,
            progress: progress,
          });
          // Stop camera for session-invalid state
          if (cameraIsReady) {
            stopCamera();
          }
          handleReconcile();
          return;
        }

        if (
          result.code === SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_NOT_STARTED
        ) {
          setSessionInvalid(true);
          setFeedback({
            status: "notStarted",
            rejectionReasons: [],
            errorCode: result.code,
            progress: progress,
          });
          if (cameraIsReady) {
            stopCamera();
          }
          handleReconcile();
          return;
        }

        if (result.code === SAMPLE_CLIENT_ERROR_CODES.MODEL_MISMATCH) {
          setSessionInvalid(true);
          setFeedback({
            status: "modelMismatch",
            rejectionReasons: [],
            errorCode: result.code,
            progress: progress,
          });
          if (cameraIsReady) {
            stopCamera();
          }
          // No automatic restart or reset
          return;
        }

        // Network error: reconciliation available and triggered
        if (result.code === "NETWORK_ERROR") {
          setFeedback({
            status: "error",
            rejectionReasons: [],
            errorCode: "NETWORK_ERROR",
            progress: progress,
          });
          // Per PHASE 4.5B4 spec, network failures trigger the
          // reconciliation path (which causes router.refresh()) so
          // the server-authoritative state is re-fetched. The
          // "Connection error" copy stays visible.
          handleReconcile();
          return;
        }

        // Other reconciliation-required errors
        setFeedback({
          status: "error",
          rejectionReasons: [],
          errorCode: result.code,
          progress: progress,
        });
        handleReconcile();
        return;
      }

      // Non-reconciliation errors (NO_FACE, MULTIPLE_FACES,
      // infrastructure errors): camera stays running, no retry.
      setFeedback((prev) => ({
        status: "error",
        rejectionReasons: [],
        errorCode: result.code,
        progress: prev.progress,
      }));
    } catch {
      // Defensive: any thrown value (e.g. an unexpected network
      // throw the helper did not catch) is surfaced as MALFORMED.
      setFeedback({
        status: "error",
        rejectionReasons: [],
        errorCode: "MALFORMED_RESPONSE",
        progress: {
          acceptedSamples: initialAcceptedSamples,
          requiredSamples,
          complete: initialComplete,
        },
      });
    } finally {
      submissionInFlightRef.current = false;
      setPending(false);
    }
  }, [
    cameraIsReady,
    captureImpl,
    fetchImpl,
    initialAcceptedSamples,
    initialComplete,
    isComplete,
    progress,
    requiredSamples,
    sessionInvalid,
    stopCamera,
    videoRef,
    handleReconcile,
  ]);

  // The capture button is enabled ONLY when:
  //   - the camera is ready
  //   - the enrollment session is not yet complete
  //   - the session is still valid (not expired/mismatched/not started)
  //   - no submission is currently in flight
  //   - the capture utility is available
  //   - the server has not reported limitReached (5/5 already)
  //
  // The `submissionInFlightRef.current` value is only meaningful at
  // click time, so we do not read it during render. The synchronous
  // guard inside `handleCapture` still protects against two rapid
  // clicks; here we just reflect the React-tracked `pending` flag.
  const captureDisabled =
    !cameraIsReady ||
    pending ||
    isComplete ||
    sessionInvalid ||
    feedback.status === "limitReached" ||
    feedback.status === "conflict";

  // Determine if camera should be stopped for current session state
  const cameraStoppedForSession =
    sessionInvalid &&
    (feedback.status === "expired" ||
      feedback.status === "notStarted" ||
      feedback.status === "modelMismatch" ||
      feedback.status === "limitReached");

  return (
    <section
      aria-label="Face ID enrollment sample"
      data-status={
        pending
          ? "pending"
          : isComplete
            ? "complete"
            : sessionInvalid
              ? "invalid"
              : feedback.status
      }
      className={cn(
        "flex w-full max-w-xl flex-col gap-4",
        "rounded-xl border border-border bg-surface p-4 sm:p-5",
        className,
      )}
    >
      {/* Video frame */}
      <div
        className={cn(
          "relative w-full overflow-hidden rounded-lg border border-border bg-muted",
          "aspect-video",
        )}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={cn(
            "h-full w-full object-cover",
            "[transform:scaleX(-1)]",
          )}
          aria-label={LABELS.previewTitle}
        />
        {cameraStatus !== "ready" || cameraStoppedForSession ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <span className="rounded-full bg-surface px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
              {cameraStatus === "requesting"
                ? "Requesting camera…"
                : cameraStoppedForSession
                  ? "Camera paused"
                  : "Camera off"}
            </span>
          </div>
        ) : null}
      </div>

      {/* Camera + capture controls */}
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            onClick={handleTurnOn}
            disabled={
              cameraIsReady ||
              cameraStatus === "requesting" ||
              sessionInvalid
            }
            loading={cameraStatus === "requesting"}
            variant="secondary"
            aria-label={LABELS.turnOn}
          >
            {cameraStatus === "requesting" ? LABELS.starting : LABELS.turnOn}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={handleStop}
            disabled={!cameraIsReady && cameraStatus !== "requesting"}
            aria-label={LABELS.stop}
          >
            {LABELS.stop}
          </Button>
        </div>

        <Button
          type="button"
          variant="primary"
          onClick={handleCapture}
          disabled={captureDisabled}
          loading={pending}
          aria-busy={pending || undefined}
          aria-disabled={captureDisabled || undefined}
        >
          {pending ? LABELS.processing : LABELS.capture}
        </Button>
      </div>

      {/* Server-authoritative progress. aria-live so screen readers
          announce each new count. */}
      <p
        aria-live="polite"
        className="text-sm font-medium text-foreground"
      >
        {formatProgress(progress)}
      </p>

      {/* Session expiry info (informational only) */}
      {expiresAt && !sessionInvalid ? (
        <p className="text-xs text-muted-foreground">
          Session expires {formatExpiry(expiresAt)}.
        </p>
      ) : null}

      {/* Camera error block. Rendered only for stable mapped errors. */}
      {cameraError && cameraErrorMessage ? (
        <div
          role="alert"
          className={cn(
            "rounded-md border border-destructive/30 bg-destructive-soft",
            "px-3 py-2.5 text-sm text-destructive",
          )}
        >
          <p className="font-medium">Camera unavailable</p>
          <p className="mt-0.5">{cameraErrorMessage}</p>
        </div>
      ) : null}

      {/* Capture-level errors (FRAME_NOT_READY etc.) */}
      <CaptureErrorBlock
        code={feedback.status === "error" ? feedback.errorCode : null}
      />

      {/* Feedback block. Only one of these is rendered at a time —
          the most recent server response wins. */}
      {feedback.status === "accepted" ? (
        <FeedbackBlock
          tone="success"
          role="status"
          heading={LABELS.acceptedHeading}
          body={formatProgress(progress)}
        />
      ) : null}

      {feedback.status === "complete" ? (
        <FeedbackBlock
          tone="info"
          role="status"
          heading={LABELS.completeHeading}
          body={LABELS.completeBody}
        />
      ) : null}

      {feedback.status === "rejected" ? (
        <QualityRejectionBlock reasons={feedback.rejectionReasons} />
      ) : null}

      {feedback.status === "conflict" ? (
        <FeedbackBlock
          tone="warning"
          role="status"
          heading={LABELS.conflictHeading}
          body={LABELS.conflictBody}
        />
      ) : null}

      {feedback.status === "limitReached" ? (
        <FeedbackBlock
          tone="info"
          role="status"
          heading={LABELS.limitReachedHeading}
          body={LABELS.limitReachedBody}
        />
      ) : null}

      {feedback.status === "expired" ? (
        <FeedbackBlock
          tone="warning"
          role="status"
          heading={LABELS.expiredHeading}
          body={LABELS.expiredBody}
        />
      ) : null}

      {feedback.status === "notStarted" ? (
        <FeedbackBlock
          tone="warning"
          role="status"
          heading={LABELS.notStartedHeading}
          body={LABELS.notStartedBody}
        />
      ) : null}

      {feedback.status === "modelMismatch" ? (
        <FeedbackBlock
          tone="warning"
          role="status"
          heading={LABELS.modelMismatchHeading}
          body={LABELS.modelMismatchBody}
        />
      ) : null}

      {feedback.status === "recovering" ? (
        <FeedbackBlock
          tone="info"
          role="status"
          heading={LABELS.recoveringHeading}
          body={LABELS.recoveringBody}
        />
      ) : null}

      {feedback.status === "error" &&
      feedback.errorCode &&
      (feedback.errorCode === SAMPLE_CLIENT_ERROR_CODES.NO_FACE ||
        feedback.errorCode === SAMPLE_CLIENT_ERROR_CODES.MULTIPLE_FACES) ? (
        <RecoverableDomainBlock
          code={feedback.errorCode}
          {...recoverableDomainHeading(feedback.errorCode)}
        />
      ) : null}

      {feedback.status === "error" &&
      feedback.errorCode &&
      feedback.errorCode !== SAMPLE_CLIENT_ERROR_CODES.NO_FACE &&
      feedback.errorCode !== SAMPLE_CLIENT_ERROR_CODES.MULTIPLE_FACES &&
      feedback.errorCode !== "NETWORK_ERROR" &&
      !isCaptureError(feedback.errorCode) ? (
        <FeedbackBlock
          tone="warning"
          role="alert"
          heading={LABELS.errorHeading}
          body={LABELS.errorBody}
        />
      ) : null}

      {/* Network error with reconciliation available */}
      {feedback.status === "error" &&
      feedback.errorCode === "NETWORK_ERROR" ? (
        <FeedbackBlock
          tone="warning"
          role="status"
          heading="Connection error"
          body="Could not reach the server. Please check your connection and try again."
        />
      ) : null}

      {/* Privacy note (PHASE 4.5B3-accurate). Optional override. */}
      <p className="text-xs leading-[18px] text-muted-foreground">
        {privacyNote ?? DEFAULT_PRIVACY_NOTE}
      </p>

      {/*
        Camera-side privacy note. Kept for callers that want to display
        a more detailed note via a portal; otherwise the single panel-
        level note above is the B3-accurate copy.
      */}
      {cameraPrivacyNote ? (
        <p className="sr-only">{cameraPrivacyNote}</p>
      ) : null}
    </section>
  );
}

const DEFAULT_PRIVACY_NOTE =
  "Each sample you choose to capture is sent securely to the application for face analysis. Raw camera images are not kept by the application.";

// =============================================================================
// Helpers
// =============================================================================

/**
 * Formats an ISO timestamp into a short human-readable string.
 */
function formatExpiry(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "soon";
  }
}

// =============================================================================
// Sub-blocks
// =============================================================================

/**
 * Decides whether a feedback error code is a capture-time error
 * (FRAME_NOT_READY etc.) rather than a server response error.
 */
function isCaptureError(code: string): boolean {
  switch (code) {
    case CAPTURE_ERROR_CODES.FRAME_NOT_READY:
    case CAPTURE_ERROR_CODES.FRAME_CANVAS_UNAVAILABLE:
    case CAPTURE_ERROR_CODES.FRAME_ENCODING_FAILED:
    case "MALFORMED_RESPONSE":
    case "NETWORK_ERROR":
      return true;
    default:
      return false;
  }
}

function CaptureErrorBlock({ code }: { code: string | null }) {
  if (!code) return null;
  if (!isCaptureError(code)) return null;
  const message =
    code === CAPTURE_ERROR_CODES.FRAME_NOT_READY
      ? CAPTURE_ERROR_MESSAGES[CAPTURE_ERROR_CODES.FRAME_NOT_READY]
      : code === CAPTURE_ERROR_CODES.FRAME_CANVAS_UNAVAILABLE
        ? CAPTURE_ERROR_MESSAGES[CAPTURE_ERROR_CODES.FRAME_CANVAS_UNAVAILABLE]
        : code === CAPTURE_ERROR_CODES.FRAME_ENCODING_FAILED
          ? CAPTURE_ERROR_MESSAGES[CAPTURE_ERROR_CODES.FRAME_ENCODING_FAILED]
          : "The capture could not be completed. Please try again.";
  return (
    <FeedbackBlock
      tone="warning"
      role="alert"
      heading={LABELS.captureErrorHeading}
      body={message}
    />
  );
}

function RecoverableDomainBlock({
  code,
  heading,
  body,
}: {
  code: string;
  heading: string;
  body: string;
}) {
  return (
    <FeedbackBlock
      tone="warning"
      role="status"
      heading={heading}
      body={body}
      code={code}
    />
  );
}

function QualityRejectionBlock({
  reasons,
}: {
  reasons: readonly QualityRejectionCode[];
}) {
  if (reasons.length === 0) return null;
  const primary = reasons[0]!;
  const secondary = reasons.slice(1);
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "rounded-md border border-warning/30 bg-warning-soft",
        "px-3 py-2.5 text-sm text-warning",
      )}
    >
      <p className="font-medium">{LABELS.rejectedHeading}</p>
      <ul className="mt-1 flex flex-col gap-1">
        <li>
          {/* Primary reason — strongest, listed first. */}
          {QUALITY_REJECTION_COPY[primary]}
        </li>
        {secondary.map((reason) => (
          <li
            key={reason}
            className="text-xs text-warning/90"
          >
            {QUALITY_REJECTION_COPY[reason]}
          </li>
        ))}
      </ul>
    </div>
  );
}

interface FeedbackBlockProps {
  tone: "success" | "info" | "warning";
  role: "status" | "alert";
  heading: string;
  body: string;
  code?: string;
}

function FeedbackBlock({
  tone,
  role,
  heading,
  body,
  code,
}: FeedbackBlockProps) {
  return (
    <div
      role={role}
      aria-live={role === "status" ? "polite" : undefined}
      data-tone={tone}
      className={cn(
        "rounded-md border px-3 py-2.5 text-sm",
        tone === "success" &&
          "border-success/30 bg-success-soft text-success",
        tone === "info" && "border-info/30 bg-info-soft text-info",
        tone === "warning" &&
          "border-warning/30 bg-warning-soft text-warning",
      )}
    >
      <p className="font-medium">{heading}</p>
      <p className="mt-0.5">{body}</p>
      {code ? (
        <p className="mt-2 text-xs text-muted-foreground">{code}</p>
      ) : null}
    </div>
  );
}
