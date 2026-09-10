/**
 * Tests for the face-profile-service.
 *
 * PHASE 4.2 — FaceProfile + FaceEnrollmentSession database foundation.
 *
 * These tests use mocks for the Mongoose connection and FaceProfile
 * model so we can exercise the service logic without spinning up a
 * real MongoDB. The mocked model returns a `findOne`, `findOneAndUpdate`,
 * `exists`, and `deleteOne` stub that we drive deterministically.
 *
 * The service is responsible for:
 *   - looking up by `userId` only (never query/body-derived identity)
 *   - mapping duplicate-key errors to safe
 *     `BiometricPersistenceError` instances
 *   - keeping the model in a one-user, one-FaceProfile state via
 *     upsert
 *   - keeping `status: "active"` as the only valid persisted status
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FaceProfileAttrs } from "@/lib/biometrics/face-profile-model";

// =============================================================================
// In-memory store + mock implementation
// =============================================================================

const store = new Map<string, FaceProfileAttrs>();

function makeFaceProfileFixture(
  overrides: Partial<FaceProfileAttrs> = {},
): FaceProfileAttrs {
  return {
    userId: "user-1",
    status: "active",
    modelIdentity: "insightface/buffalo_l",
    modelName: "buffalo_l",
    embeddingDimension: 512,
    normalization: "l2",
    templateVersion: 1,
    requiredSampleCount: 5,
    sampleCount: 5,
    samples: [],
    centroid: {
      ciphertext: "c",
      iv: "i",
      authTag: "a",
      keyVersion: 1,
    },
    enrolledAt: new Date("2026-01-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

const modelCalls: Array<{
  method:
    | "findOne"
    | "findOneAndUpdate"
    | "exists"
    | "deleteOne";
  filter: Record<string, unknown>;
  bodyKeys: string[];
}> = [];

const mockFindOne = vi.fn((filter: { userId: string }) => ({
  lean: () => ({
    exec: async () => {
      const existing = store.get(filter.userId);
      return existing ? { ...existing } : null;
    },
  }),
}));

const mockFindOneAndUpdate = vi.fn(
  (
    filter: { userId: string },
    update: {
      $set?: Partial<FaceProfileAttrs>;
      $setOnInsert?: Partial<FaceProfileAttrs>;
    },
    options: { upsert?: boolean; new?: boolean } = {},
  ) => {
    const existing = store.get(filter.userId);
    const now = new Date();
    if (existing) {
      Object.assign(existing, update.$set ?? {});
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
    const fresh: FaceProfileAttrs = {
      ...makeFaceProfileFixture(filter.userId ? { userId: filter.userId } : {}),
      ...(update.$set ?? {}),
      ...(update.$setOnInsert ?? {}),
      userId: filter.userId,
      createdAt: (update.$setOnInsert?.createdAt as Date | undefined) ?? now,
      updatedAt: now,
    };
    store.set(filter.userId, fresh);
    return {
      lean: () => ({
        exec: async () => ({ ...fresh }),
      }),
    };
  },
);

const mockExists = vi.fn((filter: { userId: string }) => {
  // Mongoose's `exists` returns a thenable Query. The service
  // `await`s it directly (no `.exec()`), so the mock must also be
  // thenable. We expose an `.exec()` too for completeness.
  const promise = Promise.resolve(
    store.has(filter.userId) ? { _id: "exists" } : null,
  );
  (promise as { exec?: () => Promise<unknown> }).exec = () => promise;
  return promise;
});

const mockDeleteOne = vi.fn((filter: { userId: string }) => {
  return {
    exec: async () => {
      const had = store.delete(filter.userId);
      return { deletedCount: had ? 1 : 0, acknowledged: true };
    },
  };
});

vi.mock("@/lib/biometrics/face-profile-model", () => ({
  FaceProfileModel: {
    findOne: (...args: unknown[]) => {
      const filter = args[0] as { userId: string };
      modelCalls.push({
        method: "findOne",
        filter,
        bodyKeys: [],
      });
      return mockFindOne(filter);
    },
    findOneAndUpdate: (...args: unknown[]) => {
      const filter = args[0] as { userId: string };
      const update = args[1] as {
        $set?: Partial<FaceProfileAttrs>;
        $setOnInsert?: Partial<FaceProfileAttrs>;
      };
      modelCalls.push({
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
    exists: (...args: unknown[]) => {
      const filter = args[0] as { userId: string };
      modelCalls.push({
        method: "exists",
        filter,
        bodyKeys: [],
      });
      return mockExists(filter);
    },
    deleteOne: (...args: unknown[]) => {
      const filter = args[0] as { userId: string };
      modelCalls.push({
        method: "deleteOne",
        filter,
        bodyKeys: [],
      });
      return mockDeleteOne(filter);
    },
  },
  FACE_PROFILE_STATUSES: ["active"],
}));

vi.mock("@/lib/mongoose", () => ({
  getMongooseConnection: () => Promise.resolve(),
}));

import {
  getFaceProfileByUserId,
  hasFaceProfile,
  saveFaceProfile,
  deleteFaceProfileByUserId,
} from "@/lib/biometrics/face-profile-service";
import {
  BIOMETRIC_PERSISTENCE_ERROR_CODES,
  BiometricPersistenceError,
} from "@/lib/biometrics/biometric-errors";

describe("face-profile-service / getFaceProfileByUserId", () => {
  beforeEach(() => store.clear());
  afterEach(() => {
    vi.clearAllMocks();
    modelCalls.length = 0;
  });

  it("queries by userId", async () => {
    store.set("user-1", makeFaceProfileFixture());
    await getFaceProfileByUserId("user-1");
    const call = modelCalls.find((c) => c.method === "findOne");
    expect(call).toBeDefined();
    expect(call?.filter.userId).toBe("user-1");
  });

  it("returns null when no profile exists", async () => {
    const result = await getFaceProfileByUserId("missing");
    expect(result).toBeNull();
  });

  it("returns a plain profile when one exists", async () => {
    store.set(
      "user-2",
      makeFaceProfileFixture({ userId: "user-2", sampleCount: 3 }),
    );
    const result = await getFaceProfileByUserId("user-2");
    expect(result?.userId).toBe("user-2");
    expect(result?.sampleCount).toBe(3);
  });
});

describe("face-profile-service / hasFaceProfile", () => {
  beforeEach(() => store.clear());
  afterEach(() => {
    vi.clearAllMocks();
    modelCalls.length = 0;
  });

  it("returns false when no profile exists", async () => {
    expect(await hasFaceProfile("missing")).toBe(false);
  });

  it("returns true when a profile exists", async () => {
    store.set("user-3", makeFaceProfileFixture());
    expect(await hasFaceProfile("user-3")).toBe(true);
  });
});

describe("face-profile-service / saveFaceProfile", () => {
  beforeEach(() => store.clear());
  afterEach(() => {
    vi.clearAllMocks();
    modelCalls.length = 0;
  });

  it("creates a new FaceProfile using the supplied userId", async () => {
    const result = await saveFaceProfile(
      makeFaceProfileFixture({ userId: "user-4" }),
    );
    expect(result.userId).toBe("user-4");
    const call = modelCalls.find((c) => c.method === "findOneAndUpdate");
    expect(call).toBeDefined();
    expect(call?.filter.userId).toBe("user-4");
  });

  it("uses one-user persistence: idempotent upsert", async () => {
    await saveFaceProfile(
      makeFaceProfileFixture({ userId: "user-5", sampleCount: 5 }),
    );
    await saveFaceProfile(
      makeFaceProfileFixture({ userId: "user-5", sampleCount: 5 }),
    );
    expect(store.size).toBe(1);
  });

  it("rejects an invalid status", async () => {
    await expect(
      saveFaceProfile(
        makeFaceProfileFixture({
          userId: "user-6",
          // @ts-expect-error testing runtime validation
          status: "deleted",
        }),
      ),
    ).rejects.toMatchObject({
      code: BIOMETRIC_PERSISTENCE_ERROR_CODES.INVALID_BIOMETRIC_DATA,
    });
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
      saveFaceProfile(makeFaceProfileFixture({ userId: "user-7" })),
    ).rejects.toMatchObject({
      code: BIOMETRIC_PERSISTENCE_ERROR_CODES.BIOMETRIC_PROFILE_ALREADY_EXISTS,
    });
  });
});

describe("face-profile-service / deleteFaceProfileByUserId", () => {
  beforeEach(() => store.clear());
  afterEach(() => {
    vi.clearAllMocks();
    modelCalls.length = 0;
  });

  it("targets only the supplied userId", async () => {
    store.set("user-keep", makeFaceProfileFixture({ userId: "user-keep" }));
    store.set("user-drop", makeFaceProfileFixture({ userId: "user-drop" }));

    const deleted = await deleteFaceProfileByUserId("user-drop");
    expect(deleted).toBe(true);
    expect(store.has("user-keep")).toBe(true);
    expect(store.has("user-drop")).toBe(false);

    const call = modelCalls.find((c) => c.method === "deleteOne");
    expect(call).toBeDefined();
    expect(call?.filter.userId).toBe("user-drop");
  });

  it("returns false when no profile exists for the user", async () => {
    const deleted = await deleteFaceProfileByUserId("missing");
    expect(deleted).toBe(false);
  });
});

describe("face-profile-service / BiometricPersistenceError shape", () => {
  it("does not leak Mongoose internals", () => {
    const err = new BiometricPersistenceError({
      code: BIOMETRIC_PERSISTENCE_ERROR_CODES.UNKNOWN_ERROR,
      message: "An unexpected error occurred.",
    });
    const json = err.toJSON();
    expect(json.code).toBe(BIOMETRIC_PERSISTENCE_ERROR_CODES.UNKNOWN_ERROR);
    expect(json.message).toBe("An unexpected error occurred.");
    expect(JSON.stringify(json)).not.toMatch(/Mongoose|mongodb|connection/i);
  });
});
