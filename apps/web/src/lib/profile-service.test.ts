/**
 * Tests for the profile-service.
 *
 * These tests use mocks for the Mongoose connection and model so we
 * can exercise the service logic without spinning up a real
 * MongoDB. The mocked model returns a `findOneAndUpdate` / `findOne`
 * stub that we drive deterministically.
 *
 * The service is responsible for:
 *   - validating input via Zod
 *   - mapping duplicate-key errors to safe ProfileErrors
 *   - ensuring identity is derived from `userId`, not request bodies
 *   - keeping `role`, `userId`, and `emailSnapshot` immutable in
 *     `updateProfile`
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProfileAttrs } from "@/lib/profile-model";

/**
 * In-memory mock of the Profile Mongoose model.
 *
 * Stores one document per `userId`. The model API surface used here
 * mirrors the real model's chainable methods.
 */

interface StoredProfile extends ProfileAttrs {
  _id: string;
}

const store = new Map<string, StoredProfile>();

function makeDoc(profile: StoredProfile) {
  return {
    ...profile,
    toObject() {
      return { ...profile };
    },
  };
}

const mockFindOneAndUpdate = vi.fn(
  (
    filter: { userId: string },
    update: {
      $set?: Partial<ProfileAttrs>;
      $setOnInsert?: { userId: string };
    },
    options: { upsert?: boolean; new?: boolean } = {},
  ) => {
    const existing = store.get(filter.userId);
    if (!existing && !options.upsert) {
      return {
        lean: () => ({
          exec: async () => null,
        }),
      };
    }
    const now = new Date();
    if (existing) {
      Object.assign(existing, update.$set ?? {});
      existing.updatedAt = now;
      return {
        lean: () => ({
          exec: async () => ({ ...existing }),
        }),
      };
    }
    const doc: StoredProfile = {
      _id: `auto-${Math.random().toString(36).slice(2)}`,
      userId: update.$setOnInsert?.userId ?? filter.userId,
      emailSnapshot: update.$set?.emailSnapshot ?? "",
      role: (update.$set?.role as "student" | "teacher") ?? "student",
      fullName: update.$set?.fullName ?? "",
      identificationCode: update.$set?.identificationCode ?? "",
      phone: update.$set?.phone ?? undefined,
      onboardingCompleted: update.$set?.onboardingCompleted ?? false,
      createdAt: now,
      updatedAt: now,
    };
    store.set(filter.userId, doc);
    return {
      lean: () => ({
        exec: async () => ({ ...doc }),
      }),
    };
  },
);

const mockFindOne = vi.fn((filter: { userId: string }) => ({
  lean: () => ({
    exec: async () => {
      const existing = store.get(filter.userId);
      return existing ? { ...existing } : null;
    },
  }),
}));

// Track calls to assert that identity-bearing fields come from the
// service layer (the userId argument), not from the request payload.
const modelCalls: Array<{
  method: "findOne" | "findOneAndUpdate";
  filter: { userId: string };
  bodyKeys: string[];
}> = [];

vi.mock("@/lib/profile-model", () => {
  return {
    ProfileModel: {
      findOne: (...args: unknown[]) => {
        modelCalls.push({
          method: "findOne",
          filter: args[0] as { userId: string },
          bodyKeys: [],
        });
        return mockFindOne(args[0] as { userId: string });
      },
      findOneAndUpdate: (...args: unknown[]) => {
        const filter = args[0] as { userId: string };
        const update = args[1] as {
          $set?: Partial<ProfileAttrs>;
          $setOnInsert?: { userId: string };
        };
        const bodyKeys = Object.keys(update.$set ?? {});
        modelCalls.push({
          method: "findOneAndUpdate",
          filter,
          bodyKeys,
        });
        return mockFindOneAndUpdate(
          filter,
          update,
          args[2] as { upsert?: boolean; new?: boolean },
        );
      },
    },
  };
});

vi.mock("@/lib/mongoose", () => ({
  getMongooseConnection: () => Promise.resolve(),
}));

import {
  getProfileByUserId,
  isOnboardingComplete,
  updateProfile,
  upsertOnboarding,
} from "@/lib/profile-service";
import {
  PROFILE_ERROR_CODES,
  ProfileError,
} from "@/lib/profile-errors";

describe("profile-service / getProfileByUserId", () => {
  beforeEach(() => store.clear());
  afterEach(() => {
    vi.clearAllMocks();
    modelCalls.length = 0;
  });

  it("returns null when no profile exists", async () => {
    const result = await getProfileByUserId("missing");
    expect(result).toBeNull();
  });

  it("returns a plain profile when one exists", async () => {
    await upsertOnboarding("user-a", "a@example.com", {
      role: "student",
      fullName: "Alice",
      identificationCode: "STU-1",
    });
    const profile = await getProfileByUserId("user-a");
    expect(profile).not.toBeNull();
    expect(profile?.userId).toBe("user-a");
    expect(profile?.onboardingCompleted).toBe(true);
  });
});

describe("profile-service / isOnboardingComplete", () => {
  beforeEach(() => store.clear());
  afterEach(() => {
    vi.clearAllMocks();
    modelCalls.length = 0;
  });

  it("returns false when no profile exists", async () => {
    expect(await isOnboardingComplete("missing")).toBe(false);
  });

  it("returns true after a successful onboarding", async () => {
    await upsertOnboarding("user-b", "b@example.com", {
      role: "teacher",
      fullName: "Bob",
      identificationCode: "TEA-1",
    });
    expect(await isOnboardingComplete("user-b")).toBe(true);
  });
});

describe("profile-service / upsertOnboarding", () => {
  beforeEach(() => store.clear());
  afterEach(() => {
    vi.clearAllMocks();
    modelCalls.length = 0;
  });

  it("creates a profile and uses session-derived userId and emailSnapshot", async () => {
    const result = await upsertOnboarding("user-c", "c@example.com", {
      role: "student",
      fullName: "Charlie",
      identificationCode: "STU-C",
      phone: "+84 901",
    });

    expect(result.userId).toBe("user-c");
    expect(result.emailSnapshot).toBe("c@example.com");
    expect(result.onboardingCompleted).toBe(true);

    // The model call should use the server-provided userId filter,
    // not anything derived from the request body.
    const call = modelCalls.find((c) => c.method === "findOneAndUpdate");
    expect(call).toBeDefined();
    expect(call?.filter.userId).toBe("user-c");
  });

  it("is idempotent on repeated submissions (no duplicate profile)", async () => {
    const payload = {
      role: "student" as const,
      fullName: "Charlie",
      identificationCode: "STU-C",
    };
    await upsertOnboarding("user-d", "d@example.com", payload);
    await upsertOnboarding("user-d", "d@example.com", payload);
    const profile = await getProfileByUserId("user-d");
    expect(profile).not.toBeNull();
    // Exactly one document.
    expect(store.size).toBe(1);
  });

  it("rejects invalid role with INVALID_PROFILE_DATA", async () => {
    await expect(
      upsertOnboarding("user-e", "e@example.com", {
        role: "admin",
        fullName: "Eve",
        identificationCode: "X-1",
      }),
    ).rejects.toMatchObject({
      code: PROFILE_ERROR_CODES.INVALID_PROFILE_DATA,
    });
  });

  it("rejects empty fullName with INVALID_PROFILE_DATA", async () => {
    await expect(
      upsertOnboarding("user-f", "f@example.com", {
        role: "student",
        fullName: "   ",
        identificationCode: "X-1",
      }),
    ).rejects.toMatchObject({
      code: PROFILE_ERROR_CODES.INVALID_PROFILE_DATA,
    });
  });

  it("rejects empty identificationCode with INVALID_PROFILE_DATA", async () => {
    await expect(
      upsertOnboarding("user-g", "g@example.com", {
        role: "student",
        fullName: "G",
        identificationCode: "",
      }),
    ).rejects.toMatchObject({
      code: PROFILE_ERROR_CODES.INVALID_PROFILE_DATA,
    });
  });

  it("maps Mongo duplicate-key errors to IDENTIFICATION_CODE_TAKEN", async () => {
    // First create a profile occupying the code.
    await upsertOnboarding("user-h1", "h1@example.com", {
      role: "student",
      fullName: "H",
      identificationCode: "DUPE-1",
    });

    // Stub findOneAndUpdate to throw a duplicate-key error for the
    // second user trying the same code. The throw must surface from
    // the awaited chain — we put it inside `.exec()` because that is
    // the async boundary the service code awaits.
    mockFindOneAndUpdate.mockImplementationOnce(() => ({
      lean: () => ({
        exec: async () => {
          throw { code: 11000, keyValue: { identificationCode: "DUPE-1" } };
        },
      }),
    }));

    await expect(
      upsertOnboarding("user-h2", "h2@example.com", {
        role: "student",
        fullName: "H Two",
        identificationCode: "DUPE-1",
      }),
    ).rejects.toMatchObject({
      code: PROFILE_ERROR_CODES.IDENTIFICATION_CODE_TAKEN,
    });
  });
});

describe("profile-service / updateProfile", () => {
  beforeEach(() => store.clear());
  afterEach(() => {
    vi.clearAllMocks();
    modelCalls.length = 0;
  });

  it("updates an existing profile and ignores role", async () => {
    await upsertOnboarding("user-i", "i@example.com", {
      role: "student",
      fullName: "Original",
      identificationCode: "STU-I",
    });

    const updated = await updateProfile("user-i", {
      fullName: "Updated",
      identificationCode: "STU-I-2",
      phone: "+84 902",
    });
    expect(updated.fullName).toBe("Updated");
    expect(updated.identificationCode).toBe("STU-I-2");
    expect(updated.role).toBe("student"); // role is immutable here
    expect(updated.emailSnapshot).toBe("i@example.com"); // emailSnapshot is immutable here
    expect(updated.userId).toBe("user-i"); // userId is immutable here
  });

  it("cannot change role through the updateProfile path (schema rejects it)", async () => {
    await upsertOnboarding("user-j", "j@example.com", {
      role: "student",
      fullName: "J",
      identificationCode: "STU-J",
    });
    // Even if a malicious client posts `role: teacher`, Zod's
    // ProfileUpdateSchema strips it.
    const result = await updateProfile("user-j", {
      role: "teacher",
      fullName: "J",
      identificationCode: "STU-J",
    });
    expect(result.role).toBe("student");
  });

  it("cannot change userId or emailSnapshot (schema rejects them)", async () => {
    await upsertOnboarding("user-k", "k@example.com", {
      role: "teacher",
      fullName: "K",
      identificationCode: "TEA-K",
    });
    const result = await updateProfile("user-k", {
      userId: "different",
      emailSnapshot: "attacker@example.com",
      fullName: "K",
      identificationCode: "TEA-K",
    });
    expect(result.userId).toBe("user-k");
    expect(result.emailSnapshot).toBe("k@example.com");
  });

  it("throws PROFILE_NOT_FOUND when no profile exists", async () => {
    await expect(
      updateProfile("missing-user", {
        fullName: "Nobody",
        identificationCode: "X-1",
      }),
    ).rejects.toMatchObject({
      code: PROFILE_ERROR_CODES.PROFILE_NOT_FOUND,
    });
  });

  it("maps duplicate identificationCode to IDENTIFICATION_CODE_TAKEN", async () => {
    await upsertOnboarding("user-l1", "l1@example.com", {
      role: "student",
      fullName: "L1",
      identificationCode: "DUPE-L",
    });
    await upsertOnboarding("user-l2", "l2@example.com", {
      role: "student",
      fullName: "L2",
      identificationCode: "OTHER-L",
    });

    mockFindOneAndUpdate.mockImplementationOnce(() => ({
      lean: () => ({
        exec: async () => {
          throw { code: 11000, keyValue: { identificationCode: "DUPE-L" } };
        },
      }),
    }));

    await expect(
      updateProfile("user-l2", {
        fullName: "L2",
        identificationCode: "DUPE-L",
      }),
    ).rejects.toMatchObject({
      code: PROFILE_ERROR_CODES.IDENTIFICATION_CODE_TAKEN,
    });
  });
});