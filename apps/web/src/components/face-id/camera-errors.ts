/**
 * Pure utilities for mapping browser camera failures to a stable
 * application-level error shape.
 *
 * PHASE 4.5A — Browser Camera Foundation.
 *
 * Why a separate file?
 *   - Pure functions with no React, no hooks, no DOM globals, and no
 *     env access are trivial to test in isolation.
 *   - The mapping table lives in one place so adding a new code is a
 *     single-file change.
 *
 * What this module NEVER does:
 *   - Never throws.
 *   - Never includes raw stack traces in the returned value.
 *   - Never assumes a specific browser exception type — it accepts any
 *     value and inspects it defensively.
 *
 * Privacy posture:
 *   - The output is safe to render to the user and safe to log. The
 *     input value is NEVER leaked to the caller in any form.
 */

import {
  CAMERA_ERROR_CODES,
  CAMERA_ERROR_MESSAGES,
  type CameraErrorCode,
} from "@/components/face-id/camera-constants";

/**
 * Shape of a stable, user-safe camera error.
 *
 * `code` is one of the closed `CameraErrorCode` values. `message` is
 * a short, user-readable description suitable for direct display.
 */
export interface CameraErrorShape {
  code: CameraErrorCode;
  message: string;
}

/**
 * Coerces an unknown thrown value (typically a `DOMException` from
 * `getUserMedia`) into a stable `CameraErrorShape`.
 *
 * Mapping rules (deterministic):
 *   - `NotAllowedError`           → CAMERA_PERMISSION_DENIED
 *   - `NotFoundError`,
 *     `OverconstrainedError`      → CAMERA_NOT_FOUND
 *   - `NotReadableError`          → CAMERA_IN_USE
 *   - `SecurityError`             → CAMERA_INSECURE_CONTEXT
 *   - anything else               → CAMERA_UNAVAILABLE
 *
 * Inputs that are not `Error`-like (e.g. `null`, `undefined`,
 * primitives) also map to `CAMERA_UNAVAILABLE`. The original value is
 * intentionally discarded; the function NEVER surfaces the raw
 * exception name, message, or stack to the caller.
 */
export function mapCameraError(unknownError: unknown): CameraErrorShape {
  const name = readErrorName(unknownError);

  switch (name) {
    case "NotAllowedError":
      return makeShape(CAMERA_ERROR_CODES.CAMERA_PERMISSION_DENIED);
    case "NotFoundError":
    case "OverconstrainedError":
      return makeShape(CAMERA_ERROR_CODES.CAMERA_NOT_FOUND);
    case "NotReadableError":
      return makeShape(CAMERA_ERROR_CODES.CAMERA_IN_USE);
    case "SecurityError":
      return makeShape(CAMERA_ERROR_CODES.CAMERA_INSECURE_CONTEXT);
    default:
      return makeShape(CAMERA_ERROR_CODES.CAMERA_UNAVAILABLE);
  }
}

/**
 * Returns `true` when `getUserMedia` cannot be used because the page
 * is not in a secure context.
 *
 * In a browser, `window.isSecureContext` is the canonical signal.
 * When running outside a real browser (server-side rendering, test
 * harness without `window`) this function returns `true` — the caller
 * is then expected to handle secure-context as a runtime concern, not
 * a build-time one.
 *
 * Localhost is treated as secure by modern browsers, so this returns
 * `false` during normal local development.
 */
export function isInsecureBrowserContext(): boolean {
  if (typeof window === "undefined") {
    // Server / non-browser: do not lie about it. Callers should only
    // call this function in browser-bound code paths.
    return true;
  }
  // `window.isSecureContext` is `boolean` in modern browsers. The
  // optional-chaining + `?? false` form protects against odd test
  // sandboxes that delete the property.
  return window.isSecureContext !== true;
}

/**
 * Extracts a `.name` string from any unknown value, without throwing.
 *
 * Returns an empty string when the input is not `Error`-like. The
 * empty string is intentional — it forces the mapping switch into
 * `default`, which produces `CAMERA_UNAVAILABLE`.
 */
function readErrorName(value: unknown): string {
  if (typeof value !== "object" || value === null) {
    return "";
  }
  const candidate = (value as { name?: unknown }).name;
  if (typeof candidate !== "string") {
    return "";
  }
  return candidate;
}

function makeShape(code: CameraErrorCode): CameraErrorShape {
  // `code` is a closed enum — the literal lookup is safe at runtime.
  return {
    code,
    message: CAMERA_ERROR_MESSAGES[code],
  };
}
