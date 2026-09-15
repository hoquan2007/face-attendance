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

// =============================================================================
// PHASE 4.6B3C — CONFIGURED + RESIDUAL SESSION TESTS
// =============================================================================

describe("PHASE 4.6B3C — configured + residual temp session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("B3C — configured=true + active temp session → both true in DTO", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockGetFaceProfileByUserId.mockResolvedValue({
      enrolledAt: new Date("2026-01-01T00:00:00Z"),
      sampleCount: 5,
    });
    mockGetEnrollmentSessionByUserId.mockResolvedValue({
      mode: "create",
      requiredSampleCount: 5,
      acceptedSamples: [{ a: 1 }, { a: 2 }, { a: 3 }],
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      generationId: "gen-residual",
    });
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    const result = await getFaceIdStatus();

    // Both configured and active can be true — this is the residue case.
    // The page must prefer configured for rendering.
    expect(result.status?.configured).toBe(true);
    expect(result.status?.enrollment.active).toBe(true);
    expect(result.status?.faceId?.sampleCount).toBe(5);
    expect(result.status?.enrollment.acceptedSamples).toBe(3);
  });

  it("B3C — configured=true + 5/5 temp residue → both true in DTO", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockGetFaceProfileByUserId.mockResolvedValue({
      enrolledAt: new Date("2026-01-01T00:00:00Z"),
      sampleCount: 5,
    });
    mockGetEnrollmentSessionByUserId.mockResolvedValue({
      mode: "create",
      requiredSampleCount: 5,
      acceptedSamples: Array(5).fill({ a: 1 }),
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      generationId: "gen-residual-5",
    });
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    const result = await getFaceIdStatus();

    expect(result.status?.configured).toBe(true);
    expect(result.status?.enrollment.active).toBe(true);
    expect(result.status?.enrollment.acceptedSamples).toBe(5);
    expect(result.status?.enrollment.requiredSamples).toBe(5);
  });

  it("B3C — DTO contains no sensitive fields in residue case", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockGetFaceProfileByUserId.mockResolvedValue({
      enrolledAt: new Date("2026-01-01T00:00:00Z"),
      sampleCount: 5,
      sourceEnrollmentGenerationId: "secret-lineage-abc",
    });
    mockGetEnrollmentSessionByUserId.mockResolvedValue({
      mode: "create",
      requiredSampleCount: 5,
      acceptedSamples: [{ a: 1 }],
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      generationId: "gen-residual",
    });
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    const result = await getFaceIdStatus();
    const stringified = JSON.stringify(result.status);

    // sourceEnrollmentGenerationId is never serialized to browser DTO
    expect(stringified).not.toContain("sourceEnrollmentGenerationId");
    expect(stringified).not.toContain("secret-lineage-abc");
    // generationId is only the enrollment session one (safe, used for reconciliation)
    expect(stringified).toContain("gen-residual");
    // No ciphertext in the enrollment session (only the count is returned)
    expect(stringified).not.toContain("ciphertext");
    // Use explicit field-name check for iv/authTag (avoid false positives like "active")
    expect(stringified).not.toMatch(/"iv":/);
    expect(stringified).not.toMatch(/"authTag":/);
    expect(stringified).not.toContain("centroid");
  });

  it("B3C — legacy profile (no sourceEnrollmentGenerationId) → configured=true", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    // Legacy profile: no sourceEnrollmentGenerationId field
    mockGetFaceProfileByUserId.mockResolvedValue({
      enrolledAt: new Date("2025-06-01T00:00:00Z"),
      sampleCount: 5,
      // No sourceEnrollmentGenerationId — legacy document
    });
    mockGetEnrollmentSessionByUserId.mockResolvedValue(null);

    const result = await getFaceIdStatus();

    expect(result.status?.configured).toBe(true);
    expect(result.status?.faceId?.sampleCount).toBe(5);
    expect(result.status?.enrollment.active).toBe(false);
  });

  it("B3C — status DTO block shape for faceId is always safe", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockGetFaceProfileByUserId.mockResolvedValue({
      enrolledAt: new Date("2026-01-01T00:00:00Z"),
      sampleCount: 5,
      sourceEnrollmentGenerationId: "never-expose-this",
      centroid: { ciphertext: "SECRET", iv: "x", authTag: "y", keyVersion: 1 },
    });
    mockGetEnrollmentSessionByUserId.mockResolvedValue(null);

    const result = await getFaceIdStatus();
    const faceIdKeys = Object.keys(result.status?.faceId as object).sort();

    // Only the two safe fields are exposed
    expect(faceIdKeys).toEqual(["enrolledAt", "sampleCount"].sort());
    const stringified = JSON.stringify(result.status?.faceId);
    expect(stringified).not.toContain("centroid");
    expect(stringified).not.toContain("ciphertext");
    expect(stringified).not.toContain("sourceEnrollmentGenerationId");
    expect(stringified).not.toContain("never-expose-this");
  });

  it("B3C — status DTO block shape for enrollment is always safe", async () => {
    mockGetSession.mockResolvedValue({ user: { id: "u1" } });
    mockIsOnboardingComplete.mockResolvedValue(true);
    mockGetFaceProfileByUserId.mockResolvedValue({
      enrolledAt: new Date("2026-01-01T00:00:00Z"),
      sampleCount: 5,
    });
    mockGetEnrollmentSessionByUserId.mockResolvedValue({
      mode: "create",
      requiredSampleCount: 5,
      acceptedSamples: [{ encryptedVector: { ciphertext: "SECRET" } }],
      expiresAt: new Date("2030-01-01T00:00:00Z"),
      generationId: "gen-123",
    });
    mockIsEnrollmentSessionExpired.mockReturnValue(false);

    const result = await getFaceIdStatus();
    const enrollmentKeys = Object.keys(
      result.status?.enrollment as object,
    ).sort();

    // Only the safe fields are exposed; acceptedSamples is a count, not an array
    expect(enrollmentKeys).toEqual(
      [
        "active",
        "acceptedSamples",
        "expiresAt",
        "generationId",
        "mode",
        "requiredSamples",
      ].sort(),
    );
    // The array is NOT returned — only the count
    expect(result.status?.enrollment.acceptedSamples).toBe(1);
    const stringified = JSON.stringify(result.status?.enrollment);
    expect(stringified).not.toContain("encryptedVector");
    expect(stringified).not.toContain("ciphertext");
  });
});
