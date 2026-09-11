/**
 * Tests for the pure camera-error mapping utilities.
 *
 * PHASE 4.5A — Browser Camera Foundation.
 *
 * These tests verify:
 *   - Permission denial maps to CAMERA_PERMISSION_DENIED.
 *   - Missing camera maps to CAMERA_NOT_FOUND.
 *   - NotReadableError maps to CAMERA_IN_USE.
 *   - Insecure context maps to CAMERA_INSECURE_CONTEXT.
 *   - Unknown errors map to CAMERA_UNAVAILABLE.
 *   - The output NEVER exposes raw exception stacks or messages.
 *   - Insecure-context detection uses `window.isSecureContext`.
 *   - The mapping is pure (no DOM globals required for the
 *     DOMException case).
 */

import { afterEach, describe, expect, it } from "vitest";

import { CAMERA_ERROR_CODES } from "@/components/face-id/camera-constants";
import {
  isInsecureBrowserContext,
  mapCameraError,
} from "@/components/face-id/camera-errors";

/**
 * Builds a fake DOMException-like value with the given `.name`. We do
 * NOT use the real `DOMException` constructor because it is not
 * available in every jsdom build and the mapper only ever inspects
 * `.name`.
 */
function fakeDomException(name: string, message = "boom"): {
  name: string;
  message: string;
} {
  return { name, message };
}

describe("mapCameraError", () => {
  it("maps NotAllowedError to CAMERA_PERMISSION_DENIED", () => {
    const result = mapCameraError(fakeDomException("NotAllowedError"));
    expect(result.code).toBe(CAMERA_ERROR_CODES.CAMERA_PERMISSION_DENIED);
    expect(result.message).toContain("Camera access was blocked");
  });

  it("maps NotFoundError to CAMERA_NOT_FOUND", () => {
    const result = mapCameraError(fakeDomException("NotFoundError"));
    expect(result.code).toBe(CAMERA_ERROR_CODES.CAMERA_NOT_FOUND);
    expect(result.message).toContain("No camera was found");
  });

  it("maps OverconstrainedError to CAMERA_NOT_FOUND", () => {
    const result = mapCameraError(fakeDomException("OverconstrainedError"));
    expect(result.code).toBe(CAMERA_ERROR_CODES.CAMERA_NOT_FOUND);
  });

  it("maps NotReadableError to CAMERA_IN_USE", () => {
    const result = mapCameraError(fakeDomException("NotReadableError"));
    expect(result.code).toBe(CAMERA_ERROR_CODES.CAMERA_IN_USE);
    expect(result.message).toContain("currently being used");
  });

  it("maps SecurityError to CAMERA_INSECURE_CONTEXT", () => {
    const result = mapCameraError(fakeDomException("SecurityError"));
    expect(result.code).toBe(CAMERA_ERROR_CODES.CAMERA_INSECURE_CONTEXT);
    expect(result.message).toContain("HTTPS or localhost");
  });

  it("maps unknown exception names to CAMERA_UNAVAILABLE", () => {
    const result = mapCameraError(fakeDomException("SomethingWeird"));
    expect(result.code).toBe(CAMERA_ERROR_CODES.CAMERA_UNAVAILABLE);
  });

  it("maps null to CAMERA_UNAVAILABLE (does not throw)", () => {
    const result = mapCameraError(null);
    expect(result.code).toBe(CAMERA_ERROR_CODES.CAMERA_UNAVAILABLE);
  });

  it("maps undefined to CAMERA_UNAVAILABLE (does not throw)", () => {
    const result = mapCameraError(undefined);
    expect(result.code).toBe(CAMERA_ERROR_CODES.CAMERA_UNAVAILABLE);
  });

  it("maps a plain string to CAMERA_UNAVAILABLE", () => {
    const result = mapCameraError("not-an-error");
    expect(result.code).toBe(CAMERA_ERROR_CODES.CAMERA_UNAVAILABLE);
  });

  it("maps a primitive number to CAMERA_UNAVAILABLE", () => {
    const result = mapCameraError(42);
    expect(result.code).toBe(CAMERA_ERROR_CODES.CAMERA_UNAVAILABLE);
  });

  it("does NOT leak the raw exception message into the output", () => {
    const secretMessage = "TOP-SECRET-INTERNAL-PATH-WITH-DETAILS";
    const result = mapCameraError(
      fakeDomException("NotAllowedError", secretMessage),
    );
    // The message must NOT contain the raw exception payload.
    expect(JSON.stringify(result)).not.toContain(secretMessage);
    // And it must NOT contain the raw exception name.
    expect(JSON.stringify(result)).not.toContain("NotAllowedError");
  });

  it("does NOT leak a raw stack string into the output", () => {
    const stack =
      "Error: at /internal/server/path/to/secret/file.ts:42:7\n  at nextTick";
    const result = mapCameraError({ name: "Boom", message: "x", stack });
    expect(JSON.stringify(result)).not.toContain(stack);
    expect(JSON.stringify(result)).not.toContain("internal/server/path");
  });

  it("returns the closed-enum `message` field for every code", () => {
    for (const code of Object.values(CAMERA_ERROR_CODES)) {
      // The function takes an unknown; passing a non-matching name
      // always routes to CAMERA_UNAVAILABLE, but we still want to
      // verify that the mapping for THAT code returns the right
      // message.
      // We craft a fake exception that maps to the desired code via
      // the documented names.
      const name = codeToDomName(code);
      if (!name) continue; // CAMERA_UNAVAILABLE has no canonical name
      const result = mapCameraError(fakeDomException(name));
      expect(result.code).toBe(code);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Helper that returns the canonical DOMException name for a code.
 * Used by the loop test above to keep coverage exhaustive without
 * scattering literals.
 */
function codeToDomName(
  code: (typeof CAMERA_ERROR_CODES)[keyof typeof CAMERA_ERROR_CODES],
): string | null {
  switch (code) {
    case CAMERA_ERROR_CODES.CAMERA_PERMISSION_DENIED:
      return "NotAllowedError";
    case CAMERA_ERROR_CODES.CAMERA_NOT_FOUND:
      return "NotFoundError";
    case CAMERA_ERROR_CODES.CAMERA_IN_USE:
      return "NotReadableError";
    case CAMERA_ERROR_CODES.CAMERA_INSECURE_CONTEXT:
      return "SecurityError";
    case CAMERA_ERROR_CODES.CAMERA_UNAVAILABLE:
      return null;
    default:
      return null;
  }
}

describe("isInsecureBrowserContext", () => {
  const originalIsSecureContext = Object.getOwnPropertyDescriptor(
    window,
    "isSecureContext",
  );

  afterEach(() => {
    // Restore the original property after each test to avoid
    // leaking global state into other test files.
    if (originalIsSecureContext) {
      Object.defineProperty(window, "isSecureContext", originalIsSecureContext);
    } else {
      delete (window as unknown as { isSecureContext?: boolean })
        .isSecureContext;
    }
  });

  it("returns false when window.isSecureContext is true", () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    expect(isInsecureBrowserContext()).toBe(false);
  });

  it("returns true when window.isSecureContext is false", () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    expect(isInsecureBrowserContext()).toBe(true);
  });
});
