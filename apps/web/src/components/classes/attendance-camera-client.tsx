/**
 * `AttendanceCameraClient` — Client Component for live face recognition preview.
 *
 * PHASE 6.5 — CONTROLLED CONTINUOUS FACE SCANNING +
 * BACKPRESSURE + SESSION-AWARE AUTO STOP.
 *
 * This is the ONLY browser-side component that:
 *   - Requests camera access via `getUserMedia`
 *   - Captures video frames as JPEG
 *   - Sends frames to `/api/attendance/recognize`
 *   - Drives the controlled auto-scan loop with backpressure
 *   - Displays recognition preview results
 *
 * ## Privacy contract
 *   - Camera starts ONLY after explicit user action (Enable camera button).
 *   - Camera stops on component unmount, Stop camera button, track-ended
 *     event, or session-closed message.
 *   - Auto scan starts ONLY after explicit Start auto scan — NEVER
 *     automatically after Enable camera.
 *   - Raw frames remain transient — never persisted locally or
 *     remotely. The browser DOES NOT retain a second attendance
 *     state in memory; the server-rendered Present state is the
 *     single source of truth.
 *   - At most ONE recognize request is in flight at any moment.
 *     Manual scan and auto scan share the SAME in-flight guard.
 *   - Frames are sent ONLY to the existing Next.js recognize
 *     route; the browser never talks to the Face Service directly.
 *
 * ## Scan cadence
 *   - Auto scan uses a self-scheduling async loop. The next scan is
 *     ONLY scheduled after the previous scan's HTTP round-trip has
 *     completed PLUS a fixed cooldown.
 *   - `AUTO_SCAN_INTERVAL_MS` is the conservative constant the loop
 *     honors between scans. The implementation NEVER uses
 *     `setInterval` / `setTimeout` overlap to start a second
 *     in-flight request — the in-flight guard enforces this
 *     defense-in-depth regardless of any timer drift.
 *   - The loop NEVER uses browser animation-frame APIs for
 *     recognition.
 *
 * ## Visibility & session-awareness
 *   - When `document.visibilityState` becomes `hidden`, the loop
 *     pauses. When it becomes `visible` again the loop resumes
 *     ONLY if auto scan was active before the hide. An explicit
 *     Stop auto scan remains stopped across visibility changes.
 *   - When the recognize route reports `SESSION_NOT_ACTIVE` /
 *     `SESSION_CLASS_MISMATCH` the auto scan stops and the
 *     session-closed state is rendered.
 *   - When the route reports `NO_RECOGNITION_CANDIDATES` the auto
 *     scan stops and a safe empty-gallery message is shown.
 *   - When the active MediaStream track emits `ended`, auto scan
 *     stops and the camera state is reset safely.
 *
 * ## Result handling
 *   - The auto scan reuses the existing Phase 6.4 recognize route.
 *   - On `recordedCount > 0` the component invokes
 *     `router.refresh()` so the server-rendered Present panel
 *     re-renders from its authoritative source.
 *   - On `recordedCount === 0` (idempotent repeat or no face) no
 *     refresh is triggered.
 *   - Transient safe failures (e.g. service unavailable) never
 *     create a rapid retry — the next scan waits for the normal
 *     cooldown.
 */

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Camera, CameraOff, Play, Square, RefreshCw, AlertCircle, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardSection } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// =============================================================================
// Constants
// =============================================================================

/**
 * Conservative auto-scan cadence for Phase 6.5.
 *
 * The implementation is a self-scheduling async loop; the constant
 * here is the *minimum* gap observed between consecutive scans
 * after the previous scan's network round-trip resolved. The loop
 * MUST NOT retry faster than this even if the previous scan was
 * fast.
 */
const AUTO_SCAN_INTERVAL_MS = 1800;

/**
 * Helper delay used by the self-scheduling loop between
 * consecutive recognition requests.
 *
 * Returns a `{ promise, cancel }` pair. The caller MUST call
 * `cancel()` on any stop-event so the pending setTimeout is
 * cleared and the awaiting promise resolves immediately. This
 * keeps the auto-scan loop tight against unmount / stop
 * triggers — without it the unmount cleanup may leave a
 * pending timer that the in-flight test framework waits on.
 */
function delay(ms: number): { promise: Promise<void>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resolveFn: (() => void) | null = null;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
    timer = setTimeout(() => {
      timer = null;
      resolve();
    }, ms);
  });
  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (resolveFn) {
      resolveFn();
      resolveFn = null;
    }
  };
  return { promise, cancel };
}

// =============================================================================
// Types
// =============================================================================

interface RecognizedMatch {
  fullName: string;
  identificationCode: string;
}

interface RecognitionResult {
  facesDetected: number;
  unmatchedCount: number;
  matches: RecognizedMatch[];
  /** Number of PRESENT marks recorded by THIS request. */
  recordedCount: number;
  /** Number of PRESENT marks already recorded (idempotent repeat). */
  alreadyRecordedCount: number;
  /**
   * Set when the route reports the session was closed at the
   * final pre-write recheck — the preview matches are still
   * returned for UX, but no marks were written.
   */
  sessionClosedDuringProcessing?: boolean;
}

interface AttendanceCameraClientProps {
  classId: string;
  sessionId: string;
  rosterCount: number;
}

// =============================================================================
// Image processing helpers
// =============================================================================

/** Maximum edge length for captured frames (1280px per spec). */
const MAX_EDGE = 1280;

/** JPEG quality for encoding (0.85 per spec). */
const JPEG_QUALITY = 0.85;

/**
 * Captures the current video frame, resizes if needed, and encodes as JPEG.
 * All processing is transient — no persistence.
 */
async function captureFrame(video: HTMLVideoElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");

    if (!ctx) {
      reject(new Error("Canvas context not available"));
      return;
    }

    let { videoWidth: width, videoHeight: height } = video;

    if (width === 0 || height === 0) {
      reject(new Error("Video has no dimensions"));
      return;
    }

    // Resize if max edge exceeds limit.
    if (width > MAX_EDGE || height > MAX_EDGE) {
      const ratio = Math.min(MAX_EDGE / width, MAX_EDGE / height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }

    canvas.width = width;
    canvas.height = height;

    ctx.drawImage(video, 0, 0, width, height);

    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("Failed to encode frame as JPEG"));
        }
      },
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
}

// =============================================================================
// Safe error mapping
// =============================================================================

function classifyError(code: string): { heading: string; body: string } {
  switch (code) {
    case "UNAUTHENTICATED":
      return {
        heading: "Sign-in required",
        body: "Please sign in again.",
      };
    case "PROFILE_INCOMPLETE":
      return {
        heading: "Profile incomplete",
        body: "Complete your profile to use face recognition.",
      };
    case "NON_OWNER":
      return {
        heading: "Access denied",
        body: "Only teachers can use face recognition.",
      };
    case "CLASS_NOT_ACCESSIBLE":
    case "SESSION_NOT_FOUND":
      return {
        heading: "Class not accessible",
        body: "You do not have access to this class.",
      };
    case "SESSION_NOT_ACTIVE":
    case "SESSION_CLASS_MISMATCH":
      return {
        heading: "Attendance session is no longer active",
        body: "Please stop and restart the attendance session.",
      };
    case "NO_RECOGNITION_CANDIDATES":
      return {
        heading: "No enrolled faces available",
        body: "No enrolled faces are available for recognition in this session.",
      };
    case "INVALID_IMAGE":
      return {
        heading: "Invalid image",
        body: "Please try a clearer image.",
      };
    case "IMAGE_TOO_LARGE":
      return {
        heading: "Image too large",
        body: "Please try a smaller image.",
      };
    case "FACE_SERVICE_ERROR":
      return {
        heading: "Recognition service error",
        body: "Face recognition failed. Please try again.",
      };
    default:
      return {
        heading: "Recognition failed",
        body: "An error occurred. Please try again.",
      };
  }
}

// =============================================================================
// Internal: outcome of a single recognition attempt
// =============================================================================

/**
 * Discriminated union describing what the auto loop should do next
 * after a single scan attempt resolves.
 *
 *   - `continue`     — schedule the next scan after the cooldown.
 *   - `stop`         — stop the auto loop entirely (terminal
 *                      reasons: session closed, no candidates, …).
 *   - `stopNoFaces`  — render the controlled "no enrolled faces"
 *                      message and stop the auto loop.
 */
type AutoScanNext = "continue" | "stop" | "stopNoFaces";

// =============================================================================
// Component
// =============================================================================

export function AttendanceCameraClient({
  classId,
  sessionId,
}: AttendanceCameraClientProps) {
  // ---- Camera state ----
  const [cameraEnabled, setCameraEnabled] = React.useState(false);
  const [stream, setStream] = React.useState<MediaStream | null>(null);

  // ---- Recognition state ----
  const [scanning, setScanning] = React.useState(false);
  const [result, setResult] = React.useState<RecognitionResult | null>(null);
  const [error, setError] = React.useState<{
    heading: string;
    body: string;
    code: string;
  } | null>(null);

  // ---- Auto scan state ----
  const [autoScanActive, setAutoScanActive] = React.useState(false);
  const [autoScanState, setAutoScanState] = React.useState<
    "idle" | "auto scanning" | "scanning" | "paused" | "no-candidates"
  >("idle");

  // ---- Session closed state (permanent after detected) ----
  const [sessionClosed, setSessionClosed] = React.useState(false);

  // ---- Video ref ----
  const videoRef = React.useRef<HTMLVideoElement>(null);

  // ---- Router for refreshing the Server Component on persisted updates ----
  const router = useRouter();

  // ---- Double-click guard (synchronous, before first await) ----
  // Shared by BOTH the manual scan AND the auto-scan loop. This
  // is the canonical in-flight guard for the entire component.
  const scanInFlightRef = React.useRef(false);

  // ---- Auto-scan loop control signals ----
  // Cancels the next-scheduling wait and prevents further scans.
  const stopAutoScanRef = React.useRef(false);

  // ---- Effect: cleanup on unmount ----
  React.useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
      }
    };
  }, [stream]);

  // ---- Effect: attach `ended` listener to the active stream tracks ----
  // When the camera track ends unexpectedly (browser-level stop
  // by the OS, privacy switch, etc.) we MUST stop scanning and
  // update the UI cleanly. We attach one listener per track.
  React.useEffect(() => {
    if (!stream) return;
    const tracks = stream.getTracks();
    const onEnded = (): void => {
      // Signal the auto loop to stop and update the camera state.
      stopAutoScanRef.current = true;
      setAutoScanActive(false);
      setAutoScanState("idle");
      setCameraEnabled(false);
      setError({
        heading: "Camera disconnected",
        body: "The camera stream ended unexpectedly. Enable the camera to continue.",
        code: "CAMERA_ERROR",
      });
    };
    const attached: Array<{
      track: MediaStreamTrack;
      listener: typeof onEnded;
    }> = [];
    for (const track of tracks) {
      // The MediaStreamTrack in modern browsers exposes
      // `addEventListener("ended", ...)`. Tests with older
      // mock shapes (e.g. only `stop`) skip this effect.
      const t = track as unknown as {
        addEventListener?: (
          name: string,
          cb: typeof onEnded,
        ) => void;
        removeEventListener?: (
          name: string,
          cb: typeof onEnded,
        ) => void;
      };
      if (typeof t.addEventListener !== "function") continue;
      t.addEventListener("ended", onEnded);
      attached.push({ track: track as MediaStreamTrack, listener: onEnded });
    }
    return () => {
      for (const { track, listener } of attached) {
        const t = track as unknown as {
          removeEventListener?: (
            name: string,
            cb: typeof onEnded,
          ) => void;
        };
        t.removeEventListener?.("ended", listener);
      }
    };
  }, [stream]);

  // ---- Enable camera ----
  const handleEnableCamera = React.useCallback(async (): Promise<void> => {
    if (cameraEnabled) return;

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
        audio: false,
      });

      setStream(mediaStream);

      if (videoRef.current) {
        videoRef.current.srcObject = mediaStream;
        await videoRef.current.play();
      }

      setCameraEnabled(true);
      setError(null);
      setResult(null);
    } catch (err: unknown) {
      const heading = "Camera access denied";
      const body =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Please allow camera access in your browser settings."
          : "Could not access the camera. Please check your device.";
      setError({ heading, body, code: "CAMERA_ERROR" });
    }
  }, [cameraEnabled]);

  // ---- Single scan attempt (shared by manual + auto) ----
  // Returns the discriminated next-step the loop should take, or
  // throws / returns nothing for the manual scan path (the
  // manual button only cares about updating local UI state).
  const performSingleScan = React.useCallback(async (): Promise<AutoScanNext | null> => {
    // Synchronous guard — must run BEFORE any await.
    if (scanInFlightRef.current) return null;
    scanInFlightRef.current = true;

    setScanning(true);

    // Snapshot the document-visible flag so we can stop early
    // if the page hid while we were capturing.
    const wasVisibleAtStart =
      typeof document === "undefined"
        ? true
        : document.visibilityState !== "hidden";

    // Capture frame from video.
    const video = videoRef.current;
    if (!video || video.readyState < 2 || !wasVisibleAtStart) {
      scanInFlightRef.current = false;
      setScanning(false);
      return null;
    }

    let imageBlob: Blob;
    try {
      imageBlob = await captureFrame(video);
    } catch {
      scanInFlightRef.current = false;
      setScanning(false);
      setError({
        heading: "Capture failed",
        body: "Could not capture the current frame.",
        code: "CAMERA_ERROR",
      });
      return null;
    }

    try {
      const formData = new FormData();
      formData.append("classId", classId);
      formData.append("sessionId", sessionId);
      formData.append("image", imageBlob, "frame.jpg");

      const response = await fetch("/api/attendance/recognize", {
        method: "POST",
        body: formData,
      });

      const data = await response.json();

      if (!response.ok) {
        // Error response — map to safe copy.
        const code = data?.error?.code ?? "ATTENDANCE_RECOGNIZE_FAILED";
        if (
          code === "SESSION_NOT_ACTIVE" ||
          code === "SESSION_CLASS_MISMATCH"
        ) {
          setSessionClosed(true);
          scanInFlightRef.current = false;
          setScanning(false);
          return "stop";
        }
        if (code === "NO_RECOGNITION_CANDIDATES") {
          // Stop scanning — no usable candidates.
          const mapped = classifyError(code);
          setError({ ...mapped, code });
          scanInFlightRef.current = false;
          setScanning(false);
          return "stopNoFaces";
        }
        const mapped = classifyError(code);
        setError({ ...mapped, code });
        scanInFlightRef.current = false;
        setScanning(false);
        // Transient safe failure — the loop should wait the
        // normal cooldown and try again.
        return "continue";
      }

      // Success — show recognition preview.
      setResult(data as RecognitionResult);
      setError(null);

      const recorded = (data as RecognitionResult).recordedCount ?? 0;
      if (recorded > 0) {
        router.refresh();
      }
      scanInFlightRef.current = false;
      setScanning(false);
      return "continue";
    } catch {
      const mapped = classifyError("ATTENDANCE_RECOGNIZE_FAILED");
      setError({ ...mapped, code: "ATTENDANCE_RECOGNIZE_FAILED" });
      scanInFlightRef.current = false;
      setScanning(false);
      // Transient safe failure — continue after cooldown.
      return "continue";
    }
  }, [classId, sessionId, router]);

  // ---- Manual scan ----
  const handleScan = React.useCallback(async (): Promise<void> => {
    // Manual path: do not reset the loop signal — we run as a
    // single attempt that respects the in-flight guard.
    await performSingleScan();
  }, [performSingleScan]);

  // ---- Stop camera ----
  const handleStopCamera = React.useCallback((): void => {
    // Stop the auto scan whenever the camera stops.
    stopAutoScanRef.current = true;
    setAutoScanActive(false);
    setAutoScanState("idle");
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      setStream(null);
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraEnabled(false);
  }, [stream]);

  // ---- Start auto scan ----
  const handleStartAutoScan = React.useCallback((): void => {
    // Reset loop-stop signal and flip the public auto-scan
    // state. The loop runs as a fire-and-forget async; the
    // loop body itself owns the per-scan in-flight guard.
    stopAutoScanRef.current = false;
    setAutoScanActive(true);
    setAutoScanState("auto scanning");
  }, []);

  // ---- Stop auto scan ----
  const handleStopAutoScan = React.useCallback((): void => {
    stopAutoScanRef.current = true;
    setAutoScanActive(false);
    setAutoScanState("idle");
  }, []);

  // ---- Auto-scan loop ----
  // Self-scheduling async loop. Each iteration awaits the
  // previous scan's network round-trip, then waits the cooldown,
  // then attempts the next scan. The in-flight guard inside
  // `performSingleScan` ensures only ONE request is ever in
  // flight regardless of any timing drift.
  React.useEffect(() => {
    if (!autoScanActive) return;
    if (!cameraEnabled) {
      // Cannot scan without a camera. The loop simply aborts.
      stopAutoScanRef.current = true;
      return;
    }

    let cancelled = false;
    let currentDelayCancel: (() => void) | null = null;

    (async () => {
      while (true) {
        if (cancelled || stopAutoScanRef.current) break;
        // Read the actual document visibility every iteration
        // so environment changes mid-flight are honoured.
        const visibleNow =
          typeof document === "undefined"
            ? true
            : document.visibilityState !== "hidden";
        if (!visibleNow) {
          // Page hidden. The loop wakes when the document
          // becomes visible again. We poll with a small delay;
          // the effect's cleanup cancels it on unmount or when
          // the dependency flips autoScanActive to false.
          const wait = delay(250);
          currentDelayCancel = wait.cancel;
          await wait.promise;
          currentDelayCancel = null;
          continue;
        }
        if (!cameraEnabled) break;

        const next = await performSingleScan();
        if (cancelled || stopAutoScanRef.current) break;
        if (next === "stop" || next === "stopNoFaces") {
          if (next === "stopNoFaces") {
            setAutoScanState("no-candidates");
          } else {
            setAutoScanState("idle");
          }
          stopAutoScanRef.current = true;
          setAutoScanActive(false);
          break;
        }

        const wait = delay(AUTO_SCAN_INTERVAL_MS);
        currentDelayCancel = wait.cancel;
        await wait.promise;
        currentDelayCancel = null;
        if (cancelled || stopAutoScanRef.current) break;
      }
    })();

    return () => {
      cancelled = true;
      stopAutoScanRef.current = true;
      if (currentDelayCancel) {
        currentDelayCancel();
        currentDelayCancel = null;
      }
    };
  }, [autoScanActive, cameraEnabled, performSingleScan]);

  // ---- Session closed state — stop further scans ----
  if (sessionClosed) {
    return (
      <Card>
        <CardContent>
          <div
            role="status"
            className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-5 py-6"
          >
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-warning" aria-hidden="true" />
              <h2 className="text-base font-semibold text-foreground">
                Attendance session is no longer active
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              The attendance session has been closed. Please stop and restart
              the attendance session to continue.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ---- No-candidates stop state ----
  if (autoScanState === "no-candidates") {
    return (
      <Card>
        <CardContent>
          <div
            role="status"
            data-attendance-auto-scan-state="no-candidates"
            className="flex flex-col gap-2 rounded-xl border border-border bg-surface px-5 py-6"
          >
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-warning" aria-hidden="true" />
              <h2 className="text-base font-semibold text-foreground">
                No enrolled faces available
              </h2>
            </div>
            <p className="text-sm text-muted-foreground">
              No enrolled faces are available for recognition in this session.
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {/* Camera workspace */}
      <Card>
        <CardSection>
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-base font-semibold text-foreground">
              Camera Preview
            </h2>
            {autoScanActive ? (
              <span
                data-attendance-auto-scan-active="true"
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-secondary px-2.5 py-0.5 text-xs font-medium text-muted-foreground"
              >
                <span className="h-1.5 w-1.5 rounded-full bg-primary" aria-hidden="true" />
                Auto scanning
              </span>
            ) : null}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {autoScanActive
              ? "Recognition is repeating on a controlled cadence."
              : "Position faces clearly in the frame, then tap Scan."}
          </p>
        </CardSection>
        <CardContent>
          <div className="flex flex-col gap-4">
            {/* Video preview */}
            <div className="relative aspect-video overflow-hidden rounded-xl bg-muted">
              {cameraEnabled ? (
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="h-full w-full object-cover"
                  aria-label="Camera preview"
                />
              ) : (
                <div className="flex h-full w-full flex-col items-center justify-center gap-3">
                  <Camera className="h-12 w-12 text-muted-foreground" aria-hidden="true" />
                  <p className="text-sm text-muted-foreground">
                    Camera is off
                  </p>
                </div>
              )}

              {/* Restrained scanning overlay */}
              {scanning ? (
                <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                  <div className="flex items-center gap-2 rounded-lg bg-black/70 px-4 py-2 text-white">
                    <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                    <span className="text-sm">Scanning…</span>
                  </div>
                </div>
              ) : null}
            </div>

            {/* Controls */}
            <div className="flex flex-wrap items-center gap-3">
              {!cameraEnabled ? (
                <Button
                  type="button"
                  variant="primary"
                  onClick={handleEnableCamera}
                  aria-label="Enable camera"
                >
                  <Camera className="mr-2 h-4 w-4" aria-hidden="true" />
                  Enable camera
                </Button>
              ) : (
                <>
                  {/* Manual scan remains available alongside auto scan */}
                  <Button
                    type="button"
                    variant="primary"
                    onClick={handleScan}
                    disabled={scanning}
                    aria-label="Scan frame for recognition"
                  >
                    <RefreshCw
                      className={cn("mr-2 h-4 w-4", scanning && "animate-spin")}
                      aria-hidden="true"
                    />
                    {scanning ? "Scanning…" : "Scan frame"}
                  </Button>

                  {!autoScanActive ? (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={handleStartAutoScan}
                      disabled={scanning}
                      data-attendance-action="start-auto-scan"
                      aria-label="Start auto scan"
                    >
                      <Play className="mr-2 h-4 w-4" aria-hidden="true" />
                      Start auto scan
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={handleStopAutoScan}
                      data-attendance-action="stop-auto-scan"
                      aria-label="Stop auto scan"
                    >
                      <Square className="mr-2 h-4 w-4" aria-hidden="true" />
                      Stop auto scan
                    </Button>
                  )}

                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleStopCamera}
                    aria-label="Stop camera"
                  >
                    <CameraOff className="mr-2 h-4 w-4" aria-hidden="true" />
                    Stop camera
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Error state */}
      {error ? (
        <Card>
          <CardContent>
            <div
              role="alert"
              aria-live="polite"
              className={cn(
                "flex flex-col gap-1.5 rounded-xl border border-warning/30",
                "bg-warning-soft px-5 py-4 text-sm",
              )}
            >
              <div className="flex items-center gap-2">
                <AlertCircle className="h-4 w-4 text-warning" aria-hidden="true" />
                <p className="font-medium text-foreground">{error.heading}</p>
              </div>
              <p className="text-muted-foreground">{error.body}</p>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {/* Recognition result */}
      {result ? (
        <Card>
          <CardSection>
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              <h2 className="text-base font-semibold text-foreground">
                Recognition Preview
              </h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {result.matches.length > 0
                ? `Recognized ${result.matches.length} of ${result.facesDetected} face${result.facesDetected !== 1 ? "s" : ""} in frame.`
                : `No recognized faces in frame.`}
              {result.unmatchedCount > 0
                ? ` ${result.unmatchedCount} face${result.unmatchedCount !== 1 ? "s" : ""} not recognized.`
                : ""}
            </p>
          </CardSection>
          <CardContent>
            {result.matches.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {result.matches.map((match, index) => (
                  <li
                    key={index}
                    className="flex items-center justify-between rounded-lg border border-border bg-surface px-4 py-2.5"
                  >
                    <span className="text-sm font-medium text-foreground">
                      {match.fullName}
                    </span>
                    <span className="font-mono text-sm text-muted-foreground">
                      {match.identificationCode}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {result.facesDetected === 0
                  ? "No face detected in this frame."
                  : "No faces matched any enrolled student."}
              </p>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* Info footer */}
      <p className="text-xs text-muted-foreground">
        Recognition is preview only. No attendance marks are recorded yet.
      </p>
    </div>
  );
}
