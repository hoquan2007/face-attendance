/**
 * Tests for the enrollment start server action.
 *
 * PHASE 4.5B1 — Face ID Page Shell.
 *
 * These tests mock:
 *   - getSession
 *   - profile-service
 *   - face-profile-service
 *   - enrollment-session-service
 *
 * No MongoDB / Mongoose is touched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// Mock collaborators
// =============================================================================

const mockGetSession = vi.fn();
const mockIsOnboardingComplete = vi.fn();
const mockHasFaceProfile = vi.fn();
const mockCreateOrResetEnrollmentSession = vi.fn();

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

import { startFaceEnrollment } from "@/lib/biometrics/enrollment-start-action";

describe("enrollment-start-action / startFaceEnrollment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns UNAUTHENTICATED when no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const result = await startFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UNAUTHENTICATED");
    }
  });

  it("returns PROFILE_INCOMPLETE when profile not complete", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(false);
    const result = await startFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PROFILE_INCOMPLETE");
    }
  });

  it("returns FACE_PROFILE_ALREADY_EXISTS when face profile exists", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockHasFaceProfile.mockResolvedValue(true);
    const result = await startFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("FACE_PROFILE_ALREADY_EXISTS");
    }
    expect(mockCreateOrResetEnrollmentSession).not.toHaveBeenCalled();
  });

  it("creates a session and returns success DTO", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockHasFaceProfile.mockResolvedValue(false);
    mockCreateOrResetEnrollmentSession.mockResolvedValue({
      userId: "u1",
      mode: "create",
      requiredSampleCount: 5,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      generationId: "gen-start-action-1",
    });
    const result = await startFaceEnrollment();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.status).toBe("started");
      expect(result.mode).toBe("create");
      expect(result.acceptedSamples).toBe(0);
      expect(result.requiredSamples).toBe(5);
      expect(result.generationId).toBe("gen-start-action-1");
    }
  });

  it("maps persistence errors to ENROLLMENT_START_FAILED", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockHasFaceProfile.mockResolvedValue(false);
    mockCreateOrResetEnrollmentSession.mockRejectedValue(
      new Error("DB exploded"),
    );
    const result = await startFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("ENROLLMENT_START_FAILED");
    }
  });

  it("does not pass any userId from the request body", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockHasFaceProfile.mockResolvedValue(false);
    mockCreateOrResetEnrollmentSession.mockResolvedValue({
      userId: "u1",
      mode: "create",
      requiredSampleCount: 5,
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      generationId: "gen-start-action-2",
    });
    await startFaceEnrollment();
    // Pass! The action signature has no body parameter — it is
    // explicitly empty.
    expect(mockCreateOrResetEnrollmentSession).toHaveBeenCalledTimes(1);
    const callArg = mockCreateOrResetEnrollmentSession.mock.calls[0]?.[0] as
      | { userId: string; mode: string }
      | undefined;
    expect(callArg?.userId).toBe("u1"); // From session, not browser.
    expect(callArg?.mode).toBe("create");
  });
});
