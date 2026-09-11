/**
 * Tests for GET /api/face-id/enrollment/status.
 *
 * PHASE 4.4B2 — Face ID Enrollment Status API.
 *
 * These tests mock:
 *   - `getSession` (the Better Auth server session helper)
 *   - the `profile-service` (Profile completion check)
 *   - the `face-profile-service` (FaceProfile read)
 *   - the `enrollment-session-service` (read, expiration check,
 *     best-effort delete)
 *   - the `face-service-client` (must never be called)
 *   - the `biometrics/encryption` module (must never be called —
 *     status is biometric-free and crypto-free)
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

const mockGetFaceProfileByUserId = vi.fn();

const mockGetEnrollmentSessionByUserId = vi.fn();
const mockIsEnrollmentSessionExpired = vi.fn();
const mockDeleteEnrollmentSessionByUserId = vi.fn();

const mockGetFaceServiceHealth = vi.fn();
const mockAnalyzeEnrollmentSample = vi.fn();

// Cryptography / encryption module — the status route must NEVER
// import it. The test still mocks it so that any future refactor
// that accidentally pulls it in (e.g. via a transitive re-export)
// would surface as a `vi.fn()` call that we can assert was never
// invoked.
const mockEncryptBiometricValue = vi.fn();
const mockDecryptBiometricValue = vi.fn();
const mockBuildEncryptionContext = vi.fn();

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

vi.mock("@/lib/biometrics/face-profile-service", () => ({
  getFaceProfileByUserId: (...args: unknown[]) =>
    mockGetFaceProfileByUserId(...args),
}));

vi.mock("@/lib/biometrics/enrollment-session-service", () => ({
  getEnrollmentSessionByUserId: (...args: unknown[]) =>
    mockGetEnrollmentSessionByUserId(...args),
  isEnrollmentSessionExpired: (...args: unknown[]) =>
    mockIsEnrollmentSessionExpired(...args),
  deleteEnrollmentSessionByUserId: (...args: unknown[]) =>
    mockDeleteEnrollmentSessionByUserId(...args),
}));

// The status route deliberately does NOT import the Face Service
// client, but we mock it defensively so the test can assert it is
// never called even if a future refactor accidentally imports it.
vi.mock("@/lib/biometrics/face-service-client", () => ({
  getFaceServiceHealth: (...args: unknown[]) =>
    mockGetFaceServiceHealth(...args),
  analyzeEnrollmentSample: (...args: unknown[]) =>
    mockAnalyzeEnrollmentSample(...args),
}));

// The status route deliberately does NOT import the encryption
// module, but we mock it defensively so the test can assert it is
// never called even if a future refactor accidentally imports it.
vi.mock("@/lib/biometrics/encryption", () => ({
  encryptBiometricValue: (...args: unknown[]) =>
    mockEncryptBiometricValue(...args),
  decryptBiometricValue: (...args: unknown[]) =>
    mockDecryptBiometricValue(...args),
  buildEncryptionContext: (...args: unknown[]) =>
    mockBuildEncryptionContext(...args),
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

function makeFaceProfileFixture(overrides: {
  userId?: string;
  enrolledAt?: Date;
  sampleCount?: number;
} = {}) {
  return {
    userId: overrides.userId ?? "user-1",
    status: "active" as const,
    modelIdentity: "insightface-buffalo-l",
    modelName: "buffalo_l",
    embeddingDimension: 512,
    normalization: "l2" as const,
    templateVersion: 1,
    requiredSampleCount: 5,
    sampleCount: overrides.sampleCount ?? 5,
    samples: [
      // Encrypted-vector shape is present so we can verify it is
      // never copied into the response.
      {
        encryptedVector: {
          ciphertext: "base64-ciphertext-A",
          iv: "base64-iv-A",
          authTag: "base64-authTag-A",
          keyVersion: 1,
        },
        sampleIndex: 0,
      },
      {
        encryptedVector: {
          ciphertext: "base64-ciphertext-B",
          iv: "base64-iv-B",
          authTag: "base64-authTag-B",
          keyVersion: 1,
        },
        sampleIndex: 1,
      },
    ],
    centroid: {
      ciphertext: "base64-centroid-ciphertext",
      iv: "base64-centroid-iv",
      authTag: "base64-centroid-authTag",
      keyVersion: 1,
    },
    enrolledAt: overrides.enrolledAt ?? new Date("2026-09-01T10:00:00.000Z"),
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    updatedAt: new Date("2026-09-01T10:00:00.000Z"),
  };
}

function makeEnrollmentSessionFixture(overrides: {
  userId?: string;
  mode?: "create" | "replace";
  requiredSampleCount?: number;
  acceptedSamples?: unknown[];
  expiresAt?: Date;
} = {}) {
  return {
    userId: overrides.userId ?? "user-1",
    mode: overrides.mode ?? "create",
    templateVersion: 1,
    requiredSampleCount: overrides.requiredSampleCount ?? 5,
    acceptedSamples: overrides.acceptedSamples ?? [],
    expiresAt:
      overrides.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// =============================================================================
// Import SUT
// =============================================================================

import { GET } from "@/app/api/face-id/enrollment/status/route";
import { ENROLLMENT_ROUTE_ERROR_CODES } from "@/lib/biometrics/enrollment-route-errors";

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
 * Builds a minimal NextRequest-like object. Only the URL matters for
 * the tests; the route does not read any other request property.
 */
function makeRequest(url = "http://localhost/api/face-id/enrollment/status") {
  return new Request(url, { method: "GET" }) as unknown as Parameters<
    typeof GET
  >[0];
}

async function callRoute(
  url = "http://localhost/api/face-id/enrollment/status",
): Promise<ResponseShape> {
  const result = await GET(makeRequest(url));
  return unwrapResponse(result as unknown as { status: number; body: unknown });
}

// =============================================================================
// Tests
// =============================================================================

describe("GET /api/face-id/enrollment/status", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockIsOnboardingComplete.mockReset();
    mockGetFaceProfileByUserId.mockReset();
    mockGetEnrollmentSessionByUserId.mockReset();
    mockIsEnrollmentSessionExpired.mockReset();
    mockDeleteEnrollmentSessionByUserId.mockReset();
    mockGetFaceServiceHealth.mockReset();
    mockAnalyzeEnrollmentSample.mockReset();
    mockEncryptBiometricValue.mockReset();
    mockDecryptBiometricValue.mockReset();
    mockBuildEncryptionContext.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------
  // 1. Authentication
  // -------------------------------------------------------------------

  it("rejects unauthenticated requests with UNAUTHENTICATED", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const res = await callRoute();
    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.UNAUTHENTICATED,
        message: expect.any(String),
      },
    });
    expect(mockIsOnboardingComplete).not.toHaveBeenCalled();
    expect(mockGetFaceProfileByUserId).not.toHaveBeenCalled();
    expect(mockGetEnrollmentSessionByUserId).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // 2. Profile requirement
  // -------------------------------------------------------------------

  it("rejects when no Profile exists (PROFILE_INCOMPLETE)", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(false);

    const res = await callRoute();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.PROFILE_INCOMPLETE,
        message: expect.any(String),
      },
    });
    expect(mockGetFaceProfileByUserId).not.toHaveBeenCalled();
    expect(mockGetEnrollmentSessionByUserId).not.toHaveBeenCalled();
  });

  it("rejects when Profile exists but onboardingCompleted is false (PROFILE_INCOMPLETE)", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(false);

    const res = await callRoute();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.PROFILE_INCOMPLETE,
      },
    });
  });

  it("accepts a completed Profile and continues to the service layer", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(mockGetFaceProfileByUserId).toHaveBeenCalledWith("user-1");
    expect(mockGetEnrollmentSessionByUserId).toHaveBeenCalledWith("user-1");
  });

  // -------------------------------------------------------------------
  // 3. FaceProfile status — no profile
  // -------------------------------------------------------------------

  it("returns configured=false when no FaceProfile exists", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    const res = await callRoute();
    expect(res.status).toBe(200);
    const body = res.body as { configured: boolean; faceId: unknown };
    expect(body.configured).toBe(false);
    expect(body.faceId).toBeNull();
  });

  // -------------------------------------------------------------------
  // 4. FaceProfile status — configured
  // -------------------------------------------------------------------

  it("returns configured=true when a FaceProfile exists", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(
      makeFaceProfileFixture({ userId: "user-1" }),
    );
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    const res = await callRoute();
    expect(res.status).toBe(200);
    const body = res.body as { configured: boolean; faceId: unknown };
    expect(body.configured).toBe(true);
    expect(body.faceId).not.toBeNull();
  });

  it("includes enrolledAt in the configured response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    const enrolledAt = new Date("2026-09-01T10:00:00.000Z");
    mockGetFaceProfileByUserId.mockResolvedValueOnce(
      makeFaceProfileFixture({ userId: "user-1", enrolledAt }),
    );
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    const res = await callRoute();
    const body = res.body as { faceId: { enrolledAt: string } | null };
    expect(body.faceId).not.toBeNull();
    expect(body.faceId?.enrolledAt).toBe(enrolledAt.toISOString());
  });

  it("includes sampleCount in the configured response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(
      makeFaceProfileFixture({ userId: "user-1", sampleCount: 5 }),
    );
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    const res = await callRoute();
    const body = res.body as { faceId: { sampleCount: number } | null };
    expect(body.faceId).not.toBeNull();
    expect(body.faceId?.sampleCount).toBe(5);
  });

  // -------------------------------------------------------------------
  // 5. Response privacy: no identity / biometric leakage
  // -------------------------------------------------------------------

  it("does NOT include userId in the success response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(
      makeFaceProfileFixture({ userId: "user-1" }),
    );
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    const res = await callRoute();
    expect(res.status).toBe(200);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("userId");
    expect(json).not.toContain("user-1");
  });

  it("does NOT include email in the success response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(
      makeFaceProfileFixture({ userId: "user-1" }),
    );
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    const res = await callRoute();
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("email");
  });

  it("does NOT include embedding in the success response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(
      makeFaceProfileFixture({ userId: "user-1" }),
    );
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    const res = await callRoute();
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("embedding");
  });

  it("does NOT include centroid in the success response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(
      makeFaceProfileFixture({ userId: "user-1" }),
    );
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    const res = await callRoute();
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("centroid");
  });

  it("does NOT include ciphertext / iv / authTag / keyVersion in the success response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(
      makeFaceProfileFixture({ userId: "user-1" }),
    );
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    const res = await callRoute();
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("ciphertext");
    expect(json).not.toContain("authTag");
    expect(json).not.toContain("keyVersion");
    // `iv` is a 2-letter token that could match a long arbitrary
    // string. Assert the encrypted vector is not present as a
    // structured object instead.
    const body = res.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("iv");
    expect(body).not.toHaveProperty("authTag");
    expect(body).not.toHaveProperty("keyVersion");
    expect(body).not.toHaveProperty("ciphertext");
  });

  it("does NOT include encrypted sample objects in the success response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(
      makeFaceProfileFixture({ userId: "user-1" }),
    );
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    const res = await callRoute();
    const body = res.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("samples");
    expect(body).not.toHaveProperty("encryptedSamples");
    expect(body).not.toHaveProperty("acceptedSampleData");
    expect(body).not.toHaveProperty("encryptedVector");
    // No base64 ciphertext from the fixture must leak.
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("base64-ciphertext-A");
    expect(json).not.toContain("base64-ciphertext-B");
    expect(json).not.toContain("base64-centroid");
  });

  it("does NOT include model identity / normalization / quality in the success response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(
      makeFaceProfileFixture({ userId: "user-1" }),
    );
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    const res = await callRoute();
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("modelIdentity");
    expect(json).not.toContain("modelName");
    expect(json).not.toContain("embeddingDimension");
    expect(json).not.toContain("normalization");
    expect(json).not.toContain("qualitySummary");
    expect(json).not.toContain("quality");
    expect(json).not.toContain("templateVersion");
  });

  it("does NOT leak identity in unauthenticated / profile-incomplete error responses", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const res = await callRoute();
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("user-1");
    expect(json).not.toContain("embedding");
    expect(json).not.toContain("centroid");
    expect(json).not.toContain("ciphertext");
  });

  // -------------------------------------------------------------------
  // 6. EnrollmentSession status — no session
  // -------------------------------------------------------------------

  it("returns enrollment.active=false when no EnrollmentSession exists", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    const res = await callRoute();
    const body = res.body as {
      enrollment: {
        active: boolean;
        mode: string | null;
        acceptedSamples: number;
        requiredSamples: number;
        expiresAt: string | null;
      };
    };
    expect(body.enrollment.active).toBe(false);
    expect(body.enrollment.mode).toBeNull();
    expect(body.enrollment.acceptedSamples).toBe(0);
    expect(body.enrollment.requiredSamples).toBe(0);
    expect(body.enrollment.expiresAt).toBeNull();
  });

  // -------------------------------------------------------------------
  // 7. EnrollmentSession status — active unexpired
  // -------------------------------------------------------------------

  it("returns enrollment.active=true for an unexpired session", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        requiredSampleCount: 5,
        acceptedSamples: [{}, {}],
        expiresAt,
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValueOnce(false);

    const res = await callRoute();
    const body = res.body as {
      enrollment: {
        active: boolean;
        mode: string | null;
        acceptedSamples: number;
        requiredSamples: number;
        expiresAt: string | null;
      };
    };
    expect(body.enrollment.active).toBe(true);
    expect(body.enrollment.acceptedSamples).toBe(2);
    expect(body.enrollment.requiredSamples).toBe(5);
    expect(body.enrollment.expiresAt).toBe(expiresAt.toISOString());
  });

  it("derives acceptedSamples from acceptedSamples.length (not from any client input)", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    // The fixture provides 3 sample objects; the route must derive
    // 3 from the array length even if a malicious client were to
    // somehow pass a different number — the route never reads the
    // request body.
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        requiredSampleCount: 5,
        acceptedSamples: [{}, {}, {}],
        expiresAt,
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValueOnce(false);

    const res = await callRoute();
    const body = res.body as { enrollment: { acceptedSamples: number } };
    expect(body.enrollment.acceptedSamples).toBe(3);
  });

  it("returns requiredSamples from the session document", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        requiredSampleCount: 7,
        acceptedSamples: [{}],
        expiresAt,
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValueOnce(false);

    const res = await callRoute();
    const body = res.body as { enrollment: { requiredSamples: number } };
    expect(body.enrollment.requiredSamples).toBe(7);
  });

  it("returns expiresAt safely (ISO 8601 string) for an active session", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    const expiresAt = new Date("2026-12-31T23:59:59.000Z");
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        acceptedSamples: [{}],
        expiresAt,
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValueOnce(false);

    const res = await callRoute();
    const body = res.body as { enrollment: { expiresAt: string } };
    expect(body.enrollment.expiresAt).toBe("2026-12-31T23:59:59.000Z");
  });

  it("serializes mode='create' on an active CREATE session", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        mode: "create",
        acceptedSamples: [{}],
        expiresAt,
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValueOnce(false);

    const res = await callRoute();
    const body = res.body as { enrollment: { mode: string } };
    expect(body.enrollment.mode).toBe("create");
  });

  it("serializes mode='replace' on an active REPLACE session (future-safe)", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        mode: "replace",
        acceptedSamples: [{}],
        expiresAt,
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValueOnce(false);

    const res = await callRoute();
    const body = res.body as { enrollment: { mode: string } };
    expect(body.enrollment.mode).toBe("replace");
  });

  it("does not expose the actual acceptedSamples array in the response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        requiredSampleCount: 5,
        acceptedSamples: [
          { encryptedVector: "secret-1" },
          { encryptedVector: "secret-2" },
        ],
        expiresAt,
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValueOnce(false);

    const res = await callRoute();
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("secret-1");
    expect(json).not.toContain("secret-2");
    // The response exposes `acceptedSamples` as a NUMBER count
    // (derived from the stored array length); the actual array
    // must never be copied into the response.
    const body = res.body as { enrollment: { acceptedSamples: unknown } };
    expect(typeof body.enrollment.acceptedSamples).toBe("number");
    expect(body.enrollment.acceptedSamples).toBe(2);
    expect(Array.isArray(body.enrollment.acceptedSamples)).toBe(false);
  });

  // -------------------------------------------------------------------
  // 8. EnrollmentSession status — expired
  // -------------------------------------------------------------------

  it("returns enrollment.active=false for an expired session", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        expiresAt: new Date(Date.now() - 1000),
        acceptedSamples: [{}, {}],
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValueOnce(true);
    mockDeleteEnrollmentSessionByUserId.mockResolvedValueOnce(true);

    const res = await callRoute();
    const body = res.body as {
      enrollment: {
        active: boolean;
        mode: string | null;
        acceptedSamples: number;
        requiredSamples: number;
        expiresAt: string | null;
      };
    };
    expect(body.enrollment.active).toBe(false);
    expect(body.enrollment.mode).toBeNull();
    expect(body.enrollment.acceptedSamples).toBe(0);
    expect(body.enrollment.expiresAt).toBeNull();
  });

  it("attempts best-effort cleanup of an expired session", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        expiresAt: new Date(Date.now() - 1000),
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValueOnce(true);
    mockDeleteEnrollmentSessionByUserId.mockResolvedValueOnce(true);

    await callRoute();
    expect(mockDeleteEnrollmentSessionByUserId).toHaveBeenCalledWith("user-1");
    expect(mockDeleteEnrollmentSessionByUserId).toHaveBeenCalledTimes(1);
  });

  it("still returns enrollment.active=false even if cleanup fails", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        expiresAt: new Date(Date.now() - 1000),
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValueOnce(true);
    // Simulate a transient Mongo failure during best-effort
    // cleanup. The route must NOT bubble the error as a 5xx.
    mockDeleteEnrollmentSessionByUserId.mockRejectedValueOnce(
      new Error("connection terminated"),
    );

    const res = await callRoute();
    expect(res.status).toBe(200);
    const body = res.body as { enrollment: { active: boolean } };
    expect(body.enrollment.active).toBe(false);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("connection terminated");
    expect(json).not.toContain("stack");
  });

  // -------------------------------------------------------------------
  // 9. Read-only invariants
  // -------------------------------------------------------------------

  it("GET does not create or reset an enrollment session", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    await callRoute();
    // The only session-service entry points the route calls are the
    // read (`getEnrollmentSessionByUserId`) and the
    // best-effort-delete. No createOrReset mock is exposed at all.
    expect(mockDeleteEnrollmentSessionByUserId).not.toHaveBeenCalled();
  });

  it("GET does not modify the FaceProfile", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    const before = makeFaceProfileFixture({ userId: "user-1" });
    const after = makeFaceProfileFixture({ userId: "user-1" });
    mockGetFaceProfileByUserId.mockResolvedValueOnce(before);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    await callRoute();
    // The fixture objects must be returned unchanged by the
    // service; the route does not mutate them. We assert the
    // service received the expected userId, and that no
    // face-profile mutation was triggered (no save / delete mocks
    // exist — a stray call would surface as undefined).
    expect(mockGetFaceProfileByUserId).toHaveBeenCalledWith("user-1");
    expect(before).toEqual(after);
  });

  it("GET does not modify the EnrollmentSession when it is active", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const sessionBefore = makeEnrollmentSessionFixture({
      userId: "user-1",
      requiredSampleCount: 5,
      acceptedSamples: [{}, {}],
      expiresAt,
    });
    const sessionAfter = makeEnrollmentSessionFixture({
      userId: "user-1",
      requiredSampleCount: 5,
      acceptedSamples: [{}, {}],
      expiresAt,
    });
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(sessionBefore);
    mockIsEnrollmentSessionExpired.mockReturnValueOnce(false);

    await callRoute();
    // No create-or-reset, no delete. Only the read was called.
    expect(mockDeleteEnrollmentSessionByUserId).not.toHaveBeenCalled();
    expect(sessionBefore).toEqual(sessionAfter);
  });

  // -------------------------------------------------------------------
  // 10. Security ownership: query userId cannot affect ownership
  // -------------------------------------------------------------------

  it("ignores ?userId=another-user and uses session.user.id for all service calls", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "session-user" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    const res = await callRoute(
      "http://localhost/api/face-id/enrollment/status?userId=another-user",
    );
    expect(res.status).toBe(200);

    expect(mockIsOnboardingComplete).toHaveBeenCalledWith("session-user");
    expect(mockGetFaceProfileByUserId).toHaveBeenCalledWith("session-user");
    expect(mockGetEnrollmentSessionByUserId).toHaveBeenCalledWith(
      "session-user",
    );
    // The other user's id must not appear in the response.
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("another-user");
  });

  it("ignores ?userId=another-user even when an enrollment session exists", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "session-user" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "session-user",
        acceptedSamples: [{}],
        expiresAt,
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValueOnce(false);

    const res = await callRoute(
      "http://localhost/api/face-id/enrollment/status?userId=another-user",
    );
    expect(res.status).toBe(200);
    expect(mockGetEnrollmentSessionByUserId).toHaveBeenCalledWith(
      "session-user",
    );
    // Best-effort cleanup, if any, must be called with the
    // session-user too.
    expect(mockDeleteEnrollmentSessionByUserId).not.toHaveBeenCalled();
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("another-user");
  });

  // -------------------------------------------------------------------
  // 11. Face Service client is never called
  // -------------------------------------------------------------------

  it("never calls getFaceServiceHealth()", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    await callRoute();
    expect(mockGetFaceServiceHealth).not.toHaveBeenCalled();
  });

  it("never calls analyzeEnrollmentSample()", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    await callRoute();
    expect(mockAnalyzeEnrollmentSample).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // 12. Encryption module is never called
  // -------------------------------------------------------------------

  it("never calls encryptBiometricValue()", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    await callRoute();
    expect(mockEncryptBiometricValue).not.toHaveBeenCalled();
  });

  it("never calls decryptBiometricValue()", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(
      makeFaceProfileFixture({ userId: "user-1" }),
    );
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    await callRoute();
    expect(mockDecryptBiometricValue).not.toHaveBeenCalled();
  });

  it("never calls buildEncryptionContext()", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(
      makeFaceProfileFixture({ userId: "user-1" }),
    );
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        acceptedSamples: [{}],
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValueOnce(false);

    await callRoute();
    expect(mockBuildEncryptionContext).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // 13. Database / service error mapping
  // -------------------------------------------------------------------

  it("maps an unknown thrown service value to ENROLLMENT_STATUS_FAILED", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockRejectedValueOnce(
      new Error("connection-string-here / MongooseNetworkError"),
    );

    const res = await callRoute();
    expect(res.status).toBe(500);
    const body = res.body as { error: { code: string; message: string } };
    expect(body.error.code).toBe(
      ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_STATUS_FAILED,
    );
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("connection-string");
    expect(json).not.toContain("MongooseNetworkError");
    expect(json).not.toContain("stack");
  });

  it("does not leak Mongo / Mongoose internals in error responses", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(null);
    mockGetEnrollmentSessionByUserId.mockRejectedValueOnce({
      // Simulated Mongo duplicate-key error leaking driver internals.
      code: 11000,
      keyValue: { userId: "user-1" },
      message: "E11000 duplicate key error on connection-string-here",
      stack: "MongooseError: ... at nativeConnection...",
    });

    const res = await callRoute();
    expect(res.status).toBe(500);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("E11000");
    expect(json).not.toContain("Mongoose");
    expect(json).not.toContain("connection-string");
    expect(json).not.toContain("stack");
    expect(json).toContain(
      ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_STATUS_FAILED,
    );
  });

  // -------------------------------------------------------------------
  // 14. Configured + stale session interaction
  // -------------------------------------------------------------------

  it("reports configured=true AND enrollment.active=false for a configured user with no session", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockGetFaceProfileByUserId.mockResolvedValueOnce(
      makeFaceProfileFixture({ userId: "user-1", sampleCount: 5 }),
    );
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(null);

    const res = await callRoute();
    const body = res.body as {
      configured: boolean;
      faceId: { sampleCount: number } | null;
      enrollment: { active: boolean; mode: string | null };
    };
    expect(body.configured).toBe(true);
    expect(body.faceId).not.toBeNull();
    expect(body.faceId?.sampleCount).toBe(5);
    expect(body.enrollment.active).toBe(false);
    expect(body.enrollment.mode).toBeNull();
  });

  it("does NOT auto-replace or delete the active FaceProfile when a stale session is present", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    const profile = makeFaceProfileFixture({ userId: "user-1" });
    mockGetFaceProfileByUserId.mockResolvedValueOnce(profile);
    // A "stale" REPLACE session: should be reported as such without
    // touching the existing FaceProfile.
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    mockGetEnrollmentSessionByUserId.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({
        userId: "user-1",
        mode: "replace",
        acceptedSamples: [{}],
        expiresAt,
      }),
    );
    mockIsEnrollmentSessionExpired.mockReturnValueOnce(false);

    const res = await callRoute();
    const body = res.body as {
      configured: boolean;
      enrollment: { active: boolean; mode: string | null };
    };
    expect(body.configured).toBe(true);
    expect(body.enrollment.active).toBe(true);
    expect(body.enrollment.mode).toBe("replace");
    // The profile fixture object is returned unchanged by the
    // service; the route does not invoke any mutation primitive.
    expect(profile.samples.length).toBe(2);
  });
});
