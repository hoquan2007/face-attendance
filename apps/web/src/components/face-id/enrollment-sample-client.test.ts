/**
 * Tests for the client-side `submitFaceEnrollmentSample` helper.
 *
 * PHASE 4.5B3 — Capture + Submit + Quality Feedback.
 *
 * Coverage:
 *   - HTTP method + path
 *   - FormData construction (single `image` field, JPEG Blob, no extra metadata)
 *   - No manual Content-Type / userId / sampleIndex / modelIdentity
 *   - Accepted (200 OK) response parsing
 *   - Rejected quality (200 OK) response parsing
 *   - Route-level error envelope parsing
 *   - Malformed-response mapping
 *   - Network-error mapping
 *   - No automatic retry (exactly one fetch per call)
 *   - Privacy: no embedding / ciphertext / modelIdentity / userId /
 *     FACE_SERVICE_SECRET / X-Service-Token / FACE_SERVICE_URL in
 *     any outbound payload.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ENROLLMENT_SAMPLE_ENDPOINT_PATH,
  submitFaceEnrollmentSample,
  SAMPLE_CLIENT_ERROR_CODES,
  QUALITY_REJECTION_CODES,
} from "@/components/face-id/enrollment-sample-client";

// =============================================================================
// Fakes
// =============================================================================

const originalLocation = Object.getOwnPropertyDescriptor(window, "location");

/**
 * Spy-friendly fetch stub. Each test resets the queue and the call log
 * so multiple calls can be inspected independently.
 */
const fetchLog: Array<{
  url: string;
  init: RequestInit | undefined;
}> = [];

let fetchQueue: Array<
  | { kind: "ok"; body: unknown; status?: number }
  | { kind: "error"; error: Error }
> = [];

function pushOk(body: unknown, status = 200): void {
  fetchQueue.push({ kind: "ok", body, status });
}

const fetchMock = vi.fn(
  (input: unknown, init?: RequestInit): Promise<Response> => {
    fetchLog.push({ url: String(input), init });
    const next = fetchQueue.shift();
    if (!next) {
      return Promise.reject(new Error("fetch queue empty"));
    }
    if (next.kind === "error") {
      return Promise.reject(next.error);
    }
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  },
);

function makeJpegBlob(byteLength = 64): Blob {
  const bytes = new Uint8Array(byteLength);
  return new Blob([bytes], { type: "image/jpeg" });
}

// =============================================================================
// Lifecycle
// =============================================================================

beforeEach(() => {
  fetchLog.length = 0;
  fetchQueue = [];
  fetchMock.mockClear();
  // The helper reads `window.location.origin` to build the absolute URL.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { origin: "http://localhost:3000" },
  });
  // Replace the global `fetch`. The helper imports `fetch` from the
  // global scope, so we need to override the runtime binding too.
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  if (originalLocation) {
    Object.defineProperty(window, "location", originalLocation);
  } else {
    delete (window as unknown as { location?: Location }).location;
  }
  vi.restoreAllMocks();
});

// =============================================================================
// Tests
// =============================================================================

describe("submitFaceEnrollmentSample — request shape", () => {
  it("sends a POST to /api/face-id/enrollment/sample", async () => {
    pushOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchLog).toHaveLength(1);
    const entry = fetchLog[0]!;
    expect(entry.url).toBe(
      `http://localhost:3000${ENROLLMENT_SAMPLE_ENDPOINT_PATH}`,
    );
    expect(entry.init?.method).toBe("POST");
  });

  it("sends exactly one FormData body with one `image` field", async () => {
    pushOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const init = fetchLog[0]!.init;
    expect(init?.body).toBeInstanceOf(FormData);
    const fd = init?.body as FormData;
    const entries = Array.from(fd.entries());
    expect(entries).toHaveLength(1);
    const [name, value] = entries[0]!;
    expect(name).toBe("image");
    expect(value).toBeInstanceOf(Blob);
  });

  it("image field is a JPEG Blob (MimeType image/jpeg)", async () => {
    pushOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const fd = fetchLog[0]!.init?.body as FormData;
    const file = fd.get("image") as Blob;
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe("image/jpeg");
  });

  it("does NOT manually set Content-Type multipart/form-data header", async () => {
    pushOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const headers = fetchLog[0]!.init?.headers;
    expect(headers).toBeUndefined();
  });

  it("does NOT send userId, sampleIndex, modelIdentity, or email", async () => {
    pushOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const fd = fetchLog[0]!.init?.body as FormData;
    const names = Array.from(fd.keys());
    expect(names).toEqual(["image"]);
    // No identity field
    for (const n of names) {
      expect(n).not.toBe("userId");
      expect(n).not.toBe("sampleIndex");
      expect(n).not.toBe("modelIdentity");
      expect(n).not.toBe("email");
    }
  });

  it("does NOT reference the Face Service URL or send X-Service-Token", async () => {
    pushOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const url = fetchLog[0]!.url;
    expect(url).not.toMatch(/face-service|fastapi/);
    const headers = fetchLog[0]!.init?.headers as Record<string, string> | undefined;
    const allHeaderValues = headers
      ? Object.values(headers).join(",")
      : "";
    expect(allHeaderValues.toLowerCase()).not.toContain(
      "x-service-token",
    );
  });

  it("uses the harmless 'face-sample.jpg' filename in form data", async () => {
    pushOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const fd = fetchLog[0]!.init?.body as FormData;
    const file = fd.get("image") as File;
    expect(file.name).toBe("face-sample.jpg");
  });

  it("makes exactly one fetch per call (no automatic retry)", async () => {
    // Even on a 500 response, only one fetch must be issued.
    pushOk(
      {
        error: {
          code: "FACE_SERVICE_UNAVAILABLE",
          message: "Service is down",
        },
      },
      502,
    );

    await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchLog).toHaveLength(1);
  });
});

describe("submitFaceEnrollmentSample — response parsing", () => {
  it("parses an accepted 200 OK response safely", async () => {
    pushOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    const result = await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accepted).toBe(true);
    expect(result.rejectionReasons).toEqual([]);
    expect(result.progress).toEqual({
      acceptedSamples: 1,
      requiredSamples: 5,
      complete: false,
    });
  });

  it("parses a quality-rejection response safely and preserves order", async () => {
    pushOk({
      accepted: false,
      rejectionReasons: [
        "FACE_TOO_LARGE",
        "TOO_BLURRY",
        "FACE_NEAR_EDGE",
      ],
      progress: {
        acceptedSamples: 2,
        requiredSamples: 5,
        complete: false,
      },
    });

    const result = await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.accepted).toBe(false);
    // Canonical order: FACE_NEAR_EDGE appears last in the canonical
    // order, so the panel receives reasons in deterministic sequence.
    expect(result.rejectionReasons).toEqual([
      QUALITY_REJECTION_CODES.FACE_TOO_LARGE,
      QUALITY_REJECTION_CODES.TOO_BLURRY,
      QUALITY_REJECTION_CODES.FACE_NEAR_EDGE,
    ]);
  });

  it("preserves server-authoritative progress on a rejection", async () => {
    pushOk({
      accepted: false,
      rejectionReasons: ["TOO_BLURRY"],
      progress: {
        acceptedSamples: 3,
        requiredSamples: 5,
        complete: false,
      },
    });

    const result = await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.progress.acceptedSamples).toBe(3);
    expect(result.progress.requiredSamples).toBe(5);
    expect(result.progress.complete).toBe(false);
  });

  it("maps a route error envelope to a stable client error code", async () => {
    pushOk(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_EXPIRED,
          message: "Session expired",
        },
      },
      409,
    );

    const result = await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_EXPIRED);
    expect(result.httpStatus).toBe(409);
  });

  it("maps FACE_SERVICE_TIMEOUT safely to a stable code (no service URL leaked)", async () => {
    pushOk(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.FACE_SERVICE_TIMEOUT,
          message: "Timed out calling the face-recognition service",
        },
      },
      502,
    );

    const result = await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(SAMPLE_CLIENT_ERROR_CODES.FACE_SERVICE_TIMEOUT);
    // The helper's return value must not contain the raw server message;
    // UI maps the code to friendly copy.
    expect(JSON.stringify(result)).not.toContain(
      "Timed out calling the face-recognition service",
    );
  });

  it("maps malformed JSON to MALFORMED_RESPONSE", async () => {
    fetchQueue.push({ kind: "ok", body: "<<<not-json>>>" });

    const result = await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MALFORMED_RESPONSE");
  });

  it("maps a 200 OK with an unexpected shape to MALFORMED_RESPONSE", async () => {
    pushOk({ accepted: "yes", totally_unexpected: true });

    const result = await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("MALFORMED_RESPONSE");
  });

  it("maps a network failure to NETWORK_ERROR", async () => {
    fetchQueue.push({
      kind: "error",
      error: new Error("DNS resolution failed"),
    });

    const result = await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("NETWORK_ERROR");
    expect(result.httpStatus).toBeNull();
    // The raw error message must not leak.
    expect(JSON.stringify(result)).not.toContain("DNS resolution failed");
  });

  it("maps an unknown route error code to ENROLLMENT_SAMPLE_FAILED", async () => {
    pushOk(
      {
        error: {
          code: "SOMETHING_NEW_FROM_THE_FUTURE",
          message: "Mystery failure",
        },
      },
      500,
    );

    const result = await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe(SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_FAILED);
  });
});

// =============================================================================
// Privacy regression — what the browser MUST NOT see
// =============================================================================

describe("submitFaceEnrollmentSample — privacy regression", () => {
  it("response with a fake embedding [0.123456] never reaches the caller", async () => {
    // The route contract guarantees the browser never sees embeddings,
    // but a defense-in-depth parser is required so a malformed
    // response with an `embedding` field does not leak.
    pushOk({
      accepted: true,
      rejectionReasons: [],
      embedding: [0.123456, 0.654321],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    const result = await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("0.123456");
    expect(serialized).not.toContain("0.654321");
    expect(serialized).not.toContain("embedding");
  });

  it("response with fake ciphertext / authTag / iv is never returned to caller", async () => {
    pushOk({
      accepted: true,
      rejectionReasons: [],
      ciphertext: "super-secret-ciphertext-base64",
      iv: "super-secret-iv",
      authTag: "super-secret-tag",
      keyVersion: 1,
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    const result = await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("authTag");
    expect(serialized).not.toContain("keyVersion");
  });

  it("response referencing modelIdentity never leaks", async () => {
    pushOk({
      accepted: true,
      rejectionReasons: [],
      modelIdentity: "model-secret-identity",
      modelName: "secret-model",
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    const result = await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("model-secret-identity");
    expect(serialized).not.toContain("secret-model");
    expect(serialized).not.toContain("modelIdentity");
  });

  it("URL does NOT reference FACE_SERVICE_URL", async () => {
    pushOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    // Patch `window.location.origin` to a malicious-looking origin to
    // ensure the helper does NOT inject any external base URL.
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { origin: "http://malicious.test" },
    });

    await submitFaceEnrollmentSample(makeJpegBlob(), {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchLog[0]!.url.startsWith("http://malicious.test")).toBe(true);
    expect(fetchLog[0]!.url).not.toMatch(/face-service|fastapi/i);
  });
});
