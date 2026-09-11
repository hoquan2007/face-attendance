/**
 * Public surface for the browser camera foundation.
 *
 * PHASE 4.5A — Browser Camera Foundation.
 * PHASE 4.5B2 — Video Frame Capture → JPEG Blob Foundation (capture
 *   utilities added here).
 *
 * Consumers should import from `@/components/face-id` rather than
 * reaching into the individual files. This keeps the public contract
 * small and explicit.
 *
 * Camera foundation (PHASE 4.5A):
 *   - `CameraPreview` : the React component
 *   - `useFaceCamera` : the underlying hook (for advanced consumers)
 *   - `CAMERA_ERROR_CODES` : closed enum of stable camera error codes
 *   - `CAMERA_ERROR_MESSAGES` : friendly copy for each error code
 *
 * Frame capture (PHASE 4.5B2):
 *   - `captureVideoFrame` : captures one video frame → JPEG Blob
 *   - `calculateCaptureDimensions` : pure dimension resize helper
 *   - `CAPTURE_ERROR_CODES` : closed enum of stable capture error codes
 *   - `CAPTURE_ERROR_MESSAGES` : friendly copy for each capture error code
 *
 * Internal helpers (mapping, error coercion, status text) are NOT
 * re-exported here.
 */

export { CameraPreview } from "@/components/face-id/camera-preview";
export { useFaceCamera } from "@/components/face-id/use-face-camera";
export type {
  FaceCameraStatus,
  UseFaceCamera,
} from "@/components/face-id/use-face-camera";
export {
  CAMERA_ERROR_CODES,
  CAMERA_ERROR_MESSAGES,
} from "@/components/face-id/camera-constants";
export type { CameraErrorCode } from "@/components/face-id/camera-constants";
export type { CameraErrorShape } from "@/components/face-id/camera-errors";

// PHASE 4.5B2 — Frame capture
export { captureVideoFrame } from "@/components/face-id/capture-video-frame";
export {
  CAPTURE_ERROR_CODES,
  CAPTURE_ERROR_MESSAGES,
} from "@/components/face-id/capture-video-frame";
export type {
  CaptureErrorCode,
  CaptureErrorShape,
  CapturedVideoFrame,
} from "@/components/face-id/capture-video-frame";
// `calculateCaptureDimensions` is an internal helper used by
// `captureVideoFrame` and the PHASE 4.5B2 test suite only. PHASE
// 4.5B3 consumers must not depend on it — the only supported way to
// resize a captured frame is to call `captureVideoFrame(video)`.
// The helper remains exported from its source module so the tests
// can import it directly.
