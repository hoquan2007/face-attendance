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

import type { FaceEnrollmentSessionAttrs } from "@/lib/biometrics/enrollment-session-model";

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
      return existing ? { ...existing } : null;
    },
  }),
}));

const mockFindOneAndUpdate = vi.fn(
  (
    filter: { userId: string },
    update: {
      $set?: Partial<FaceEnrollmentSessionAttrs>;
      $setOnInsert?: Partial<FaceEnrollmentSessionAttrs>;
    },
    options: { upsert?: boolean; new?: boolean } = {},
  ) => {
    const existing = sessionStore.get(filter.userId);
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
    const fresh: FaceEnrollmentSessionAttrs = {
      ...makeSessionFixture({ userId: filter.userId }),
      ...(update.$set ?? {}),
      ...(update.$setOnInsert ?? {}),
      userId: filter.userId,
      createdAt: (update.$setOnInsert?.createdAt as Date | undefined) ?? now,
      updatedAt: now,
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
