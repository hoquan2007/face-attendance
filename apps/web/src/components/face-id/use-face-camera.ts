/**
 * `useFaceCamera` — React hook for the browser camera foundation.
 *
 * PHASE 4.5A — Browser Camera Foundation.
 *
 * Scope:
 *   - Start the front-facing camera after an EXPLICIT user action.
 *   - Expose a `videoRef` that the caller attaches to a `<video>`.
 *   - Expose a small typed state model: `idle | requesting | ready |
 *     error`.
 *   - Stop the camera and clean up tracks on unmount, on user cancel,
 *     and when an in-flight start fails after a stream was partially
 *     obtained.
 *
 * Out of scope for PHASE 4.5A:
 *   - Image capture, canvas, ImageCapture, toBlob, toDataURL.
 *   - Uploads to `/api/face-id/enrollment/sample`.
 *   - Microphone access (`audio: false` is enforced).
 *   - Camera-selection UI (no `enumerateDevices` call).
 *
 * Client boundary:
 *   - This module is `"use client"` because it touches
 *     `navigator.mediaDevices` and DOM MediaStreams.
 *   - It MUST NOT import any server-only module. In particular, no
 *     imports from `@/lib/biometrics/*` (those are all server-only).
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  CAMERA_AUDIO_CONSTRAINTS,
  CAMERA_VIDEO_CONSTRAINTS,
} from "@/components/face-id/camera-constants";
import {
  isInsecureBrowserContext,
  mapCameraError,
  type CameraErrorShape,
} from "@/components/face-id/camera-errors";

/**
 * The lifecycle states surfaced by `useFaceCamera`.
 *
 * - `idle`       : nothing has happened yet, OR the camera has been
 *                  stopped and is ready to start again.
 * - `requesting` : a `getUserMedia` call is in flight.
 * - `ready`      : a stream is active and attached to `videoRef`.
 * - `error`      : the last attempt failed; `error` carries the safe
 *                  mapped shape.
 */
export type FaceCameraStatus = "idle" | "requesting" | "ready" | "error";

/**
 * Public return value of `useFaceCamera`.
 */
export interface UseFaceCamera {
  /** Attach to a `<video>` element. The hook writes `srcObject`. */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** Current lifecycle status. */
  status: FaceCameraStatus;
  /**
   * Stable camera error, populated only when `status === "error"`.
   * Never contains raw browser exception names, messages, or stack
   * traces.
   */
  error: CameraErrorShape | null;
  /** `true` when `status === "ready"`. Convenience for consumers. */
  isReady: boolean;
  /**
   * Request the camera. MUST be triggered by an explicit user action
   * (e.g. a button click) — never on mount, render, or effect.
   *
   * Behavior:
   *   - If the browser context is insecure, sets an
   *     `CAMERA_INSECURE_CONTEXT` error.
   *   - If a stream is already active, the hook treats the call as
   *     idempotent — the existing stream is preserved and no second
   *     `getUserMedia` call is made. This guarantees no stream leak
   *     across repeated starts.
   *   - If a previous `getUserMedia` call is still pending, the call
   *     is a no-op — at most ONE `getUserMedia` request may be in
   *     flight at a time. Concurrent starts are coalesced.
   *   - Otherwise, requests a new stream with `audio: false`.
   */
  startCamera: () => Promise<void>;
  /** Stops every active track and detaches the stream from the video. */
  stopCamera: () => void;
}

/**
 * React hook for the browser camera foundation.
 *
 * Lifecycle:
 *   - The hook NEVER calls `getUserMedia` on mount. The caller MUST
 *     invoke `startCamera()` only after an explicit user gesture.
 *   - On unmount, every active `MediaStreamTrack` is stopped and the
 *     stream is detached from the video element. The OS camera LED is
 *     guaranteed to turn off.
 */
export function useFaceCamera(): UseFaceCamera {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Use a ref to keep the current stream accessible from cleanup
  // callbacks without re-running effects.
  const streamRef = useRef<MediaStream | null>(null);
  // Tracks whether the component is still mounted. Prevents
  // `setState` after unmount when an in-flight `getUserMedia`
  // resolves late.
  const isMountedRef = useRef<boolean>(true);
  // In-flight guard: prevents concurrent `getUserMedia` calls when
  // the first request is still pending.
  const requestInFlightRef = useRef<boolean>(false);
  // Tracks the "generation" of the current request. Incremented on
  // each `startCamera` call and on each `stopCamera` call so that
  // a stream resolved after a stop is immediately invalidated.
  const requestGenerationRef = useRef<number>(0);

  const [status, setStatus] = useState<FaceCameraStatus>("idle");
  const [error, setError] = useState<CameraErrorShape | null>(null);

  const stopCamera = useCallback((): void => {
    // Invalidate any in-flight request so its resolved stream is
    // immediately discarded rather than becoming active.
    requestGenerationRef.current += 1;

    const stream = streamRef.current;
    if (stream) {
      // Stopping every track is the only reliable way to release the
      // OS-level camera LED across Chromium, Firefox, and WebKit.
      stream.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // Stopping a track that is already stopped is a no-op in
          // spec but some platforms throw — swallow defensively.
        }
      });
    }
    streamRef.current = null;

    const video = videoRef.current;
    if (video) {
      // Detach the stream from the element so the preview stops
      // rendering immediately even if the browser has not fully
      // released the hardware yet.
      video.srcObject = null;
    }

    if (isMountedRef.current) {
      setStatus("idle");
      setError(null);
    }
  }, []);

  const startCamera = useCallback(async (): Promise<void> => {
    // Idempotent repeated-start. If a stream is already active, do
    // nothing — guarantees no MediaStream leak from repeated clicks.
    if (streamRef.current) {
      return;
    }

    // In-flight guard. `streamRef.current` is only set AFTER
    // `getUserMedia` resolves, so without this guard two rapid
    // `startCamera()` calls would each fire their own
    // `getUserMedia`, leaking the second stream. This synchronous
    // ref check guarantees at most ONE `getUserMedia` request is
    // in flight at a time.
    if (requestInFlightRef.current) {
      return;
    }

    // Guard against insecure contexts BEFORE calling getUserMedia so
    // we never trigger the browser's own error path.
    if (isInsecureBrowserContext()) {
      const mapped = mapCameraError(new Error("SecurityError"));
      // `mapCameraError` only inspects `.name`; we override here
      // because the "no `window`" path of `isInsecureBrowserContext`
      // never produces a DOMException with `.name === "SecurityError"`.
      const insecureShape: CameraErrorShape = {
        code: "CAMERA_INSECURE_CONTEXT",
        message: mapped.message,
      };
      if (isMountedRef.current) {
        setStatus("error");
        setError(insecureShape);
      }
      return;
    }

    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== "function"
    ) {
      if (isMountedRef.current) {
        setStatus("error");
        setError(mapCameraError(new Error("MediaDevicesUnavailable")));
      }
      return;
    }

    // Mark the request in flight BEFORE the async boundary so a
    // second synchronous call observes the guard. The matching
    // release lives in the `finally` block below.
    requestInFlightRef.current = true;
    // Snapshot the generation for THIS request. If `stopCamera` (or
    // a later `startCamera`) runs while we are pending, it bumps the
    // generation; on resolution we detect the mismatch and discard.
    const myGeneration = ++requestGenerationRef.current;

    if (isMountedRef.current) {
      setStatus("requesting");
      setError(null);
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: CAMERA_AUDIO_CONSTRAINTS,
        video: CAMERA_VIDEO_CONSTRAINTS,
      });

      // The component may have unmounted while getUserMedia was in
      // flight. If so, release the stream immediately and stop —
      // attaching it to a detached `<video>` would leak hardware.
      if (!isMountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      // The request was invalidated by a `stopCamera` (or a newer
      // `startCamera`) while pending. Discard the stream and do
      // not attach it as active. Its tracks are stopped so no OS
      // LED stays lit.
      if (myGeneration !== requestGenerationRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;

      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
      }

      setStatus("ready");
      setError(null);
    } catch (caught) {
      // Defensive: also stop any partially-acquired stream if the
      // platform happens to expose one through `caught`.
      const partial = extractStream(caught);
      if (partial) {
        partial.getTracks().forEach((track) => track.stop());
      }

      if (isMountedRef.current) {
        setStatus("error");
        setError(mapCameraError(caught));
      }
    } finally {
      // Release the in-flight guard so a future deliberate retry
      // (after failure, stop, or unmount cleanup) can start a new
      // request. The generation token still protects a stream that
      // resolved after stop/unmount from becoming active.
      requestInFlightRef.current = false;
    }
  }, []);

  // Cleanup on unmount. Stop every active track so the OS LED turns
  // off when the user navigates away.
  useEffect(() => {
    // Capture videoRef at effect-entry time. The element will still be
    // valid when cleanup runs because React never unmounts between
    // effect body and cleanup.
    const videoEl = videoRef.current;
    return () => {
      isMountedRef.current = false;
      // Invalidate any in-flight request so a late-resolving stream
      // is discarded (and its tracks stopped) rather than becoming
      // active on an unmounted hook.
      requestGenerationRef.current += 1;
      const stream = streamRef.current;
      if (stream) {
        stream.getTracks().forEach((track) => {
          try {
            track.stop();
          } catch {
            // See `stopCamera` for rationale.
          }
        });
      }
      streamRef.current = null;
      if (videoEl) {
        videoEl.srcObject = null;
      }
    };
  }, []);

  return {
    videoRef,
    status,
    error,
    isReady: status === "ready",
    startCamera,
    stopCamera,
  };
}

/**
 * Some browsers attach a partially-acquired stream to the rejected
 * error. This helper inspects a caught value for a `MediaStream`
 * shape and returns it if found, otherwise `null`.
 *
 * The hook only uses the returned stream to defensively stop its
 * tracks. It NEVER reads its content.
 */
function extractStream(value: unknown): MediaStream | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = (value as { stream?: unknown }).stream;
  if (typeof MediaStream !== "undefined" && candidate instanceof MediaStream) {
    return candidate;
  }
  return null;
}
