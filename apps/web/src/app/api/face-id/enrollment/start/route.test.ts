/**
 * Tests for POST /api/face-id/enrollment/start.
 *
 * PHASE 4.4B1 — Face ID Enrollment Start API.
 *
 * These tests mock:
 *   - `getSession` (the Better Auth server session helper)
 *   - the `profile-service` (Profile completion check)
 *   - the `face-profile-service` (existing FaceProfile check)
 *   - the `enrollment-session-service` (create/reset session)
 *   - the `face-service-client` (must never be called)
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

const mockHasFaceProfile = vi.fn();

const mockCreateOrResetEnrollmentSession = vi.fn();

const mockGetFaceServiceHealth = vi.fn();
const mockAnalyzeEnrollmentSample = vi.fn();

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
  hasFaceProfile: (...args: unknown[]) => mockHasFaceProfile(...args),
}));

vi.mock("@/lib/biometrics/enrollment-session-service", () => ({
  createOrResetEnrollmentSession: (...args: unknown[]) =>
    mockCreateOrResetEnrollmentSession(...args),
}));

// The route deliberately does NOT import the Face Service client, but
// we mock it defensively so the test can assert it is never called
// even if a future refactor accidentally imports it.
vi.mock("@/lib/biometrics/face-service-client", () => ({
  getFaceServiceHealth: (...args: unknown[]) =>
    mockGetFaceServiceHealth(...args),
  analyzeEnrollmentSample: (...args: unknown[]) =>
    mockAnalyzeEnrollmentSample(...args),
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
  expiresAt?: Date;
} = {}) {
  return {
    userId: overrides.userId ?? "user-1",
    mode: "create" as const,
    templateVersion: 1,
    requiredSampleCount: 5,
    acceptedSamples: [],
    expiresAt:
      overrides.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// =============================================================================
// Import SUT
// =============================================================================

import { POST } from "@/app/api/face-id/enrollment/start/route";
import { ENROLLMENT_ROUTE_ERROR_CODES } from "@/lib/biometrics/enrollment-route-errors";
import {
  BIOMETRIC_PERSISTENCE_ERROR_CODES,
  BiometricPersistenceError,
} from "@/lib/biometrics/biometric-errors";
import { DEFAULT_ENROLLMENT_SESSION_TTL_MS } from "@/lib/biometrics/enrollment-session-ttl";

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

async function callRoute(): Promise<ResponseShape> {
  // The route ignores the request body; the handler has no required
  // arguments in PHASE 4.4B1 because no input is read.
  const result = await POST();
  return unwrapResponse(result as unknown as { status: number; body: unknown });
}

// =============================================================================
// Tests
// =============================================================================

describe("POST /api/face-id/enrollment/start", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockIsOnboardingComplete.mockReset();
    mockHasFaceProfile.mockReset();
    mockCreateOrResetEnrollmentSession.mockReset();
    mockGetFaceServiceHealth.mockReset();
    mockAnalyzeEnrollmentSample.mockReset();
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
    expect(mockHasFaceProfile).not.toHaveBeenCalled();
    expect(mockCreateOrResetEnrollmentSession).not.toHaveBeenCalled();
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
    expect(mockHasFaceProfile).not.toHaveBeenCalled();
    expect(mockCreateOrResetEnrollmentSession).not.toHaveBeenCalled();
  });

  it("rejects when Profile exists but onboardingCompleted is false", async () => {
    // `isOnboardingComplete` already covers both "no profile" and
    // "profile with onboardingCompleted: false" by returning false.
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

  it("accepts a completed Profile and continues to the FaceProfile check", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    // No existing FaceProfile.
    mockHasFaceProfile.mockResolvedValueOnce(false);
    mockCreateOrResetEnrollmentSession.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );

    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(mockHasFaceProfile).toHaveBeenCalledWith("user-1");
  });

  // -------------------------------------------------------------------
  // 3. Existing FaceProfile blocks new enrollment
  // -------------------------------------------------------------------

  it("rejects when an active FaceProfile already exists", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(true);

    const res = await callRoute();
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.FACE_PROFILE_ALREADY_EXISTS,
        message: expect.any(String),
      },
    });
    expect(mockCreateOrResetEnrollmentSession).not.toHaveBeenCalled();
  });

  it("does NOT call any delete / replace operation on the existing FaceProfile", async () => {
    // The route handler has no direct delete API; we verify by
    // ensuring that the only FaceProfile-service entry point used is
    // `hasFaceProfile`, and that the enrollment-session service is
    // not called when the profile already exists.
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(true);

    await callRoute();
    expect(mockCreateOrResetEnrollmentSession).not.toHaveBeenCalled();
    // No FaceProfile mutation primitives are mocked, so a stray call
    // would surface as `undefined` / a missing-function error.
  });

  // -------------------------------------------------------------------
  // 4. Happy path: new enrollment session
  // -------------------------------------------------------------------

  it("uses mode=create when starting a new enrollment session", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(false);
    mockCreateOrResetEnrollmentSession.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );

    await callRoute();
    expect(mockCreateOrResetEnrollmentSession).toHaveBeenCalledTimes(1);
    const [input] = mockCreateOrResetEnrollmentSession.mock.calls[0] as [
      { userId: string; mode: string; requiredSampleCount: number },
    ];
    expect(input.mode).toBe("create");
  });

  it("uses the centralized required sample count = 5", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(false);
    mockCreateOrResetEnrollmentSession.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );

    await callRoute();
    const [input] = mockCreateOrResetEnrollmentSession.mock.calls[0] as [
      { requiredSampleCount: number },
    ];
    expect(input.requiredSampleCount).toBe(5);
  });

  it("responds with acceptedSamples starting at 0", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(false);
    mockCreateOrResetEnrollmentSession.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );

    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "started",
      mode: "create",
      acceptedSamples: 0,
      requiredSamples: 5,
      expiresAt: expect.any(String),
    });
  });

  it("generates expiresAt server-side (about now + DEFAULT_ENROLLMENT_SESSION_TTL_MS)", async () => {
    const before = Date.now();
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(false);
    mockCreateOrResetEnrollmentSession.mockImplementationOnce((input) => {
      // Simulate the service behavior: expiresAt = now + TTL.
      const expiresAt = new Date(
        Date.now() + DEFAULT_ENROLLMENT_SESSION_TTL_MS,
      );
      return Promise.resolve({
        ...makeEnrollmentSessionFixture({ userId: input.userId }),
        expiresAt,
      });
    });

    const res = await callRoute();
    const after = Date.now();
    const body = res.body as { expiresAt: string };
    const expiresAtMs = new Date(body.expiresAt).getTime();
    expect(expiresAtMs).toBeGreaterThanOrEqual(
      before + DEFAULT_ENROLLMENT_SESSION_TTL_MS - 100,
    );
    expect(expiresAtMs).toBeLessThanOrEqual(
      after + DEFAULT_ENROLLMENT_SESSION_TTL_MS + 100,
    );
  });

  it("passes session.user.id (not body) to the enrollment-session service", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "session-user" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(false);
    mockCreateOrResetEnrollmentSession.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "session-user" }),
    );

    await callRoute();
    const [input] = mockCreateOrResetEnrollmentSession.mock.calls[0] as [
      { userId: string },
    ];
    expect(input.userId).toBe("session-user");
  });

  it("ignores a malicious body-supplied userId (cannot affect ownership)", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "session-user" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(false);
    mockCreateOrResetEnrollmentSession.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "session-user" }),
    );

    // The route does not read the request body — a body containing
    // `{ "userId": "another-user" }` must not affect ownership.
    // Calling `POST()` with no arguments exercises the same code path
    // a malicious browser would, since the handler signature has no
    // body parameter.
    const result = await POST();
    void unwrapResponse(
      result as unknown as { status: number; body: unknown },
    );

    const [input] = mockCreateOrResetEnrollmentSession.mock.calls[0] as [
      { userId: string },
    ];
    expect(input.userId).toBe("session-user");
    expect(input.userId).not.toBe("another-user");
  });

  it("calls the enrollment-session service on a repeated start (reset semantics)", async () => {
    mockGetSession.mockResolvedValue(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockHasFaceProfile.mockResolvedValue(false);
    mockCreateOrResetEnrollmentSession.mockResolvedValue(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );

    // Two sequential starts.
    await callRoute();
    await callRoute();

    expect(mockCreateOrResetEnrollmentSession).toHaveBeenCalledTimes(2);
    const calls = mockCreateOrResetEnrollmentSession.mock.calls.map(
      ([input]) => input,
    );
    for (const input of calls) {
      expect(input).toMatchObject({
        userId: "user-1",
        mode: "create",
        requiredSampleCount: 5,
      });
    }
    // The service implementation, not the route, owns the "reset"
    // semantics; we just verify the route invokes it again rather
    // than returning a duplicate-document error.
  });

  // -------------------------------------------------------------------
  // 5. Response privacy: no biometric / identity leakage
  // -------------------------------------------------------------------

  it("does not return userId in the success response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(false);
    mockCreateOrResetEnrollmentSession.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );

    const res = await callRoute();
    expect(res.status).toBe(200);
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("userId");
    expect(json).not.toContain("user-1");
    expect(json).not.toContain("session-user");
  });

  it("does not return embedding in the success response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(false);
    mockCreateOrResetEnrollmentSession.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );

    const res = await callRoute();
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("embedding");
    expect(json).not.toContain("ciphertext");
    expect(json).not.toContain("iv");
    expect(json).not.toContain("authTag");
    expect(json).not.toContain("modelIdentity");
    expect(json).not.toContain("modelName");
    expect(json).not.toContain("email");
  });

  it("does not return encrypted biometric fields in the success response", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(false);
    mockCreateOrResetEnrollmentSession.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );

    const res = await callRoute();
    const body = res.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("userId");
    expect(body).not.toHaveProperty("email");
    expect(body).not.toHaveProperty("encryptedVector");
    expect(body).not.toHaveProperty("ciphertext");
    expect(body).not.toHaveProperty("iv");
    expect(body).not.toHaveProperty("authTag");
    expect(body).not.toHaveProperty("modelIdentity");
    expect(body).not.toHaveProperty("modelName");
    expect(body).not.toHaveProperty("embedding");
    expect(body).not.toHaveProperty("samples");
    expect(body).not.toHaveProperty("acceptedSamplesDetail");
  });

  it("does not leak Mongo / Mongoose internals in error responses", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(false);
    // Plain object — the route treats anything that is NOT a
    // BiometricPersistenceError as the safe ENROLLMENT_START_FAILED.
    mockCreateOrResetEnrollmentSession.mockRejectedValueOnce({
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
      ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_START_FAILED,
    );
  });

  // -------------------------------------------------------------------
  // 6. Service / persistence failure mapping
  // -------------------------------------------------------------------

  it("maps a BiometricPersistenceError to FACE_PROFILE_ALREADY_EXISTS on duplicate-key", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(false);
    mockCreateOrResetEnrollmentSession.mockRejectedValueOnce(
      new BiometricPersistenceError({
        code: BIOMETRIC_PERSISTENCE_ERROR_CODES.BIOMETRIC_PROFILE_ALREADY_EXISTS,
        message: "A face profile already exists for this account.",
      }),
    );

    const res = await callRoute();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.FACE_PROFILE_ALREADY_EXISTS,
      },
    });
  });

  it("maps an unknown persistence error to ENROLLMENT_START_FAILED", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(false);
    mockCreateOrResetEnrollmentSession.mockRejectedValueOnce(
      new BiometricPersistenceError({
        code: BIOMETRIC_PERSISTENCE_ERROR_CODES.UNKNOWN_ERROR,
        message: "An unexpected error occurred.",
      }),
    );

    const res = await callRoute();
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_START_FAILED,
      },
    });
  });

  it("maps a non-biometric thrown value to ENROLLMENT_START_FAILED", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(false);
    mockCreateOrResetEnrollmentSession.mockRejectedValueOnce(
      new Error("network blip"),
    );

    const res = await callRoute();
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_START_FAILED,
      },
    });
    const json = JSON.stringify(res.body);
    expect(json).not.toContain("network blip");
  });

  // -------------------------------------------------------------------
  // 7. Face Service client is never called
  // -------------------------------------------------------------------

  it("never calls getFaceServiceHealth()", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(false);
    mockCreateOrResetEnrollmentSession.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );

    await callRoute();
    expect(mockGetFaceServiceHealth).not.toHaveBeenCalled();
  });

  it("never calls analyzeEnrollmentSample()", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "user-1" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(false);
    mockCreateOrResetEnrollmentSession.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "user-1" }),
    );

    await callRoute();
    expect(mockAnalyzeEnrollmentSample).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // 8. Authenticated-and-ready path uses session.user.id (not body)
  // -------------------------------------------------------------------

  it("treats a completed session.user as authoritative for ownership", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession({ id: "session-user" }));
    mockIsOnboardingComplete.mockResolvedValueOnce(true);
    mockHasFaceProfile.mockResolvedValueOnce(false);
    mockCreateOrResetEnrollmentSession.mockResolvedValueOnce(
      makeEnrollmentSessionFixture({ userId: "session-user" }),
    );

    await callRoute();
    const profileCall = mockIsOnboardingComplete.mock.calls[0] as [string];
    const faceProfileCall = mockHasFaceProfile.mock.calls[0] as [string];
    const enrollCall = mockCreateOrResetEnrollmentSession.mock
      .calls[0] as [{ userId: string }];
    expect(profileCall[0]).toBe("session-user");
    expect(faceProfileCall[0]).toBe("session-user");
    expect(enrollCall[0].userId).toBe("session-user");
  });
});