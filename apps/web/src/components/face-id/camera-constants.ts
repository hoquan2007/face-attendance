/**
 * Centralized constants for the browser camera foundation.
 *
 * PHASE 4.5A — Browser Camera Foundation.
 *
 * This module is intentionally client-safe. It MUST NOT import any
 * server-only modules (face-service-client, encryption, Mongoose, or
 * any environment secret). It only defines stable error codes,
 * friendly user-facing messages, and the getUserMedia constraints used
 * by the `useFaceCamera` hook and the `CameraPreview` component.
 *
 * Why a constants file?
 *   - Keep the stable error code set in one place so future enrollment
 *     UI (PHASE 4.5B and beyond) can branch on a closed enum instead
 *     of free-form strings.
 *   - Keep friendly user-facing copy out of React components so it is
 *     easy to read, easy to translate later, and easy to test in
 *     isolation.
 *   - Keep getUserMedia constraints centralized so a future change to
 *     resolution / facing mode happens in exactly one place.
 *
 * Privacy posture:
 *   - `audio: false` is mandatory. This file enforces it.
 *   - The camera does NOT capture, encode, upload, or persist anything
 *     in PHASE 4.5A. The component layer renders a live preview only.
 */

/**
 * Stable error codes for the browser camera foundation.
 *
 * These codes are deliberately a closed enum so UI can map them to
 * localized copy without depending on raw browser exception names.
 *
 * Browser exceptions that may surface are documented inline next to
 * the matching code below.
 */
export const CAMERA_ERROR_CODES = {
  /**
   * The user (or their browser policy) blocked camera access.
   * Typical browser exception: `NotAllowedError`.
   */
  CAMERA_PERMISSION_DENIED: "CAMERA_PERMISSION_DENIED",

  /**
   * No camera device was found on this machine.
   * Typical browser exception: `NotFoundError`, `OverconstrainedError`.
   */
  CAMERA_NOT_FOUND: "CAMERA_NOT_FOUND",

  /**
   * The camera is in use by another application, or the OS refused
   * to give this origin access.
   * Typical browser exception: `NotReadableError`.
   */
  CAMERA_IN_USE: "CAMERA_IN_USE",

  /**
   * `navigator.mediaDevices.getUserMedia` is unavailable because the
   * page is not loaded in a secure context (HTTPS or localhost).
   * Typical browser exception: `SecurityError`.
   */
  CAMERA_INSECURE_CONTEXT: "CAMERA_INSECURE_CONTEXT",

  /**
   * Any other failure — hardware error, browser policy, unexpected
   * exception. The raw exception name / stack is NEVER surfaced.
   * Typical browser exception: anything not listed above.
   */
  CAMERA_UNAVAILABLE: "CAMERA_UNAVAILABLE",
} as const;

export type CameraErrorCode =
  (typeof CAMERA_ERROR_CODES)[keyof typeof CAMERA_ERROR_CODES];

/**
 * Friendly user-facing messages for each camera error code.
 *
 * Wording is short, helpful, and free of legal / privacy guarantees.
 * The component layer is responsible for rendering these as text and
 * for any surrounding presentation.
 *
 * Phase 4.5A is video-only — these messages explicitly do NOT
 * describe upload, encryption, or retention behavior.
 */
export const CAMERA_ERROR_MESSAGES: Record<CameraErrorCode, string> = {
  CAMERA_PERMISSION_DENIED:
    "Camera access was blocked. Allow camera access in your browser and try again.",
  CAMERA_NOT_FOUND: "No camera was found on this device.",
  CAMERA_IN_USE:
    "The camera is currently being used by another application.",
  CAMERA_INSECURE_CONTEXT:
    "Camera access requires HTTPS or localhost.",
  CAMERA_UNAVAILABLE:
    "The camera could not be started right now. Please try again.",
};

/**
 * The video constraints applied to `getUserMedia` in PHASE 4.5A.
 *
 * `facingMode: "user"` is `ideal`, not `exact`, so desktops without a
 * front camera still work (the browser picks the best match).
 *
 * `width` / `height` are `ideal`, not `exact`, because webcams vary.
 * The 1280×720 target matches the resolution target documented in
 * `docs/frontend-design.md` (1280×720 baseline).
 */
export const CAMERA_VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  facingMode: "user",
  width: { ideal: 1280 },
  height: { ideal: 720 },
};

/**
 * The audio constraints applied to `getUserMedia` in PHASE 4.5A.
 *
 * PHASE 4.5A MUST NOT request microphone access. The microphone LED
 * on supported platforms lights up the moment audio tracks are
 * acquired; passing `audio: false` guarantees that never happens for
 * enrollment.
 */
export const CAMERA_AUDIO_CONSTRAINTS = false as const;
