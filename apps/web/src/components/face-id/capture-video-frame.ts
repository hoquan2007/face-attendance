/**
 * Video frame capture utility — JPEG Blob foundation.
 *
 * PHASE 4.5B2 — Video Frame Capture → JPEG Blob Foundation.
 *
 * Scope:
 *   - Capture one current frame from an already-ready HTMLVideoElement.
 *   - Draw the frame onto an ephemeral in-memory HTMLCanvasElement.
 *   - Resize while preserving source aspect ratio (max long edge = 1280,
 *     no upscale).
 *   - Encode as JPEG (quality 0.85) via `canvas.toBlob`.
 *   - Return a typed `CapturedVideoFrame` (blob + metadata).
 *
 * This module is intentionally client-safe. It MUST NOT import any
 * server-only module (face-service-client, encryption, Mongoose, any
 * env secret). It performs ZERO network requests and produces ZERO
 * persistent side-effects.
 *
 * Out of scope:
 *   - getUserMedia / camera startup (consumes an already-ready video).
 *   - Base64 / data URLs.
 *   - URL.createObjectURL (no preview yet).
 *   - Face detection, face cropping, overlays, guides, watermarks.
 *   - Submission to any enrollment API.
 *   - Canvas rendered into the page DOM.
 *
 * Mirror note:
 *   The CSS `[transform:scaleX(-1)]` applied to CameraPreview's <video>
 *   does NOT affect source pixels drawn via drawImage. No ctx.scale or
 *   ctx.translate mirror transform is applied here. The captured image
 *   preserves the original camera frame orientation.
 */

/**
 * Stable error codes for frame capture operations.
 *
 * These codes are deliberately a closed enum so callers can branch on
 * them without depending on raw browser exception names or stack
 * traces.
 *
 * Camera startup errors (CAMERA_PERMISSION_DENIED, CAMERA_NOT_FOUND,
 * etc.) belong to `camera-errors.ts` — they are separate from capture
 * errors which relate to frame processing and encoding.
 */
export const CAPTURE_ERROR_CODES = {
  /**
   * The video element has not yet produced a usable frame.
   * The camera stream exists but `readyState < HAVE_CURRENT_DATA`,
   * or `videoWidth` / `videoHeight` is zero.
   */
  FRAME_NOT_READY: "FRAME_NOT_READY",

  /**
   * The browser could not obtain a 2D rendering context from the
   * ephemeral canvas. This is extremely rare in practice.
   */
  FRAME_CANVAS_UNAVAILABLE: "FRAME_CANVAS_UNAVAILABLE",

  /**
   * The canvas encoding step (`toBlob`) returned null — the browser
   * failed to encode the frame as a JPEG.
   */
  FRAME_ENCODING_FAILED: "FRAME_ENCODING_FAILED",
} as const;

export type CaptureErrorCode =
  (typeof CAPTURE_ERROR_CODES)[keyof typeof CAPTURE_ERROR_CODES];

/**
 * Friendly user-facing messages for each capture error code.
 * Wording is short, helpful, and free of implementation details.
 */
export const CAPTURE_ERROR_MESSAGES: Record<CaptureErrorCode, string> = {
  [CAPTURE_ERROR_CODES.FRAME_NOT_READY]:
    "The camera has not produced a frame yet. Please try again.",
  [CAPTURE_ERROR_CODES.FRAME_CANVAS_UNAVAILABLE]:
    "The image capture engine is unavailable.",
  [CAPTURE_ERROR_CODES.FRAME_ENCODING_FAILED]:
    "The captured frame could not be encoded. Please try again.",
};

/**
 * Shape of a stable, user-safe capture error.
 */
export interface CaptureErrorShape {
  code: CaptureErrorCode;
  message: string;
}

/**
 * The maximum length of the long edge (width or height) of the
 * captured JPEG.
 *
 * Rules:
 *   - If source long edge > 1280 → scale down proportionally.
 *   - If source long edge <= 1280 → DO NOT upscale.
 *
 * This is a development-quality setting. The Next.js sample endpoint
 * remains authoritative for its existing 1.5 MB request limit.
 */
export const FACE_CAPTURE_MAX_LONG_EDGE = 1280;

/**
 * JPEG encoding quality for `canvas.toBlob`.
 * A value of 0.85 produces good quality at a reasonable file size.
 * This is a development-quality setting.
 */
export const FACE_CAPTURE_JPEG_QUALITY = 0.85;

/**
 * The MIME type used for the captured frame.
 */
export const FACE_CAPTURE_MIME_TYPE = "image/jpeg" as const;

/**
 * Result of a successful `captureVideoFrame` call.
 */
export interface CapturedVideoFrame {
  /** The JPEG blob. Held only in browser memory — never written to
   *  disk, IndexedDB, or sent over the network in this phase. */
  blob: Blob;
  /**
   * MIME type of the blob. Always `"image/jpeg"` in PHASE 4.5B2.
   */
  mimeType: typeof FACE_CAPTURE_MIME_TYPE;
  /**
   * Output width of the captured frame in pixels.
   * May be less than source width if source was downscaled.
   */
  width: number;
  /**
   * Output height of the captured frame in pixels.
   * May be less than source height if source was downscaled.
   */
  height: number;
  /**
   * Size of the JPEG blob in bytes.
   */
  size: number;
}

/**
 * Internal — converts a capture error code to its stable shape.
 */
function makeCaptureError(code: CaptureErrorCode): CaptureErrorShape {
  return {
    code,
    message: CAPTURE_ERROR_MESSAGES[code],
  };
}

/**
 * Calculates output dimensions for frame capture.
 *
 * Preserves source aspect ratio.
 * Scales down if the long edge exceeds `maxLongEdge`.
 * Does NOT upscale if the long edge is at or below `maxLongEdge`.
 *
 * @param sourceWidth  - Source frame width in pixels. Must be > 0.
 * @param sourceHeight - Source frame height in pixels. Must be > 0.
 * @param maxLongEdge  - Maximum allowed length of the long edge.
 * @returns An object with `width` and `height` as positive integers.
 * @throws {Error} If `sourceWidth` or `sourceHeight` is not a positive
 *                 finite integer, or if `maxLongEdge` is not a positive
 *                 finite number.
 */
export function calculateCaptureDimensions(
  sourceWidth: number,
  sourceHeight: number,
  maxLongEdge: number,
): { width: number; height: number } {
  if (
    !Number.isFinite(sourceWidth) ||
    sourceWidth <= 0 ||
    !Number.isInteger(sourceWidth)
  ) {
    throw new Error(
      "calculateCaptureDimensions: sourceWidth must be a positive integer",
    );
  }
  if (
    !Number.isFinite(sourceHeight) ||
    sourceHeight <= 0 ||
    !Number.isInteger(sourceHeight)
  ) {
    throw new Error(
      "calculateCaptureDimensions: sourceHeight must be a positive integer",
    );
  }
  if (!Number.isFinite(maxLongEdge) || maxLongEdge <= 0) {
    throw new Error(
      "calculateCaptureDimensions: maxLongEdge must be a positive number",
    );
  }

  const sourceLongEdge = Math.max(sourceWidth, sourceHeight);

  // No upscale: if the source long edge is at or below the max, use
  // the source dimensions directly.
  if (sourceLongEdge <= maxLongEdge) {
    return { width: sourceWidth, height: sourceHeight };
  }

  // Scale proportionally so the long edge equals maxLongEdge.
  const ratio = maxLongEdge / sourceLongEdge;
  const scaledWidth = Math.round(sourceWidth * ratio);
  const scaledHeight = Math.round(sourceHeight * ratio);

  return { width: scaledWidth, height: scaledHeight };
}

/**
 * Validates that the video element has produced a usable frame.
 *
 * Checks:
 *   - `videoWidth > 0`
 *   - `videoHeight > 0`
 *   - `readyState >= HTMLMediaElement.HAVE_CURRENT_DATA`
 *
 * @returns `true` if the video is ready, `false` otherwise.
 */
function isVideoFrameReady(video: HTMLVideoElement): boolean {
  if (video.videoWidth <= 0 || video.videoHeight <= 0) {
    return false;
  }
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
    return false;
  }
  return true;
}

/**
 * Captures one current frame from an already-ready HTMLVideoElement
 * and returns it as a JPEG Blob.
 *
 * Conceptual flow:
 *
 *   HTMLVideoElement
 *       ↓
 *   ephemeral canvas (programmatically created, never rendered)
 *       ↓
 *   resize while preserving aspect ratio (max long edge = 1280)
 *       ↓
 *   JPEG encoding via canvas.toBlob
 *       ↓
 *   CapturedVideoFrame { blob, mimeType, width, height, size }
 *
 * The canvas is released after encoding (canvas.width = 0,
 * canvas.height = 0).
 *
 * The returned Blob exists only in browser memory. Nothing is written
 * to disk, IndexedDB, localStorage, or sent over the network.
 *
 * @param video - An already-ready HTMLVideoElement. Must have an
 *                active MediaStream attached and a current frame
 *                available. The caller is responsible for ensuring
 *                the video is ready (e.g. status === "ready" from
 *                `useFaceCamera`).
 * @returns A Promise that resolves with a typed `CapturedVideoFrame`,
 *          or rejects with a `CaptureErrorShape`. Raw browser
 *          exception names, messages, and stacks are NEVER leaked
 *          to the caller — every reject is a `CaptureErrorShape`.
 *
 *          Usage:
 *
 *          ```ts
 *          try {
 *            const frame = await captureVideoFrame(video);
 *            // upload frame.blob in PHASE 4.5B3
 *          } catch (err) {
 *            const error = err as CaptureErrorShape;
 *            // show error.message
 *          }
 *          ```
 */
export async function captureVideoFrame(
  video: HTMLVideoElement,
): Promise<CapturedVideoFrame> {
  // ── 1. Validate video has a usable frame ──────────────────────────────
  if (!isVideoFrameReady(video)) {
    throw makeCaptureError(CAPTURE_ERROR_CODES.FRAME_NOT_READY);
  }

  // ── 2. Calculate output dimensions ────────────────────────────────────
  let outputWidth: number;
  let outputHeight: number;
  try {
    const dims = calculateCaptureDimensions(
      video.videoWidth,
      video.videoHeight,
      FACE_CAPTURE_MAX_LONG_EDGE,
    );
    outputWidth = dims.width;
    outputHeight = dims.height;
  } catch {
    // Should not happen with a validated video element, but defensive
    // mapping keeps the function total.
    throw makeCaptureError(CAPTURE_ERROR_CODES.FRAME_ENCODING_FAILED);
  }

  // ── 3. Create ephemeral canvas ─────────────────────────────────────────
  const canvas = document.createElement("canvas");
  canvas.width = outputWidth;
  canvas.height = outputHeight;

  // ── 4. Obtain 2D context ───────────────────────────────────────────────
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    // Release canvas memory immediately.
    canvas.width = 0;
    canvas.height = 0;
    throw makeCaptureError(CAPTURE_ERROR_CODES.FRAME_CANVAS_UNAVAILABLE);
  }

  // ── 5. Draw the current frame ─────────────────────────────────────────
  // NOTE: No ctx.scale(-1, 1) mirror transform is applied. The CSS
  // `[transform:scaleX(-1)]` on CameraPreview's <video> affects only
  // the CSS-rendered preview. The drawImage source is the original
  // unmodified frame from the camera stream.
  //
  // No face detection, no crop, no overlay, no watermark.
  try {
    ctx.drawImage(video, 0, 0, outputWidth, outputHeight);
  } catch {
    // Release canvas memory immediately.
    canvas.width = 0;
    canvas.height = 0;
    throw makeCaptureError(CAPTURE_ERROR_CODES.FRAME_ENCODING_FAILED);
  }

  // ── 6. Encode to JPEG Blob via toBlob ─────────────────────────────────
  let blob: Blob | null = null;
  try {
    blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(
        (b) => {
          // `b` may be null if encoding failed.
          resolve(b);
        },
        FACE_CAPTURE_MIME_TYPE,
        FACE_CAPTURE_JPEG_QUALITY,
      );
    });
  } catch {
    // Release canvas memory immediately.
    canvas.width = 0;
    canvas.height = 0;
    throw makeCaptureError(CAPTURE_ERROR_CODES.FRAME_ENCODING_FAILED);
  }

  // ── 7. Release ephemeral canvas backing memory ─────────────────────────
  // Do this AFTER toBlob has delivered the blob (or null) so we don't
  // destroy the backing pixels prematurely.
  canvas.width = 0;
  canvas.height = 0;

  // ── 8. Validate encoding result ────────────────────────────────────────
  if (blob === null) {
    throw makeCaptureError(CAPTURE_ERROR_CODES.FRAME_ENCODING_FAILED);
  }

  // ── 9. Return typed result ─────────────────────────────────────────────
  return {
    blob,
    mimeType: FACE_CAPTURE_MIME_TYPE,
    width: outputWidth,
    height: outputHeight,
    size: blob.size,
  };
}
