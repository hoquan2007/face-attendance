/**
 * Tests for the PHASE 4.6B3A authenticated enrollment completion
 * Server Action.
 *
 * Covers the 56-test contract:
 *   1..6    — Auth (no userId parameter, no session, B2C not called,
 *             session-derived userId, browser cannot override,
 *             response carries no userId)
 *   7..10   — Profile gating
 *   11..22  — Success (B2C exactly once, session.user.id passed,
 *             configured=true, safe enrolledAt / sampleCount,
 *             no centroid / generationId / sourceEnrollmentGenerationId /
 *             claimToken / ciphertext / encrypted samples /
 *             model identity in response)
 *   23..26  — Idempotency (B2C idempotent success, already-consumed,
 *             cleanup_pending not failure, no auto-retry)
 *   27..32  — Enrollment state errors
 *   33..38  — Biometric domain errors
 *   39..47  — Infrastructure errors
 *   48..54  — No side channels
 *   55..56  — Single invocation
 *
 * Implementation notes:
 *   - All collaborators are mocked at module boundaries. No
 *     MongoDB / Mongoose / Network is touched.
 *   - The B2C orchestrator is mocked so the action tests can drive
 *     the success / failure / idempotency matrix precisely.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// =============================================================================
// Mock collaborators
// =============================================================================

const mockGetSession = vi.fn();
const mockIsOnboardingComplete = vi.fn();
const mockCompleteFinalized = vi.fn();

vi.mock("@/lib/session", () => ({
  getSession: () => mockGetSession(),
}));

vi.mock("@/lib/profile-service", () => ({
  isOnboardingComplete: (...args: unknown[]) =>
    mockIsOnboardingComplete(...args),
}));

vi.mock("@/lib/biometrics/face-enrollment-completion-service", () => {
  class FaceEnrollmentCompletionError extends Error {
    code: string;
    constructor(opts: { code: string; message: string }) {
      super(opts.message);
      this.name = "FaceEnrollmentCompletionError";
      this.code = opts.code;
    }
  }
  return {
    completeFinalizedFaceEnrollmentForUser: (...args: unknown[]) =>
      mockCompleteFinalized(...args),
    FaceEnrollmentCompletionError,
    FACE_ENROLLMENT_COMPLETION_ERROR_CODES: {
      INVALID_USER_ID: "INVALID_USER_ID",
      NO_PROFILE_PERSISTED: "NO_PROFILE_PERSISTED",
      LEGACY_PROFILE_PRESENT: "LEGACY_PROFILE_PRESENT",
      LINEAGE_MISMATCH: "LINEAGE_MISMATCH",
      ENROLLMENT_COMPLETION_FAILED: "ENROLLMENT_COMPLETION_FAILED",
    },
  };
});

// Also expose B1B / B2B / B2A / persistence error classes for the
// domain-error mapping tests.
vi.mock("@/lib/biometrics/face-profile-finalization-service", () => {
  class FaceProfileFinalizationError extends Error {
    code: string;
    domainError?: { code: string; message: string };
    constructor(opts: {
      code: string;
      message: string;
      domainError?: { code: string; message: string };
    }) {
      super(opts.message);
      this.name = "FaceProfileFinalizationError";
      this.code = opts.code;
      this.domainError = opts.domainError;
    }
  }
  return {
    FaceProfileFinalizationError,
    FACE_PROFILE_FINALIZATION_ERROR_CODES: {
      ENROLLMENT_SESSION_NOT_FOUND: "ENROLLMENT_SESSION_NOT_FOUND",
      ENROLLMENT_SESSION_EXPIRED: "ENROLLMENT_SESSION_EXPIRED",
      ENROLLMENT_INCOMPLETE: "ENROLLMENT_INCOMPLETE",
      ENROLLMENT_SESSION_INVALID: "ENROLLMENT_SESSION_INVALID",
      UNSUPPORTED_ENROLLMENT_MODE: "UNSUPPORTED_ENROLLMENT_MODE",
      UNSUPPORTED_TEMPLATE_VERSION: "UNSUPPORTED_TEMPLATE_VERSION",
      ENROLLMENT_SAMPLE_INDEX_INVALID: "ENROLLMENT_SAMPLE_INDEX_INVALID",
      ENROLLMENT_SAMPLE_STRUCTURE_INVALID:
        "ENROLLMENT_SAMPLE_STRUCTURE_INVALID",
      ENROLLMENT_METADATA_MISMATCH: "ENROLLMENT_METADATA_MISMATCH",
      ENROLLMENT_FINALIZATION_CLAIM_FAILED:
        "ENROLLMENT_FINALIZATION_CLAIM_FAILED",
      ENROLLMENT_FINALIZATION_CLAIM_LOST:
        "ENROLLMENT_FINALIZATION_CLAIM_LOST",
      FACE_PROFILE_CENTROID_ENCRYPTION_FAILED:
        "FACE_PROFILE_CENTROID_ENCRYPTION_FAILED",
      FACE_PROFILE_PERSISTENCE_FAILED: "FACE_PROFILE_PERSISTENCE_FAILED",
      FACE_PROFILE_ALREADY_EXISTS: "FACE_PROFILE_ALREADY_EXISTS",
      FACE_PROFILE_SOURCE_GENERATION_MISMATCH:
        "FACE_PROFILE_SOURCE_GENERATION_MISMATCH",
    },
  };
});

vi.mock("@/lib/biometrics/enrollment-finalization-service", () => {
  class EnrollmentFinalizationError extends Error {
    code: string;
    domainError?: { code: string; message: string };
    constructor(opts: {
      code: string;
      message: string;
      domainError?: { code: string; message: string };
    }) {
      super(opts.message);
      this.name = "EnrollmentFinalizationError";
      this.code = opts.code;
      this.domainError = opts.domainError;
    }
  }
  return {
    EnrollmentFinalizationError,
    ENROLLMENT_FINALIZATION_ERROR_CODES: {
      ENROLLMENT_SESSION_NOT_FOUND: "ENROLLMENT_SESSION_NOT_FOUND",
      ENROLLMENT_SESSION_EXPIRED: "ENROLLMENT_SESSION_EXPIRED",
      ENROLLMENT_INCOMPLETE: "ENROLLMENT_INCOMPLETE",
      ENROLLMENT_SESSION_INVALID: "ENROLLMENT_SESSION_INVALID",
      UNSUPPORTED_ENROLLMENT_MODE: "UNSUPPORTED_ENROLLMENT_MODE",
      UNSUPPORTED_TEMPLATE_VERSION: "UNSUPPORTED_TEMPLATE_VERSION",
      ENROLLMENT_SAMPLE_INDEX_INVALID: "ENROLLMENT_SAMPLE_INDEX_INVALID",
      ENROLLMENT_SAMPLE_DECRYPTION_FAILED:
        "ENROLLMENT_SAMPLE_DECRYPTION_FAILED",
      ENROLLMENT_SAMPLE_VECTOR_INVALID: "ENROLLMENT_SAMPLE_VECTOR_INVALID",
      ENROLLMENT_GENERATION_CHANGED: "ENROLLMENT_GENERATION_CHANGED",
      ENROLLMENT_FINALIZATION_FAILED: "ENROLLMENT_FINALIZATION_FAILED",
    },
  };
});

vi.mock("@/lib/biometrics/enrollment-finalization-claim-service", () => {
  class EnrollmentFinalizationClaimError extends Error {
    code: string;
    constructor(opts: { code: string; message: string }) {
      super(opts.message);
      this.name = "EnrollmentFinalizationClaimError";
      this.code = opts.code;
    }
  }
  return {
    EnrollmentFinalizationClaimError,
    ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES: {
      ENROLLMENT_SESSION_NOT_FOUND: "ENROLLMENT_SESSION_NOT_FOUND",
      ENROLLMENT_SESSION_EXPIRED: "ENROLLMENT_SESSION_EXPIRED",
      ENROLLMENT_GENERATION_CHANGED: "ENROLLMENT_GENERATION_CHANGED",
      ENROLLMENT_INCOMPLETE: "ENROLLMENT_INCOMPLETE",
      ENROLLMENT_FINALIZATION_ALREADY_CLAIMED:
        "ENROLLMENT_FINALIZATION_ALREADY_CLAIMED",
      ENROLLMENT_FINALIZATION_IN_PROGRESS:
        "ENROLLMENT_FINALIZATION_IN_PROGRESS",
      UNSUPPORTED_ENROLLMENT_MODE: "UNSUPPORTED_ENROLLMENT_MODE",
      UNSUPPORTED_TEMPLATE_VERSION: "UNSUPPORTED_TEMPLATE_VERSION",
      UNSUPPORTED_NORMALIZATION: "UNSUPPORTED_NORMALIZATION",
      ENROLLMENT_FINALIZATION_CLAIM_FAILED:
        "ENROLLMENT_FINALIZATION_CLAIM_FAILED",
      ENROLLMENT_FINALIZATION_CLAIM_INVALID:
        "ENROLLMENT_FINALIZATION_CLAIM_INVALID",
      MODEL_MISMATCH: "MODEL_MISMATCH",
    },
  };
});

vi.mock("@/lib/biometrics/biometric-errors", () => {
  class BiometricPersistenceError extends Error {
    code: string;
    constructor(opts: { code: string; message: string }) {
      super(opts.message);
      this.name = "BiometricPersistenceError";
      this.code = opts.code;
    }
  }
  return {
    BiometricPersistenceError,
    BIOMETRIC_PERSISTENCE_ERROR_CODES: {
      BIOMETRIC_PROFILE_NOT_FOUND: "BIOMETRIC_PROFILE_NOT_FOUND",
      BIOMETRIC_PROFILE_ALREADY_EXISTS: "BIOMETRIC_PROFILE_ALREADY_EXISTS",
      INVALID_BIOMETRIC_DATA: "INVALID_BIOMETRIC_DATA",
      UNKNOWN_ERROR: "UNKNOWN_ERROR",
      ENROLLMENT_FINALIZATION_IN_PROGRESS:
        "ENROLLMENT_FINALIZATION_IN_PROGRESS",
      FACE_PROFILE_PERSISTENCE_FAILED: "FACE_PROFILE_PERSISTENCE_FAILED",
      FACE_PROFILE_ALREADY_EXISTS: "FACE_PROFILE_ALREADY_EXISTS",
      FACE_PROFILE_SOURCE_GENERATION_MISMATCH:
        "FACE_PROFILE_SOURCE_GENERATION_MISMATCH",
      FACE_PROFILE_CENTROID_ENCRYPTION_FAILED:
        "FACE_PROFILE_CENTROID_ENCRYPTION_FAILED",
      ENROLLMENT_FINALIZATION_CLAIM_LOST:
        "ENROLLMENT_FINALIZATION_CLAIM_LOST",
    },
  };
});

import {
  finishFaceEnrollment,
  FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES,
} from "@/lib/biometrics/enrollment-completion-action";

// =============================================================================
// Default success shape from B2C
// =============================================================================

function makeCompletion(
  overrides: Partial<{
    configured: boolean;
    enrolledAt: Date | null;
    sampleCount: number | null;
    cleanupStatus: "consumed" | "already_consumed" | "cleanup_pending";
  }> = {},
) {
  return {
    configured: true,
    enrolledAt: new Date("2026-09-12T10:00:00.000Z"),
    sampleCount: 5,
    cleanupStatus: "consumed" as const,
    ...overrides,
  };
}

// =============================================================================
// beforeEach / afterEach
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  // Default: authenticated user with completed profile and a
  // successful B2C completion.
  mockGetSession.mockResolvedValue({
    user: { id: "user-1", email: "u@example.com" },
  });
  mockIsOnboardingComplete.mockResolvedValue(true);
  mockCompleteFinalized.mockResolvedValue(makeCompletion());
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// 1..6 — AUTH
// =============================================================================

describe("auth", () => {
  it("1. accepts no userId parameter (zero-argument action)", () => {
    // The action is exported as a function with arity 0.
    expect(finishFaceEnrollment.length).toBe(0);
  });

  it("2. no session → UNAUTHENTICATED", async () => {
    mockGetSession.mockResolvedValue(null);
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.UNAUTHENTICATED,
      );
      expect(result.retryable).toBe(false);
    }
  });

  it("3. unauthenticated path does not call B2C", async () => {
    mockGetSession.mockResolvedValue(null);
    await finishFaceEnrollment();
    expect(mockCompleteFinalized).not.toHaveBeenCalled();
  });

  it("4. authenticated userId comes from Better Auth session", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-from-session", email: "u@example.com" },
    });
    await finishFaceEnrollment();
    expect(mockCompleteFinalized).toHaveBeenCalledTimes(1);
    expect(mockCompleteFinalized).toHaveBeenCalledWith("user-from-session");
  });

  it("5. browser cannot choose another userId", async () => {
    // The action signature is zero-argument — TypeScript prevents
    // passing any extra argument at compile time. We verify at
    // runtime that even calling with extra positional args is
    // ignored.
    mockGetSession.mockResolvedValue({
      user: { id: "real-user", email: "u@example.com" },
    });
    // Intentional: pass an extra positional argument that the
    // browser could try to inject. The action must ignore it.
    await (finishFaceEnrollment as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>)("malicious-user-id", "x", "y");
    expect(mockCompleteFinalized).toHaveBeenCalledTimes(1);
    expect(mockCompleteFinalized).toHaveBeenCalledWith("real-user");
  });

  it("6. action response never returns userId", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", email: "u@example.com" },
    });
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("userId")).toBe(false);
    expect(json.includes("user-1")).toBe(false);
  });
});

// =============================================================================
// 7..10 — PROFILE
// =============================================================================

describe("profile gating", () => {
  it("7. missing application profile handled safely", async () => {
    mockIsOnboardingComplete.mockResolvedValue(false);
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.PROFILE_INCOMPLETE,
      );
    }
  });

  it("8. incomplete profile → PROFILE_INCOMPLETE", async () => {
    mockIsOnboardingComplete.mockResolvedValue(false);
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("PROFILE_INCOMPLETE");
      expect(result.retryable).toBe(false);
    }
  });

  it("9. incomplete profile does not call B2C", async () => {
    mockIsOnboardingComplete.mockResolvedValue(false);
    await finishFaceEnrollment();
    expect(mockCompleteFinalized).not.toHaveBeenCalled();
  });

  it("10. completed profile permits completion", async () => {
    mockIsOnboardingComplete.mockResolvedValue(true);
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(true);
  });
});

// =============================================================================
// 11..22 — SUCCESS
// =============================================================================

describe("success", () => {
  it("11. successful action calls B2C exactly once", async () => {
    await finishFaceEnrollment();
    expect(mockCompleteFinalized).toHaveBeenCalledTimes(1);
  });

  it("12. passes session.user.id to B2C", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "session-user-xyz", email: "u@example.com" },
    });
    await finishFaceEnrollment();
    expect(mockCompleteFinalized).toHaveBeenCalledWith("session-user-xyz");
  });

  it("13. configured=true returned", async () => {
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configured).toBe(true);
    }
  });

  it("14. safe enrolledAt returned", async () => {
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.faceId.enrolledAt).toBe("2026-09-12T10:00:00.000Z");
      expect(typeof result.faceId.enrolledAt).toBe("string");
    }
  });

  it("15. safe sampleCount returned", async () => {
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.faceId.sampleCount).toBe(5);
    }
  });

  it("16. no centroid returned", async () => {
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("centroid")).toBe(false);
  });

  it("17. no generationId returned", async () => {
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("generationId")).toBe(false);
  });

  it("18. no sourceEnrollmentGenerationId returned", async () => {
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("sourceEnrollmentGenerationId")).toBe(false);
  });

  it("19. no claimToken returned", async () => {
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("claimToken")).toBe(false);
    expect(json.includes("finalizationClaim")).toBe(false);
  });

  it("20. no ciphertext returned", async () => {
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("ciphertext")).toBe(false);
  });

  it("21. no encrypted samples returned", async () => {
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("samples")).toBe(false);
    expect(json.includes("encryptedVector")).toBe(false);
    expect(json.includes("iv")).toBe(false);
    expect(json.includes("authTag")).toBe(false);
  });

  it("22. no model identity returned", async () => {
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("modelIdentity")).toBe(false);
    expect(json.includes("modelName")).toBe(false);
    expect(json.includes("embeddingDimension")).toBe(false);
    expect(json.includes("normalization")).toBe(false);
    expect(json.includes("insightface")).toBe(false);
    expect(json.includes("buffalo")).toBe(false);
  });
});

// =============================================================================
// 23..26 — IDEMPOTENCY
// =============================================================================

describe("idempotency", () => {
  it("23. B2C idempotent success maps to action success", async () => {
    mockCompleteFinalized.mockResolvedValue(makeCompletion());
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configured).toBe(true);
    }
  });

  it("24. already-consumed completion remains configured=true", async () => {
    mockCompleteFinalized.mockResolvedValue(
      makeCompletion({ cleanupStatus: "already_consumed" }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configured).toBe(true);
      expect(result.cleanupStatus).toBe("already_consumed");
    }
  });

  it("25. cleanup_pending success is NOT mapped to failure", async () => {
    mockCompleteFinalized.mockResolvedValue(
      makeCompletion({ cleanupStatus: "cleanup_pending" }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.configured).toBe(true);
      expect(result.cleanupStatus).toBe("cleanup_pending");
    }
  });

  it("26. action does not retry B2C automatically", async () => {
    // Even when B2C throws an error, the action must call B2C
    // exactly once. No automatic retry.
    const { EnrollmentFinalizationError } = await import(
      "@/lib/biometrics/enrollment-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationError({
        code: "ENROLLMENT_SESSION_NOT_FOUND",
        message: "no session",
      }),
    );
    await finishFaceEnrollment();
    expect(mockCompleteFinalized).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 27..32 — ENROLLMENT STATE ERRORS
// =============================================================================

describe("enrollment state errors", () => {
  it("27. session not found mapped safely", async () => {
    const { EnrollmentFinalizationError } = await import(
      "@/lib/biometrics/enrollment-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationError({
        code: "ENROLLMENT_SESSION_NOT_FOUND",
        message: "no session",
      }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.ENROLLMENT_SESSION_NOT_FOUND,
      );
      expect(result.retryable).toBe(false);
    }
  });

  it("28. expired session mapped safely", async () => {
    const { EnrollmentFinalizationError } = await import(
      "@/lib/biometrics/enrollment-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationError({
        code: "ENROLLMENT_SESSION_EXPIRED",
        message: "expired",
      }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.ENROLLMENT_SESSION_EXPIRED,
      );
      expect(result.retryable).toBe(false);
    }
  });

  it("29. incomplete session mapped safely", async () => {
    const { EnrollmentFinalizationError } = await import(
      "@/lib/biometrics/enrollment-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationError({
        code: "ENROLLMENT_INCOMPLETE",
        message: "incomplete",
      }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.ENROLLMENT_INCOMPLETE,
      );
      expect(result.retryable).toBe(false);
    }
  });

  it("30. generation changed mapped safely", async () => {
    const { EnrollmentFinalizationError } = await import(
      "@/lib/biometrics/enrollment-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationError({
        code: "ENROLLMENT_GENERATION_CHANGED",
        message: "gen changed",
      }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.ENROLLMENT_GENERATION_CHANGED,
      );
      expect(result.retryable).toBe(true);
    }
  });

  it("31. finalization already claimed/in progress mapped safely", async () => {
    const { EnrollmentFinalizationClaimError } = await import(
      "@/lib/biometrics/enrollment-finalization-claim-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationClaimError({
        code: "ENROLLMENT_FINALIZATION_ALREADY_CLAIMED",
        message: "claimed",
      }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.ENROLLMENT_FINALIZATION_ALREADY_CLAIMED,
      );
      expect(result.retryable).toBe(true);
    }
  });

  it("32. raw internal claim details never returned", async () => {
    const { EnrollmentFinalizationClaimError } = await import(
      "@/lib/biometrics/enrollment-finalization-claim-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationClaimError({
        code: "ENROLLMENT_FINALIZATION_IN_PROGRESS",
        message: "secret-claim-token-xxx in flight",
      }),
    );
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("secret-claim-token")).toBe(false);
    expect(json.includes("xxx")).toBe(false);
    expect(json.includes("claimToken")).toBe(false);
  });
});

// =============================================================================
// 33..38 — BIOMETRIC DOMAIN ERRORS
// =============================================================================

describe("biometric domain errors", () => {
  it("33. INCONSISTENT_FACE_SAMPLES mapped safely", async () => {
    const { EnrollmentFinalizationError } = await import(
      "@/lib/biometrics/enrollment-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationError({
        code: "ENROLLMENT_FINALIZATION_FAILED",
        message: "b1b",
        domainError: { code: "INCONSISTENT_FACE_SAMPLES", message: "x" },
      }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.INCONSISTENT_FACE_SAMPLES,
      );
      expect(result.retryable).toBe(false);
    }
  });

  it("34. inconsistent samples returns configured=false", async () => {
    // Even on failure, configured must remain falsy. The action
    // returns ok: false; the success result shape (which contains
    // configured=true) is NEVER produced on failure.
    const { EnrollmentFinalizationError } = await import(
      "@/lib/biometrics/enrollment-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationError({
        code: "ENROLLMENT_FINALIZATION_FAILED",
        message: "b1b",
        domainError: { code: "INCONSISTENT_FACE_SAMPLES", message: "x" },
      }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
  });

  it("35. MODEL_MISMATCH mapped safely", async () => {
    const { EnrollmentFinalizationError } = await import(
      "@/lib/biometrics/enrollment-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationError({
        code: "ENROLLMENT_FINALIZATION_FAILED",
        message: "b1b",
        domainError: { code: "MODEL_MISMATCH", message: "x" },
      }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.MODEL_MISMATCH,
      );
      expect(result.retryable).toBe(false);
    }
  });

  it("36. sample decryption failure mapped safely", async () => {
    const { EnrollmentFinalizationError } = await import(
      "@/lib/biometrics/enrollment-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationError({
        code: "ENROLLMENT_SAMPLE_DECRYPTION_FAILED",
        message: "aes",
      }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.ENROLLMENT_SAMPLE_DECRYPTION_FAILED,
      );
    }
  });

  it("37. malformed plaintext vector/data-integrity failure mapped safely", async () => {
    const { EnrollmentFinalizationError } = await import(
      "@/lib/biometrics/enrollment-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationError({
        code: "ENROLLMENT_SAMPLE_VECTOR_INVALID",
        message: "vector",
      }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.ENROLLMENT_SAMPLE_VECTOR_INVALID,
      );
    }
  });

  it("38. raw AES error never returned", async () => {
    const { EnrollmentFinalizationError } = await import(
      "@/lib/biometrics/enrollment-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationError({
        code: "ENROLLMENT_SAMPLE_DECRYPTION_FAILED",
        message: "aes-gcm auth tag mismatch for nonce=ffff",
      }),
    );
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("aes-gcm")).toBe(false);
    expect(json.includes("auth tag")).toBe(false);
    expect(json.includes("nonce")).toBe(false);
    expect(json.includes("ffff")).toBe(false);
  });
});

// =============================================================================
// 39..47 — INFRASTRUCTURE ERRORS
// =============================================================================

describe("infrastructure errors", () => {
  it("39. Face Service timeout mapped safely", async () => {
    const { EnrollmentFinalizationError } = await import(
      "@/lib/biometrics/enrollment-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationError({
        code: "ENROLLMENT_FINALIZATION_FAILED",
        message: "x",
        domainError: { code: "FACE_SERVICE_TIMEOUT", message: "x" },
      }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.FACE_SERVICE_TIMEOUT,
      );
      expect(result.retryable).toBe(true);
    }
  });

  it("40. Face Service unavailable mapped safely", async () => {
    const { EnrollmentFinalizationError } = await import(
      "@/lib/biometrics/enrollment-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationError({
        code: "ENROLLMENT_FINALIZATION_FAILED",
        message: "x",
        domainError: { code: "FACE_SERVICE_UNAVAILABLE", message: "x" },
      }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.FACE_SERVICE_UNAVAILABLE,
      );
      expect(result.retryable).toBe(true);
    }
  });

  it("41. Face Service unauthorized mapped safely", async () => {
    const { EnrollmentFinalizationError } = await import(
      "@/lib/biometrics/enrollment-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationError({
        code: "ENROLLMENT_FINALIZATION_FAILED",
        message: "x",
        domainError: { code: "FACE_SERVICE_UNAUTHORIZED", message: "x" },
      }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.FACE_SERVICE_UNAUTHORIZED,
      );
    }
  });

  it("42. invalid Face Service response mapped safely", async () => {
    const { EnrollmentFinalizationError } = await import(
      "@/lib/biometrics/enrollment-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationError({
        code: "ENROLLMENT_FINALIZATION_FAILED",
        message: "x",
        domainError: { code: "FACE_SERVICE_INVALID_RESPONSE", message: "x" },
      }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });

  it("43. biometric encryption unavailable mapped safely", async () => {
    const { FaceProfileFinalizationError } = await import(
      "@/lib/biometrics/face-profile-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new FaceProfileFinalizationError({
        code: "FACE_PROFILE_CENTROID_ENCRYPTION_FAILED",
        message: "encryption key missing",
      }),
    );
    const result = await finishFaceEnrollment();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES.BIOMETRIC_ENCRYPTION_UNAVAILABLE,
      );
    }
  });

  it("44. raw stack not returned", async () => {
    const error = new Error(
      "TypeError: Cannot read property 'foo' of undefined\n    at Object.<anonymous> (file:///secret-path/server.ts:42:7)",
    );
    mockCompleteFinalized.mockRejectedValue(error);
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("TypeError")).toBe(false);
    expect(json.includes("Cannot read property")).toBe(false);
    expect(json.includes("secret-path")).toBe(false);
    expect(json.includes("at Object")).toBe(false);
  });

  it("45. raw HTTP body not returned", async () => {
    mockCompleteFinalized.mockRejectedValue(
      new Error(
        'HTTP 502 Bad Gateway\nBody: {"raw_internal":"secret","key":"FFFFF"}',
      ),
    );
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("raw_internal")).toBe(false);
    expect(json.includes("secret")).toBe(false);
    expect(json.includes("FFFFF")).toBe(false);
  });

  it("46. service URL not returned", async () => {
    mockCompleteFinalized.mockRejectedValue(
      new Error("ECONNREFUSED https://face-service.internal.acme/v1/finalize"),
    );
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("face-service.internal")).toBe(false);
    expect(json.includes("acme")).toBe(false);
    expect(json.includes("/v1/finalize")).toBe(false);
  });

  it("47. secret not returned", async () => {
    mockCompleteFinalized.mockRejectedValue(
      new Error("FACE_SERVICE_SECRET=ZZZZ-XXXX leaked"),
    );
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("FACE_SERVICE_SECRET")).toBe(false);
    expect(json.includes("ZZZZ-XXXX")).toBe(false);
  });
});

// =============================================================================
// 48..54 — NO SIDE CHANNELS
// =============================================================================

describe("no side channels", () => {
  it("48. action sends no browser userId to downstream services", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "real-session-user", email: "u@example.com" },
    });
    await (finishFaceEnrollment as unknown as (
      ...args: unknown[]
    ) => Promise<unknown>)("attacker-controlled-id");
    expect(mockCompleteFinalized).toHaveBeenCalledTimes(1);
    expect(mockCompleteFinalized).toHaveBeenCalledWith("real-session-user");
  });

  it("49. action sends no claim token to browser", async () => {
    // The B2C result type never returns claim tokens, but
    // simulate a case where the underlying service mistakenly
    // includes one in its return. The action must still not
    // surface it.
    const leakyCompletion = {
      configured: true,
      enrolledAt: new Date("2026-09-12T10:00:00.000Z"),
      sampleCount: 5,
      cleanupStatus: "consumed" as const,
      // Intentionally leak internal fields via an escape hatch:
      claimToken: "must-not-leak-claim-token",
      sourceEnrollmentGenerationId: "must-not-leak-lineage",
      userId: "must-not-leak-user-id",
    };
    mockCompleteFinalized.mockResolvedValue(leakyCompletion);
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("must-not-leak-claim-token")).toBe(false);
    expect(json.includes("must-not-leak-lineage")).toBe(false);
    expect(json.includes("must-not-leak-user-id")).toBe(false);
  });

  it("50. action sends no generationId to browser", async () => {
    mockCompleteFinalized.mockResolvedValue({
      configured: true,
      enrolledAt: new Date("2026-09-12T10:00:00.000Z"),
      sampleCount: 5,
      cleanupStatus: "consumed" as const,
      generationId: "must-not-leak-gen",
    });
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("must-not-leak-gen")).toBe(false);
  });

  it("51. action exposes no centroid", async () => {
    mockCompleteFinalized.mockResolvedValue({
      configured: true,
      enrolledAt: new Date("2026-09-12T10:00:00.000Z"),
      sampleCount: 5,
      cleanupStatus: "consumed" as const,
      centroid: [0.1, 0.2, 0.3],
    });
    const result = await finishFaceEnrollment();
    const json = JSON.stringify(result);
    expect(json.includes("centroid")).toBe(false);
  });

  it("52. no localStorage / sessionStorage / IndexedDB", async () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/enrollment-completion-action.ts",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    expect(codeOnly.includes("localStorage")).toBe(false);
    expect(codeOnly.includes("sessionStorage")).toBe(false);
    expect(codeOnly.includes("IndexedDB")).toBe(false);
    expect(codeOnly.includes("document.")).toBe(false);
    expect(codeOnly.includes("window.")).toBe(false);
  });

  it("53. no public API route created", async () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/enrollment-completion-action.ts",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    expect(codeOnly.includes("route.ts")).toBe(false);
    expect(codeOnly.includes("NextResponse")).toBe(false);
    expect(codeOnly.includes("app/api/")).toBe(false);
  });

  it("54. no direct Face Service fetch introduced", async () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/enrollment-completion-action.ts",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    expect(codeOnly.includes("fetch(")).toBe(false);
    expect(codeOnly.includes("FACE_SERVICE_URL")).toBe(false);
    expect(codeOnly.includes("finalizeFaceEnrollment")).toBe(false);
    expect(codeOnly.includes("face-service-client")).toBe(false);
  });
});

// =============================================================================
// 55..56 — ONE INVOCATION
// =============================================================================

describe("one invocation → one B2C invocation", () => {
  it("55. one action invocation → one B2C invocation", async () => {
    await finishFaceEnrollment();
    expect(mockCompleteFinalized).toHaveBeenCalledTimes(1);
  });

  it("56. domain failure → no automatic second B2C invocation", async () => {
    const { EnrollmentFinalizationError } = await import(
      "@/lib/biometrics/enrollment-finalization-service"
    );
    mockCompleteFinalized.mockRejectedValue(
      new EnrollmentFinalizationError({
        code: "ENROLLMENT_INCOMPLETE",
        message: "incomplete",
      }),
    );
    await finishFaceEnrollment();
    expect(mockCompleteFinalized).toHaveBeenCalledTimes(1);

    // A second call must NOT trigger an automatic retry either.
    await finishFaceEnrollment();
    expect(mockCompleteFinalized).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// Extra — server-only boundary & module hygiene
// =============================================================================

describe("server-only boundary & module hygiene", () => {
  it("opens with \"use server\"", async () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/enrollment-completion-action.ts",
      ),
      "utf8",
    );
    expect(source.includes('"use server"')).toBe(true);
  });

  it("does not import any biometric model / Face Service client directly", async () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/enrollment-completion-action.ts",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    // Direct Mongo / model imports forbidden.
    expect(codeOnly.includes("FaceProfileModel")).toBe(false);
    expect(codeOnly.includes("FaceEnrollmentSessionModel")).toBe(false);
    expect(codeOnly.includes("mongoose")).toBe(false);
    // Direct Face Service client calls forbidden.
    expect(codeOnly.includes("finalizeFaceEnrollment")).toBe(false);
    expect(codeOnly.includes("analyzeEnrollmentSample")).toBe(false);
    // Direct B1B / B2A / B2B calls forbidden — only B2C is allowed.
    expect(codeOnly.includes("finalizeEnrollmentSessionForUser")).toBe(
      false,
    );
    expect(codeOnly.includes("claimEnrollmentSessionForFinalization")).toBe(
      false,
    );
    expect(codeOnly.includes("persistFinalizedFaceProfileForUser")).toBe(
      false,
    );
    // Encryption utilities forbidden.
    expect(codeOnly.includes("encryptBiometricVector")).toBe(false);
    expect(codeOnly.includes("decryptBiometricVector")).toBe(false);
    expect(codeOnly.includes("BIOMETRIC_ENCRYPTION_KEY")).toBe(false);
    // Console logging of internals forbidden.
    expect(codeOnly.includes("console.log")).toBe(false);
    expect(codeOnly.includes("console.error")).toBe(false);
  });

  it("does not call redirect / revalidate / refresh", async () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/enrollment-completion-action.ts",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    expect(codeOnly.includes("redirect(")).toBe(false);
    expect(codeOnly.includes("revalidatePath")).toBe(false);
    expect(codeOnly.includes("revalidateTag")).toBe(false);
    expect(codeOnly.includes("router.refresh")).toBe(false);
  });
});
