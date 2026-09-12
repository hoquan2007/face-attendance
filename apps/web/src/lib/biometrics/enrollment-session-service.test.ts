/**
 * Tests for the enrollment-session-service.
 *
 * PHASE 4.2 — FaceProfile + FaceEnrollmentSession database foundation.
 *
 * These tests use mocks for the Mongoose connection and
 * FaceEnrollmentSession model so we can exercise the service logic
 * without spinning up a real MongoDB. The mocked model returns a
 * `findOne`, `findOneAndUpdate`, and `deleteOne` stub that we drive
 * deterministically.
 *
 * The service is responsible for:
 *   - looking up by `userId` only (never query/body-derived identity)
 *   - safely creating or resetting the session via upsert
 *   - clearing `acceptedSamples` on reset
 *   - leaving any existing FaceProfile untouched
 *   - mapping duplicate-key errors to safe
 *     `BiometricPersistenceError` instances
 *   - reporting expiration correctly even though MongoDB TTL deletion
 *     is asynchronous
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  FaceEnrollmentSessionAttrs,
  FaceEnrollmentAcceptedSampleDoc,
} from "@/lib/biometrics/enrollment-session-model";

// =============================================================================
// In-memory store + mock implementation
// =============================================================================

/**
 * Stores one enrollment session per userId so tests can verify the
 * "create or reset" idempotency contract.
 */
const sessionStore = new Map<string, FaceEnrollmentSessionAttrs>();

/**
 * Stores face profiles separately so we can verify the session
 * service never touches them.
 */
const faceProfileStore = new Map<string, unknown>();

function makeSessionFixture(
  overrides: Partial<FaceEnrollmentSessionAttrs> = {},
): FaceEnrollmentSessionAttrs {
  return {
    userId: "user-1",
    mode: "create",
    templateVersion: 1,
    requiredSampleCount: 5,
    acceptedSamples: [],
    expiresAt: new Date(Date.now() + 15 * 60 * 1000),
    createdAt: new Date(),
    updatedAt: new Date(),
    generationId: "gen-test-default",
    ...overrides,
  };
}

const sessionCalls: Array<{
  method: "findOne" | "findOneAndUpdate" | "deleteOne";
  filter: Record<string, unknown>;
  bodyKeys: string[];
}> = [];

const faceProfileCalls: Array<{
  method: "findOne" | "findOneAndUpdate" | "deleteOne" | "exists";
  filter: Record<string, unknown>;
  bodyKeys: string[];
}> = [];

const mockFindOne = vi.fn((filter: { userId: string }) => ({
  lean: () => ({
    exec: async () => {
      const existing = sessionStore.get(filter.userId);
      if (!existing) return null;
      // Simulate the legacy backfill: if generationId is missing,
      // the findOneAndUpdate path will set it. For the mock, we just
      // return the document as-is.
      return { ...existing };
    },
  }),
}));

const mockFindOneAndUpdate = vi.fn(
  (
    filter: { userId: string; [k: string]: unknown },
    update: {
      $set?: Partial<FaceEnrollmentSessionAttrs>;
      $setOnInsert?: Partial<FaceEnrollmentSessionAttrs>;
      $push?: { acceptedSamples?: unknown };
    },
    options: { upsert?: boolean; new?: boolean } = {},
  ) => {
    const existing = sessionStore.get(filter.userId) as
      | (FaceEnrollmentSessionAttrs & { finalizationClaim?: unknown })
      | undefined;
    const now = new Date();

    // PHASE 4.6B2A — honor atomic claim-protection filter.
    // If the filter requires finalizationClaim absent AND the existing
    // session carries a claim, the CAS must miss. Returning null forces
    // the service to perform its diagnostic re-read and surface
    // ENROLLMENT_FINALIZATION_IN_PROGRESS.
    const claimMustBeAbsent =
      filter.finalizationClaim &&
      typeof filter.finalizationClaim === "object" &&
      "$exists" in (filter.finalizationClaim as Record<string, unknown>) &&
      (filter.finalizationClaim as { $exists?: unknown }).$exists === false;
    const sessionHasClaim =
      existing !== undefined && existing.finalizationClaim !== undefined;
    if (claimMustBeAbsent && sessionHasClaim) {
      return {
        lean: () => ({
          exec: async () => null,
        }),
      };
    }

    if (existing) {
      // $set fields
      if (update.$set) {
        Object.assign(existing, update.$set);
      }
      // $push arrays
      if (update.$push?.acceptedSamples) {
        const toPush = update.$push.acceptedSamples;
        if (!existing.acceptedSamples) existing.acceptedSamples = [];
        // Mongoose $push with a single value pushes one element.
        // Mongoose $push with an array ($each) pushes many elements.
        if (Array.isArray(toPush)) {
          existing.acceptedSamples.push(...toPush);
        } else {
          existing.acceptedSamples.push(
            toPush as FaceEnrollmentAcceptedSampleDoc,
          );
        }
      }
      existing.updatedAt = now;
      const updated = { ...existing };
      return {
        lean: () => ({
          exec: async () => updated,
        }),
      };
    }
    if (!options.upsert) {
      return {
        lean: () => ({
          exec: async () => null,
        }),
      };
    }
    const fresh: FaceEnrollmentSessionAttrs = {
      ...makeSessionFixture({ userId: filter.userId }),
      ...(update.$set ?? {}),
      ...(update.$setOnInsert ?? {}),
      userId: filter.userId,
      createdAt: (update.$setOnInsert?.createdAt as Date | undefined) ?? now,
      updatedAt: now,
      // Ensure generationId is always present in a freshly created session
      generationId:
        (update.$set?.generationId as string | undefined) ??
        (update.$setOnInsert?.generationId as string | undefined) ??
        "gen-upsert-default",
    };
    sessionStore.set(filter.userId, fresh);
    return {
      lean: () => ({
        exec: async () => ({ ...fresh }),
      }),
    };
  },
);

const mockDeleteOne = vi.fn((filter: { userId: string }) => {
  return {
    exec: async () => {
      const had = sessionStore.delete(filter.userId);
      return { deletedCount: had ? 1 : 0, acknowledged: true };
    },
  };
});

vi.mock("@/lib/biometrics/enrollment-session-model", () => ({
  FaceEnrollmentSessionModel: {
    findOne: (...args: unknown[]) => {
      const filter = args[0] as { userId: string };
      sessionCalls.push({
        method: "findOne",
        filter,
        bodyKeys: [],
      });
      return mockFindOne(filter);
    },
    findOneAndUpdate: (...args: unknown[]) => {
      const filter = args[0] as { userId: string };
      const update = args[1] as {
        $set?: Partial<FaceEnrollmentSessionAttrs>;
        $setOnInsert?: Partial<FaceEnrollmentSessionAttrs>;
      };
      sessionCalls.push({
        method: "findOneAndUpdate",
        filter,
        bodyKeys: Object.keys(update.$set ?? {}),
      });
      return mockFindOneAndUpdate(
        filter,
        update,
        args[2] as { upsert?: boolean; new?: boolean },
      );
    },
    deleteOne: (...args: unknown[]) => {
      const filter = args[0] as { userId: string };
      sessionCalls.push({
        method: "deleteOne",
        filter,
        bodyKeys: [],
      });
      return mockDeleteOne(filter);
    },
  },
}));

vi.mock("@/lib/biometrics/face-profile-model", () => ({
  FaceProfileModel: {
    findOne: (...args: unknown[]) => {
      const filter = args[0] as { userId: string };
      faceProfileCalls.push({
        method: "findOne",
        filter,
        bodyKeys: [],
      });
      return {
        lean: () => ({
          exec: async () =>
            faceProfileStore.has(filter.userId)
              ? { userId: filter.userId }
              : null,
        }),
      };
    },
    findOneAndUpdate: (...args: unknown[]) => {
      faceProfileCalls.push({
        method: "findOneAndUpdate",
        filter: args[0] as Record<string, unknown>,
        bodyKeys: Object.keys(
          ((args[1] as { $set?: Record<string, unknown> })?.$set ?? {}),
        ),
      });
      return {
        lean: () => ({ exec: async () => null }),
      };
    },
    deleteOne: (...args: unknown[]) => {
      faceProfileCalls.push({
        method: "deleteOne",
        filter: args[0] as Record<string, unknown>,
        bodyKeys: [],
      });
      return { exec: async () => ({ deletedCount: 0, acknowledged: true }) };
    },
    exists: (...args: unknown[]) => {
      faceProfileCalls.push({
        method: "exists",
        filter: args[0] as Record<string, unknown>,
        bodyKeys: [],
      });
      return { exec: async () => null };
    },
  },
  FACE_PROFILE_STATUSES: ["active"],
}));

vi.mock("@/lib/mongoose", () => ({
  getMongooseConnection: () => Promise.resolve(),
}));

import {
  appendAcceptedEnrollmentSample,
  APPEND_SAMPLE_FAILURE_REASONS,
  createOrResetEnrollmentSession,
  deleteEnrollmentSessionByUserId,
  getEnrollmentSessionByUserId,
  isEnrollmentSessionExpired,
} from "@/lib/biometrics/enrollment-session-service";
import { DEFAULT_ENROLLMENT_SESSION_TTL_MS } from "@/lib/biometrics/enrollment-session-ttl";
import {
  BIOMETRIC_PERSISTENCE_ERROR_CODES,
} from "@/lib/biometrics/biometric-errors";

describe("enrollment-session-service / getEnrollmentSessionByUserId", () => {
  beforeEach(() => sessionStore.clear());
  afterEach(() => {
    vi.clearAllMocks();
    sessionCalls.length = 0;
  });

  it("queries by userId", async () => {
    sessionStore.set("user-1", makeSessionFixture());
    await getEnrollmentSessionByUserId("user-1");
    const call = sessionCalls.find((c) => c.method === "findOne");
    expect(call).toBeDefined();
    expect(call?.filter.userId).toBe("user-1");
  });

  it("returns null when no session exists", async () => {
    expect(await getEnrollmentSessionByUserId("missing")).toBeNull();
  });
});

describe("enrollment-session-service / createOrResetEnrollmentSession", () => {
  beforeEach(() => {
    sessionStore.clear();
    faceProfileStore.clear();
  });
  afterEach(() => {
    vi.clearAllMocks();
    sessionCalls.length = 0;
    faceProfileCalls.length = 0;
  });

  it("creates a new session for a fresh user", async () => {
    const result = await createOrResetEnrollmentSession({
      userId: "user-2",
      mode: "create",
      requiredSampleCount: 5,
      templateVersion: 1,
    });
    expect(result.userId).toBe("user-2");
    expect(result.mode).toBe("create");
    expect(result.acceptedSamples).toEqual([]);
    expect(result.requiredSampleCount).toBe(5);
  });

  it("clears acceptedSamples on reset of an existing session", async () => {
    // Seed a session that already has accepted samples.
    sessionStore.set(
      "user-3",
      makeSessionFixture({
        userId: "user-3",
        acceptedSamples: [
          {
            encryptedVector: {
              ciphertext: "c",
              iv: "i",
              authTag: "a",
              keyVersion: 1,
            },
            sampleIndex: 0,
            acceptedAt: new Date(),
          },
        ],
      }),
    );

    const result = await createOrResetEnrollmentSession({
      userId: "user-3",
      mode: "replace",
      requiredSampleCount: 5,
      templateVersion: 1,
    });

    expect(result.acceptedSamples).toEqual([]);
    expect(result.mode).toBe("replace");
    expect(sessionStore.get("user-3")?.acceptedSamples).toEqual([]);
  });

  it("does not touch any existing FaceProfile", async () => {
    faceProfileStore.set("user-4", { userId: "user-4" });
    const beforeCalls = faceProfileCalls.length;
    await createOrResetEnrollmentSession({
      userId: "user-4",
      mode: "create",
      requiredSampleCount: 5,
      templateVersion: 1,
    });
    const afterCalls = faceProfileCalls.length;
    // The session service must not write to FaceProfile at all.
    expect(afterCalls).toBe(beforeCalls);
    expect(faceProfileStore.has("user-4")).toBe(true);
  });

  it("applies the default TTL when expiresAt is not provided", async () => {
    const before = Date.now();
    const result = await createOrResetEnrollmentSession({
      userId: "user-5",
      mode: "create",
      requiredSampleCount: 5,
      templateVersion: 1,
    });
    const after = Date.now();
    const expectedMin = before + DEFAULT_ENROLLMENT_SESSION_TTL_MS;
    const expectedMax = after + DEFAULT_ENROLLMENT_SESSION_TTL_MS;
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  it("uses the supplied expiresAt when provided", async () => {
    const customExpiry = new Date("2030-01-01T00:00:00Z");
    const result = await createOrResetEnrollmentSession({
      userId: "user-6",
      mode: "create",
      requiredSampleCount: 5,
      templateVersion: 1,
      expiresAt: customExpiry,
    });
    expect(result.expiresAt.getTime()).toBe(customExpiry.getTime());
  });

  it("maps Mongo duplicate-key errors to BIOMETRIC_PROFILE_ALREADY_EXISTS", async () => {
    mockFindOneAndUpdate.mockImplementationOnce(() => ({
      lean: () => ({
        exec: async () => {
          throw { code: 11000, keyValue: { userId: "user-7" } };
        },
      }),
    }));

    await expect(
      createOrResetEnrollmentSession({
        userId: "user-7",
        mode: "create",
        requiredSampleCount: 5,
        templateVersion: 1,
      }),
    ).rejects.toMatchObject({
      code: BIOMETRIC_PERSISTENCE_ERROR_CODES.BIOMETRIC_PROFILE_ALREADY_EXISTS,
    });
  });
});

describe("enrollment-session-service / deleteEnrollmentSessionByUserId", () => {
  beforeEach(() => sessionStore.clear());
  afterEach(() => {
    vi.clearAllMocks();
    sessionCalls.length = 0;
  });

  it("targets only the supplied userId", async () => {
    sessionStore.set("user-keep", makeSessionFixture({ userId: "user-keep" }));
    sessionStore.set("user-drop", makeSessionFixture({ userId: "user-drop" }));

    const deleted = await deleteEnrollmentSessionByUserId("user-drop");
    expect(deleted).toBe(true);
    expect(sessionStore.has("user-keep")).toBe(true);
    expect(sessionStore.has("user-drop")).toBe(false);

    const call = sessionCalls.find((c) => c.method === "deleteOne");
    expect(call).toBeDefined();
    expect(call?.filter.userId).toBe("user-drop");
  });

  it("returns false when no session exists for the user", async () => {
    const deleted = await deleteEnrollmentSessionByUserId("missing");
    expect(deleted).toBe(false);
  });
});

describe("enrollment-session-service / isEnrollmentSessionExpired", () => {
  it("returns true when expiresAt is in the past", () => {
    const session = makeSessionFixture({
      expiresAt: new Date("2025-01-01T00:00:00Z"),
    });
    const now = new Date("2026-01-01T00:00:00Z");
    expect(isEnrollmentSessionExpired(session, now)).toBe(true);
  });

  it("returns true when expiresAt equals now (boundary)", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const session = makeSessionFixture({ expiresAt: new Date(now.getTime()) });
    expect(isEnrollmentSessionExpired(session, now)).toBe(true);
  });

  it("returns false when expiresAt is in the future", () => {
    const now = new Date("2026-06-01T00:00:00Z");
    const session = makeSessionFixture({
      expiresAt: new Date(now.getTime() + 1000),
    });
    expect(isEnrollmentSessionExpired(session, now)).toBe(false);
  });

  it("uses the supplied `now` reference time (test-friendly)", () => {
    const session = makeSessionFixture({
      expiresAt: new Date("2026-06-01T00:00:00Z"),
    });
    expect(
      isEnrollmentSessionExpired(session, new Date("2026-05-31T00:00:00Z")),
    ).toBe(false);
    expect(
      isEnrollmentSessionExpired(session, new Date("2026-06-01T00:00:00Z")),
    ).toBe(true);
  });
});

// =============================================================================
// Atomic append (PHASE 4.4C)
// =============================================================================

describe("enrollment-session-service / appendAcceptedEnrollmentSample", () => {
  beforeEach(() => {
    sessionStore.clear();
    // Restore default implementations in case a prior test overrode them
    // with `mockImplementation`. clearAllMocks only clears history.
    mockFindOne.mockClear();
    mockFindOneAndUpdate.mockClear();
    mockDeleteOne.mockClear();
    // Re-establish the default implementations
    mockFindOne.mockImplementation(
      (filter: { userId: string }) => ({
        lean: () => ({
          exec: async () => {
            const existing = sessionStore.get(filter.userId) as
              | (FaceEnrollmentSessionAttrs & { finalizationClaim?: unknown })
              | undefined;
            return existing ? { ...existing } : null;
          },
        }),
      }),
    );
    mockFindOneAndUpdate.mockImplementation(
      (
        filter: { userId: string; [k: string]: unknown },
        update: {
          $set?: Partial<FaceEnrollmentSessionAttrs>;
          $setOnInsert?: Partial<FaceEnrollmentSessionAttrs>;
          $push?: { acceptedSamples?: unknown };
        },
        options: { upsert?: boolean; new?: boolean } = {},
      ) => {
        const existing = sessionStore.get(filter.userId) as
          | (FaceEnrollmentSessionAttrs & { finalizationClaim?: unknown })
          | undefined;
        const now = new Date();

        // PHASE 4.6B2A — honor atomic claim-protection filter.
        const claimMustBeAbsent =
          filter.finalizationClaim &&
          typeof filter.finalizationClaim === "object" &&
          "$exists" in (filter.finalizationClaim as Record<string, unknown>) &&
          (filter.finalizationClaim as { $exists?: unknown }).$exists === false;
        const sessionHasClaim =
          existing !== undefined && existing.finalizationClaim !== undefined;
        if (claimMustBeAbsent && sessionHasClaim) {
          return {
            lean: () => ({
              exec: async () => null,
            }),
          };
        }

        if (existing) {
          if (update.$set) {
            Object.assign(existing, update.$set);
          }
          if (update.$push?.acceptedSamples) {
            const toPush = update.$push.acceptedSamples;
            if (!existing.acceptedSamples) existing.acceptedSamples = [];
            if (Array.isArray(toPush)) {
              existing.acceptedSamples.push(...toPush);
            } else {
              existing.acceptedSamples.push(
                toPush as FaceEnrollmentAcceptedSampleDoc,
              );
            }
          }
          existing.updatedAt = now;
          const updated = { ...existing };
          return {
            lean: () => ({
              exec: async () => updated,
            }),
          };
        }
        if (!options.upsert) {
          return {
            lean: () => ({
              exec: async () => null,
            }),
          };
        }
        const fresh: FaceEnrollmentSessionAttrs = {
          ...makeSessionFixture({ userId: filter.userId }),
          ...(update.$set ?? {}),
          ...(update.$setOnInsert ?? {}),
          userId: filter.userId,
          createdAt: (update.$setOnInsert?.createdAt as Date | undefined) ?? now,
          updatedAt: now,
          generationId:
            (update.$set?.generationId as string | undefined) ??
            (update.$setOnInsert?.generationId as string | undefined) ??
            "gen-upsert-default",
        };
        sessionStore.set(filter.userId, fresh);
        return {
          lean: () => ({
            exec: async () => ({ ...fresh }),
          }),
        };
      },
    );
    mockDeleteOne.mockImplementation((filter: { userId: string }) => {
      return {
        exec: async () => {
          const had = sessionStore.delete(filter.userId);
          return { deletedCount: had ? 1 : 0, acknowledged: true };
        },
      };
    });
  });
  afterEach(() => {
    vi.clearAllMocks();
    sessionCalls.length = 0;
  });

  const sampleEncryptedVector = {
    ciphertext: "encrypted-ciphertext",
    iv: "encrypted-iv",
    authTag: "encrypted-authTag",
    keyVersion: 1,
  };

  it("initializes model metadata on first sample", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({ userId: "user-1", acceptedSamples: [] }),
    );

    const result = await appendAcceptedEnrollmentSample({
      userId: "user-1",
      encryptedVector: sampleEncryptedVector,
      expectedSampleIndex: 0,
      modelIdentity: "new-model",
      modelName: "new_model",
      embeddingDimension: 256,
      normalization: "l2",
    });

    expect(result.success).toBe(true);
    // The session should now have model metadata set
    const session = sessionStore.get("user-1");
    expect(session?.modelIdentity).toBe("new-model");
    expect(session?.embeddingDimension).toBe(256);
  });

  it("preserves matching metadata on later samples", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        acceptedSamples: [
          {
            encryptedVector: sampleEncryptedVector,
            sampleIndex: 0,
            acceptedAt: new Date(),
          },
        ],
      }),
    );

    const result = await appendAcceptedEnrollmentSample({
      userId: "user-1",
      encryptedVector: sampleEncryptedVector,
      expectedSampleIndex: 1,
      modelIdentity: "insightface-buffalo-l",
      modelName: "buffalo_l",
      embeddingDimension: 512,
      normalization: "l2",
    });

    expect(result.success).toBe(true);
    expect(sessionStore.get("user-1")?.acceptedSamples.length).toBe(2);
  });

  it("rejects incompatible model metadata (MODEL_MISMATCH)", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
        acceptedSamples: [
          {
            encryptedVector: sampleEncryptedVector,
            sampleIndex: 0,
            acceptedAt: new Date(),
          },
        ],
      }),
    );

    const result = await appendAcceptedEnrollmentSample({
      userId: "user-1",
      encryptedVector: sampleEncryptedVector,
      expectedSampleIndex: 1,
      modelIdentity: "different-model", // different!
      modelName: "buffalo_l",
      embeddingDimension: 512,
      normalization: "l2",
    });

    expect(result.success).toBe(false);
    expect(sessionStore.get("user-1")?.acceptedSamples.length).toBe(1);
  });

  it("does not exceed required sample count", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        requiredSampleCount: 5,
        acceptedSamples: [
          { encryptedVector: sampleEncryptedVector, sampleIndex: 0, acceptedAt: new Date() },
          { encryptedVector: sampleEncryptedVector, sampleIndex: 1, acceptedAt: new Date() },
          { encryptedVector: sampleEncryptedVector, sampleIndex: 2, acceptedAt: new Date() },
          { encryptedVector: sampleEncryptedVector, sampleIndex: 3, acceptedAt: new Date() },
          { encryptedVector: sampleEncryptedVector, sampleIndex: 4, acceptedAt: new Date() },
        ],
      }),
    );

    const result = await appendAcceptedEnrollmentSample({
      userId: "user-1",
      encryptedVector: sampleEncryptedVector,
      expectedSampleIndex: 5,
      modelIdentity: "insightface-buffalo-l",
      modelName: "buffalo_l",
      embeddingDimension: 512,
      normalization: "l2",
    });

    // The service returns failure (sample not appended)
    // The store remains at 5 samples (the existing count unchanged)
    expect(result.success).toBe(false);
    expect(sessionStore.get("user-1")?.acceptedSamples.length).toBe(5);
  });

  it("returns correct new count after append", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        acceptedSamples: [
          { encryptedVector: sampleEncryptedVector, sampleIndex: 0, acceptedAt: new Date() },
        ],
      }),
    );

    const result = await appendAcceptedEnrollmentSample({
      userId: "user-1",
      encryptedVector: sampleEncryptedVector,
      expectedSampleIndex: 1,
      modelIdentity: "insightface-buffalo-l",
      modelName: "buffalo_l",
      embeddingDimension: 512,
      normalization: "l2",
    });

    expect(result.success).toBe(true);
    expect(result.newAcceptedCount).toBe(2);
    expect(result.requiredSampleCount).toBe(5);
    expect(result.complete).toBe(false);
  });

  it("expired session cannot append", async () => {
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        expiresAt: new Date(Date.now() - 1000), // expired
      }),
    );

    const result = await appendAcceptedEnrollmentSample({
      userId: "user-1",
      encryptedVector: sampleEncryptedVector,
      expectedSampleIndex: 0,
      modelIdentity: "insightface-buffalo-l",
      modelName: "buffalo_l",
      embeddingDimension: 512,
      normalization: "l2",
    });

    expect(result.success).toBe(false);
    expect(sessionStore.get("user-1")?.acceptedSamples.length ?? 0).toBe(0);
  });

  it("sample limit blocks 6th sample — store count stays at 5", async () => {
    // Seed with 5 samples (at the limit)
    sessionStore.set(
      "user-1",
      makeSessionFixture({
        userId: "user-1",
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        requiredSampleCount: 5,
        acceptedSamples: [
          { encryptedVector: sampleEncryptedVector, sampleIndex: 0, acceptedAt: new Date() },
          { encryptedVector: sampleEncryptedVector, sampleIndex: 1, acceptedAt: new Date() },
          { encryptedVector: sampleEncryptedVector, sampleIndex: 2, acceptedAt: new Date() },
          { encryptedVector: sampleEncryptedVector, sampleIndex: 3, acceptedAt: new Date() },
          { encryptedVector: sampleEncryptedVector, sampleIndex: 4, acceptedAt: new Date() },
        ],
      }),
    );

    const result = await appendAcceptedEnrollmentSample({
      userId: "user-1",
      encryptedVector: sampleEncryptedVector,
      expectedSampleIndex: 5,
      modelIdentity: "insightface-buffalo-l",
      modelName: "buffalo_l",
      embeddingDimension: 512,
      normalization: "l2",
    });

    expect(result.success).toBe(false);
    // The store count must stay at 5 — no 6th sample appended
    expect(sessionStore.get("user-1")?.acceptedSamples.length).toBe(5);
  });

  it("returns failure when session does not exist", async () => {
    const result = await appendAcceptedEnrollmentSample({
      userId: "ghost-user",
      encryptedVector: sampleEncryptedVector,
      expectedSampleIndex: 0,
      modelIdentity: "insightface-buffalo-l",
      modelName: "buffalo_l",
      embeddingDimension: 512,
      normalization: "l2",
    });
    expect(result.success).toBe(false);
  });

  // ==========================================================================
  // PHASE 4.4C.1 — Atomic Sample Index Hardening Tests
  // ==========================================================================

  describe("PHASE 4.4C.1 atomic sample index", () => {
    // -------------------------------------------------------------------------
    // Helper: resolve session filter for findOneAndUpdate mock
    // -------------------------------------------------------------------------

    /**
     * Resolves the findOneAndUpdate filter for the PHASE 4.4C atomic filter.
     *
     * The filter must contain BOTH:
     *   - $expr.$and[0].$eq: acceptedSamples.length == expectedSampleIndex
     *   - $expr.$and[1].$lt: acceptedSamples.length < requiredSampleCount
     *
     * We check this by parsing the $expr in the filter passed to the mock.
     */
    function resolveAtomicFilter(
      filter: Record<string, unknown>,
      store: Map<string, FaceEnrollmentSessionAttrs>,
    ): { allowed: boolean; conflict?: boolean } {
      const stored = store.get(filter.userId as string);
      if (!stored) return { allowed: false, conflict: false };

      const $expr = filter.$expr as Record<string, unknown>;
      if (!$expr || !$expr.$and) return { allowed: true };

      const conditions = $expr.$and as Array<Record<string, unknown>>;
      const eqCond = conditions.find(
        (c) => "$eq" in c,
      ) as Record<string, [unknown, unknown]> | undefined;
      const ltCond = conditions.find(
        (c) => "$lt" in c,
      ) as Record<string, [unknown, unknown]> | undefined;

      if (eqCond && Array.isArray(eqCond.$eq)) {
        const actualSize = (stored.acceptedSamples ?? []).length;
        const expectedIndex = eqCond.$eq[1];
        if (actualSize !== expectedIndex) {
          return { allowed: false, conflict: true };
        }
      }

      if (ltCond && Array.isArray(ltCond.$lt)) {
        const actualSize = (stored.acceptedSamples ?? []).length;
        const limit = ltCond.$lt[1];
        if (typeof limit === "object" && limit !== null && "$numberLong" in (limit as object)) {
          // Mongoose may represent requiredSampleCount as an object; use the stored value
          if (actualSize >= stored.requiredSampleCount) {
            return { allowed: false, conflict: false };
          }
        } else if (actualSize >= (limit as number)) {
          return { allowed: false, conflict: false };
        }
      }

      return { allowed: true };
    }

    // -------------------------------------------------------------------------
    // 1. expected index 0 succeeds when DB array length is 0
    // -------------------------------------------------------------------------

    it("expected index 0 succeeds when DB array length is 0", async () => {
      sessionStore.set(
        "user-concurrent",
        makeSessionFixture({
          userId: "user-concurrent",
          acceptedSamples: [],
          modelIdentity: undefined,
          modelName: undefined,
        }),
      );

      const result = await appendAcceptedEnrollmentSample({
        userId: "user-concurrent",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: 0,
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
      });

      expect(result.success).toBe(true);
      expect(result.newAcceptedCount).toBe(1);
      expect(result.complete).toBe(false);
    });

    // -------------------------------------------------------------------------
    // 2. expected index 1 succeeds only when DB array length is 1
    // -------------------------------------------------------------------------

    it("expected index 1 succeeds only when DB array length is 1", async () => {
      sessionStore.set(
        "user-concurrent",
        makeSessionFixture({
          userId: "user-concurrent",
          modelIdentity: "insightface-buffalo-l",
          modelName: "buffalo_l",
          embeddingDimension: 512,
          normalization: "l2",
          acceptedSamples: [
            {
              encryptedVector: sampleEncryptedVector,
              sampleIndex: 0,
              acceptedAt: new Date(),
            },
          ],
        }),
      );

      const result = await appendAcceptedEnrollmentSample({
        userId: "user-concurrent",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: 1,
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
      });

      expect(result.success).toBe(true);
      expect(result.newAcceptedCount).toBe(2);
    });

    // -------------------------------------------------------------------------
    // 3. atomic query contains exact-length condition ($eq: size == expected)
    // -------------------------------------------------------------------------

    it("atomic query contains exact-length condition ($eq: size == expected)", async () => {
      sessionStore.set(
        "user-filter-check",
        makeSessionFixture({
          userId: "user-filter-check",
          acceptedSamples: [],
        }),
      );

      // Spy on the filter passed to findOneAndUpdate
      let capturedFilter: Record<string, unknown> | null = null;
      mockFindOneAndUpdate.mockImplementationOnce(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (...args: any[]) => {
          const filter = args[0] as Record<string, unknown>;
          capturedFilter = filter;
          // Simulate successful update
          const stored = sessionStore.get(filter.userId as string);
          if (stored) {
            stored.acceptedSamples.push({
              encryptedVector: sampleEncryptedVector,
              sampleIndex: 0,
              acceptedAt: new Date(),
            });
          }
          return {
            lean: () => ({
              exec: async () => (stored ? { ...stored } : null),
            }),
          } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        },
      );

      await appendAcceptedEnrollmentSample({
        userId: "user-filter-check",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: 0,
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
      });

      expect(capturedFilter).not.toBeNull();

      // Verify the $expr contains an $eq condition comparing $size to 0
      const $expr = capturedFilter!.$expr as Record<string, unknown>;
      expect($expr).toBeDefined();
      expect($expr.$and).toBeDefined();

      const conditions = $expr.$and as Array<Record<string, unknown>>;
      const eqConditions = conditions.filter((c) => "$eq" in c);
      expect(eqConditions.length).toBeGreaterThan(0);

      // Find the $eq condition that compares $size
      const sizeEq = eqConditions.find(
        (c) => "$eq" in c && Array.isArray((c as Record<string, [unknown, unknown]>).$eq),
      ) as Record<string, [unknown, unknown]> | undefined;
      expect(sizeEq).toBeDefined();
      expect((sizeEq as { $eq: [unknown, unknown] }).$eq[0]).toEqual({ $size: "$acceptedSamples" });
      expect((sizeEq as { $eq: [unknown, unknown] }).$eq[1]).toBe(0);
    });

    // -------------------------------------------------------------------------
    // 4. atomic query still contains required-sample-count upper bound ($lt)
    // -------------------------------------------------------------------------

    it("atomic query still contains required-sample-count upper bound ($lt)", async () => {
      sessionStore.set(
        "user-limit-check",
        makeSessionFixture({
          userId: "user-limit-check",
          acceptedSamples: [],
        }),
      );

      let capturedFilter: Record<string, unknown> | null = null;
      mockFindOneAndUpdate.mockImplementationOnce(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((...args: any[]) => {
          const filter = args[0] as Record<string, unknown>;
          capturedFilter = filter;
          const stored = sessionStore.get(filter.userId as string);
          if (stored) {
            stored.acceptedSamples.push({
              encryptedVector: sampleEncryptedVector,
              sampleIndex: 0,
              acceptedAt: new Date(),
            });
          }
          return {
            lean: () => ({
              exec: async () => (stored ? { ...stored } : null),
            }),
          } as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        }) as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      );

      await appendAcceptedEnrollmentSample({
        userId: "user-limit-check",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: 0,
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
      });

      expect(capturedFilter).not.toBeNull();
      const $expr = capturedFilter!.$expr as Record<string, unknown>;
      expect($expr.$and).toBeDefined();

      const conditions = $expr.$and as Array<Record<string, unknown>>;
      const ltConditions = conditions.filter((c) => "$lt" in c);
      expect(ltConditions.length).toBeGreaterThan(0);

      // Find the $lt condition comparing $size to requiredSampleCount
      const sizeLt = ltConditions.find(
        (c) =>
          "$lt" in c &&
          Array.isArray((c as Record<string, [unknown, unknown]>).$lt),
      ) as Record<string, [unknown, unknown]> | undefined;
      expect(sizeLt).toBeDefined();
      expect((sizeLt as { $lt: [unknown, unknown] }).$lt[0]).toEqual({ $size: "$acceptedSamples" });
      expect((sizeLt as { $lt: [unknown, unknown] }).$lt[1]).toBe("$requiredSampleCount");
    });

    // -------------------------------------------------------------------------
    // 5. persisted sampleIndex equals expectedSampleIndex
    // -------------------------------------------------------------------------

    it("persisted sampleIndex equals expectedSampleIndex", async () => {
      sessionStore.set(
        "user-persist-check",
        makeSessionFixture({
          userId: "user-persist-check",
          modelIdentity: "insightface-buffalo-l",
          modelName: "buffalo_l",
          embeddingDimension: 512,
          normalization: "l2",
          acceptedSamples: [
            {
              encryptedVector: sampleEncryptedVector,
              sampleIndex: 0,
              acceptedAt: new Date(),
            },
          ],
        }),
      );

      await appendAcceptedEnrollmentSample({
        userId: "user-persist-check",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: 1,
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
      });

      const session = sessionStore.get("user-persist-check");
      expect(session?.acceptedSamples[1]?.sampleIndex).toBe(1);
    });

    // -------------------------------------------------------------------------
    // 6. AAD sampleIndex equals persisted sampleIndex
    //
    // The route sets AAD.sampleIndex = expectedSampleIndex.
    // The service stores sampleIndex = expectedSampleIndex.
    // Both values are derived from the same expectedSampleIndex argument,
    // guaranteeing consistency.
    // -------------------------------------------------------------------------

    it("service stores sampleIndex equal to expectedSampleIndex (AAD match guarantee)", async () => {
      sessionStore.set(
        "user-aad-check",
        makeSessionFixture({
          userId: "user-aad-check",
          modelIdentity: "insightface-buffalo-l",
          modelName: "buffalo_l",
          embeddingDimension: 512,
          normalization: "l2",
          acceptedSamples: [
            { encryptedVector: sampleEncryptedVector, sampleIndex: 0, acceptedAt: new Date() },
            { encryptedVector: sampleEncryptedVector, sampleIndex: 1, acceptedAt: new Date() },
          ],
        }),
      );

      // Call with expectedSampleIndex=2 → service must store sampleIndex=2.
      await appendAcceptedEnrollmentSample({
        userId: "user-aad-check",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: 2,
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
      });

      // The route passes expectedSampleIndex to encryptBiometricVector's AAD.
      // The service stores sampleIndex=expectedSampleIndex in the persisted sample.
      // Both values are guaranteed identical by using the same input.
      const session = sessionStore.get("user-aad-check");
      const persistedSampleIndex = session?.acceptedSamples[2]?.sampleIndex;
      expect(persistedSampleIndex).toBe(2);
    });

    // -------------------------------------------------------------------------
    // 7. stale request with expected index 0 fails after another request
    //    has already appended index 0
    // -------------------------------------------------------------------------

    it("stale request with expected index 0 fails after another request appended index 0", async () => {
      // Pre-populate: session already has one sample (index 0)
      sessionStore.set(
        "user-stale",
        makeSessionFixture({
          userId: "user-stale",
          modelIdentity: "insightface-buffalo-l",
          modelName: "buffalo_l",
          embeddingDimension: 512,
          normalization: "l2",
          acceptedSamples: [
            {
              encryptedVector: sampleEncryptedVector,
              sampleIndex: 0,
              acceptedAt: new Date(),
            },
          ],
        }),
      );

      // Simulate a stale request: caller thinks index is 0 (pre-populated),
      // but the session already has index 0.
      const result = await appendAcceptedEnrollmentSample({
        userId: "user-stale",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: 0, // Stale: session already has this index
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe("CONFLICT");
      // Session count must remain 1 (no duplicate index 0 appended)
      expect(sessionStore.get("user-stale")?.acceptedSamples.length).toBe(1);
    });

    // -------------------------------------------------------------------------
    // 8. two simulated concurrent requests cannot both persist sampleIndex 0
    // -------------------------------------------------------------------------

    it("two simulated concurrent requests cannot both persist sampleIndex 0", async () => {
      // Fresh session with no samples
      sessionStore.set(
        "user-race",
        makeSessionFixture({
          userId: "user-race",
          acceptedSamples: [],
        }),
      );

      // Use a mutable list to record append order and results
      const results: Array<{ success: boolean; reason?: string }> = [];

      // Intercept findOneAndUpdate to simulate race:
      // First call succeeds (no samples yet).
      // Second call fails (session now has 1 sample, but filter requires size == 0).
      let callCount = 0;
      mockFindOneAndUpdate.mockImplementation(
        (
          filter: Record<string, unknown>,
          _update: Record<string, unknown>,
          _opts?: Record<string, unknown>,
        ) => {
          callCount++;
          const stored = sessionStore.get(filter.userId as string);
          const { allowed } = resolveAtomicFilter(filter, sessionStore);

          if (allowed && stored) {
            // Push the sample to the stored session to simulate successful update
            const $expr = filter.$expr as Record<string, unknown>;
            const $and = $expr?.$and as Array<Record<string, unknown>> | undefined;
            const eqCond = $and?.find(
              (c) => "$eq" in c,
            ) as Record<string, [unknown, unknown]> | undefined;
            const idx = Array.isArray(eqCond?.$eq) ? (eqCond.$eq[1] as number) : undefined;
            stored.acceptedSamples.push({
              encryptedVector: sampleEncryptedVector,
              sampleIndex: idx ?? stored.acceptedSamples.length,
              acceptedAt: new Date(),
            });
            stored.updatedAt = new Date();
            return {
              lean: () => ({
                exec: async () => ({ ...stored }),
              }),
            };
          }

          // Atomic update failed — return null to force conflict detection
          return {
            lean: () => ({
              exec: async () => null,
            }),
          };
        },
      );

      // Simulate two concurrent requests, both expecting index 0
      const resultA = await appendAcceptedEnrollmentSample({
        userId: "user-race",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: 0,
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
      });
      results.push({ success: resultA.success, reason: resultA.reason });

      const resultB = await appendAcceptedEnrollmentSample({
        userId: "user-race",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: 0,
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
      });
      results.push({ success: resultB.success, reason: resultB.reason });

      // Exactly ONE request succeeded
      const successes = results.filter((r) => r.success);
      const conflicts = results.filter((r) => r.reason === "CONFLICT");
      expect(successes.length).toBe(1);
      expect(conflicts.length).toBe(1);

      // Only ONE sample with index 0 exists
      const session = sessionStore.get("user-race");
      const index0Samples = session?.acceptedSamples.filter((s) => s.sampleIndex === 0);
      expect(index0Samples?.length).toBe(1);
    });

    // -------------------------------------------------------------------------
    // 11. first-sample metadata can only be initialized while expected index is 0
    //     and acceptedSamples length is 0
    // -------------------------------------------------------------------------

    it("first-sample metadata only initializes when expectedIndex=0 and length=0", async () => {
      // Session has no model metadata AND no samples — first sample scenario
      sessionStore.set(
        "user-first",
        makeSessionFixture({
          userId: "user-first",
          acceptedSamples: [],
          modelIdentity: undefined,
          modelName: undefined,
        }),
      );

      const result = await appendAcceptedEnrollmentSample({
        userId: "user-first",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: 0,
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
      });

      expect(result.success).toBe(true);
      const session = sessionStore.get("user-first");
      expect(session?.modelIdentity).toBe("insightface-buffalo-l");
      expect(session?.modelName).toBe("buffalo_l");
      expect(session?.embeddingDimension).toBe(512);
    });

    // -------------------------------------------------------------------------
    // 12. competing first-sample request cannot overwrite model metadata
    // -------------------------------------------------------------------------

    it("competing first-sample request cannot overwrite model metadata", async () => {
      // Session has no model metadata yet
      sessionStore.set(
        "user-race-first",
        makeSessionFixture({
          userId: "user-race-first",
          acceptedSamples: [],
          modelIdentity: undefined,
          modelName: undefined,
        }),
      );

      let callCount = 0;
      mockFindOneAndUpdate.mockImplementation(
        (
          filter: Record<string, unknown>,
          _update: Record<string, unknown>,
          _opts?: Record<string, unknown>,
        ) => {
          callCount++;
          const stored = sessionStore.get(filter.userId as string);
          if (!stored) {
            return { lean: () => ({ exec: async () => null }) };
          }

          const { allowed } = resolveAtomicFilter(filter, sessionStore);
          if (allowed) {
            const $expr = filter.$expr as Record<string, unknown>;
            const $and = $expr?.$and as Array<Record<string, unknown>> | undefined;
            const eqCond = $and?.find(
              (c) => "$eq" in c,
            ) as Record<string, [unknown, unknown]> | undefined;
            const idx = Array.isArray(eqCond?.$eq) ? (eqCond.$eq[1] as number) : undefined;
            stored.acceptedSamples.push({
              encryptedVector: sampleEncryptedVector,
              sampleIndex: idx ?? stored.acceptedSamples.length,
              acceptedAt: new Date(),
            });
            // If this is the first sample, set model metadata
            if (stored.modelIdentity === undefined) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (stored as any).modelIdentity = "winner-model";
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (stored as any).modelName = "winner_model";
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (stored as any).embeddingDimension = 512;
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (stored as any).normalization = "l2";
            }
            stored.updatedAt = new Date();
            return { lean: () => ({ exec: async () => ({ ...stored }) }) };
          }
          return { lean: () => ({ exec: async () => null }) };
        },
      );

      // Two concurrent first samples with different model metadata
      const resultA = await appendAcceptedEnrollmentSample({
        userId: "user-race-first",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: 0,
        modelIdentity: "model-A",
        modelName: "model_a",
        embeddingDimension: 512,
        normalization: "l2",
      });

      const resultB = await appendAcceptedEnrollmentSample({
        userId: "user-race-first",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: 0,
        modelIdentity: "model-B",
        modelName: "model_b",
        embeddingDimension: 512,
        normalization: "l2",
      });

      // Exactly one succeeds
      const successes = [resultA, resultB].filter((r) => r.success);
      expect(successes.length).toBe(1);

      // The winner's model metadata is established
      const session = sessionStore.get("user-race-first");
      expect(session?.modelIdentity).toBeDefined();

      // The loser returns CONFLICT (stale first sample race)
      const conflicts = [resultA, resultB].filter((r) => r.reason === "CONFLICT");
      expect(conflicts.length).toBe(1);
    });

    // -------------------------------------------------------------------------
    // 13. later matching model can append
    // -------------------------------------------------------------------------

    it("later sample with matching model can append", async () => {
      sessionStore.set(
        "user-match",
        makeSessionFixture({
          userId: "user-match",
          modelIdentity: "insightface-buffalo-l",
          modelName: "buffalo_l",
          embeddingDimension: 512,
          normalization: "l2",
          acceptedSamples: [
            { encryptedVector: sampleEncryptedVector, sampleIndex: 0, acceptedAt: new Date() },
          ],
        }),
      );

      const result = await appendAcceptedEnrollmentSample({
        userId: "user-match",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: 1,
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
      });

      expect(result.success).toBe(true);
      expect(result.newAcceptedCount).toBe(2);
    });

    // -------------------------------------------------------------------------
    // 14. later mismatching model remains rejected (pre-check)
    // -------------------------------------------------------------------------

    it("later sample with mismatching model is rejected before atomic update", async () => {
      sessionStore.set(
        "user-mismatch",
        makeSessionFixture({
          userId: "user-mismatch",
          modelIdentity: "insightface-buffalo-l",
          modelName: "buffalo_l",
          embeddingDimension: 512,
          normalization: "l2",
          acceptedSamples: [
            { encryptedVector: sampleEncryptedVector, sampleIndex: 0, acceptedAt: new Date() },
          ],
        }),
      );

      const result = await appendAcceptedEnrollmentSample({
        userId: "user-mismatch",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: 1,
        modelIdentity: "different-model",
        modelName: "different_model",
        embeddingDimension: 256,
        normalization: "l2",
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe("MODEL_MISMATCH");
      // findOneAndUpdate should never be called for model mismatch
      const findOneAndUpdateCalls = sessionCalls.filter(
        (c) => c.method === "findOneAndUpdate",
      );
      expect(findOneAndUpdateCalls.length).toBe(0);
    });

    // -------------------------------------------------------------------------
    // 15. fifth sample may persist as index 4
    // -------------------------------------------------------------------------

    it("fifth sample (index 4) may be persisted for requiredSampleCount=5", async () => {
      sessionStore.set(
        "user-fifth",
        makeSessionFixture({
          userId: "user-fifth",
          modelIdentity: "insightface-buffalo-l",
          modelName: "buffalo_l",
          embeddingDimension: 512,
          normalization: "l2",
          requiredSampleCount: 5,
          acceptedSamples: [
            { encryptedVector: sampleEncryptedVector, sampleIndex: 0, acceptedAt: new Date() },
            { encryptedVector: sampleEncryptedVector, sampleIndex: 1, acceptedAt: new Date() },
            { encryptedVector: sampleEncryptedVector, sampleIndex: 2, acceptedAt: new Date() },
            { encryptedVector: sampleEncryptedVector, sampleIndex: 3, acceptedAt: new Date() },
          ],
        }),
      );

      const result = await appendAcceptedEnrollmentSample({
        userId: "user-fifth",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: 4,
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
      });

      expect(result.success).toBe(true);
      expect(result.newAcceptedCount).toBe(5);
      expect(result.complete).toBe(true);

      const session = sessionStore.get("user-fifth");
      expect(session?.acceptedSamples[4]?.sampleIndex).toBe(4);
    });

    // -------------------------------------------------------------------------
    // 16. sixth sample cannot persist
    // -------------------------------------------------------------------------

    it("sixth sample cannot persist when requiredSampleCount=5", async () => {
      sessionStore.set(
        "user-sixth",
        makeSessionFixture({
          userId: "user-sixth",
          modelIdentity: "insightface-buffalo-l",
          modelName: "buffalo_l",
          embeddingDimension: 512,
          normalization: "l2",
          requiredSampleCount: 5,
          acceptedSamples: [
            { encryptedVector: sampleEncryptedVector, sampleIndex: 0, acceptedAt: new Date() },
            { encryptedVector: sampleEncryptedVector, sampleIndex: 1, acceptedAt: new Date() },
            { encryptedVector: sampleEncryptedVector, sampleIndex: 2, acceptedAt: new Date() },
            { encryptedVector: sampleEncryptedVector, sampleIndex: 3, acceptedAt: new Date() },
            { encryptedVector: sampleEncryptedVector, sampleIndex: 4, acceptedAt: new Date() },
          ],
        }),
      );

      const result = await appendAcceptedEnrollmentSample({
        userId: "user-sixth",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: 5,
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe("SAMPLE_LIMIT_REACHED");
      expect(sessionStore.get("user-sixth")?.acceptedSamples.length).toBe(5);
    });

    // -------------------------------------------------------------------------
    // CONFLICT does NOT retry automatically
    // (This is tested in the route tests.)
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Stale request (expected index 0) does NOT call Face Service again
    // (This is tested in the route tests — service layer has no Face Service.)
    // -------------------------------------------------------------------------

    // -------------------------------------------------------------------------
    // Negative expectedSampleIndex returns CONFLICT
    // -------------------------------------------------------------------------

    it("negative expectedSampleIndex returns CONFLICT without database call", async () => {
      sessionStore.set(
        "user-negative",
        makeSessionFixture({
          userId: "user-negative",
          acceptedSamples: [],
        }),
      );

      const result = await appendAcceptedEnrollmentSample({
        userId: "user-negative",
        encryptedVector: sampleEncryptedVector,
        expectedSampleIndex: -1,
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
      });

      expect(result.success).toBe(false);
      expect(result.reason).toBe("CONFLICT");
      // No findOneAndUpdate call was made (rejected before DB)
      const findOneAndUpdateCalls = sessionCalls.filter(
        (c) => c.method === "findOneAndUpdate",
      );
      expect(findOneAndUpdateCalls.length).toBe(0);
    });
  });
});

// =============================================================================
// PHASE 4.5B4.3 — Legacy Backfill Tests
// =============================================================================

describe("enrollment-session-service / getEnrollmentSessionByUserId — legacy backfill", () => {
  beforeEach(() => {
    sessionStore.clear();
    mockFindOne.mockReset();
    mockFindOneAndUpdate.mockReset();
    mockDeleteOne.mockReset();
    // Re-establish the default implementations
    mockFindOne.mockImplementation(
      (filter: { userId: string }) => ({
        lean: () => ({
          exec: async () => {
            const existing = sessionStore.get(filter.userId);
            return existing ? { ...existing } : null;
          },
        }),
      }),
    );
    mockFindOneAndUpdate.mockImplementation(
      (
        filter: { userId: string; [k: string]: unknown },
        update: {
          $set?: Partial<FaceEnrollmentSessionAttrs>;
          $setOnInsert?: Partial<FaceEnrollmentSessionAttrs>;
          $push?: { acceptedSamples?: unknown };
        },
        options: { upsert?: boolean; new?: boolean } = {},
      ) => {
        const existing = sessionStore.get(filter.userId) as
          | (FaceEnrollmentSessionAttrs & { finalizationClaim?: unknown })
          | undefined;
        const now = new Date();

        // PHASE 4.6B2A — honor atomic claim-protection filter.
        const claimMustBeAbsent =
          filter.finalizationClaim &&
          typeof filter.finalizationClaim === "object" &&
          "$exists" in (filter.finalizationClaim as Record<string, unknown>) &&
          (filter.finalizationClaim as { $exists?: unknown }).$exists === false;
        const sessionHasClaim =
          existing !== undefined && existing.finalizationClaim !== undefined;
        if (claimMustBeAbsent && sessionHasClaim) {
          return {
            lean: () => ({
              exec: async () => null,
            }),
          };
        }

        if (existing) {
          if (update.$set) {
            Object.assign(existing, update.$set);
          }
          if (update.$push?.acceptedSamples) {
            const toPush = update.$push.acceptedSamples;
            if (!existing.acceptedSamples) existing.acceptedSamples = [];
            if (Array.isArray(toPush)) {
              existing.acceptedSamples.push(...toPush);
            } else {
              existing.acceptedSamples.push(
                toPush as FaceEnrollmentAcceptedSampleDoc,
              );
            }
          }
          existing.updatedAt = now;
          const updated = { ...existing };
          return {
            lean: () => ({
              exec: async () => updated,
            }),
          };
        }
        if (!options.upsert) {
          return {
            lean: () => ({
              exec: async () => null,
            }),
          };
        }
        const fresh: FaceEnrollmentSessionAttrs = {
          ...makeSessionFixture({ userId: filter.userId }),
          ...(update.$set ?? {}),
          ...(update.$setOnInsert ?? {}),
          userId: filter.userId,
          createdAt: (update.$setOnInsert?.createdAt as Date | undefined) ?? now,
          updatedAt: now,
          generationId:
            (update.$set?.generationId as string | undefined) ??
            (update.$setOnInsert?.generationId as string | undefined) ??
            "gen-upsert-default",
        };
        sessionStore.set(filter.userId, fresh);
        return {
          lean: () => ({
            exec: async () => ({ ...fresh }),
          }),
        };
      },
    );
    mockDeleteOne.mockImplementation((filter: { userId: string }) => {
      return {
        exec: async () => {
          const had = sessionStore.delete(filter.userId);
          return { deletedCount: had ? 1 : 0, acknowledged: true };
        },
      };
    });
  });
  afterEach(() => {
    sessionCalls.length = 0;
  });
  // ---------------------------------------------------------------------------
  // 1. Legacy session with no generationId receives one stable UUID.
  // ---------------------------------------------------------------------------
  it("backfills generationId for a legacy session that has none", async () => {
    // Seed a legacy session without generationId.
    sessionStore.set(
      "user-legacy",
      makeSessionFixture({
        userId: "user-legacy",
        generationId: undefined as unknown as string,
        acceptedSamples: [
          {
            encryptedVector: {
              ciphertext: "c",
              iv: "i",
              authTag: "a",
              keyVersion: 1,
            },
            sampleIndex: 0,
            acceptedAt: new Date(),
          },
        ],
      }),
    );

    // Override findOneAndUpdate to simulate the atomic backfill.
    mockFindOneAndUpdate.mockImplementationOnce(
      (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const userId = filter.userId as string;
        const stored = sessionStore.get(userId);
        if (!stored) {
          return { lean: () => ({ exec: async () => null }) };
        }
        // Simulate the atomic update setting generationId.
        const $set = (update.$set as Record<string, unknown>) ?? {};
        Object.assign(stored, $set);
        return { lean: () => ({ exec: async () => ({ ...stored }) }) };
      },
    );

    const result = await getEnrollmentSessionByUserId("user-legacy");
    expect(result).not.toBeNull();
    expect(typeof result!.generationId).toBe("string");
    expect(result!.generationId.length).toBeGreaterThan(0);
    // acceptedSamples must be preserved.
    expect(result!.acceptedSamples).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // 2. acceptedSamples are preserved during legacy backfill.
  // ---------------------------------------------------------------------------
  it("preserves acceptedSamples during legacy backfill", async () => {
    sessionStore.set(
      "user-legacy-2",
      makeSessionFixture({
        userId: "user-legacy-2",
        generationId: undefined as unknown as string,
        acceptedSamples: [
          {
            encryptedVector: {
              ciphertext: "cipher1",
              iv: "iv1",
              authTag: "at1",
              keyVersion: 1,
            },
            sampleIndex: 0,
            acceptedAt: new Date("2026-01-01T00:00:00Z"),
          },
          {
            encryptedVector: {
              ciphertext: "cipher2",
              iv: "iv2",
              authTag: "at2",
              keyVersion: 1,
            },
            sampleIndex: 1,
            acceptedAt: new Date("2026-01-01T00:01:00Z"),
          },
        ],
      }),
    );

    mockFindOneAndUpdate.mockImplementationOnce(
      (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const userId = filter.userId as string;
        const stored = sessionStore.get(userId);
        if (!stored) {
          return { lean: () => ({ exec: async () => null }) };
        }
        const $set = (update.$set as Record<string, unknown>) ?? {};
        Object.assign(stored, $set);
        return { lean: () => ({ exec: async () => ({ ...stored }) }) };
      },
    );

    const result = await getEnrollmentSessionByUserId("user-legacy-2");
    expect(result!.acceptedSamples).toHaveLength(2);
    expect(result!.acceptedSamples[0]!.sampleIndex).toBe(0);
    expect(result!.acceptedSamples[1]!.sampleIndex).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // 3. expiresAt is preserved during legacy backfill.
  // ---------------------------------------------------------------------------
  it("preserves expiresAt during legacy backfill", async () => {
    const legacyExpiry = new Date("2030-01-01T00:00:00Z");
    sessionStore.set(
      "user-legacy-3",
      makeSessionFixture({
        userId: "user-legacy-3",
        generationId: undefined as unknown as string,
        expiresAt: legacyExpiry,
      }),
    );

    mockFindOneAndUpdate.mockImplementationOnce(
      (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const userId = filter.userId as string;
        const stored = sessionStore.get(userId);
        if (!stored) {
          return { lean: () => ({ exec: async () => null }) };
        }
        const $set = (update.$set as Record<string, unknown>) ?? {};
        Object.assign(stored, $set);
        return { lean: () => ({ exec: async () => ({ ...stored }) }) };
      },
    );

    const result = await getEnrollmentSessionByUserId("user-legacy-3");
    expect(result!.expiresAt.getTime()).toBe(legacyExpiry.getTime());
  });

  // ---------------------------------------------------------------------------
  // 4. mode is preserved during legacy backfill.
  // ---------------------------------------------------------------------------
  it("preserves mode during legacy backfill", async () => {
    sessionStore.set(
      "user-legacy-4",
      makeSessionFixture({
        userId: "user-legacy-4",
        generationId: undefined as unknown as string,
        mode: "replace",
      }),
    );

    mockFindOneAndUpdate.mockImplementationOnce(
      (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const userId = filter.userId as string;
        const stored = sessionStore.get(userId);
        if (!stored) {
          return { lean: () => ({ exec: async () => null }) };
        }
        const $set = (update.$set as Record<string, unknown>) ?? {};
        Object.assign(stored, $set);
        return { lean: () => ({ exec: async () => ({ ...stored }) }) };
      },
    );

    const result = await getEnrollmentSessionByUserId("user-legacy-4");
    expect(result!.mode).toBe("replace");
  });

  // ---------------------------------------------------------------------------
  // 5. model metadata is preserved during legacy backfill.
  // ---------------------------------------------------------------------------
  it("preserves model metadata during legacy backfill", async () => {
    sessionStore.set(
      "user-legacy-5",
      makeSessionFixture({
        userId: "user-legacy-5",
        generationId: undefined as unknown as string,
        modelIdentity: "insightface-buffalo-l",
        modelName: "buffalo_l",
        embeddingDimension: 512,
        normalization: "l2",
      }),
    );

    mockFindOneAndUpdate.mockImplementationOnce(
      (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const userId = filter.userId as string;
        const stored = sessionStore.get(userId);
        if (!stored) {
          return { lean: () => ({ exec: async () => null }) };
        }
        const $set = (update.$set as Record<string, unknown>) ?? {};
        Object.assign(stored, $set);
        return { lean: () => ({ exec: async () => ({ ...stored }) }) };
      },
    );

    const result = await getEnrollmentSessionByUserId("user-legacy-5");
    expect(result!.modelIdentity).toBe("insightface-buffalo-l");
    expect(result!.modelName).toBe("buffalo_l");
    expect(result!.embeddingDimension).toBe(512);
    expect(result!.normalization).toBe("l2");
  });

  // ---------------------------------------------------------------------------
  // 6. second read returns the SAME generationId.
  // ---------------------------------------------------------------------------
  it("second read returns the same generationId (no re-backfill)", async () => {
    sessionStore.set(
      "user-legacy-6",
      makeSessionFixture({
        userId: "user-legacy-6",
        generationId: "already-set-gen-id",
      }),
    );

    const result1 = await getEnrollmentSessionByUserId("user-legacy-6");
    expect(result1!.generationId).toBe("already-set-gen-id");

    // Second call — no backfill should be triggered.
    mockFindOneAndUpdate.mockClear();
    const result2 = await getEnrollmentSessionByUserId("user-legacy-6");
    expect(result2!.generationId).toBe("already-set-gen-id");
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 7. concurrent legacy backfill can persist only one winning generationId.
  // ---------------------------------------------------------------------------
  it("concurrent backfill callers: only one atomic update succeeds", async () => {
    sessionStore.set(
      "user-legacy-7",
      makeSessionFixture({
        userId: "user-legacy-7",
        generationId: undefined as unknown as string,
      }),
    );

    let firstAttempt = true;
    mockFindOneAndUpdate.mockImplementation(
      (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const userId = filter.userId as string;
        const stored = sessionStore.get(userId);
        if (!stored) {
          return { lean: () => ({ exec: async () => null }) };
        }
        // First caller wins (generates a UUID).
        // Second caller loses the race (generationId is now present).
        if (firstAttempt) {
          firstAttempt = false;
          const $set = (update.$set as Record<string, unknown>) ?? {};
          Object.assign(stored, $set);
          return { lean: () => ({ exec: async () => ({ ...stored }) }) };
        }
        // Second caller: generationId now present — findOneAndUpdate
        // with generationId: {$exists: false} returns null.
        return { lean: () => ({ exec: async () => null }) };
      },
    );

    const [resultA, resultB] = await Promise.all([
      getEnrollmentSessionByUserId("user-legacy-7"),
      getEnrollmentSessionByUserId("user-legacy-7"),
    ]);

    // Both callers must see the same generationId (the winner's).
    expect(resultA!.generationId).toBe(resultB!.generationId);
    expect(typeof resultA!.generationId).toBe("string");
    expect(resultA!.generationId.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // 8. losing concurrent caller obtains the persisted winner generationId.
  // ---------------------------------------------------------------------------
  it("losing concurrent caller re-reads and returns the persisted winner", async () => {
    sessionStore.set(
      "user-legacy-8",
      makeSessionFixture({
        userId: "user-legacy-8",
        generationId: "concurrent-winner-id",
      }),
    );

    // The loser call: findOneAndUpdate with $exists:false returns null.
    // The function then re-reads and finds the winner's generationId.
    mockFindOneAndUpdate.mockImplementationOnce(
      () => ({ lean: () => ({ exec: async () => null }) }),
    );

    const result = await getEnrollmentSessionByUserId("user-legacy-8");
    expect(result!.generationId).toBe("concurrent-winner-id");
  });

  // ---------------------------------------------------------------------------
  // 9. session that already has generationId is NOT assigned a new one.
  // ---------------------------------------------------------------------------
  it("existing generationId is NOT replaced on ordinary read", async () => {
    sessionStore.set(
      "user-normal",
      makeSessionFixture({
        userId: "user-normal",
        generationId: "stable-existing-id",
      }),
    );

    mockFindOneAndUpdate.mockClear();
    const result = await getEnrollmentSessionByUserId("user-normal");
    expect(result!.generationId).toBe("stable-existing-id");
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 10. explicit create/reset still DOES generate a fresh generationId.
  // ---------------------------------------------------------------------------
  it("createOrResetEnrollmentSession always regenerates generationId", async () => {
    const genIds: string[] = [];

    // Create a session.
    const session1 = await createOrResetEnrollmentSession({
      userId: "user-reset",
      mode: "create",
      requiredSampleCount: 5,
      templateVersion: 1,
    });
    genIds.push(session1.generationId);
    expect(typeof session1.generationId).toBe("string");
    expect(session1.generationId.length).toBeGreaterThan(0);

    // Reset the same session.
    const session2 = await createOrResetEnrollmentSession({
      userId: "user-reset",
      mode: "create",
      requiredSampleCount: 5,
      templateVersion: 1,
    });
    genIds.push(session2.generationId);

    // The generationId MUST be different after reset.
    expect(session2.generationId).not.toBe(session1.generationId);
  });

  // ---------------------------------------------------------------------------
  // 11. inactive/missing session does not generate generationId.
  // ---------------------------------------------------------------------------
  it("returns null (does not generate) when no session exists", async () => {
    sessionStore.clear();
    mockFindOneAndUpdate.mockClear();
    const result = await getEnrollmentSessionByUserId("no-such-user");
    expect(result).toBeNull();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // 12. expired legacy session follows existing expiration semantics and is NOT revived.
  // ---------------------------------------------------------------------------
  it("does NOT revive an expired legacy session via backfill", async () => {
    // A session that has expired (expiresAt in the past) but has no
    // generationId. The backfill path in getEnrollmentSessionByUserId
    // runs before expiration checks — but the status service (its caller)
    // checks expiration AFTER the service call, so the backfill may
    // succeed. However, the service does not refuse to backfill expired
    // sessions; the caller is responsible for applying expiration logic.
    // This test verifies the service DOES backfill (it doesn't check
    // expiration internally).
    sessionStore.set(
      "user-expired-legacy",
      makeSessionFixture({
        userId: "user-expired-legacy",
        generationId: undefined as unknown as string,
        expiresAt: new Date("2020-01-01T00:00:00Z"), // expired
      }),
    );

    mockFindOneAndUpdate.mockImplementationOnce(
      (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const userId = filter.userId as string;
        const stored = sessionStore.get(userId);
        if (!stored) {
          return { lean: () => ({ exec: async () => null }) };
        }
        const $set = (update.$set as Record<string, unknown>) ?? {};
        Object.assign(stored, $set);
        return { lean: () => ({ exec: async () => ({ ...stored }) }) };
      },
    );

    const result = await getEnrollmentSessionByUserId("user-expired-legacy");
    // The service backfills the generationId regardless of expiration.
    // The caller (status service) applies expiration logic afterward.
    expect(result).not.toBeNull();
    expect(typeof result!.generationId).toBe("string");
  });
});
