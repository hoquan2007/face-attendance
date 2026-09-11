/**
 * Tests for POST /api/face-id/enrollment/sample.
 *
 * PHASE 4.4C — Face ID Enrollment Sample API.
 *
 * These tests mock:
 *   - `getSession` (the Better Auth server session helper)
 *   - the `profile-service` (Profile completion check)
 *   - the `enrollment-session-service` (read session, check expiration,
 *     atomic append)
 *   - the `face-service-client` (analyzeEnrollmentSample)
 *   - the `biometrics/encryption` module (encryptBiometricVector)
 *
 * No MongoDB / Mongoose is touched. The route is a thin handler that
 * delegates persistence to the existing services, so we drive every
 * observable branch by changing the mocked return values.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// Mocked collaborators
// =============================================================================

const mockGetSession = vi.fn();
const mockIsOnboardingComplete = vi.fn();
const mockGetEnrollmentSessionByUserId = vi.fn();
const mockIsEnrollmentSessionExpired = vi.fn();
const mockAppendAcceptedEnrollmentSample = vi.fn();
const mockAnalyzeEnrollmentSample = vi.fn();
const mockEncryptBiometricVector = vi.fn();

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers()),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      __isNextResponse: true,
      status: init?.status ?? 200,
      body,
    }),
  },
}));

vi.mock("@/lib/session", () => ({
  getSession: () => mockGetSession(),
}));

vi.mock("@/lib/profile-service", () => ({
  isOnboardingComplete: (...args: unknown[]) =>
    mockIsOnboardingComplete(...args),
}));

vi.mock("@/lib/biometrics/enrollment-session-service", () => ({
  getEnrollmentSessionByUserId: (...args: unknown[]) =>
    mockGetEnrollmentSessionByUserId(...args),
  isEnrollmentSessionExpired: (...args: unknown[]) =>
    mockIsEnrollmentSessionExpired(...args),
  appendAcceptedEnrollmentSample: (...args: unknown[]) =>
    mockAppendAcceptedEnrollmentSample(...args),
}));

// Note: vi.mock factories are hoisted to the top of the file, so any
// helpers referenced from inside them must NOT depend on outer
// top-level variables. We define the mock error class inline inside
// each factory.
vi.mock("@/lib/biometrics/face-service-client", () => ({
  analyzeEnrollmentSample: (...args: unknown[]) =>
    mockAnalyzeEnrollmentSample(...args),
  FaceServiceClientError: class MockFaceServiceClientError extends Error {
    public readonly code: string;
    constructor(init: { code: string; message: string }) {
      super(init.message);
      this.name = "FaceServiceClientError";
      this.code = init.code;
    }
  },
  FACE_SERVICE_ERROR_CODES: {
    FACE_SERVICE_NOT_CONFIGURED: "FACE_SERVICE_NOT_CONFIGURED",
    FACE_SERVICE_UNAVAILABLE: "FACE_SERVICE_UNAVAILABLE",
    FACE_SERVICE_TIMEOUT: "FACE_SERVICE_TIMEOUT",
    FACE_SERVICE_UNAUTHORIZED: "FACE_SERVICE_UNAUTHORIZED",
    FACE_SERVICE_INVALID_RESPONSE: "FACE_SERVICE_INVALID_RESPONSE",
    FACE_SERVICE_REJECTED_REQUEST: "FACE_SERVICE_REJECTED_REQUEST",
  },
}));

vi.mock("@/lib/biometrics/encryption", () => ({
  encryptBiometricVector: (...args: unknown[]) =>
    mockEncryptBiometricVector(...args),
  BiometricError: class MockBiometricError extends Error {
    public readonly code: string;
    constructor(init: { code: string; message: string }) {
      super(init.message);
      this.name = "BiometricError";
      this.code = init.code;
    }
  },
}));

// =============================================================================
// Fixtures
// =============================================================================

function makeSession(user: { id: string; email?: string; name?: string }) {
  return {
    user: {
      id: user.id,
      email: user.email ?? `${user.id}@example.com`,
      name: user.name ?? "Test User",
      image: null,
    },
    expiresAt: new Date(),
  };
}

function makeEnrollmentSessionFixture(overrides: {
  userId?: string;
  mode?: "create" | "replace";
  templateVersion?: number;
  modelIdentity?: string;
  modelName?: string;
  embeddingDimension?: number;
  normalization?: "l2";
  requiredSampleCount?: number;
  acceptedSamples?: unknown[];
  expiresAt?: Date;
} = {}) {
  return {
    userId: overrides.userId ?? "user-1",
    mode: overrides.mode ?? "create",
    templateVersion: overrides.templateVersion ?? 1,
    modelIdentity: overrides.modelIdentity,
    modelName: overrides.modelName,
    embeddingDimension: overrides.embeddingDimension,
    normalization: overrides.normalization ?? "l2",
    requiredSampleCount: overrides.requiredSampleCount ?? 5,
    acceptedSamples: overrides.acceptedSamples ?? [],
    expiresAt:
      overrides.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function makeAcceptedFaceServiceResponse(overrides: {
  embedding?: number[];
  modelIdentity?: string;
  modelName?: string;
  embeddingDimension?: number;
  normalization?: string;
  quality?: {
    detection_score?: number;
    blur_score?: number;
    brightness?: number;
    relative_face_area?: number;
  };
} = {}) {
  return {
    accepted: true,
    quality: overrides.quality ?? {
      detection_score: 0.95,
      face_width: 120,
      face_height: 120,
      relative_face_area: 0.06,
      blur_score: 400,
      brightness: 0.5,
      near_edge: false,
    },
    embedding: overrides.embedding ?? Array(512).fill(0).map((_, i) => Math.sin(i * 0.1) * 0.5),
    rejection_reasons: [],
    model: {
      identity: overrides.modelIdentity ?? "insightface-buffalo-l",
      name: overrides.modelName ?? "buffalo_l",
      embedding_dimension: overrides.embeddingDimension ?? 512,
      normalization: overrides.normalization ?? "l2",
    },
    processing_ms: 165.1,
  };
}

function makeRejectedFaceServiceResponse(
  rejectionReasons: string[],
) {
  return {
    accepted: false,
    quality: {
      detection_score: 0.5,
      face_width: 80,
      face_height: 80,
      relative_face_area: 0.01,
      blur_score: 30,
      brightness: 0.2,
      near_edge: false,
    },
    embedding: null,
    rejection_reasons: rejectionReasons,
    model: null,
    processing_ms: 60.0,
  };
}

function makeEncryptedVectorFixture() {
  return {
    ciphertext: "encrypted-ciphertext-base64",
    iv: "encrypted-iv-base64",
    authTag: "encrypted-authTag-base64",
    keyVersion: 1,
  };
}

// =============================================================================
// Import SUT
// =============================================================================

import { POST } from "@/app/api/face-id/enrollment/sample/route";
import { ENROLLMENT_ROUTE_ERROR_CODES } from "@/lib/biometrics/enrollment-route-errors";
import { BiometricError } from "@/lib/biometrics/encryption";
import { FaceServiceClientError, FACE_SERVICE_ERROR_CODES } from "@/lib/biometrics/face-service-errors";

// =============================================================================
// Helpers
// =============================================================================

interface ResponseShape {
  status: number;
  body: unknown;
}

function unwrapResponse(resp: { status: number; body: unknown }): ResponseShape {
  return { status: resp.status, body: resp.body };
}

/**
 * Creates a multipart/form-data request with an image file.
 *
 * Overrides the request.formData() method to return the constructed
 * FormData directly. This is necessary because jsdom's Request
 * implementation does not fully support multipart body parsing.
 */
function makeFormRequest(
  imageBuffer: ArrayBuffer,
  mimeType: string,
  filename = "photo.jpg",
): Parameters<typeof POST>[0] {
  const formData = new FormData();
  const file = new File([imageBuffer], filename, { type: mimeType });
  formData.append("image", file);

  const request = new Request("http://localhost/api/face-id/enrollment/sample", {
    method: "POST",
    body: formData,
  });

  // Override formData() to return our constructed FormData directly.
  // This is necessary because jsdom does not parse multipart/form-data bodies.
  (request as unknown as { formData: () => Promise<FormData> }).formData = () =>
    Promise.resolve(formData);

  return request as unknown as Parameters<typeof POST>[0];
}

/**
 * Creates a request with empty FormData (no image field).
 */
function makeEmptyFormRequest(): Parameters<typeof POST>[0] {
  const formData = new FormData();

  const request = new Request("http://localhost/api/face-id/enrollment/sample", {
    method: "POST",
    body: formData,
  });

  (request as unknown as { formData: () => Promise<FormData> }).formData = () =>
    Promise.resolve(formData);

  return request as unknown as Parameters<typeof POST>[0];
}

/**
 * Creates an oversized image buffer for testing IMAGE_TOO_LARGE.
 */
function makeOversizedBuffer(): ArrayBuffer {
  // 2MB buffer (exceeds 1.5MB limit)
  return new ArrayBuffer(2 * 1024 * 1024);
}

/**
 * Creates a valid small image buffer for testing.
 */
function makeValidImageBuffer(): ArrayBuffer {
  // A minimal JPEG-like buffer (just bytes, not a real JPEG)
  return new Uint8Array([
    0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
    0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
  ]).buffer;
}

async function callRoute(
  request: Parameters<typeof POST>[0],
): Promise<ResponseShape> {
  const result = await POST(request);
  return unwrapResponse(result as unknown as { status: number; body: unknown });
}

// =============================================================================
// Tests
// =============================================================================

describe("POST /api/face-id/enrollment/sample", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockIsOnboardingComplete.mockReset();
    mockGetEnrollmentSessionByUserId.mockReset();
    mockIsEnrollmentSessionExpired.mockReset();
    mockAppendAcceptedEnrollmentSample.mockReset();
    mockAnalyzeEnrollmentSample.mockReset();
    mockEncryptBiometricVector.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------
  // 1. Authentication
  // -------------------------------------------------------------------

  it("rejects unauthenticated requests with UNAUTHENTICATED", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.UNAUTHENTICATED,
        message: expect.any(String),
      },
    });
    expect(mockIsOnboardingComplete).not.toHaveBeenCalled();
    expect(mockGetEnrollmentSessionByUserId).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // 2. Profile requirement
  // -------------------------------------------------------------------

  it("rejects when no Profile exists (PROFILE_INCOMPLETE)", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(false);

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.PROFILE_INCOMPLETE,
        message: expect.any(String),
      },
    });
    expect(mockGetEnrollmentSessionByUserId).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // 3. Enrollment session checks
  // -------------------------------------------------------------------

  it("rejects when no enrollment session exists (ENROLLMENT_NOT_STARTED)", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_NOT_STARTED,
        message: expect.any(String),
      },
    });
  });

  it("rejects when enrollment session is expired (ENROLLMENT_EXPIRED)", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        expiresAt: new Date(Date.now() - 1000), // expired
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(true);

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_EXPIRED,
        message: expect.any(String),
      },
    });
  });

  // -------------------------------------------------------------------
  // 4. Image validation
  // -------------------------------------------------------------------

  it("rejects when no image is provided (INVALID_IMAGE)", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    const res = await callRoute(makeEmptyFormRequest());
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.INVALID_IMAGE,
        message: expect.any(String),
      },
    });
  });

  it("rejects oversized image (IMAGE_TOO_LARGE)", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    const res = await callRoute(makeFormRequest(makeOversizedBuffer(), "image/jpeg"));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.IMAGE_TOO_LARGE,
        message: expect.stringContaining("exceeds maximum size"),
      },
    });
  });

  it("rejects invalid MIME type (INVALID_IMAGE)", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    const textBuffer = new TextEncoder().encode("not an image").buffer;
    const res = await callRoute(makeFormRequest(textBuffer, "text/plain"));

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.INVALID_IMAGE,
        message: expect.stringContaining("Invalid image type"),
      },
    });
  });

  it("accepts image/jpeg MIME type", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeRejectedFaceServiceResponse(["TOO_DARK"]),
    );

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    // Should reach Face Service call (rejection expected)
    expect(mockAnalyzeEnrollmentSample).toHaveBeenCalled();
    expect(res.status).toBe(200); // Rejection is still 200 OK
  });

  it("accepts image/png MIME type", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeRejectedFaceServiceResponse(["TOO_DARK"]),
    );

    const pngBuffer = new Uint8Array([0x89, 0x50, 0x4E, 0x47]).buffer;
    const res = await callRoute(makeFormRequest(pngBuffer, "image/png"));
    expect(mockAnalyzeEnrollmentSample).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("accepts image/webp MIME type", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeRejectedFaceServiceResponse(["TOO_DARK"]),
    );

    const webpBuffer = new Uint8Array([0x52, 0x49, 0x46, 0x46]).buffer;
    const res = await callRoute(makeFormRequest(webpBuffer, "image/webp"));
    expect(mockAnalyzeEnrollmentSample).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  // -------------------------------------------------------------------
  // 5. Sample limit enforcement
  // -------------------------------------------------------------------

  it("rejects when sample limit already reached (ENROLLMENT_SAMPLE_LIMIT_REACHED)", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        requiredSampleCount: 5,
        acceptedSamples: [{}, {}, {}, {}, {}], // already at limit
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_SAMPLE_LIMIT_REACHED,
        message: expect.any(String),
      },
    });
    // Face Service should NOT be called
    expect(mockAnalyzeEnrollmentSample).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // 6. Face Service error mapping
  // -------------------------------------------------------------------

  it("maps Face Service NO_FACE error safely", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    mockAnalyzeEnrollmentSample.mockRejectedValueOnce(
      new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_REJECTED_REQUEST,
        message: "Face Service rejected",
        domainError: { code: "NO_FACE", message: "No face detected" },
      }),
    );

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.NO_FACE,
        message: expect.any(String),
      },
    });
  });

  it("maps Face Service MULTIPLE_FACES error safely", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    mockAnalyzeEnrollmentSample.mockRejectedValueOnce(
      new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_REJECTED_REQUEST,
        message: "Face Service rejected",
        domainError: { code: "MULTIPLE_FACES", message: "Multiple faces" },
      }),
    );

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.MULTIPLE_FACES,
        message: expect.any(String),
      },
    });
  });

  it("maps Face Service unavailable error safely", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    mockAnalyzeEnrollmentSample.mockRejectedValueOnce(
      new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_UNAVAILABLE,
        message: "Face Service is unavailable",
      }),
    );

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.FACE_SERVICE_UNAVAILABLE,
        message: expect.any(String),
      },
    });
  });

  it("maps Face Service timeout error safely", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    mockAnalyzeEnrollmentSample.mockRejectedValueOnce(
      new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_TIMEOUT,
        message: "Timeout",
      }),
    );

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.FACE_SERVICE_TIMEOUT,
        message: expect.any(String),
      },
    });
  });

  it("maps Face Service not configured error safely", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    mockAnalyzeEnrollmentSample.mockRejectedValueOnce(
      new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_NOT_CONFIGURED,
        message: "Not configured",
      }),
    );

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.FACE_SERVICE_NOT_CONFIGURED,
        message: expect.any(String),
      },
    });
  });

  // -------------------------------------------------------------------
  // 7. Quality rejection handling
  // -------------------------------------------------------------------

  it("returns accepted=false for rejected quality", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeRejectedFaceServiceResponse(["FACE_TOO_SMALL"]),
    );

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(200);
    const body = res.body as { accepted: boolean; rejectionReasons: string[]; progress: { acceptedSamples: number; requiredSamples: number; complete: boolean } };
    expect(body.accepted).toBe(false);
    expect(body.rejectionReasons).toContain("FACE_TOO_SMALL");
    expect(body.progress.acceptedSamples).toBe(0);
    expect(body.progress.requiredSamples).toBe(5);
    expect(body.progress.complete).toBe(false);
  });

  it("does not encrypt on rejected quality", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeRejectedFaceServiceResponse(["TOO_BLURRY"]),
    );

    await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(mockEncryptBiometricVector).not.toHaveBeenCalled();
  });

  it("does not append sample on rejected quality", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeRejectedFaceServiceResponse(["TOO_DARK"]),
    );

    await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(mockAppendAcceptedEnrollmentSample).not.toHaveBeenCalled();
  });

  it("does not increment count on rejected quality", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        acceptedSamples: [{}], // already has 1 sample
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeRejectedFaceServiceResponse(["LOW_DETECTION_CONFIDENCE"]),
    );

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    const body = res.body as { progress: { acceptedSamples: number } };
    expect(body.progress.acceptedSamples).toBe(1); // count unchanged
  });

  // -------------------------------------------------------------------
  // 8. Accepted sample handling
  // -------------------------------------------------------------------

  it("encrypts embedding for accepted sample", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    // The route fetches the session twice — once at validation, once after Face Service
    mockGetEnrollmentSessionByUserId.mockResolvedValue(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
    });

    await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(mockEncryptBiometricVector).toHaveBeenCalledTimes(1);
    // Verify the embedding was passed (not the full response)
    const encryptCall = mockEncryptBiometricVector.mock.calls[0]!;
    expect(Array.isArray(encryptCall[0])).toBe(true); // first arg is embedding array
    expect(encryptCall[1]).toMatchObject({
      userId: "user-1",
      vectorType: "sample",
    });
  });

  it("uses session.user.id in AAD for encryption", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "session-user-123" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "session-user-123" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
    });

    await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    const encryptCall = mockEncryptBiometricVector.mock.calls[0]!;
    expect(encryptCall[1].userId).toBe("session-user-123");
  });

  it("uses correct 0-based sampleIndex in AAD", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
        acceptedSamples: [{}], // 1 sample already, so index should be 1
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 2,
      requiredSampleCount: 5,
      complete: false,
    });

    await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    const encryptCall = mockEncryptBiometricVector.mock.calls[0]!;
    expect(encryptCall[1].sampleIndex).toBe(1); // 0-based, second sample
  });

  it("establishes model metadata on first sample", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse({
        modelIdentity: "insightface-buffalo-l-v2",
        modelName: "buffalo_l_v2",
        embeddingDimension: 1024,
      }),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
    });

    await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    const appendCall = mockAppendAcceptedEnrollmentSample.mock.calls[0]!;
    expect(appendCall[0]).toMatchObject({
      modelIdentity: "insightface-buffalo-l-v2",
      modelName: "buffalo_l_v2",
      embeddingDimension: 1024,
    });
  });

  it("accepts compatible later sample with matching model", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        acceptedSamples: [{}],
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 2,
      requiredSampleCount: 5,
      complete: false,
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(200);
    expect(mockAppendAcceptedEnrollmentSample).toHaveBeenCalled();
  });

  it("rejects model mismatch (MODEL_MISMATCH)", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        acceptedSamples: [{}],
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    // Face Service returns different model
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse({
        modelIdentity: "different-model",
        modelName: "different_model",
        embeddingDimension: 256,
      }),
    );

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.MODEL_MISMATCH,
        message: expect.any(String),
      },
    });
    expect(mockEncryptBiometricVector).not.toHaveBeenCalled();
    expect(mockAppendAcceptedEnrollmentSample).not.toHaveBeenCalled();
  });

  it("rejects dimension mismatch (MODEL_MISMATCH)", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        acceptedSamples: [{}],
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    // Face Service returns different dimension
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse({
        embeddingDimension: 1024,
      }),
    );

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.MODEL_MISMATCH,
        message: expect.any(String),
      },
    });
  });

  // -------------------------------------------------------------------
  // 9. Sample limit at exact threshold
  // -------------------------------------------------------------------

  it("returns complete=true at required sample count", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
        requiredSampleCount: 5,
        acceptedSamples: [{}, {}, {}, {}], // 4 samples, adding 1 makes 5
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 5,
      requiredSampleCount: 5,
      complete: true,
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    const body = res.body as { progress: { acceptedSamples: number; complete: boolean } };
    expect(body.progress.acceptedSamples).toBe(5);
    expect(body.progress.complete).toBe(true);
  });

  // -------------------------------------------------------------------
  // 10. Response privacy
  // -------------------------------------------------------------------

  it("does not expose embedding in accepted response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("embedding");
    expect(json).not.toContain("0.5"); // embedding values
  });

  it("does not expose ciphertext in response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("ciphertext");
    expect(json).not.toContain("encrypted-ciphertext-base64");
  });

  it("does not expose modelIdentity in response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse({
        modelIdentity: "secret-model-identity",
      }),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("modelIdentity");
    expect(json).not.toContain("secret-model-identity");
  });

  it("does not expose userId in response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("userId");
    expect(json).not.toContain("user-1");
  });

  it("ignores client-supplied userId in form data", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "session-user" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "session-user" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeRejectedFaceServiceResponse(["TOO_DARK"]),
    );

    // Add malicious userId to form data
    const maliciousForm = new FormData();
    const file = new File([makeValidImageBuffer()], "photo.jpg", { type: "image/jpeg" });
    maliciousForm.append("image", file);
    maliciousForm.append("userId", "malicious-user");

    const maliciousRequest = new Request(
      "http://localhost/api/face-id/enrollment/sample",
      {
        method: "POST",
        body: maliciousForm,
      },
    );

    (maliciousRequest as unknown as { formData: () => Promise<FormData> }).formData =
      () => Promise.resolve(maliciousForm);

    await callRoute(
      maliciousRequest as unknown as Parameters<typeof POST>[0],
    );

    // Session user ID should be used, not the malicious one
    expect(mockIsOnboardingComplete).toHaveBeenCalledWith("session-user");
    expect(mockGetEnrollmentSessionByUserId).toHaveBeenCalledWith("session-user");
    expect(mockIsOnboardingComplete).not.toHaveBeenCalledWith("malicious-user");
  });

  // -------------------------------------------------------------------
  // 11. Encryption failure handling
  // -------------------------------------------------------------------

  it("maps encryption failure to safe error without persisting", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockImplementationOnce(() => {
      throw new BiometricError({
        code: "BIOMETRIC_KEY_MISSING",
        message: "Key missing",
      });
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.BIOMETRIC_ENCRYPTION_UNAVAILABLE,
        message: expect.any(String),
      },
    });
    // Sample should NOT be persisted
    expect(mockAppendAcceptedEnrollmentSample).not.toHaveBeenCalled();
  });

  it("does not persist plaintext embedding on encryption failure", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockImplementationOnce(() => {
      throw new BiometricError({
        code: "BIOMETRIC_KEY_MISSING",
        message: "Key missing",
      });
    });

    await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));

    // The append function should never be called, so no plaintext
    // embedding is ever passed to persistence
    expect(mockAppendAcceptedEnrollmentSample).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // 12. Persistence failure handling
  // -------------------------------------------------------------------

  it("maps persistence failure to safe error", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: false,
      newAcceptedCount: 0,
      requiredSampleCount: 5,
      complete: false,
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_SAMPLE_FAILED,
        message: expect.any(String),
      },
    });
  });

  // -------------------------------------------------------------------
  // 13. Face Service response boundary
  // -------------------------------------------------------------------

  it("does not spread raw Face Service response into JSON", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    // Create a fake embedding with a recognizable value
    const fakeEmbedding = Array(512).fill(0);
    fakeEmbedding[0] = 0.123456; // recognizable value

    mockAnalyzeEnrollmentSample.mockResolvedValueOnce({
      accepted: true,
      quality: {
        detection_score: 0.95,
        face_width: 120,
        face_height: 120,
        relative_face_area: 0.06,
        blur_score: 400,
        brightness: 0.5,
        near_edge: false,
      },
      embedding: fakeEmbedding,
      rejection_reasons: [],
      model: {
        identity: "insightface-buffalo-l",
        name: "buffalo_l",
        embedding_dimension: 512,
        normalization: "l2",
      },
      processing_ms: 165.1,
    });
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    const json = JSON.stringify(res.body);

    // The recognizable embedding value must NOT appear in the response
    expect(json).not.toContain("0.123456");
    expect(json).not.toContain("embedding");

    // The mock should verify that the encryption function received the embedding
    // but the encrypted result (with different values) is what gets stored
    expect(mockEncryptBiometricVector).toHaveBeenCalled();
  });

  it("makes exactly one Face Service call per valid request", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
    });

    await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(mockAnalyzeEnrollmentSample).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------
  // 14. POST is not automatically retried
  // -------------------------------------------------------------------

  it("POST never automatically retries on failure", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    // Face Service returns an error
    mockAnalyzeEnrollmentSample.mockRejectedValueOnce(
      new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_UNAVAILABLE,
        message: "Service down",
      }),
    );

    await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));

    // Should be called exactly once, not retried
    expect(mockAnalyzeEnrollmentSample).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------
  // 15. Success response structure
  // -------------------------------------------------------------------

  it("returns correct progress in success response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(200);
    const body = res.body as {
      accepted: boolean;
      rejectionReasons: string[];
      progress: { acceptedSamples: number; requiredSamples: number; complete: boolean };
    };
    expect(body.accepted).toBe(true);
    expect(body.rejectionReasons).toEqual([]);
    expect(body.progress.acceptedSamples).toBe(1);
    expect(body.progress.requiredSamples).toBe(5);
    expect(body.progress.complete).toBe(false);
  });

  it("returns complete=false below required count", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
        requiredSampleCount: 5,
        acceptedSamples: [{}, {}, {}], // 3 samples
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 4,
      requiredSampleCount: 5,
      complete: false,
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    const body = res.body as { progress: { complete: boolean } };
    expect(body.progress.complete).toBe(false);
  });

  it("complete=true only means samples collected, not FaceProfile exists", async () => {
    // This test documents the contract: complete=true is about sample
    // collection, not finalization
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
        acceptedSamples: [{}, {}, {}, {}],
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 5,
      requiredSampleCount: 5,
      complete: true,
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    const body = res.body as { progress: { complete: boolean } };

    // complete=true means enough samples collected
    expect(body.progress.complete).toBe(true);

    // It does NOT mean FaceProfile was created - that's a later phase
    // The response should not indicate FaceProfile existence
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("faceProfile");
    expect(json).not.toContain("enrolledAt");
  });
});

// =============================================================================
// Privacy Test: Embedding never reaches browser
// =============================================================================

describe("Privacy: embedding never reaches browser", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockIsOnboardingComplete.mockReset();
    mockGetEnrollmentSessionByUserId.mockReset();
    mockIsEnrollmentSessionExpired.mockReset();
    mockAppendAcceptedEnrollmentSample.mockReset();
    mockAnalyzeEnrollmentSample.mockReset();
    mockEncryptBiometricVector.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("recognizable fake embedding [0.123456] never appears in response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    // Create a response with a recognizable embedding
    const recognizableEmbedding = Array(512).fill(0);
    recognizableEmbedding[0] = 0.123456;
    recognizableEmbedding[1] = 0.654321;

    mockAnalyzeEnrollmentSample.mockResolvedValueOnce({
      accepted: true,
      quality: {
        detection_score: 0.95,
        face_width: 120,
        face_height: 120,
        relative_face_area: 0.06,
        blur_score: 400,
        brightness: 0.5,
        near_edge: false,
      },
      embedding: recognizableEmbedding,
      rejection_reasons: [],
      model: {
        identity: "insightface-buffalo-l",
        name: "buffalo_l",
        embedding_dimension: 512,
        normalization: "l2",
      },
      processing_ms: 165.1,
    });
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));

    // CRITICAL: The recognizable embedding values must NOT appear in response
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("0.123456");
    expect(json).not.toContain("0.654321");
    expect(json).not.toContain("embedding");

    // The encryption mock should have been called with the embedding
    expect(mockEncryptBiometricVector).toHaveBeenCalledWith(
      expect.arrayContaining([0.123456, 0.654321]),
      expect.any(Object),
    );

    // The append mock should have been called with ONLY encrypted data
    const appendCall = mockAppendAcceptedEnrollmentSample.mock.calls[0]!;
    expect(appendCall[0].encryptedVector).toEqual(makeEncryptedVectorFixture());
    expect(appendCall[0].encryptedVector).not.toEqual(
      expect.arrayContaining([0.123456]),
    );
  });

  it("encryption result (ciphertext) is never returned to browser", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce({
      ciphertext: "super-secret-ciphertext-base64",
      iv: "super-secret-iv-base64",
      authTag: "super-secret-authTag-base64",
      keyVersion: 1,
    });
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: true,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    const json = JSON.stringify(res.body);

    // The ciphertext generated by encryption should NEVER be in the response
    expect(json).not.toContain("super-secret-ciphertext-base64");
    expect(json).not.toContain("super-secret-iv-base64");
    expect(json).not.toContain("super-secret-authTag-base64");
    expect(json).not.toContain("ciphertext");
    expect(json).not.toContain("iv");
    expect(json).not.toContain("authTag");
  });
});

// =============================================================================
// PHASE 4.4C.1 — Conflict / Stale Request Tests
// =============================================================================

describe("PHASE 4.4C.1 — stale request / ENROLLMENT_SAMPLE_CONFLICT", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockIsOnboardingComplete.mockReset();
    mockGetEnrollmentSessionByUserId.mockReset();
    mockIsEnrollmentSessionExpired.mockReset();
    mockAppendAcceptedEnrollmentSample.mockReset();
    mockAnalyzeEnrollmentSample.mockReset();
    mockEncryptBiometricVector.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // 17. conflict response contains no embedding
  it("ENROLLMENT_SAMPLE_CONFLICT response contains no embedding", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-conflict" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-conflict" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: false,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
      reason: "CONFLICT",
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(409);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("embedding");
    expect(json).not.toContain("0.");
  });

  // 18. conflict response contains no ciphertext
  it("ENROLLMENT_SAMPLE_CONFLICT response contains no ciphertext", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-conflict2" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-conflict2" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce({
      ciphertext: "super-secret-ciphertext",
      iv: "super-secret-iv",
      authTag: "super-secret-authTag",
      keyVersion: 1,
    });
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: false,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
      reason: "CONFLICT",
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(409);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("ciphertext");
    expect(json).not.toContain("super-secret");
  });

  // 19. plaintext embedding is never persisted (tested by route tests above)
  // The route encrypts BEFORE calling append, so the conflict response
  // has already encrypted — this test verifies the conflict does not
  // re-encrypt or re-call Face Service.
  it("stale request does NOT call Face Service again after conflict", async () => {
    // First request: succeeds
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-no-retry" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-no-retry" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: false,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
      reason: "CONFLICT",
    });

    await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));

    // Face Service is called exactly once per POST — no automatic retry
    expect(mockAnalyzeEnrollmentSample).toHaveBeenCalledTimes(1);
    // Encryption is called exactly once per POST — no re-encryption after conflict
    expect(mockEncryptBiometricVector).toHaveBeenCalledTimes(1);
    // Append is called exactly once per POST
    expect(mockAppendAcceptedEnrollmentSample).toHaveBeenCalledTimes(1);
  });

  // 10. stale request does NOT automatically re-encrypt using sampleIndex 1
  it("stale request does NOT re-compute sampleIndex and re-encrypt", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-no-recompute" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-no-recompute",
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
        acceptedSamples: [{}], // session already has 1 sample
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: false,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
      reason: "CONFLICT",
    });

    await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));

    // Encryption is called only once (before the conflict is known)
    expect(mockEncryptBiometricVector).toHaveBeenCalledTimes(1);
    // The AAD sampleIndex passed to encryption should be 1 (current length)
    // but no re-encryption with index 2 occurs after conflict
    const encryptCall = mockEncryptBiometricVector.mock.calls[0]!;
    expect(encryptCall[1].sampleIndex).toBe(1);
    // Only one call to the persistence layer
    expect(mockAppendAcceptedEnrollmentSample).toHaveBeenCalledTimes(1);
  });

  // Maps CONFLICT reason to ENROLLMENT_SAMPLE_CONFLICT error code
  it("maps service CONFLICT reason to ENROLLMENT_SAMPLE_CONFLICT error code", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-map-conflict" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-map-conflict" }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: false,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
      reason: "CONFLICT",
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_SAMPLE_CONFLICT,
        message: expect.stringContaining("concurrent"),
      },
    });
  });

  // Stale first sample: conflict returned when another request already initialized metadata
  it("stale first sample (metadata already set) returns CONFLICT", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-stale-first" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-stale-first",
        modelIdentity: "insightface-buffalo-l", // metadata already set
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
        acceptedSamples: [{}], // and already has a sample
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    mockAnalyzeEnrollmentSample.mockResolvedValueOnce(
      makeAcceptedFaceServiceResponse(),
    );
    mockEncryptBiometricVector.mockReturnValueOnce(makeEncryptedVectorFixture());
    // Service returns CONFLICT because metadata is already set and this is not
    // the first sample, but also index doesn't match (expected 0 but length is 1)
    mockAppendAcceptedEnrollmentSample.mockResolvedValueOnce({
      success: false,
      newAcceptedCount: 1,
      requiredSampleCount: 5,
      complete: false,
      reason: "CONFLICT",
    });

    const res = await callRoute(makeFormRequest(makeValidImageBuffer(), "image/jpeg"));
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_SAMPLE_CONFLICT,
        message: expect.any(String),
      },
    });
  });
});
