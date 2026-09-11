/**
 * `CameraPreview` — restrained, accessible camera preview surface.
 *
 * PHASE 4.5A — Browser Camera Foundation.
 *
 * Scope:
 *   - Renders a `<video>` element driven by `useFaceCamera`.
 *   - Provides two buttons: "Turn on camera" and "Stop camera".
 *   - Renders concise, accessible error text when the camera fails.
 *   - Includes a small, restrained privacy note near the preview.
 *
 * Out of scope for PHASE 4.5A:
 *   - Image capture (no `<canvas>`, no `drawImage`, no `toBlob`,
 *     no `toDataURL`, no `ImageCapture`).
 *   - Sample submission (no `fetch` to `/api/face-id/enrollment/sample`).
 *   - Camera device enumeration / selection.
 *
 * Design posture:
 *   - Honours the "Quiet Precision" design language. No neon, no
 *     glassmorphism, no AI gradients, no scanning lasers.
 *   - Mirrors the video preview with CSS (selfie-style) only. The
 *     underlying stream is never transformed or mirrored in PHASE
 *     4.5A — a future capture step is responsible for any source
 *     transformation it needs.
 *   - Responsive: the video is constrained to a stable 16:9 aspect
 *     ratio and a max width that fits tablet, mobile, and desktop.
 */

"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { CAMERA_ERROR_MESSAGES } from "@/components/face-id/camera-constants";
import {
  useFaceCamera,
  type FaceCameraStatus,
} from "@/components/face-id/use-face-camera";
import { cn } from "@/lib/utils";

/**
 * Optional `className` for the outer wrapper. Useful when a future
 * enrollment page wants to embed `CameraPreview` inside a card.
 */
export interface CameraPreviewProps {
  className?: string;
  /** Optional override for the privacy copy. Defaults to the
   *  PHASE 4.5A baseline wording. */
  privacyNote?: string;
  /**
   * Optional external ref to the active `<video>` element.
   *
   * PHASE 4.5B3 — Capture + Submit + Quality Feedback.
   *
   * PHASE 4.5A intentionally did not expose the video element to
   * outside callers — the preview was a self-contained leaf. PHASE
   * 4.5B3 needs safe access to the same active `<video>` element so
   * the enrollment panel can call `captureVideoFrame(video)` when
   * the user explicitly clicks "Capture sample".
   *
   * When provided, the consumer MUST attach this ref to a `<video>`
   * element rendered by itself, OR pass it back to `CameraPreview`
   * through its child render. For the minimal integration chosen in
   * PHASE 4.5B3, the new `EnrollmentSamplePanel` component owns
   * `useFaceCamera()` itself and renders its own `<video>` alongside
   * the existing camera controls, so this prop remains `undefined`
   * in practice. It is exposed here so future enrollment UI may
   * reuse `CameraPreview` without duplicating `useFaceCamera`.
   *
   * When this prop is `undefined`, the component behaves exactly as
   * in PHASE 4.5A: it owns its own internal `videoRef`.
   */
  videoRef?: React.RefObject<HTMLVideoElement | null>;
}

/**
 * Stable button labels. Centralized so a future localization layer
 * only has to touch one place per string.
 */
const LABELS = {
  turnOn: "Turn on camera",
  stop: "Stop camera",
  starting: "Starting camera…",
  previewLabel: "Camera preview",
  errorHeading: "Camera unavailable",
} as const;

/**
 * Default privacy note. Deliberately restrained: it does NOT claim
 * any future guarantee about sample transmission, because PHASE 4.5B
 * will send user-chosen samples to the server.
 */
const DEFAULT_PRIVACY_NOTE =
  "The camera preview stays on this device until you choose to capture a sample.";

/**
 * Friendly status text shown when the camera is active. Plain
 * language, no decorative UI.
 */
function statusText(status: FaceCameraStatus): string | null {
  switch (status) {
    case "requesting":
      return "Requesting camera access…";
    case "ready":
      return "Camera on. You can stop the camera when you are done.";
    case "idle":
    case "error":
    default:
      return null;
  }
}

export function CameraPreview({
  className,
  privacyNote = DEFAULT_PRIVACY_NOTE,
  videoRef: externalVideoRef,
}: CameraPreviewProps) {
  const camera = useFaceCamera();
  // If the caller provides their own videoRef, use it. Otherwise use
  // the internal one from `useFaceCamera`. Either way the hook owns
  // the lifecycle — the parent ref is only a read access window.
  const videoRef = externalVideoRef ?? camera.videoRef;
  const { status, error, isReady, startCamera, stopCamera } = camera;

  const onStart = React.useCallback((): void => {
    // Explicit user action is the ONLY trigger for getUserMedia in
    // PHASE 4.5A. We deliberately do NOT memoize the async result
    // because the caller does not need it — the hook updates its own
    // state.
    void startCamera();
  }, [startCamera]);

  const onStop = React.useCallback((): void => {
    stopCamera();
  }, [stopCamera]);

  const message = error ? CAMERA_ERROR_MESSAGES[error.code] : null;
  const liveMessage = statusText(status);

  return (
    <section
      aria-label="Camera preview"
      data-status={status}
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
          // Stable 16:9 preview, responsive.
          "aspect-video",
        )}
      >
        <video
          ref={videoRef}
          // Live preview attributes. `muted` is required for
          // autoplay in most browsers; there is no audio track in
          // PHASE 4.5A but the attribute is harmless and future-proof.
          autoPlay
          playsInline
          muted
          // Mirroring is presentation-only. The underlying stream is
          // untouched; CSS transforms do not affect pixel data.
          className={cn(
            "h-full w-full object-cover",
            "[transform:scaleX(-1)]",
          )}
          // Live preview is decorative for screen readers — the
          // status text below carries the accessible meaning.
          aria-label={LABELS.previewLabel}
        />
        {/* Subtle idle overlay so the empty preview area does not
            look like a missing image. Restrained — no scan lines,
            no neon, no AI gradients. */}
        {status !== "ready" ? (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <span className="rounded-full bg-surface px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">
              {status === "requesting"
                ? "Requesting camera…"
                : "Camera off"}
            </span>
          </div>
        ) : null}
      </div>

      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          onClick={onStart}
          // Explicit permission rule: the button is the only path
          // to getUserMedia. It is also the only way to *retry*
          // after an error — consumers can wire a different trigger
          // if needed, but the principle is identical.
          disabled={isReady || status === "requesting"}
          loading={status === "requesting"}
          aria-label={LABELS.turnOn}
        >
          {status === "requesting" ? LABELS.starting : LABELS.turnOn}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={onStop}
          disabled={!isReady && status !== "requesting"}
          aria-label={LABELS.stop}
        >
          {LABELS.stop}
        </Button>
      </div>

      {/* Live status text. `aria-live="polite"` so assistive tech
          announces state transitions without interrupting. */}
      <p
        aria-live="polite"
        className="min-h-[1.25rem] text-sm text-muted-foreground"
      >
        {liveMessage}
      </p>

      {/* Error block. Rendered only when there is a stable mapped
          error. Raw exception details are NEVER shown. */}
      {error && message ? (
        <div
          role="alert"
          className={cn(
            "rounded-md border border-destructive/30 bg-destructive-soft",
            "px-3 py-2.5 text-sm text-destructive",
          )}
        >
          <p className="font-medium">{LABELS.errorHeading}</p>
          <p className="mt-0.5">{message}</p>
          <p className="mt-2 text-xs text-muted-foreground">
            No image has been captured or uploaded.
          </p>
        </div>
      ) : null}

      {/* Privacy note. Restrained, factual, and PHASE 4.5A-accurate:
          the preview is local-only. Future sample transmission is
          intentionally NOT claimed here. */}
      <p className="text-xs leading-[18px] text-muted-foreground">
        {privacyNote}
      </p>
    </section>
  );
}
