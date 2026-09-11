/**
 * Tests for the safe face-id status service.
 *
 * PHASE 4.5B1 — Face ID Page Shell.
 *
 * These tests mock all collaborators so we can verify the safe status
 * DTO logic without touching the database.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// Mock collaborators
// =============================================================================

const mockGetSession = vi.fn();
const mockIsOnboardingComplete = vi.fn();
const mockGetFaceProfileByUserId = vi.fn();
const mockGetEnrollmentSessionByUserId = vi.fn();
const mockIsEnrollmentSessionExpired = vi.fn();
const mockDeleteEnrollmentSessionByUserId = vi.fn();

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

import {
  getFaceIdStatus,
  REQUIRED_SAMPLES,
  type FaceIdStatus,
} from "@/lib/biometrics/face-id-status-service";

describe("face-id-status-service / getFaceIdStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns isAuthenticated=false when no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const result = await getFaceIdStatus();
    expect(result.isAuthenticated).toBe(false);
    expect(result.isOnboardingComplete).toBe(false);
    expect(result.status).toBeNull();
  });

  it("returns isOnboardingComplete=false when profile incomplete", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(false);
    const result = await getFaceIdStatus();
    expect(result.isAuthenticated).toBe(true);
    expect(result.isOnboardingComplete).toBe(false);
    expect(result.status).toBeNull();
  });

  it("returns isAuthenticated and status when auth+profile complete, no face id and no active session", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockGetFaceProfileByUserId.mockResolvedValue(null);
    mockGetEnrollmentSessionByUserId.mockResolvedValue(null);
    const result = await getFaceIdStatus();
    expect(result.isAuthenticated).toBe(true);
    expect(result.isOnboardingComplete).toBe(true);
    expect(result.status).toBeDefined();
    expect(result.status?.configured).toBe(false);
    expect(result.status?.faceId).toBeNull();
    expect(result.status?.enrollment.active).toBe(false);
  });

  it("returns configured=true with faceId block when profile exists", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockGetFaceProfileByUserId.mockResolvedValue({
      enrolledAt: new Date("2026-01-01T00:00:00Z"),
      sampleCount: 5,
    });
    mockGetEnrollmentSessionByUserId.mockResolvedValue(null);
    const result = await getFaceIdStatus();
    expect(result.status?.configured).toBe(true);
    expect(result.status?.faceId?.sampleCount).toBe(5);
    expect(typeof result.status?.faceId?.enrolledAt).toBe("string");
  });

  it("returns active enrollment block when session is unexpired", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockGetFaceProfileByUserId.mockResolvedValue(null);
    mockGetEnrollmentSessionByUserId.mockResolvedValue({
      mode: "create",
      requiredSampleCount: 5,
      acceptedSamples: [{ a: 1 }, { a: 2 }],
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      generationId: "gen-abc-123",
    });
    mockIsEnrollmentSessionExpired.mockReturnValue(false);
    const result = await getFaceIdStatus();
    expect(result.status?.enrollment.active).toBe(true);
    expect(result.status?.enrollment.acceptedSamples).toBe(2);
    expect(result.status?.enrollment.requiredSamples).toBe(5);
    expect(result.status?.enrollment.mode).toBe("create");
  });

  it("treats expired session as inactive and attempts cleanup", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockGetFaceProfileByUserId.mockResolvedValue(null);
    mockGetEnrollmentSessionByUserId.mockResolvedValue({
      mode: "create",
      requiredSampleCount: 5,
      acceptedSamples: [],
      expiresAt: new Date("2025-01-01T00:00:00Z"),
    });
    mockIsEnrollmentSessionExpired.mockReturnValue(true);
    mockDeleteEnrollmentSessionByUserId.mockResolvedValue(true);
    const result = await getFaceIdStatus();
    expect(mockDeleteEnrollmentSessionByUserId).toHaveBeenCalled();
    expect(result.status?.enrollment.active).toBe(false);
  });

  it("reports inactive even when cleanup of expired session fails", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockGetFaceProfileByUserId.mockResolvedValue(null);
    mockGetEnrollmentSessionByUserId.mockResolvedValue({
      mode: "create",
      requiredSampleCount: 5,
      acceptedSamples: [],
      expiresAt: new Date("2025-01-01T00:00:00Z"),
    });
    mockIsEnrollmentSessionExpired.mockReturnValue(true);
    mockDeleteEnrollmentSessionByUserId.mockRejectedValue(new Error("oops"));
    const result = await getFaceIdStatus();
    expect(result.status?.enrollment.active).toBe(false);
  });

  it("returns safe inactive state when a service throws", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockGetFaceProfileByUserId.mockRejectedValue(new Error("DB down"));
    mockGetEnrollmentSessionByUserId.mockResolvedValue(null);
    const result = await getFaceIdStatus();
    expect(result.isAuthenticated).toBe(true);
    expect(result.status?.configured).toBe(false);
    expect(result.status?.enrollment.active).toBe(false);
  });

  it("does not include any biometric field types in DTO shape", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockGetFaceProfileByUserId.mockResolvedValue({
      enrolledAt: new Date("2026-01-01T00:00:00Z"),
      sampleCount: 5,
      // Intentionally include decoy sensitive fields to verify they
      // are NEVER propagated.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _decoy_embedding: [0.1, 0.2] as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      _decoy_ciphertext: "xxxx" as any,
    } as never);
    mockGetEnrollmentSessionByUserId.mockResolvedValue({
      mode: "create",
      requiredSampleCount: 5,
      acceptedSamples: [
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { encryptedVector: { ciphertext: "x", iv: "y", authTag: "z" } } as any,
      ],
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      generationId: "gen-test-status",
    });
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    const result = await getFaceIdStatus();
    const status: FaceIdStatus = result.status as FaceIdStatus;

    const stringified = JSON.stringify(status);
    expect(stringified).not.toContain("ciphertext");
    expect(stringified).not.toContain("embedding");
    // Check for IV / authTag using quotes (i.e. field names or values),
    // not as substrings of unrelated words like "active".
    expect(stringified).not.toMatch(/"iv"/i);
    expect(stringified).not.toMatch(/"authTag"/i);
    expect(stringified).not.toContain("userId");

    // Block-shape sanity
    expect(status.faceId).not.toBeNull();
    expect(Object.keys(status.faceId as object).sort()).toEqual(
      ["enrolledAt", "sampleCount"].sort(),
    );
    expect(status.enrollment.acceptedSamples).toBe(1);
  });

  it("exposes REQUIRED_SAMPLES=5 from centralized constant", () => {
    expect(REQUIRED_SAMPLES).toBe(5);
  });
});
