/**
 * `AttendanceCameraClient` — Client Component for live face recognition preview.
 *
 * PHASE 6.3 — LIVE FACE RECOGNITION PREVIEW.
 *
 * This is the ONLY browser-side component that:
 *   - Requests camera access via `getUserMedia`
 *   - Captures video frames as JPEG
 *   - Sends frames to `/api/attendance/recognize`
 *   - Displays recognition preview results
 *
 * Privacy contract:
 *   - Camera starts ONLY after explicit user action (Enable camera button)
 *   - Camera stops on component unmount or Stop camera button
 *   - No localStorage, sessionStorage, IndexedDB, or Cache API
 *   - No automatic frame capture or continuous scanning
 *   - No image persistence
 *
 * Double-click protection:
 *   - Synchronous in-flight ref guard collapses two rapid clicks into ONE request
 *   - Scan button disabled while request is in flight
 *   - No automatic retry
 *
 * Results:
 *   - Safe display data only: fullName, identificationCode
 *   - NO studentUserId, candidateKey, embedding, centroid, FaceProfile id
 */

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Camera, CameraOff, RefreshCw, AlertCircle, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardSection } from "@/components/ui/card";
import { cn } from "@/lib/utils";

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

  // ---- Session closed state (permanent after detected) ----
  const [sessionClosed, setSessionClosed] = React.useState(false);

  // ---- Video ref ----
  const videoRef = React.useRef<HTMLVideoElement>(null);

  // ---- Router for refreshing the Server Component on persisted updates ----
  const router = useRouter();

  // ---- Double-click guard (synchronous, before first await) ----
  const scanInFlightRef = React.useRef(false);

  // ---- Cleanup on unmount ----
  React.useEffect(() => {
    return () => {
      if (stream) {
        stream.getTracks().forEach((track) => track.stop());
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

  // ---- Stop camera ----
  const handleStopCamera = React.useCallback((): void => {
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      setStream(null);
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setCameraEnabled(false);
  }, [stream]);

  // ---- Scan frame ----
  const handleScan = React.useCallback(async (): Promise<void> => {
    // Synchronous guard — must run BEFORE any await.
    if (scanInFlightRef.current) return;
    scanInFlightRef.current = true;

    // Clear previous error.
    setError(null);

    // Capture frame from video.
    const video = videoRef.current;
    if (!video || video.readyState < 2) {
      scanInFlightRef.current = false;
      setError({
        heading: "Camera not ready",
        body: "Please wait for the camera to initialize.",
        code: "CAMERA_ERROR",
      });
      return;
    }

    let imageBlob: Blob;
    try {
      imageBlob = await captureFrame(video);
    } catch {
      scanInFlightRef.current = false;
      setError({
        heading: "Capture failed",
        body: "Could not capture the current frame.",
        code: "CAMERA_ERROR",
      });
      return;
    }

    setScanning(true);

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
          return;
        }
        const mapped = classifyError(code);
        setError({ ...mapped, code });
        scanInFlightRef.current = false;
        setScanning(false);
        return;
      }

      // Success — show recognition preview.
      // PHASE 6.4: a successful scan may have persisted PRESENT
      // marks server-side. We refresh the Server Component so
      // the persisted present list is re-rendered authoritatively.
      // We do NOT maintain a second permanent attendance state in
      // client memory — the preview above is intentionally
      // transient.
      setResult(data as RecognitionResult);
      setError(null);

      // Trigger a Server Component refresh only when at least
      // one mark was newly recorded. Repeated scans where every
      // matched student was already marked do not need a refresh
      // (the persisted state has not changed), and no-face
      // responses obviously do not need one either.
      const recorded = (data as RecognitionResult).recordedCount ?? 0;
      if (recorded > 0) {
        router.refresh();
      }
    } catch {
      const mapped = classifyError("ATTENDANCE_RECOGNIZE_FAILED");
      setError({ ...mapped, code: "ATTENDANCE_RECOGNIZE_FAILED" });
    } finally {
      scanInFlightRef.current = false;
      setScanning(false);
    }
  }, [classId, sessionId, router]);

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

  return (
    <div className="flex flex-col gap-5">
      {/* Camera workspace */}
      <Card>
        <CardSection>
          <h2 className="text-base font-semibold text-foreground">
            Camera Preview
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Position faces clearly in the frame, then tap Scan.
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

              {/* Scanning overlay */}
              {scanning && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/30">
                  <div className="flex items-center gap-2 rounded-lg bg-black/70 px-4 py-2 text-white">
                    <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
                    <span className="text-sm">Recognizing…</span>
                  </div>
                </div>
              )}
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
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleStopCamera}
                    disabled={scanning}
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
