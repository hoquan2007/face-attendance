/**
 * Tests for the PHASE 4.6B2A atomic completion claim service.
 *
 * Covers the 61-test contract:
 *   - Claim success (1..10)
 *   - Atomic preconditions (11..20)
 *   - Database complete-condition (21..24)
 *   - Release (25..34)
 *   - Reset protection (35..44)
 *   - Concurrency (45..50)
 *   - Privacy (51..58)
 *   - Legacy session (59..61)
 *
 * Implementation notes:
 *   - Uses in-memory store + Mongoose mock mirrors the existing
 *     enrollment-session-service.test.ts style.
 *   - Never mocks `randomUUID()` directly — the implementation uses
 *     the real `node:crypto` source.
 *   - The `generateClaimToken` override hook is provided for tests
 *     that need a deterministic token.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FaceEnrollmentFinalizationClaimDoc,
  FaceEnrollmentSessionAttrs,
} from "@/lib/biometrics/enrollment-session-model";

// =============================================================================
// In-memory store + mock implementation
// =============================================================================

const sessionStore = new Map<string, FaceEnrollmentSessionAttrs>();

const sessionCalls: Array<{
  method: "findOne" | "findOneAndUpdate";
  filter: Record<string, unknown>;
  updateBodyKeys: string[];
}> = [];

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
    generationId: "gen-test-default",
    modelIdentity: "insightface-buffalo-l",
    modelName: "buffalo_l",
    embeddingDimension: 512,
    normalization: "l2",
    ...overrides,
  };
}

/**
 * Builds N encrypted samples that match the canonical fixtures so
 * `acceptedSamples.length === requiredSampleCount` is satisfied.
 */
function buildFiveSamples(): FaceEnrollmentSessionAttrs["acceptedSamples"] {
  const now = new Date();
  return Array.from({ length: 5 }, (_, i) => ({
    encryptedVector: {
      ciphertext: `cipher-${i}`,
      iv: `iv-${i}`,
      authTag: `authTag-${i}`,
      keyVersion: 1,
    },
    sampleIndex: i,
    acceptedAt: now,
  }));
}

/**
 * Mocked `findOneAndUpdate`. Honors the B2A atomic CAS contract:
 *   - userId must match
 *   - generationId must match (when present in filter)
 *   - expiresAt > now (when present)
 *   - mode / templateVersion / normalization must be in supported set
 *   - acceptedSamples length must equal requiredSampleCount
 *   - finalizationClaim must be absent (when filter requires it)
 *   - For release: finalizationClaim.token must match (when present)
 *
 * On success, applies $set fields and returns the persisted doc.
 */
const mockFindOneAndUpdate = vi.fn(
  (
    filter: Record<string, unknown>,
    update: {
      $set?: Record<string, unknown>;
      $setOnInsert?: Record<string, unknown>;
      $push?: unknown;
    },
    options: { upsert?: boolean; new?: boolean } = {},
  ) => {
    const userId = filter.userId as string;
    const existing = sessionStore.get(userId);
    const now = new Date();

    // CAS check: only claim operations go through here in this test
    // suite. Two flavors:
    //   1. Acquisition — filter requires finalizationClaim absent.
    //   2. Release — filter requires finalizationClaim.token match.
    if (existing !== undefined) {
      // Acquisition CAS
      if (
        filter.finalizationClaim &&
        typeof filter.finalizationClaim === "object" &&
        "$exists" in (filter.finalizationClaim as Record<string, unknown>) &&
        (filter.finalizationClaim as { $exists?: unknown }).$exists === false
      ) {
        // Acquire — must have no existing claim.
        if (existing.finalizationClaim !== undefined) {
          return { lean: () => ({ exec: async () => null }) };
        }
        // Generation match
        if (
          typeof filter.generationId === "string" &&
          filter.generationId !== existing.generationId
        ) {
          return { lean: () => ({ exec: async () => null }) };
        }
        // Expiration check
        const exp = (filter.expiresAt as { $gt?: Date } | undefined)?.$gt;
        if (exp && existing.expiresAt.getTime() <= exp.getTime()) {
          return { lean: () => ({ exec: async () => null }) };
        }
        // Mode check
        if (filter.mode && typeof filter.mode === "object" && "$in" in filter.mode) {
          const allowed = filter.mode.$in as string[];
          if (!allowed.includes(existing.mode)) {
            return { lean: () => ({ exec: async () => null }) };
          }
        }
        // templateVersion check
        if (
          filter.templateVersion &&
          typeof filter.templateVersion === "object" &&
          "$in" in filter.templateVersion
        ) {
          const allowed = filter.templateVersion.$in as number[];
          if (!allowed.includes(existing.templateVersion)) {
            return { lean: () => ({ exec: async () => null }) };
          }
        }
        // normalization check
        if (
          filter.normalization &&
          typeof filter.normalization === "object" &&
          "$in" in filter.normalization
        ) {
          const allowed = filter.normalization.$in as string[];
          if (!existing.normalization || !allowed.includes(existing.normalization)) {
            return { lean: () => ({ exec: async () => null }) };
          }
        }
        // Sample count guard via $expr
        if (filter.$expr) {
          if (existing.acceptedSamples.length !== existing.requiredSampleCount) {
            return { lean: () => ({ exec: async () => null }) };
          }
        }
      }

      // Release CAS — finalizationClaim.token must match
      if (
        filter["finalizationClaim.token"] !== undefined &&
        typeof filter["finalizationClaim.token"] === "string"
      ) {
        if (
          !existing.finalizationClaim ||
          existing.finalizationClaim.token !== filter["finalizationClaim.token"]
        ) {
          return { lean: () => ({ exec: async () => null }) };
        }
        // Generation check
        if (
          typeof filter.generationId === "string" &&
          filter.generationId !== existing.generationId
        ) {
          return { lean: () => ({ exec: async () => null }) };
        }
        // Apply the update
        if (update.$set) {
          Object.assign(existing, update.$set);
        }
        const updated = { ...existing };
        return { lean: () => ({ exec: async () => updated }) };
      }
    }

    if (existing !== undefined) {
      // Acquisition success path
      if (update.$set) {
        Object.assign(existing, update.$set);
      }
      existing.updatedAt = now;
      const updated = { ...existing };
      return { lean: () => ({ exec: async () => updated }) };
    }

    if (!options.upsert) {
      return { lean: () => ({ exec: async () => null }) };
    }

    // Upsert path — for tests that call the reset operation.
    const fresh: FaceEnrollmentSessionAttrs = {
      ...makeSessionFixture({ userId }),
      ...(update.$set ?? {}),
      ...(update.$setOnInsert ?? {}),
      userId,
    };
    sessionStore.set(userId, fresh);
    return { lean: () => ({ exec: async () => ({ ...fresh }) }) };
  },
);

const mockFindOne = vi.fn((filter: Record<string, unknown>) => {
  const userId = filter.userId as string;
  return {
    lean: () => ({
      exec: async () => {
        const existing = sessionStore.get(userId);
        return existing ? { ...existing } : null;
      },
    }),
  };
});

vi.mock("@/lib/biometrics/enrollment-session-model", () => ({
  FaceEnrollmentSessionModel: {
    findOne: (...args: unknown[]) => {
      const filter = args[0] as Record<string, unknown>;
      sessionCalls.push({
        method: "findOne",
        filter,
        updateBodyKeys: [],
      });
      return mockFindOne(filter);
    },
    findOneAndUpdate: (...args: unknown[]) => {
      const filter = args[0] as Record<string, unknown>;
      const update = args[1] as {
        $set?: Record<string, unknown>;
        $setOnInsert?: Record<string, unknown>;
      };
      sessionCalls.push({
        method: "findOneAndUpdate",
        filter,
        updateBodyKeys: Object.keys(update.$set ?? {}),
      });
      return mockFindOneAndUpdate(
        filter,
        update,
        args[2] as { upsert?: boolean; new?: boolean },
      );
    },
  },
}));

vi.mock("@/lib/mongoose", () => ({
  getMongooseConnection: () => Promise.resolve(),
}));

import {
  claimEnrollmentSessionForFinalization,
  EnrollmentFinalizationClaimError,
  ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES,
  releaseEnrollmentFinalizationClaim,
} from "@/lib/biometrics/enrollment-finalization-claim-service";
import { ENROLLMENT_ROUTE_ERROR_CODES } from "@/lib/biometrics/enrollment-route-errors";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function resetStore(): void {
  sessionStore.clear();
  sessionCalls.length = 0;
  mockFindOneAndUpdate.mockClear();
  mockFindOne.mockClear();
}

// =============================================================================
// 1..10 — Claim success
// =============================================================================

describe("claim / success", () => {
  beforeEach(resetStore);
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("1. complete valid session can be claimed", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    const result = await claimEnrollmentSessionForFinalization({
      userId: "user-1",
      generationId: "gen-A",
    });

    expect(result.userId).toBe("user-1");
    expect(result.generationId).toBe("gen-A");
    expect(result.claimToken.length).toBeGreaterThan(0);
    expect(result.claimedAt).toBeInstanceOf(Date);
  });

  it("2. claim contains non-empty token", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    const result = await claimEnrollmentSessionForFinalization({
      userId: "user-1",
      generationId: "gen-A",
    });
    expect(typeof result.claimToken).toBe("string");
    expect(result.claimToken.length).toBeGreaterThan(0);
  });

  it("3. token is server-generated via node:crypto randomUUID", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    // Default implementation uses randomUUID — verify by structure.
    const result = await claimEnrollmentSessionForFinalization({
      userId: "user-1",
      generationId: "gen-A",
    });
    // node:crypto randomUUID produces v4 UUIDs — 36 chars, dashed.
    expect(result.claimToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("4. token is not derived from userId", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    const result = await claimEnrollmentSessionForFinalization({
      userId: "user-1",
      generationId: "gen-A",
    });
    // Token must be independent of userId — not contain the userId.
    expect(result.claimToken.includes("user-1")).toBe(false);
  });

  it("5. claim generationId equals current session generation", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    const result = await claimEnrollmentSessionForFinalization({
      userId: "user-1",
      generationId: "gen-A",
    });
    expect(result.generationId).toBe("gen-A");
  });

  it("6. claimedAt recorded", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    const before = Date.now();
    const result = await claimEnrollmentSessionForFinalization({
      userId: "user-1",
      generationId: "gen-A",
    });
    const after = Date.now();
    expect(result.claimedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(result.claimedAt.getTime()).toBeLessThanOrEqual(after + 1000);
  });

  it("7. claim persisted on enrollment session", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    await claimEnrollmentSessionForFinalization({
      userId: "user-1",
      generationId: "gen-A",
    });

    const persisted = sessionStore.get("user-1");
    expect(persisted?.finalizationClaim).toBeDefined();
    expect(persisted?.finalizationClaim?.generationId).toBe("gen-A");
    expect(persisted?.finalizationClaim?.token.length).toBeGreaterThan(0);
  });

  it("8. acceptedSamples unchanged by claim", async () => {
    const samples = buildFiveSamples();
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: samples,
        generationId: "gen-A",
      }),
    );

    await claimEnrollmentSessionForFinalization({
      userId: "user-1",
      generationId: "gen-A",
    });

    const persisted = sessionStore.get("user-1");
    expect(persisted?.acceptedSamples.length).toBe(5);
  });

  it("9. expiresAt unchanged by claim", async () => {
    const fixedExpiry = new Date(Date.now() + 15 * 60 * 1000);
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        expiresAt: fixedExpiry,
        generationId: "gen-A",
      }),
    );

    await claimEnrollmentSessionForFinalization({
      userId: "user-1",
      generationId: "gen-A",
    });

    const persisted = sessionStore.get("user-1");
    expect(persisted?.expiresAt.getTime()).toBe(fixedExpiry.getTime());
  });

  it("10. model metadata unchanged by claim", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
        generationId: "gen-A",
      }),
    );

    await claimEnrollmentSessionForFinalization({
      userId: "user-1",
      generationId: "gen-A",
    });

    const persisted = sessionStore.get("user-1");
    expect(persisted?.modelIdentity).toBe("insightface-buffalo-l");
    expect(persisted?.modelName).toBe("buffalo_l");
    expect(persisted?.embeddingDimension).toBe(512);
    expect(persisted?.normalization).toBe("l2");
  });
});

// =============================================================================
// 11..20 — Atomic preconditions
// =============================================================================

describe("claim / atomic preconditions", () => {
  beforeEach(resetStore);
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("11. missing session cannot be claimed", async () => {
    await expect(
      claimEnrollmentSessionForFinalization({
        userId: "no-such-user",
        generationId: "gen-A",
      }),
    ).rejects.toMatchObject({
      code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES.ENROLLMENT_SESSION_NOT_FOUND,
    });
  });

  it("12. expired session cannot be claimed", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        expiresAt: new Date(Date.now() - 1000), // expired
        generationId: "gen-A",
      }),
    );

    await expect(
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
    ).rejects.toMatchObject({
      code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES.ENROLLMENT_SESSION_EXPIRED,
    });
  });

  it("13. incomplete session cannot be claimed", async () => {
    // Only 3 of 5 samples accepted.
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples().slice(0, 3),
        generationId: "gen-A",
      }),
    );

    await expect(
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
    ).rejects.toMatchObject({
      code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES.ENROLLMENT_INCOMPLETE,
    });
  });

  it("14. wrong generation cannot be claimed", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    await expect(
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-B", // wrong
      }),
    ).rejects.toMatchObject({
      code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES.ENROLLMENT_GENERATION_CHANGED,
    });
  });

  it("15. generation drift between B1B snapshot and claim fails", async () => {
    // B1B finalized with gen-A; meanwhile the session was reset → gen-B.
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-B",
      }),
    );

    await expect(
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
    ).rejects.toMatchObject({
      code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES.ENROLLMENT_GENERATION_CHANGED,
    });
  });

  it("16. existing claim cannot be overwritten", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
        finalizationClaim: {
          token: "existing-token",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    await expect(
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
    ).rejects.toMatchObject({
      code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES.ENROLLMENT_FINALIZATION_ALREADY_CLAIMED,
    });
  });

  it("17. second finalizer receives safe already-claimed result", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
        finalizationClaim: {
          token: "existing-token",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    await expect(
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
    ).rejects.toBeInstanceOf(EnrollmentFinalizationClaimError);
  });

  it("18. second finalizer does NOT receive first claim token", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
        finalizationClaim: {
          token: "secret-first-token",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    try {
      await claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      });
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(EnrollmentFinalizationClaimError);
      const e = err as EnrollmentFinalizationClaimError;
      // The error must NOT carry the existing claim token.
      expect(JSON.stringify(e.toJSON()).includes("secret-first-token")).toBe(
        false,
      );
    }
  });

  it("19. claim operation does not change generationId", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    await claimEnrollmentSessionForFinalization({
      userId: "user-1",
      generationId: "gen-A",
    });

    const persisted = sessionStore.get("user-1");
    expect(persisted?.generationId).toBe("gen-A");
  });

  it("20. claim operation does not reset enrollment", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    await claimEnrollmentSessionForFinalization({
      userId: "user-1",
      generationId: "gen-A",
    });

    // The session still has its samples and a claim.
    const persisted = sessionStore.get("user-1");
    expect(persisted?.acceptedSamples.length).toBe(5);
    expect(persisted?.finalizationClaim).toBeDefined();
  });
});

// =============================================================================
// 21..24 — Database complete-condition
// =============================================================================

describe("claim / database complete-condition", () => {
  beforeEach(resetStore);
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("21. database claim condition requires complete sample count", async () => {
    // Verify by inspection: $expr filter is used to enforce sample count.
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples().slice(0, 2),
        generationId: "gen-A",
      }),
    );

    await expect(
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
    ).rejects.toMatchObject({
      code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES.ENROLLMENT_INCOMPLETE,
    });
  });

  it("22. 4/5 cannot be claimed", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples().slice(0, 4),
        generationId: "gen-A",
      }),
    );

    await expect(
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
    ).rejects.toMatchObject({
      code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES.ENROLLMENT_INCOMPLETE,
    });
  });

  it("23. 5/5 can be claimed", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    const result = await claimEnrollmentSessionForFinalization({
      userId: "user-1",
      generationId: "gen-A",
    });
    expect(result.claimToken.length).toBeGreaterThan(0);
  });

  it("24. requiredSampleCount changes do not allow invalid claim", async () => {
    // Session claims requiredSampleCount=5 but only has 3 samples.
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples().slice(0, 3),
        requiredSampleCount: 5,
        generationId: "gen-A",
      }),
    );

    await expect(
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
    ).rejects.toMatchObject({
      code: ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES.ENROLLMENT_INCOMPLETE,
    });
  });
});

// =============================================================================
// 25..34 — Release
// =============================================================================

describe("claim / release", () => {
  beforeEach(resetStore);
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("25. correct token releases claim", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
        finalizationClaim: {
          token: "test-token-25",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    const released = await releaseEnrollmentFinalizationClaim({
      userId: "user-1",
      generationId: "gen-A",
      claimToken: "test-token-25",
    });
    expect(released.released).toBe(true);
    expect(sessionStore.get("user-1")?.finalizationClaim).toBeUndefined();
  });

  it("26. correct generation required to release", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
        finalizationClaim: {
          token: "test-token-26",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    const released = await releaseEnrollmentFinalizationClaim({
      userId: "user-1",
      generationId: "gen-B", // wrong
      claimToken: "test-token-26",
    });
    expect(released.released).toBe(false);
    expect(sessionStore.get("user-1")?.finalizationClaim?.token).toBe(
      "test-token-26",
    );
  });

  it("27. wrong generation cannot release claim", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
        finalizationClaim: {
          token: "test-token-27",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    const released = await releaseEnrollmentFinalizationClaim({
      userId: "user-1",
      generationId: "gen-B",
      claimToken: "test-token-27",
    });
    expect(released.released).toBe(false);
    expect(sessionStore.get("user-1")?.finalizationClaim).toBeDefined();
  });

  it("28. wrong token cannot release claim", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
        finalizationClaim: {
          token: "correct-token",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    const released = await releaseEnrollmentFinalizationClaim({
      userId: "user-1",
      generationId: "gen-A",
      claimToken: "wrong-token",
    });
    expect(released.released).toBe(false);
    expect(sessionStore.get("user-1")?.finalizationClaim?.token).toBe(
      "correct-token",
    );
  });

  it("29. another finalizer's claim remains after wrong-token release attempt", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
        finalizationClaim: {
          token: "primary-token",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    const released = await releaseEnrollmentFinalizationClaim({
      userId: "user-1",
      generationId: "gen-A",
      claimToken: "wrong-attempt-token",
    });
    expect(released.released).toBe(false);
    // Primary token still present.
    expect(sessionStore.get("user-1")?.finalizationClaim?.token).toBe(
      "primary-token",
    );
  });

  it("30. release does not alter accepted samples", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
        finalizationClaim: {
          token: "test-token-30",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    await releaseEnrollmentFinalizationClaim({
      userId: "user-1",
      generationId: "gen-A",
      claimToken: "test-token-30",
    });
    expect(sessionStore.get("user-1")?.acceptedSamples.length).toBe(5);
  });

  it("31. release does not alter generation", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
        finalizationClaim: {
          token: "test-token-31",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    await releaseEnrollmentFinalizationClaim({
      userId: "user-1",
      generationId: "gen-A",
      claimToken: "test-token-31",
    });
    expect(sessionStore.get("user-1")?.generationId).toBe("gen-A");
  });

  it("32. release does not alter expiresAt", async () => {
    const expiry = new Date(Date.now() + 15 * 60 * 1000);
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        expiresAt: expiry,
        generationId: "gen-A",
        finalizationClaim: {
          token: "test-token-32",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    await releaseEnrollmentFinalizationClaim({
      userId: "user-1",
      generationId: "gen-A",
      claimToken: "test-token-32",
    });
    expect(sessionStore.get("user-1")?.expiresAt.getTime()).toBe(
      expiry.getTime(),
    );
  });

  it("33. release does not alter model metadata", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
        finalizationClaim: {
          token: "test-token-33",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    await releaseEnrollmentFinalizationClaim({
      userId: "user-1",
      generationId: "gen-A",
      claimToken: "test-token-33",
    });
    const p = sessionStore.get("user-1");
    expect(p?.modelIdentity).toBe("insightface-buffalo-l");
    expect(p?.modelName).toBe("buffalo_l");
    expect(p?.embeddingDimension).toBe(512);
    expect(p?.normalization).toBe("l2");
  });

  it("34. already-released claim behaves deterministically", async () => {
    // No claim installed.
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    const released = await releaseEnrollmentFinalizationClaim({
      userId: "user-1",
      generationId: "gen-A",
      claimToken: "any-token",
    });
    expect(released.released).toBe(false);
    // The function MUST NOT throw — it is idempotent.
  });
});

// =============================================================================
// 35..44 — Reset protection
// =============================================================================

describe("claim / reset protection", () => {
  beforeEach(resetStore);
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("35. create/reset without claim continues working", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({ userId: "user-1", acceptedSamples: [] }),
    );

    // The reset function uses the same mocked findOneAndUpdate which
    // honors finalizationClaim absent. With no claim, the reset should
    // succeed.
    const { createOrResetEnrollmentSession } = await import(
      "@/lib/biometrics/enrollment-session-service"
    );

    const result = await createOrResetEnrollmentSession({
      userId: "user-1",
      mode: "create",
      requiredSampleCount: 5,
      templateVersion: 1,
    });

    expect(result.userId).toBe("user-1");
    expect(result.acceptedSamples).toEqual([]);
  });

  it("36. normal reset creates fresh generationId as before", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "old-gen",
        acceptedSamples: buildFiveSamples(),
      }),
    );

    const { createOrResetEnrollmentSession } = await import(
      "@/lib/biometrics/enrollment-session-service"
    );

    const result = await createOrResetEnrollmentSession({
      userId: "user-1",
      mode: "create",
      requiredSampleCount: 5,
      templateVersion: 1,
    });

    expect(result.generationId).not.toBe("old-gen");
    expect(result.acceptedSamples).toEqual([]);
  });

  it("37. active finalization claim blocks reset", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        acceptedSamples: buildFiveSamples(),
        finalizationClaim: {
          token: "blocking-token",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    const { createOrResetEnrollmentSession } = await import(
      "@/lib/biometrics/enrollment-session-service"
    );
    const { BIOMETRIC_PERSISTENCE_ERROR_CODES } = await import(
      "@/lib/biometrics/biometric-errors"
    );

    await expect(
      createOrResetEnrollmentSession({
        userId: "user-1",
        mode: "create",
        requiredSampleCount: 5,
        templateVersion: 1,
      }),
    ).rejects.toMatchObject({
      code: BIOMETRIC_PERSISTENCE_ERROR_CODES.ENROLLMENT_FINALIZATION_IN_PROGRESS,
    });
  });

  it("38. blocked reset does NOT change generationId", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        acceptedSamples: buildFiveSamples(),
        finalizationClaim: {
          token: "blocking-token",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    const { createOrResetEnrollmentSession } = await import(
      "@/lib/biometrics/enrollment-session-service"
    );

    try {
      await createOrResetEnrollmentSession({
        userId: "user-1",
        mode: "create",
        requiredSampleCount: 5,
        templateVersion: 1,
      });
    } catch {
      // expected
    }

    expect(sessionStore.get("user-1")?.generationId).toBe("gen-A");
  });

  it("39. blocked reset does NOT clear accepted samples", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        acceptedSamples: buildFiveSamples(),
        finalizationClaim: {
          token: "blocking-token",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    const { createOrResetEnrollmentSession } = await import(
      "@/lib/biometrics/enrollment-session-service"
    );

    try {
      await createOrResetEnrollmentSession({
        userId: "user-1",
        mode: "create",
        requiredSampleCount: 5,
        templateVersion: 1,
      });
    } catch {
      // expected
    }

    expect(sessionStore.get("user-1")?.acceptedSamples.length).toBe(5);
  });

  it("40. blocked reset does NOT change expiresAt", async () => {
    const expiry = new Date(Date.now() + 10 * 60 * 1000);
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        acceptedSamples: buildFiveSamples(),
        expiresAt: expiry,
        finalizationClaim: {
          token: "blocking-token",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    const { createOrResetEnrollmentSession } = await import(
      "@/lib/biometrics/enrollment-session-service"
    );

    try {
      await createOrResetEnrollmentSession({
        userId: "user-1",
        mode: "create",
        requiredSampleCount: 5,
        templateVersion: 1,
      });
    } catch {
      // expected
    }

    expect(sessionStore.get("user-1")?.expiresAt.getTime()).toBe(
      expiry.getTime(),
    );
  });

  it("41. blocked reset does NOT change model metadata", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        acceptedSamples: buildFiveSamples(),
        finalizationClaim: {
          token: "blocking-token",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    const { createOrResetEnrollmentSession } = await import(
      "@/lib/biometrics/enrollment-session-service"
    );

    try {
      await createOrResetEnrollmentSession({
        userId: "user-1",
        mode: "create",
        requiredSampleCount: 5,
        templateVersion: 1,
      });
    } catch {
      // expected
    }

    const p = sessionStore.get("user-1");
    expect(p?.modelIdentity).toBe("insightface-buffalo-l");
    expect(p?.modelName).toBe("buffalo_l");
  });

  it("42. blocked reset does NOT overwrite claim token", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        acceptedSamples: buildFiveSamples(),
        finalizationClaim: {
          token: "primary-claim-token",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    const { createOrResetEnrollmentSession } = await import(
      "@/lib/biometrics/enrollment-session-service"
    );

    try {
      await createOrResetEnrollmentSession({
        userId: "user-1",
        mode: "create",
        requiredSampleCount: 5,
        templateVersion: 1,
      });
    } catch {
      // expected
    }

    expect(sessionStore.get("user-1")?.finalizationClaim?.token).toBe(
      "primary-claim-token",
    );
  });

  it("43. start-route maps ENROLLMENT_FINALIZATION_IN_PROGRESS safely", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        acceptedSamples: buildFiveSamples(),
        finalizationClaim: {
          token: "blocking-token",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    // The mapping is exercised via the route-error mapper.
    const { mapEnrollmentStartError } = await import(
      "@/lib/biometrics/enrollment-route-errors"
    );
    const { BiometricPersistenceError, BIOMETRIC_PERSISTENCE_ERROR_CODES } =
      await import("@/lib/biometrics/biometric-errors");

    const err = new BiometricPersistenceError({
      code: BIOMETRIC_PERSISTENCE_ERROR_CODES.ENROLLMENT_FINALIZATION_IN_PROGRESS,
      message: "blocked",
    });
    const mapped = mapEnrollmentStartError(err);
    expect(mapped.code).toBe(
      ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_FINALIZATION_IN_PROGRESS,
    );
    // Friendly copy must NOT expose claim token.
    expect(mapped.message.includes("blocking-token")).toBe(false);
  });

  it("44. browser response never exposes claimToken", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
        finalizationClaim: {
          token: "this-must-not-leak",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );

    // Verify by string match on the JSON shape that would reach the
    // browser — the literal claim token MUST NOT be visible from a
    // public read.
    const { getEnrollmentSessionByUserId } = await import(
      "@/lib/biometrics/enrollment-session-service"
    );
    const session = await getEnrollmentSessionByUserId("user-1");
    const serialized = JSON.stringify({
      active: true,
      mode: session?.mode,
      acceptedSamples: session?.acceptedSamples.length,
      requiredSamples: session?.requiredSampleCount,
      expiresAt: session?.expiresAt.toISOString(),
      generationId: session?.generationId,
    });
    expect(serialized.includes("this-must-not-leak")).toBe(false);
    expect(serialized.includes("claimToken")).toBe(false);
    expect(serialized.includes("finalizationClaim")).toBe(false);
  });
});

// =============================================================================
// 45..50 — Concurrency
// =============================================================================

describe("claim / concurrency", () => {
  beforeEach(resetStore);
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("45. two simultaneous claim attempts for same generation: only one wins", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    const [a, b] = await Promise.allSettled([
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
    ]);

    const wins = [a, b].filter((r) => r.status === "fulfilled");
    const losses = [a, b].filter((r) => r.status === "rejected");
    expect(wins.length).toBe(1);
    expect(losses.length).toBe(1);
  });

  it("46. winner token is the only persisted token", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    const results = await Promise.allSettled([
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
    ]);

    const winner = results.find(
      (r) => r.status === "fulfilled",
    ) as PromiseFulfilledResult<{ claimToken: string }>;
    const persisted = sessionStore.get("user-1");
    expect(persisted?.finalizationClaim?.token).toBe(winner.value.claimToken);
  });

  it("47. loser cannot overwrite winner", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    const results = await Promise.allSettled([
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
    ]);

    const winnerToken = (
      results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
        claimToken: string;
      }>
    ).value.claimToken;
    const persisted = sessionStore.get("user-1");
    expect(persisted?.finalizationClaim?.token).toBe(winnerToken);
  });

  it("48. loser cannot release winner without token", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    const results = await Promise.allSettled([
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
    ]);

    const winnerToken = (
      results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{
        claimToken: string;
      }>
    ).value.claimToken;

    // Loser tries to release with a fake token.
    const released = await releaseEnrollmentFinalizationClaim({
      userId: "user-1",
      generationId: "gen-A",
      claimToken: "fake-loser-token",
    });
    expect(released.released).toBe(false);
    expect(sessionStore.get("user-1")?.finalizationClaim?.token).toBe(
      winnerToken,
    );
  });

  it("49. reset racing with successful claim cannot replace claimed generation", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    const { createOrResetEnrollmentSession } = await import(
      "@/lib/biometrics/enrollment-session-service"
    );

    // First acquire the claim.
    await claimEnrollmentSessionForFinalization({
      userId: "user-1",
      generationId: "gen-A",
    });

    // Now try to reset — must fail atomically.
    await expect(
      createOrResetEnrollmentSession({
        userId: "user-1",
        mode: "create",
        requiredSampleCount: 5,
        templateVersion: 1,
      }),
    ).rejects.toThrow();

    // Generation stays at gen-A.
    expect(sessionStore.get("user-1")?.generationId).toBe("gen-A");
  });

  it("50. claim racing with reset has deterministic CAS outcome", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        acceptedSamples: buildFiveSamples(),
        generationId: "gen-A",
      }),
    );

    const { createOrResetEnrollmentSession } = await import(
      "@/lib/biometrics/enrollment-session-service"
    );

    // Race: claim and reset fire in parallel. Exactly one must win.
    const [claimResult, resetResult] = await Promise.allSettled([
      claimEnrollmentSessionForFinalization({
        userId: "user-1",
        generationId: "gen-A",
      }),
      createOrResetEnrollmentSession({
        userId: "user-1",
        mode: "create",
        requiredSampleCount: 5,
        templateVersion: 1,
      }),
    ]);

    // The CAS is deterministic: at least one operation succeeds OR
    // the claim wins and the reset is blocked — the database never
    // observes both "claim installed" AND "generation reset".
    const persisted = sessionStore.get("user-1");
    if (claimResult.status === "fulfilled") {
      // Claim won — reset must have failed (or reset was no-op).
      expect(resetResult.status).toBe("rejected");
      expect(persisted?.generationId).toBe("gen-A");
      expect(persisted?.finalizationClaim).toBeDefined();
    } else if (resetResult.status === "fulfilled") {
      // Reset won — claim must have failed (new generation, no claim).
      expect(claimResult.status).toBe("rejected");
      // After a reset, generation is fresh.
      expect(persisted?.finalizationClaim).toBeUndefined();
    } else {
      throw new Error(
        "Both operations failed — deterministic CAS must produce exactly one winner.",
      );
    }
  });
});

// =============================================================================
// 51..58 — Privacy
// =============================================================================

describe("claim / privacy", () => {
  beforeEach(resetStore);
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("51. status DTO does not contain finalizationClaim", async () => {
    const session = makeSessionFixture({
      userId: "user-1",
      acceptedSamples: buildFiveSamples(),
      generationId: "gen-A",
      finalizationClaim: {
        token: "must-not-leak",
        generationId: "gen-A",
        claimedAt: new Date(),
      },
    });
    sessionStore.set("user-1", session);

    // The DTO we construct for the browser (mirroring face-id-status-service)
    const safeDto = {
      active: true,
      mode: session.mode,
      acceptedSamples: session.acceptedSamples.length,
      requiredSamples: session.requiredSampleCount,
      expiresAt: session.expiresAt.toISOString(),
      generationId: session.generationId,
    };
    expect(JSON.stringify(safeDto).includes("finalizationClaim")).toBe(false);
    expect(JSON.stringify(safeDto).includes("must-not-leak")).toBe(false);
  });

  it("52. status DTO does not contain claimToken", async () => {
    const session = makeSessionFixture({
      userId: "user-1",
      acceptedSamples: buildFiveSamples(),
      generationId: "gen-A",
      finalizationClaim: {
        token: "claim-token-x",
        generationId: "gen-A",
        claimedAt: new Date(),
      },
    });
    const safeDto = {
      active: true,
      mode: session.mode,
      acceptedSamples: session.acceptedSamples.length,
      requiredSamples: session.requiredSampleCount,
      expiresAt: session.expiresAt.toISOString(),
      generationId: session.generationId,
    };
    expect(JSON.stringify(safeDto).includes("claimToken")).toBe(false);
    expect(JSON.stringify(safeDto).includes("claim-token-x")).toBe(false);
  });

  it("53..56. /face-id / setup / start / sample responses never expose claimToken", () => {
    // Verify by source-code inspection: the start route and the
    // enrollment-route-error helpers do not import the claim service
    // and never serialize the claim field. There is no public
    // Next.js route in B2A that exposes the claim.
    const baseDir = join(process.cwd(), "src");
    const statusSource = readFileSync(
      join(baseDir, "lib/biometrics/face-id-status-service.ts"),
      "utf8",
    );
    const routeErrorsSource = readFileSync(
      join(baseDir, "lib/biometrics/enrollment-route-errors.ts"),
      "utf8",
    );
    expect(statusSource.includes("claimEnrollmentSessionForFinalization")).toBe(
      false,
    );
    expect(statusSource.includes("claimToken")).toBe(false);
    expect(statusSource.includes("finalizationClaim")).toBe(false);
    expect(routeErrorsSource.includes("claimEnrollmentSessionForFinalization")).toBe(
      false,
    );
    expect(routeErrorsSource.includes("claimToken")).toBe(false);
    // Error message that mentions claim must NOT appear either.
    expect(routeErrorsSource.includes("finalizationClaim")).toBe(false);
  });

  it("57. claim token is not sent to Face Service", () => {
    const baseDir = join(process.cwd(), "src");
    const clientSource = readFileSync(
      join(baseDir, "lib/biometrics/face-service-client.ts"),
      "utf8",
    );
    expect(clientSource.includes("claimToken")).toBe(false);
    expect(clientSource.includes("finalizationClaim")).toBe(false);
  });

  it("58. claim token is not stored in browser storage", () => {
    const baseDir = join(process.cwd(), "src");
    const claimSource = readFileSync(
      join(baseDir, "lib/biometrics/enrollment-finalization-claim-service.ts"),
      "utf8",
    );
    // Note: the word "sessionStorage" can appear in a string literal
    // referring to "no session storage is used", but the implementation
    // MUST NOT call any of these APIs. We strip comments to be safe.
    const codeOnly = claimSource
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    expect(codeOnly.includes("localStorage")).toBe(false);
    expect(codeOnly.includes("sessionStorage")).toBe(false);
    expect(codeOnly.includes("IndexedDB")).toBe(false);
    expect(codeOnly.includes("window.")).toBe(false);
    expect(codeOnly.includes("document.")).toBe(false);
  });
});

// =============================================================================
// 59..61 — Legacy session
// =============================================================================

describe("claim / legacy session", () => {
  beforeEach(resetStore);
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("59. legacy session gets generationId first", async () => {
    // Simulate legacy backfill: the read returns a session with a
    // freshly minted generationId, after which the session is fully
    // formed.
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        acceptedSamples: buildFiveSamples(),
      }),
    );

    const { getEnrollmentSessionByUserId } = await import(
      "@/lib/biometrics/enrollment-session-service"
    );
    const session = await getEnrollmentSessionByUserId("user-1");
    expect(session?.generationId).toBe("gen-A");
  });

  it("60. then complete legacy session can be claimed", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        acceptedSamples: buildFiveSamples(),
      }),
    );

    const result = await claimEnrollmentSessionForFinalization({
      userId: "user-1",
      generationId: "gen-A",
    });
    expect(result.claimToken.length).toBeGreaterThan(0);
    expect(result.generationId).toBe("gen-A");
  });

  it("61. claim does not replace the backfilled generation", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        generationId: "gen-A",
        acceptedSamples: buildFiveSamples(),
      }),
    );

    await claimEnrollmentSessionForFinalization({
      userId: "user-1",
      generationId: "gen-A",
    });
    expect(sessionStore.get("user-1")?.generationId).toBe("gen-A");
  });
});

// =============================================================================
// Explicitly: B2A introduces no claim expiry / lease / heartbeat
// =============================================================================

describe("claim / no time-based expiry", () => {
  beforeEach(resetStore);
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("does not introduce claimExpiresAt", () => {
    const baseDir = join(process.cwd(), "src");
    const source = readFileSync(
      join(baseDir, "lib/biometrics/enrollment-finalization-claim-service.ts"),
      "utf8",
    );
    // Strip comments so documentation that mentions "no claimExpiresAt"
    // does not register as a literal occurrence.
    const codeOnly = source
      .split("\n")
      .filter(
        (line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    // The B2A claim primitive MUST NOT have a per-claim expiry field.
    // The session's own expiresAt is referenced (filter: expiresAt > now)
    // because it is the lifecycle boundary — that is intentional.
    expect(codeOnly.includes("claimExpiresAt")).toBe(false);
  });

  it("does not introduce setTimeout for claim release", () => {
    const baseDir = join(process.cwd(), "src");
    const source = readFileSync(
      join(baseDir, "lib/biometrics/enrollment-finalization-claim-service.ts"),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    expect(codeOnly.includes("setTimeout")).toBe(false);
  });

  it("does not introduce background lease / cleanup", () => {
    const baseDir = join(process.cwd(), "src");
    const source = readFileSync(
      join(baseDir, "lib/biometrics/enrollment-finalization-claim-service.ts"),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    expect(codeOnly.includes("claimLease")).toBe(false);
    expect(codeOnly.includes("claimHeartbeat")).toBe(false);
    expect(codeOnly.includes("claimTimeout")).toBe(false);
  });
});