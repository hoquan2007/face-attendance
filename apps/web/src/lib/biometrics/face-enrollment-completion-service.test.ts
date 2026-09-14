/**
 * Tests for the PHASE 4.6B2C enrollment completion + crash-recovery
 * orchestration service.
 *
 * Covers the 52-test contract:
 *   1..10   — Strict CAS consume (NORMAL path)
 *   11..18  — Crash-recovery lineage-bound consume
 *   19..22  — Different lineage
 *   23..26  — Legacy FaceProfile
 *   27..32  — Ambiguous normal delete
 *   33..38  — Idempotency
 *   39..48  — Result privacy
 *   49..52  — No transaction / no rollback
 *
 * Implementation notes:
 *   - Uses in-memory store + Mongoose mock mirrors the existing
 *     face-profile-finalization-service.test.ts style.
 *   - The B2B service `persistFinalizedFaceProfileForUser` is mocked
 *     so the B2C tests can drive the matrix precisely without
 *     invoking real B1B / Face Service / AES-GCM.
 *   - The FaceEnrollmentSession Mongoose `findOneAndDelete` is
 *     mocked at the model layer (consistent with the claim service
 *     test mock style).
 *   - The FaceProfile persistence service mocks are honoured for
 *     lineage classification.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { FaceProfileAttrs } from "@/lib/biometrics/face-profile-model";
import type {
  FaceEnrollmentSessionAttrs,
} from "@/lib/biometrics/enrollment-session-model";
import { BiometricPersistenceError } from "@/lib/biometrics/biometric-errors";

// =============================================================================
// In-memory stores + observation logs
// =============================================================================

const sessionStore = new Map<string, FaceEnrollmentSessionAttrs>();
const profileStore = new Map<string, FaceProfileAttrs>();

const sessionReadLog: Array<{ userId: string }> = [];
const findOneAndDeleteCalls: Array<{
  userId?: string;
  generationId?: string;
  finalizationClaimToken?: string;
  finalizationClaimGenerationId?: string;
}> = [];

const persistLog: Array<{
  userId: string;
  sourceEnrollmentGenerationId: string;
}> = [];

let mockPersistedResponse: {
  sourceEnrollmentGenerationId: string;
  claimToken: string;
  claimedAt: Date;
  created: boolean;
} | null = null;

// =============================================================================
// Helpers — fixtures
// =============================================================================

function makeSessionFixture(
  overrides: Partial<FaceEnrollmentSessionAttrs> = {},
): FaceEnrollmentSessionAttrs {
  const now = new Date();
  return {
    userId: "user-1",
    mode: "create",
    templateVersion: 1,
    requiredSampleCount: 5,
    acceptedSamples: [],
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
    generationId: "gen-A",
    modelIdentity: "insightface-buffalo-l",
    modelName: "buffalo_l",
    embeddingDimension: 512,
    normalization: "l2",
    ...overrides,
  };
}

function makeProfileFixture(
  overrides: Partial<FaceProfileAttrs> = {},
): FaceProfileAttrs {
  const now = new Date();
  return {
    userId: "user-1",
    status: "active",
    modelIdentity: "insightface-buffalo-l",
    modelName: "buffalo_l",
    embeddingDimension: 512,
    normalization: "l2",
    templateVersion: 1,
    requiredSampleCount: 5,
    sampleCount: 5,
    samples: [],
    centroid: {
      ciphertext: "centroid-cipher",
      iv: "centroid-iv",
      authTag: "centroid-authTag",
      keyVersion: 1,
    },
    qualitySummary: {
      minSelfSimilarity: 0.82,
      meanSelfSimilarity: 0.87,
    },
    enrolledAt: now,
    sourceEnrollmentGenerationId: "gen-A",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

// =============================================================================
// Module mocks
// =============================================================================

vi.mock("@/lib/biometrics/face-profile-finalization-service", () => ({
  persistFinalizedFaceProfileForUser: vi.fn(
    async (userId: string) => {
      persistLog.push({
        userId,
        sourceEnrollmentGenerationId:
          mockPersistedResponse?.sourceEnrollmentGenerationId ?? "gen-A",
      });
      if (!mockPersistedResponse) {
        throw new Error("B2B not configured");
      }
      return mockPersistedResponse;
    },
  ),
  PersistedFaceProfile: class {},
  FACE_PROFILE_FINALIZATION_ERROR_CODES: {
    ENROLLMENT_SESSION_NOT_FOUND: "ENROLLMENT_SESSION_NOT_FOUND",
    FACE_PROFILE_PERSISTENCE_FAILED: "FACE_PROFILE_PERSISTENCE_FAILED",
  },
  FaceProfileFinalizationError: class extends Error {
    code: string;
    constructor(opts: { code: string; message: string }) {
      super(opts.message);
      this.name = "FaceProfileFinalizationError";
      this.code = opts.code;
    }
  },
}));

vi.mock("@/lib/biometrics/face-profile-service", () => ({
  getFaceProfileByUserId: vi.fn(async (userId: string) => {
    sessionReadLog.push({ userId });
    return profileStore.get(userId) ?? null;
  }),
  hasFaceProfile: vi.fn(async (userId: string) => profileStore.has(userId)),
  classifyFaceProfileByLineage: vi.fn(
    async (params: { userId: string; lineage: string }) => {
      const existing = profileStore.get(params.userId);
      if (!existing) return "none" as const;
      const lineage = existing.sourceEnrollmentGenerationId;
      if (typeof lineage !== "string" || lineage.length === 0) {
        return "legacy" as const;
      }
      return lineage === params.lineage
        ? ("same" as const)
        : ("different" as const);
    },
  ),
}));

vi.mock("@/lib/biometrics/enrollment-session-service", () => ({
  getEnrollmentSessionByUserId: vi.fn(async (userId: string) => {
    sessionReadLog.push({ userId });
    const doc = sessionStore.get(userId);
    if (!doc) return null;
    return { ...doc, acceptedSamples: [...doc.acceptedSamples] };
  }),
  isEnrollmentSessionExpired: vi.fn(
    (session: { expiresAt: Date }, now: Date = new Date()) =>
      session.expiresAt.getTime() <= now.getTime(),
  ),
}));

vi.mock("@/lib/biometrics/enrollment-session-model", () => ({
  FaceEnrollmentSessionModel: {
    findOne: vi.fn(() => ({ exec: async () => null })),
    findOneAndUpdate: vi.fn(() => ({ exec: async () => null })),
    findOneAndDelete: vi.fn(
      (filter: Record<string, unknown>) => {
        // Record the call.
        findOneAndDeleteCalls.push({
          userId: filter.userId as string,
          generationId: filter.generationId as string,
          finalizationClaimToken: filter["finalizationClaim.token"] as string,
          finalizationClaimGenerationId:
            (filter["finalizationClaim.generationId"] as string) ?? undefined,
        });

        const userId = filter.userId as string;
        const generationId = filter.generationId as string;
        const doc = sessionStore.get(userId);
        if (!doc) {
          return { lean: () => ({ exec: async () => null }) };
        }
        // STRICT CAS: deletion requires generationId match.
        if (doc.generationId !== generationId) {
          return { lean: () => ({ exec: async () => null }) };
        }
        // If the filter requires a specific claim token, verify it.
        const tokenFilter = filter["finalizationClaim.token"];
        if (typeof tokenFilter === "string") {
          if (
            !doc.finalizationClaim ||
            doc.finalizationClaim.token !== tokenFilter
          ) {
            return { lean: () => ({ exec: async () => null }) };
          }
          const genFilter = filter["finalizationClaim.generationId"];
          if (
            typeof genFilter === "string" &&
            doc.finalizationClaim.generationId !== genFilter
          ) {
            return { lean: () => ({ exec: async () => null }) };
          }
        }
        // All checks passed → atomically delete (remove from store).
        sessionStore.delete(userId);
        return { lean: () => ({ exec: async () => ({ ...doc }) }) };
      },
    ),
  },
}));

vi.mock("@/lib/mongoose", () => ({
  getMongooseConnection: () => Promise.resolve(),
}));

// =============================================================================
// Module under test (lazy import after mocks)
// =============================================================================

const {
  completeFinalizedFaceEnrollmentForUser,
  consumeEnrollmentSession,
  recoverAndConsumeEnrollmentSession,
  FaceEnrollmentCompletionError,
  FACE_ENROLLMENT_COMPLETION_ERROR_CODES,
} = await import("@/lib/biometrics/face-enrollment-completion-service");
import type { FaceEnrollmentCompletionError as FaceEnrollmentCompletionErrorType } from "@/lib/biometrics/face-enrollment-completion-service";

// =============================================================================
// beforeEach / afterEach
// =============================================================================

beforeEach(() => {
  sessionStore.clear();
  profileStore.clear();
  sessionReadLog.length = 0;
  findOneAndDeleteCalls.length = 0;
  persistLog.length = 0;
  mockPersistedResponse = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// 1..10 — STRICT CONSUME (normal path)
// =============================================================================

describe("consumeEnrollmentSession — strict CAS", () => {
  it("1. strict CAS succeed: B2B persistence + strict consume succeeds", async () => {
    // Persist a profile in the store and a session with a matching
    // claim; configure the B2B mock to return a successful
    // persistence with a known generation + claim token.
    profileStore.set("user-1", makeProfileFixture({ userId: "user-1" }));
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        finalizationClaim: {
          token: "tok-A",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );
    mockPersistedResponse = {
      sourceEnrollmentGenerationId: "gen-A",
      claimToken: "tok-A",
      claimedAt: new Date(),
      created: true,
    };

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(result.configured).toBe(true);
    expect(result.cleanupStatus).toBe("consumed");
    // Session is gone.
    expect(sessionStore.has("user-1")).toBe(false);
    // FaceProfile remained.
    expect(profileStore.has("user-1")).toBe(true);
  });

  it("2. strict consume requires userId — empty userId → no-op", async () => {
    const result = await consumeEnrollmentSession({
      userId: "",
      generationId: "gen-A",
      claimToken: "tok-A",
    });
    expect(result.deleted).toBe(false);
    expect(findOneAndDeleteCalls.length).toBe(0);
  });

  it("3. strict consume requires exact generationId", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        finalizationClaim: {
          token: "tok-A",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    const result = await consumeEnrollmentSession({
      userId: "user-1",
      generationId: "gen-B", // wrong generation
      claimToken: "tok-A",
    });
    expect(result.deleted).toBe(false);
    expect(sessionStore.has("user-1")).toBe(true);
  });

  it("4. strict consume requires exact claim token", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        finalizationClaim: {
          token: "tok-correct",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    const result = await consumeEnrollmentSession({
      userId: "user-1",
      generationId: "gen-A",
      claimToken: "tok-wrong",
    });
    expect(result.deleted).toBe(false);
    expect(sessionStore.has("user-1")).toBe(true);
  });

  it("5. correct token deletes source temp session", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        finalizationClaim: {
          token: "tok-correct",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );
    const result = await consumeEnrollmentSession({
      userId: "user-1",
      generationId: "gen-A",
      claimToken: "tok-correct",
    });
    expect(result.deleted).toBe(true);
    expect(sessionStore.has("user-1")).toBe(false);
  });

  it("6. wrong token does NOT delete", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        finalizationClaim: {
          token: "tok-correct",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );
    const result = await consumeEnrollmentSession({
      userId: "user-1",
      generationId: "gen-A",
      claimToken: "tok-bogus",
    });
    expect(result.deleted).toBe(false);
    expect(sessionStore.has("user-1")).toBe(true);
  });

  it("7. wrong generation does NOT delete", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        finalizationClaim: {
          token: "tok-A",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );
    const result = await consumeEnrollmentSession({
      userId: "user-1",
      generationId: "gen-B",
      claimToken: "tok-A",
    });
    expect(result.deleted).toBe(false);
    expect(sessionStore.has("user-1")).toBe(true);
  });

  it("8. consume does NOT delete another user's session", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        finalizationClaim: {
          token: "tok-A",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );
    sessionStore.set(
      "user-2",
      makeSessionFixture({
        userId: "user-2",
        generationId: "gen-A",
        finalizationClaim: {
          token: "tok-A",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    const result = await consumeEnrollmentSession({
      userId: "user-1",
      generationId: "gen-A",
      claimToken: "tok-A",
    });
    expect(result.deleted).toBe(true);
    expect(sessionStore.has("user-2")).toBe(true);
  });

  it("9. consume leaves FaceProfile intact", async () => {
    const profile = makeProfileFixture({ userId: "user-1" });
    profileStore.set("user-1", profile);
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        finalizationClaim: {
          token: "tok-A",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    await consumeEnrollmentSession({
      userId: "user-1",
      generationId: "gen-A",
      claimToken: "tok-A",
    });

    // Profile is unchanged.
    const after = profileStore.get("user-1");
    expect(after).toBeDefined();
    expect(after?.enrolledAt.toISOString()).toBe(profile.enrolledAt.toISOString());
    expect(after?.sampleCount).toBe(profile.sampleCount);
  });

  it("10. consume result contains no claimToken", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        finalizationClaim: {
          token: "must-not-leak-claim-token",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    const result = await consumeEnrollmentSession({
      userId: "user-1",
      generationId: "gen-A",
      claimToken: "must-not-leak-claim-token",
    });
    expect(result.deleted).toBe(true);
    const json = JSON.stringify(result);
    expect(json.includes("must-not-leak-claim-token")).toBe(false);
    expect(json.includes("claimToken")).toBe(false);
    expect(json.includes("finalizationClaim")).toBe(false);
  });
});

// =============================================================================
// 11..18 — CRASH RECOVERY
// =============================================================================

describe("recoverAndConsumeEnrollmentSession — lineage-bound", () => {
  it("11. recovery consumes temp session when FaceProfile already exists with matching lineage", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        sourceEnrollmentGenerationId: "gen-A",
      }),
    );
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
      }),
    );

    const result = await recoverAndConsumeEnrollmentSession({
      userId: "user-1",
      generationId: "gen-A",
    });
    expect(result.deleted).toBe(true);
    expect(sessionStore.has("user-1")).toBe(false);
  });

  it("12. recovery does NOT invoke B1B (no persist_log entry)", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({ userId: "user-1" }),
    );
    sessionStore.set(
      "user-1",
      makeSessionFixture({ userId: "user-1", generationId: "gen-A" }),
    );

    await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(persistLog.length).toBe(0);
  });

  it("13. recovery does NOT call Face Service directly", async () => {
    // The B2C module never imports the face-service-client. We verify
    // via source-code inspection.
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/face-enrollment-completion-service.ts",
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
    expect(codeOnly.includes("face-service-client")).toBe(false);
    expect(codeOnly.includes("analyzeEnrollmentSample")).toBe(false);
    expect(codeOnly.includes("finalizeFaceEnrollment")).toBe(false);
    expect(codeOnly.includes("finalizeEnrollmentSessionForUser")).toBe(false);
    expect(codeOnly.includes("decryptBiometricVector")).toBe(false);
  });

  it("14. recovery does NOT decrypt samples", async () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/face-enrollment-completion-service.ts",
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
    expect(codeOnly.includes("decrypt")).toBe(false);
    expect(codeOnly.includes("BIOMETRIC_ENCRYPTION_KEY")).toBe(false);
  });

  it("15. recovery does NOT encrypt centroid", async () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/face-enrollment-completion-service.ts",
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
    expect(codeOnly.includes("encryptBiometricVector")).toBe(false);
    expect(codeOnly.includes("encrypt(")).toBe(false);
  });

  it("16. recovery does NOT rewrite FaceProfile", async () => {
    const originalProfile = makeProfileFixture({ userId: "user-1" });
    profileStore.set("user-1", originalProfile);
    sessionStore.set(
      "user-1",
      makeSessionFixture({ userId: "user-1", generationId: "gen-A" }),
    );

    await completeFinalizedFaceEnrollmentForUser("user-1");
    const after = profileStore.get("user-1")!;
    // enrolledAt preserved
    expect(after.enrolledAt.toISOString()).toBe(
      originalProfile.enrolledAt.toISOString(),
    );
    // sampleCount preserved
    expect(after.sampleCount).toBe(originalProfile.sampleCount);
    // lineage preserved
    expect(after.sourceEnrollmentGenerationId).toBe(
      originalProfile.sourceEnrollmentGenerationId,
    );
  });

  it("17. matching profile + already absent temp → idempotent success", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({ userId: "user-1", sourceEnrollmentGenerationId: "gen-A" }),
    );
    // No session in store.

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(result.configured).toBe(true);
    expect(result.cleanupStatus).toBe("already_consumed");
  });

  it("18. matching profile + TTL-removed temp → idempotent success", async () => {
    // Simulate TTL-removed session by just not having one in the store.
    profileStore.set(
      "user-1",
      makeProfileFixture({ userId: "user-1", sourceEnrollmentGenerationId: "gen-A" }),
    );

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(result.cleanupStatus).toBe("already_consumed");
  });
});

// =============================================================================
// 19..22 — DIFFERENT LINEAGE
// =============================================================================

describe("different lineage", () => {
  it("19. profile gen A + temp gen B → B is NOT deleted", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        sourceEnrollmentGenerationId: "gen-A",
      }),
    );
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-B",
      }),
    );

    await completeFinalizedFaceEnrollmentForUser("user-1");
    // Session with gen-B remains untouched.
    expect(sessionStore.has("user-1")).toBe(true);
    expect(sessionStore.get("user-1")?.generationId).toBe("gen-B");
  });

  it("20. different-generation current session remains byte-for-byte unchanged", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        sourceEnrollmentGenerationId: "gen-A",
      }),
    );
    const sessionSnapshot = makeSessionFixture({
      userId: "user-1",
      generationId: "gen-B",
    });
    sessionStore.set("user-1", sessionSnapshot);
    const sessionBeforeJson = JSON.stringify(sessionSnapshot);

    await completeFinalizedFaceEnrollmentForUser("user-1");
    const sessionAfterJson = JSON.stringify(sessionStore.get("user-1"));
    expect(sessionAfterJson).toBe(sessionBeforeJson);
  });

  it("21. no delete-by-userId-only operation exists in B2C recovery", async () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/face-enrollment-completion-service.ts",
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

    // `findOneAndDelete` MUST always include both `userId` AND
    // `generationId` in the filter. We verify by extracting every
    // `findOneAndDelete(` call and confirming the filter object
    // includes those fields. A simpler proxy: `deleteOne` (with no
    // CAS predicate) is forbidden.
    expect(codeOnly.includes("deleteOne")).toBe(false);
    expect(codeOnly.includes("findOneAndDelete({ userId")).toBe(false);
    // Verify recovery filter includes `generationId`.
    expect(codeOnly.includes("userId: input.userId")).toBe(true);
    expect(codeOnly.includes("generationId: input.generationId")).toBe(true);
  });

  it("22. lineage mismatch returns safe deterministic outcome", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        sourceEnrollmentGenerationId: "gen-A",
      }),
    );
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-B",
        finalizationClaim: {
          token: "tok-B",
          generationId: "gen-B",
          claimedAt: new Date(),
        },
      }),
    );

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(result.configured).toBe(true);
    expect(result.cleanupStatus).toBe("cleanup_pending");
    // Different generation session remains in place.
    expect(sessionStore.has("user-1")).toBe(true);
    expect(sessionStore.get("user-1")?.generationId).toBe("gen-B");
  });
});

// =============================================================================
// 23..26 — LEGACY PROFILE
// =============================================================================

describe("legacy FaceProfile", () => {
  it("23. legacy FaceProfile without lineage remains readable", async () => {
    const legacy = makeProfileFixture({
      userId: "user-1",
      sourceEnrollmentGenerationId: undefined,
    });
    profileStore.set("user-1", legacy);

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(result.configured).toBe(true);
    expect(result.enrolledAt).toEqual(legacy.enrolledAt);
  });

  it("24. legacy profile does NOT cause arbitrary temp session deletion", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        sourceEnrollmentGenerationId: undefined,
      }),
    );
    sessionStore.set(
      "user-1",
      makeSessionFixture({ userId: "user-1", generationId: "gen-X" }),
    );

    await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(sessionStore.has("user-1")).toBe(true);
    expect(sessionStore.get("user-1")?.generationId).toBe("gen-X");
  });

  it("25. legacy profile does NOT cause Face Service rerun", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        sourceEnrollmentGenerationId: undefined,
      }),
    );

    await completeFinalizedFaceEnrollmentForUser("user-1");
    // No B2B invocation.
    expect(persistLog.length).toBe(0);
  });

  it("26. legacy state returns safe existing-profile outcome", async () => {
    const legacy = makeProfileFixture({
      userId: "user-1",
      sourceEnrollmentGenerationId: undefined,
    });
    profileStore.set("user-1", legacy);
    sessionStore.set(
      "user-1",
      makeSessionFixture({ userId: "user-1", generationId: "gen-X" }),
    );

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(result.configured).toBe(true);
    expect(result.sampleCount).toBe(legacy.sampleCount);
    // Legacy profile present + temp session present → cleanup_pending.
    expect(result.cleanupStatus).toBe("cleanup_pending");
  });
});

// =============================================================================
// 27..32 — AMBIGUOUS NORMAL DELETE
// =============================================================================

describe("ambiguous normal delete", () => {
  it("27. B2B persists profile but strict delete returns no document", async () => {
    // Setup B2B to succeed and provide generation A + claim token.
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        sourceEnrollmentGenerationId: "gen-A",
      }),
    );
    // No session in store — strict CAS misses (already absent).
    mockPersistedResponse = {
      sourceEnrollmentGenerationId: "gen-A",
      claimToken: "tok-A",
      claimedAt: new Date(),
      created: true,
    };
    // B2B was already persisted by something (we pre-populated the
    // profile store). The orchestrator should still call B2B which
    // returns idempotent success (mocked).
    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    // Strict CAS missed → cleanup_status is "already_consumed".
    expect(result.cleanupStatus).toBe("already_consumed");
    // Profile is still authoritative.
    expect(profileStore.has("user-1")).toBe(true);
  });

  it("28. re-read finds source session already absent → success", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({ userId: "user-1" }),
    );
    // No session.

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(result.configured).toBe(true);
    expect(result.cleanupStatus).toBe("already_consumed");
  });

  it("29. re-read finds same source generation → cleanup_pending", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        sourceEnrollmentGenerationId: "gen-A",
      }),
    );
    // Session exists with matching generation. But the recovery CAS
    // would delete it — except the test setup means it WILL be
    // deleted. To force "cleanup_pending" we need the recovery CAS
    // to miss but the session to still be present. This is a
    // synthetic scenario, so we'll trigger it by removing the
    // session after the orchestrator's own CAS would have consumed
    // it by injecting a mock that doesn't actually delete.
    // Simplest path: pre-populate a session WITHOUT a finalizationClaim
    // AND simulate a scenario where the orchestrator reads it AFTER
    // the recovery CAS — by having the session NOT match (e.g.
    // different generation in a way the test can control).
    //
    // To exercise cleanup_pending with same generation we instead
    // remove the session right before the recovery CAS runs — this
    // is fragile; we use a simpler invariant: present session with
    // a generation that does NOT match the persisted lineage, then
    // confirm cleanup_pending. (Same-generation cleanup_pending is
    // exercised by Test 22 in the lineage mismatch group.)
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
      }),
    );

    // The recovery CAS matches gen-A → deletes the session, so the
    // post-CAS read finds nothing. The cleanup_status becomes
    // "consumed" instead of "cleanup_pending". Adjust: to test
    // cleanup_pending with same generation, we monkey-patch our
    // mock to skip the actual delete.
    findOneAndDeleteCalls.length = 0;
    // Replace the mock to NOT delete:
    const deleteMock = (
      await import("@/lib/biometrics/enrollment-session-model")
    ).FaceEnrollmentSessionModel.findOneAndDelete as ReturnType<typeof vi.fn>;
    deleteMock.mockImplementationOnce(() => ({
      lean: () => ({ exec: async () => null }),
    }));

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    // Recovery CAS missed but session still present with same gen →
    // cleanup_pending.
    expect(result.cleanupStatus).toBe("cleanup_pending");
  });

  it("30. re-read finds different current generation → do NOT delete current session", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        sourceEnrollmentGenerationId: "gen-A",
      }),
    );
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-B",
      }),
    );

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(result.cleanupStatus).toBe("cleanup_pending");
    // gen-B session remains.
    expect(sessionStore.get("user-1")?.generationId).toBe("gen-B");
  });

  it("31. persisted profile is NEVER rolled back", async () => {
    const profileSnapshot = makeProfileFixture({
      userId: "user-1",
      sourceEnrollmentGenerationId: "gen-A",
    });
    profileStore.set("user-1", profileSnapshot);

    // No session in store — strict CAS misses; recovery succeeds
    // (already absent). Profile remains authoritative.
    await completeFinalizedFaceEnrollmentForUser("user-1");
    const after = profileStore.get("user-1");
    expect(after?.sourceEnrollmentGenerationId).toBe("gen-A");
  });

  it("32. FaceProfile delete function is never called", async () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/face-enrollment-completion-service.ts",
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
    expect(codeOnly.includes("deleteFaceProfileByUserId")).toBe(false);
    expect(codeOnly.includes("deleteOne({ userId")).toBe(false);
    // Acceptable: the helper to "delete a session" only — that's the
    // strict CAS or lineage-bound CAS — must never accidentally
    // delete the FaceProfile.
  });
});

// =============================================================================
// 33..38 — IDEMPOTENCY
// =============================================================================

describe("idempotency", () => {
  it("33. first completion persists + consumes", async () => {
    profileStore.set("user-1", null as unknown as FaceProfileAttrs);
    // Force pre-flight read to return no profile by NOT setting one.
    profileStore.delete("user-1");
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        finalizationClaim: {
          token: "tok-A",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );
    mockPersistedResponse = {
      sourceEnrollmentGenerationId: "gen-A",
      claimToken: "tok-A",
      claimedAt: new Date(),
      created: true,
    };
    // Force B2B to populate profileStore via a side effect:
    const { persistFinalizedFaceProfileForUser } = await import(
      "@/lib/biometrics/face-profile-finalization-service"
    );
    (persistFinalizedFaceProfileForUser as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        profileStore.set(
          "user-1",
          makeProfileFixture({
            userId: "user-1",
            sourceEnrollmentGenerationId: "gen-A",
          }),
        );
        return mockPersistedResponse!;
      },
    );

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(result.configured).toBe(true);
    expect(result.cleanupStatus).toBe("consumed");
  });

  it("34. second identical completion returns success", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        sourceEnrollmentGenerationId: "gen-A",
      }),
    );
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
      }),
    );

    const result1 = await completeFinalizedFaceEnrollmentForUser("user-1");
    // First call deletes the session via recovery CAS.
    expect(result1.cleanupStatus).toBe("consumed");
    expect(sessionStore.has("user-1")).toBe(false);

    // Second call: profile still present, session absent.
    const result2 = await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(result2.configured).toBe(true);
    expect(result2.cleanupStatus).toBe("already_consumed");
  });

  it("35. second completion does not create second FaceProfile", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        sourceEnrollmentGenerationId: "gen-A",
      }),
    );
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
      }),
    );

    await completeFinalizedFaceEnrollmentForUser("user-1");
    const firstProfile = profileStore.get("user-1");
    // Second call.
    await completeFinalizedFaceEnrollmentForUser("user-1");
    const secondProfile = profileStore.get("user-1");
    expect(secondProfile).toBe(firstProfile);
    // B2B was NEVER invoked on the second call.
    expect(persistLog.length).toBe(0);
  });

  it("36. second completion does not call Face Service again", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({ userId: "user-1" }),
    );
    sessionStore.set(
      "user-1",
      makeSessionFixture({ userId: "user-1", generationId: "gen-A" }),
    );

    await completeFinalizedFaceEnrollmentForUser("user-1");
    await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(persistLog.length).toBe(0);
  });

  it("37. second completion does not require original claim token", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        sourceEnrollmentGenerationId: "gen-A",
      }),
    );
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        // No finalizationClaim at all.
      }),
    );

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(result.configured).toBe(true);
    expect(result.cleanupStatus).toBe("consumed");
  });

  it("38. repeated recovery remains deterministic", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        sourceEnrollmentGenerationId: "gen-A",
      }),
    );
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
      }),
    );

    const r1 = await completeFinalizedFaceEnrollmentForUser("user-1");
    const r2 = await completeFinalizedFaceEnrollmentForUser("user-1");
    const r3 = await completeFinalizedFaceEnrollmentForUser("user-1");

    expect(r1.cleanupStatus).toBe("consumed");
    expect(r2.cleanupStatus).toBe("already_consumed");
    expect(r3.cleanupStatus).toBe("already_consumed");
    // Profile remains authoritative throughout.
    expect(profileStore.has("user-1")).toBe(true);
  });
});

// =============================================================================
// 39..48 — RESULT PRIVACY
// =============================================================================

describe("result privacy", () => {
  it("39. final result contains configured state", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({ userId: "user-1" }),
    );

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(typeof result.configured).toBe("boolean");
    expect(result.configured).toBe(true);
  });

  it("40. final result contains safe enrolledAt / sampleCount if useful", async () => {
    const profile = makeProfileFixture({ userId: "user-1" });
    profileStore.set("user-1", profile);

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(result.enrolledAt).toBeInstanceOf(Date);
    expect(result.sampleCount).toBe(5);
  });

  it("41. final result contains no claimToken", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({ userId: "user-1" }),
    );
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        finalizationClaim: {
          token: "must-not-leak-claim-token",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    const json = JSON.stringify(result);
    expect(json.includes("must-not-leak-claim-token")).toBe(false);
    expect(json.includes("claimToken")).toBe(false);
  });

  it("42. final result contains no generationId", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        sourceEnrollmentGenerationId: "must-not-leak-gen",
      }),
    );
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
      }),
    );

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    const json = JSON.stringify(result);
    expect(json.includes("must-not-leak-gen")).toBe(false);
    expect(json.includes("generationId")).toBe(false);
  });

  it("43. final result contains no centroid", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        centroid: {
          ciphertext: "must-not-leak-centroid",
          iv: "centroid-iv",
          authTag: "centroid-authTag",
          keyVersion: 1,
        },
      }),
    );

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    const json = JSON.stringify(result);
    expect(json.includes("must-not-leak-centroid")).toBe(false);
    expect(json.includes("centroid")).toBe(false);
    expect(json.includes("ciphertext")).toBe(false);
  });

  it("44. final result contains no encrypted sample", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        samples: [
          {
            encryptedVector: {
              ciphertext: "must-not-leak-sample",
              iv: "sample-iv",
              authTag: "sample-authTag",
              keyVersion: 1,
            },
            sampleIndex: 0,
          },
        ],
      }),
    );

    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    const json = JSON.stringify(result);
    expect(json.includes("must-not-leak-sample")).toBe(false);
    expect(json.includes("samples")).toBe(false);
  });

  it("45. final result contains no ciphertext", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({ userId: "user-1" }),
    );
    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    const json = JSON.stringify(result);
    expect(json.includes("ciphertext")).toBe(false);
  });

  it("46. final result contains no iv", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({ userId: "user-1" }),
    );
    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    const json = JSON.stringify(result);
    expect(json.includes('"iv"')).toBe(false);
  });

  it("47. final result contains no authTag", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({ userId: "user-1" }),
    );
    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    const json = JSON.stringify(result);
    expect(json.includes("authTag")).toBe(false);
  });

  it("48. final result contains no userId if unnecessary", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({ userId: "user-1" }),
    );
    const result = await completeFinalizedFaceEnrollmentForUser("user-1");
    const json = JSON.stringify(result);
    expect(json.includes("userId")).toBe(false);
    expect(json.includes("user-1")).toBe(false);
  });
});

// =============================================================================
// 49..52 — NO TRANSACTION / NO ROLLBACK
// =============================================================================

describe("no transaction / no rollback", () => {
  it("49. no Mongo transaction introduced", async () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/face-enrollment-completion-service.ts",
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
    expect(codeOnly.includes("startSession")).toBe(false);
    expect(codeOnly.includes("withTransaction")).toBe(false);
    expect(codeOnly.includes("session: mongoose")).toBe(false);
  });

  it("50. cleanup failure does not delete FaceProfile", async () => {
    profileStore.set(
      "user-1",
      makeProfileFixture({ userId: "user-1" }),
    );
    // No session in the store → recovery CAS misses. The FaceProfile
    // remains in place.
    await completeFinalizedFaceEnrollmentForUser("user-1");
    expect(profileStore.has("user-1")).toBe(true);
  });

  it("51. cleanup failure does not reset enrollment generation", async () => {
    // Cleanup failure path: profile exists, session recovery misses,
    // session re-read finds a generation that doesn't match.
    profileStore.set(
      "user-1",
      makeProfileFixture({
        userId: "user-1",
        sourceEnrollmentGenerationId: "gen-A",
      }),
    );
    sessionStore.set(
      "user-1",
      makeSessionFixture({ userId: "user-1", generationId: "gen-B" }),
    );
    await completeFinalizedFaceEnrollmentForUser("user-1");
    // session gen-B is preserved.
    expect(sessionStore.get("user-1")?.generationId).toBe("gen-B");
  });

  it("52. cleanup failure does not release unrelated claim", async () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/face-enrollment-completion-service.ts",
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
    // The B2C module MUST NOT import or call releaseEnrollmentFinalizationClaim.
    // Release is B2B's responsibility (and only on its own failure
    // paths). B2C's strict consume deletes the whole session
    // atomically; it does not selectively clear the claim.
    expect(codeOnly.includes("releaseEnrollmentFinalizationClaim")).toBe(
      false,
    );
  });
});

// =============================================================================
// Extra — INVALID_USER_ID + error wrapping
// =============================================================================

describe("error surface", () => {
  it("rejects empty userId with INVALID_USER_ID", async () => {
    await expect(
      completeFinalizedFaceEnrollmentForUser(""),
    ).rejects.toBeInstanceOf(FaceEnrollmentCompletionError);
    try {
      await completeFinalizedFaceEnrollmentForUser("");
    } catch (err) {
      expect(err).toBeInstanceOf(FaceEnrollmentCompletionError);
      expect((err as FaceEnrollmentCompletionErrorType).code).toBe(
        FACE_ENROLLMENT_COMPLETION_ERROR_CODES.INVALID_USER_ID,
      );
    }
  });

  it("wraps BiometricPersistenceError into ENROLLMENT_COMPLETION_FAILED", async () => {
    const { persistFinalizedFaceProfileForUser } = await import(
      "@/lib/biometrics/face-profile-finalization-service"
    );
    (persistFinalizedFaceProfileForUser as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        throw new BiometricPersistenceError({
          code: "FACE_PROFILE_PERSISTENCE_FAILED",
          message: "fake infra error",
        });
      },
    );

    try {
      await completeFinalizedFaceEnrollmentForUser("user-1");
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FaceEnrollmentCompletionError);
      const wrapped = err as FaceEnrollmentCompletionErrorType;
      expect(wrapped.code).toBe(
        FACE_ENROLLMENT_COMPLETION_ERROR_CODES.ENROLLMENT_COMPLETION_FAILED,
      );
      expect(wrapped.underlyingCode).toBe("FACE_PROFILE_PERSISTENCE_FAILED");
    }
  });
});

// =============================================================================
// server-only boundary & browser-secret hygiene
// =============================================================================

describe("server-only boundary & browser-secret hygiene", () => {
  it("module opens with `import \"server-only\"`", async () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/face-enrollment-completion-service.ts",
      ),
      "utf8",
    );
    expect(source.includes('import "server-only"')).toBe(true);
  });

  it("no browser storage APIs are referenced in the B2C source", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/face-enrollment-completion-service.ts",
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
    expect(codeOnly.includes("window.")).toBe(false);
    expect(codeOnly.includes("document.")).toBe(false);
  });

  it("no direct Face Service fetch is introduced", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/face-enrollment-completion-service.ts",
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
  });

  it("finalizeFaceEnrollment / finalizeEnrollmentSessionForUser are never imported", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/biometrics/face-enrollment-completion-service.ts",
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
    expect(codeOnly.includes("finalizeFaceEnrollment")).toBe(false);
    expect(codeOnly.includes("finalizeEnrollmentSessionForUser")).toBe(false);
  });
});
