/**
 * Service-layer tests for the AttendanceSession module.
 *
 * PHASE 6.1 — ATTENDANCE SESSION FOUNDATION.
 *
 * Covers:
 *
 *   ## Snapshot (1..14)
 *     1-3. only ACTIVE memberships enter snapshot
 *     4-6. snapshot stores studentUserId / fullNameSnapshot /
 *          identificationCodeSnapshot
 *     7.   Profiles loaded in one batch
 *     8.   no N+1 Profile query
 *     9.   empty roster is valid (returns [])
 *     10.  orphan / missing Profile fails safely
 *     11.  incomplete student Profile fails safely
 *     12.  non-student Profile fails safely
 *     13.  snapshot does NOT expose password / biometric data
 *
 *   ## Classifier (15..17)
 *     15. partial unique classifier accepts (classId, status)
 *         where status = active
 *     16. rejects unrelated 11000
 *     17. rejects non-11000
 *
 *   ## Atomic stop (18..21)
 *     18. close only affects active session
 *     19. close preserves rosterSnapshot
 *     20. close sets status = closed and endedAt
 *     21. close returns ATTENDANCE_SESSION_NOT_ACTIVE on miss
 *
 * Implementation notes:
 *   - ClassMembershipModel, ProfileModel and AttendanceSessionModel
 *     are mocked at module boundaries. No MongoDB / Mongoose is
 *     touched.
 *   - The mocks model an in-memory store for memberships, profiles,
 *     and sessions. Every `find` / `findOne` / `findOneAndUpdate`
 *     is exercised through the store.
 *   - The "no N+1 Profile query" assertion is enforced by checking
 *     that the batched primitive is invoked EXACTLY ONCE per call.
 *   - The "Profile batched lookup" primitive is mocked at its own
 *     boundary, not through the real profile-service, so the test
 *     never depends on Mongo / Profile collection state.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Types } from "mongoose";

// =============================================================================
// Mock collaborators
// =============================================================================

const mockGetStudentProfilesByUserIds = vi.fn();

vi.mock("@/lib/mongoose", () => ({
  getMongooseConnection: () => Promise.resolve(),
}));

vi.mock("@/lib/profile-service", () => ({
  getStudentProfilesByUserIds: (...args: unknown[]) =>
    mockGetStudentProfilesByUserIds(...args),
}));

// =============================================================================
// In-memory stores
// =============================================================================

interface StoredMembership {
  _id: Types.ObjectId;
  classId: Types.ObjectId;
  studentUserId: string;
  joinedAt: Date;
  status: "active" | "inactive";
}

interface StoredProfile {
  userId: string;
  fullName: string;
  identificationCode: string;
  role: "student" | "teacher";
  onboardingCompleted: boolean;
}

interface StoredSession {
  _id: Types.ObjectId;
  classId: Types.ObjectId;
  status: "active" | "closed";
  startedAt: Date;
  endedAt: Date | null;
  startedByUserId: string;
  rosterSnapshot: StoredRosterItem[];
  createdAt: Date;
  updatedAt: Date;
}

interface StoredRosterItem {
  studentUserId: string;
  fullNameSnapshot: string;
  identificationCodeSnapshot: string;
}

const membershipStore = new Map<string, StoredMembership>();
const sessionStore = new Map<string, StoredSession>();

let nextObjectIdCounter = 0;
function makeObjectId(): Types.ObjectId {
  // We never call `.toString()` in the service; the unique-key
  // lookup uses the value's identity. We DO need a real ObjectId
  // shape so `new Types.ObjectId(input)` comparisons work in the
  // mocked findOne filters.
  nextObjectIdCounter++;
  return new Types.ObjectId(
    (60_000_000_000_000_000 + nextObjectIdCounter)
      .toString(16)
      .padStart(24, "0"),
  );
}

function membershipKey(classId: Types.ObjectId, studentUserId: string) {
  return `${classId.toHexString()}::${studentUserId}`;
}

function resetStores() {
  membershipStore.clear();
  sessionStore.clear();
  nextObjectIdCounter = 0;
  mockGetStudentProfilesByUserIds.mockReset();
}

// =============================================================================
// Mock ClassMembershipModel
// =============================================================================

const mockMembershipFind = vi.fn();
const mockMembershipFindOne = vi.fn();
const mockMembershipCreate = vi.fn();

vi.mock("@/lib/classes/class-membership-model", async () => {
  const actual =
    await vi.importActual<
      typeof import("@/lib/classes/class-membership-model")
    >("@/lib/classes/class-membership-model");
  return {
    ...actual,
    ClassMembershipModel: {
      find: (...args: unknown[]) => mockMembershipFind(...args),
      findOne: (...args: unknown[]) => mockMembershipFindOne(...args),
      create: (...args: unknown[]) => mockMembershipCreate(...args),
    },
  };
});

// =============================================================================
// Mock AttendanceSessionModel
// =============================================================================

const mockSessionCreate = vi.fn();
const mockSessionFindOne = vi.fn();
const mockSessionFindById = vi.fn();
const mockSessionFind = vi.fn();
const mockSessionFindOneAndUpdate = vi.fn();

vi.mock("@/lib/attendance/attendance-session-model", async () => {
  const actual =
    await vi.importActual<
      typeof import("@/lib/attendance/attendance-session-model")
    >("@/lib/attendance/attendance-session-model");
  return {
    ...actual,
    AttendanceSessionModel: {
      create: (...args: unknown[]) => mockSessionCreate(...args),
      findOne: (...args: unknown[]) => mockSessionFindOne(...args),
      findById: (...args: unknown[]) => mockSessionFindById(...args),
      find: (...args: unknown[]) => mockSessionFind(...args),
      findOneAndUpdate: (...args: unknown[]) =>
        mockSessionFindOneAndUpdate(...args),
    },
  };
});

// =============================================================================
// Helpers — membership + profile fixtures
// =============================================================================

function seedMembership(
  classId: Types.ObjectId,
  studentUserId: string,
  overrides: Partial<StoredMembership> = {},
): StoredMembership {
  const m: StoredMembership = {
    _id: makeObjectId(),
    classId,
    studentUserId,
    joinedAt: new Date(Date.now() - 1000 * 60 * 60),
    status: "active",
    ...overrides,
  };
  membershipStore.set(membershipKey(classId, studentUserId), m);
  return m;
}

function makeStudentProfile(
  userId: string,
  overrides: Partial<StoredProfile> = {},
): StoredProfile {
  return {
    userId,
    fullName: `Student ${userId}`,
    identificationCode: `S-${userId}`,
    role: "student",
    onboardingCompleted: true,
    ...overrides,
  };
}

// =============================================================================
// Service mock implementations
// =============================================================================

function setupMembershipFindChain(
  memberships: StoredMembership[],
) {
  mockMembershipFind.mockImplementationOnce((filter: {
    classId?: Types.ObjectId;
    status?: string;
  }) => {
    const result = memberships.filter((m) => {
      if (
        filter.classId &&
        m.classId.toHexString() !== filter.classId.toHexString()
      ) {
        return false;
      }
      if (filter.status && m.status !== filter.status) {
        return false;
      }
      return true;
    });
    const sorted = [...result].sort(
      (a, b) => a.joinedAt.getTime() - b.joinedAt.getTime(),
    );
    const query = {
      select: () => query,
      sort: () => query,
      lean: () => query,
      exec: async () => sorted,
    };
    return query;
  });
}

function setupProfileBatch(
  profiles: ReadonlyArray<StoredProfile>,
) {
  // Return ONLY completed student profiles; non-student / incomplete
  // profiles are omitted by the real primitive — the mock mirrors
  // that contract.
  mockGetStudentProfilesByUserIds.mockImplementationOnce(
    async (userIds: ReadonlyArray<string>) => {
      const map = new Map<
        string,
        {
          userId: string;
          fullName: string;
          identificationCode: string;
          role: "student";
          onboardingCompleted: true;
        }
      >();
      for (const userId of userIds) {
        const p = profiles.find((x) => x.userId === userId);
        if (!p) continue;
        if (p.role !== "student") continue;
        if (p.onboardingCompleted !== true) continue;
        if (typeof p.fullName !== "string") continue;
        if (typeof p.identificationCode !== "string") continue;
        map.set(p.userId, {
          userId: p.userId,
          fullName: p.fullName,
          identificationCode: p.identificationCode,
          role: "student",
          onboardingCompleted: true,
        });
      }
      return map;
    },
  );
}

function setupSessionFindOneChain(
  result: StoredSession | null,
) {
  mockSessionFindOne.mockImplementationOnce(() => {
    const query = {
      lean: () => query,
      exec: async () => result,
    };
    return query;
  });
}

function setupSessionFindOneAndUpdateChain(
  impl: (
    filter: {
      classId?: Types.ObjectId;
      status?: string;
    },
    update: { $set?: { status?: string; endedAt?: Date } },
  ) => Promise<StoredSession | null>,
) {
  mockSessionFindOneAndUpdate.mockImplementationOnce(
    (
      filter: {
        classId?: Types.ObjectId;
        status?: string;
      },
      update: { $set?: { status?: string; endedAt?: Date } },
    ) => {
      const query = {
        lean: () => query,
        exec: async () => impl(filter, update),
      };
      return query;
    },
  );
}

// =============================================================================
// Setup / teardown
// =============================================================================

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// Imports under test
// =============================================================================

import {
  buildAttendanceRosterSnapshot,
  closeActiveAttendanceSessionForClass,
  createAttendanceSession,
  findActiveAttendanceSessionByClassId,
  isAttendanceSessionActiveDuplicateKeyError,
  AttendanceSessionServiceError,
  ATTENDANCE_SESSION_ERROR_CODES,
  toSafeAttendanceSessionSummary,
} from "./attendance-session-service";

// =============================================================================
// 1..14 — Roster snapshot
// =============================================================================

describe("buildAttendanceRosterSnapshot", () => {
  it("1-3. only ACTIVE memberships enter the snapshot", async () => {
    const classId = makeObjectId();
    seedMembership(classId, "active-1", { status: "active" });
    seedMembership(classId, "active-2", { status: "active" });
    // Inactive membership MUST NOT enter the snapshot.
    seedMembership(classId, "inactive-1", { status: "inactive" });

    setupMembershipFindChain(
      Array.from(membershipStore.values()).filter((m) =>
        m.classId.toHexString() === classId.toHexString(),
      ),
    );
    setupProfileBatch([
      makeStudentProfile("active-1"),
      makeStudentProfile("active-2"),
      makeStudentProfile("inactive-1"),
    ]);

    const items = await buildAttendanceRosterSnapshot(classId);
    const ids = items.map((i) => i.studentUserId);
    expect(ids).toContain("active-1");
    expect(ids).toContain("active-2");
    expect(ids).not.toContain("inactive-1");
    expect(items).toHaveLength(2);
  });

  it("4-6. snapshot stores studentUserId, fullNameSnapshot, identificationCodeSnapshot", async () => {
    const classId = makeObjectId();
    seedMembership(classId, "user-a");

    setupMembershipFindChain(
      Array.from(membershipStore.values()).filter((m) =>
        m.classId.toHexString() === classId.toHexString(),
      ),
    );
    setupProfileBatch([
      {
        userId: "user-a",
        fullName: "Alice Ng",
        identificationCode: "STU-A",
        role: "student",
        onboardingCompleted: true,
      },
    ]);

    const items = await buildAttendanceRosterSnapshot(classId);
    expect(items).toHaveLength(1);
    const first = items[0];
    expect(first).toBeDefined();
    expect(first?.studentUserId).toBe("user-a");
    expect(first?.fullNameSnapshot).toBe("Alice Ng");
    expect(first?.identificationCodeSnapshot).toBe("STU-A");
  });

  it("7. Profiles are loaded in ONE batched query (no N+1)", async () => {
    const classId = makeObjectId();
    seedMembership(classId, "u1");
    seedMembership(classId, "u2");
    seedMembership(classId, "u3");
    seedMembership(classId, "u4");
    seedMembership(classId, "u5");

    setupMembershipFindChain(
      Array.from(membershipStore.values()).filter((m) =>
        m.classId.toHexString() === classId.toHexString(),
      ),
    );
    setupProfileBatch([
      makeStudentProfile("u1"),
      makeStudentProfile("u2"),
      makeStudentProfile("u3"),
      makeStudentProfile("u4"),
      makeStudentProfile("u5"),
    ]);

    await buildAttendanceRosterSnapshot(classId);

    // The batched primitive is the ONLY sanctioned Profile source.
    // It MUST be invoked exactly ONCE for the entire snapshot
    // build, regardless of membership count.
    expect(mockGetStudentProfilesByUserIds).toHaveBeenCalledTimes(1);
  });

  it("8. batched Profile query receives ALL studentUserIds in one call", async () => {
    const classId = makeObjectId();
    seedMembership(classId, "u1");
    seedMembership(classId, "u2");
    seedMembership(classId, "u3");

    setupMembershipFindChain(
      Array.from(membershipStore.values()).filter((m) =>
        m.classId.toHexString() === classId.toHexString(),
      ),
    );
    setupProfileBatch([
      makeStudentProfile("u1"),
      makeStudentProfile("u2"),
      makeStudentProfile("u3"),
    ]);

    await buildAttendanceRosterSnapshot(classId);

    expect(mockGetStudentProfilesByUserIds).toHaveBeenCalledTimes(1);
    const firstCallArgs = mockGetStudentProfilesByUserIds.mock.calls[0];
    expect(firstCallArgs).toBeDefined();
    const userIds = firstCallArgs?.[0] as string[];
    expect(userIds).toHaveLength(3);
    expect(userIds).toEqual(expect.arrayContaining(["u1", "u2", "u3"]));
  });

  it("9. empty roster is valid (returns [])", async () => {
    const classId = makeObjectId();
    setupMembershipFindChain([]);

    const items = await buildAttendanceRosterSnapshot(classId);
    expect(items).toEqual([]);
    // No batched Profile query is issued for an empty membership
    // set — the function short-circuits BEFORE touching Profile.
    expect(mockGetStudentProfilesByUserIds).not.toHaveBeenCalled();
  });

  it("10. orphan / missing Profile fails safely with ATTENDANCE_ROSTER_INVALID", async () => {
    const classId = makeObjectId();
    seedMembership(classId, "orphaned-user");

    setupMembershipFindChain(
      Array.from(membershipStore.values()).filter((m) =>
        m.classId.toHexString() === classId.toHexString(),
      ),
    );
    // The profile batch deliberately omits the orphaned user.
    setupProfileBatch([]);

    await expect(
      buildAttendanceRosterSnapshot(classId),
    ).rejects.toMatchObject({
      code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_ROSTER_INVALID,
    });
  });

  it("11. incomplete student Profile fails safely with ATTENDANCE_ROSTER_INVALID", async () => {
    const classId = makeObjectId();
    seedMembership(classId, "incomplete-user");

    setupMembershipFindChain(
      Array.from(membershipStore.values()).filter((m) =>
        m.classId.toHexString() === classId.toHexString(),
      ),
    );
    // The mock primitive mirrors the real contract: it omits
    // incomplete Profiles from the returned Map.
    setupProfileBatch([]);

    await expect(
      buildAttendanceRosterSnapshot(classId),
    ).rejects.toMatchObject({
      code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_ROSTER_INVALID,
    });
  });

  it("12. non-student Profile fails safely with ATTENDANCE_ROSTER_INVALID", async () => {
    const classId = makeObjectId();
    seedMembership(classId, "teacher-user");

    setupMembershipFindChain(
      Array.from(membershipStore.values()).filter((m) =>
        m.classId.toHexString() === classId.toHexString(),
      ),
    );
    // The Profile is a teacher → the batch primitive omits it.
    setupProfileBatch([]);

    await expect(
      buildAttendanceRosterSnapshot(classId),
    ).rejects.toMatchObject({
      code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_ROSTER_INVALID,
    });
  });

  it("13. snapshot does NOT expose password / biometric / embedding / centroid data", async () => {
    const classId = makeObjectId();
    seedMembership(classId, "u1");

    setupMembershipFindChain(
      Array.from(membershipStore.values()).filter((m) =>
        m.classId.toHexString() === classId.toHexString(),
      ),
    );
    setupProfileBatch([
      makeStudentProfile("u1", {
        fullName: "Alice Ng",
        identificationCode: "STU-A",
      }),
    ]);

    const items = await buildAttendanceRosterSnapshot(classId);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain("password");
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("embedding");
    expect(serialized).not.toContain("centroid");
    expect(serialized).not.toContain("biometric");
    expect(serialized).not.toContain("encryptedVector");
    expect(serialized).not.toContain("ciphertext");
    expect(serialized).not.toContain("emailSnapshot");
    expect(serialized).not.toContain("phone");
    expect(serialized).not.toContain("teacherUserId");

    // Each item has exactly the documented keys — no extras.
    const item = items[0];
    expect(item).toBeDefined();
    expect(Object.keys(item ?? {}).sort()).toEqual([
      "fullNameSnapshot",
      "identificationCodeSnapshot",
      "studentUserId",
    ]);
  });

  it("14. snapshot preserves joinedAt ASC (oldest member first)", async () => {
    const classId = makeObjectId();
    const earlier = new Date("2026-01-01T00:00:00Z");
    const later = new Date("2026-02-01T00:00:00Z");
    seedMembership(classId, "later-user", { joinedAt: later });
    seedMembership(classId, "earlier-user", { joinedAt: earlier });

    setupMembershipFindChain(
      Array.from(membershipStore.values()).filter((m) =>
        m.classId.toHexString() === classId.toHexString(),
      ),
    );
    setupProfileBatch([
      makeStudentProfile("later-user"),
      makeStudentProfile("earlier-user"),
    ]);

    const items = await buildAttendanceRosterSnapshot(classId);
    const ids = items.map((i) => i.studentUserId);
    expect(ids).toEqual(["earlier-user", "later-user"]);
  });
});

// =============================================================================
// 15..17 — Partial unique classifier
// =============================================================================

describe("isAttendanceSessionActiveDuplicateKeyError", () => {
  it("15. accepts (classId, status) collision with status = 'active'", () => {
    expect(
      isAttendanceSessionActiveDuplicateKeyError({
        code: 11000,
        keyValue: { classId: "abc", status: "active" },
      }),
    ).toBe(true);
    expect(
      isAttendanceSessionActiveDuplicateKeyError({
        code: 11000,
        keyPattern: { classId: 1, status: 1 },
      }),
    ).toBe(true);
  });

  it("16. rejects an unrelated 11000 collision", () => {
    expect(
      isAttendanceSessionActiveDuplicateKeyError({
        code: 11000,
        keyValue: { somethingElse: "x" },
      }),
    ).toBe(false);
    expect(
      isAttendanceSessionActiveDuplicateKeyError({
        code: 11000,
        keyValue: { classId: "abc" },
      }),
    ).toBe(false);
    expect(
      isAttendanceSessionActiveDuplicateKeyError({
        code: 11000,
        keyValue: { status: "active" },
      }),
    ).toBe(false);
  });

  it("17. rejects a non-11000 error", () => {
    expect(
      isAttendanceSessionActiveDuplicateKeyError({
        code: 11001,
        keyValue: { classId: "abc", status: "active" },
      }),
    ).toBe(false);
    expect(isAttendanceSessionActiveDuplicateKeyError(null)).toBe(false);
    expect(isAttendanceSessionActiveDuplicateKeyError(undefined)).toBe(
      false,
    );
    expect(isAttendanceSessionActiveDuplicateKeyError("oops")).toBe(false);
  });
});

// =============================================================================
// createAttendanceSession — classification
// =============================================================================

describe("createAttendanceSession — duplicate-key classification", () => {
  function setupCreateReject(err: unknown) {
    mockSessionCreate.mockImplementationOnce(async () => {
      throw err;
    });
  }

  it("maps a precise (classId, status) collision to ATTENDANCE_SESSION_ALREADY_ACTIVE", async () => {
    const classId = makeObjectId();
    seedMembership(classId, "u1");
    setupMembershipFindChain(
      Array.from(membershipStore.values()).filter((m) =>
        m.classId.toHexString() === classId.toHexString(),
      ),
    );
    setupProfileBatch([makeStudentProfile("u1")]);
    setupCreateReject({
      code: 11000,
      keyValue: { classId: classId.toHexString(), status: "active" },
    });

    await expect(
      createAttendanceSession({
        classId,
        startedByUserId: "teacher-1",
      }),
    ).rejects.toMatchObject({
      code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_SESSION_ALREADY_ACTIVE,
    });
  });

  it("maps an unrelated 11000 to ATTENDANCE_SESSION_CREATE_FAILED", async () => {
    const classId = makeObjectId();
    seedMembership(classId, "u1");
    setupMembershipFindChain(
      Array.from(membershipStore.values()).filter((m) =>
        m.classId.toHexString() === classId.toHexString(),
      ),
    );
    setupProfileBatch([makeStudentProfile("u1")]);
    setupCreateReject({
      code: 11000,
      keyValue: { somethingElse: "x" },
    });

    await expect(
      createAttendanceSession({
        classId,
        startedByUserId: "teacher-1",
      }),
    ).rejects.toMatchObject({
      code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_SESSION_CREATE_FAILED,
    });
  });

  it("maps a non-Mongo error to ATTENDANCE_SESSION_CREATE_FAILED", async () => {
    const classId = makeObjectId();
    seedMembership(classId, "u1");
    setupMembershipFindChain(
      Array.from(membershipStore.values()).filter((m) =>
        m.classId.toHexString() === classId.toHexString(),
      ),
    );
    setupProfileBatch([makeStudentProfile("u1")]);
    setupCreateReject(new Error("ECONNREFUSED 10.0.0.1:27017"));

    await expect(
      createAttendanceSession({
        classId,
        startedByUserId: "teacher-1",
      }),
    ).rejects.toMatchObject({
      code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_SESSION_CREATE_FAILED,
    });
  });

  it("propagates an explicit ATTENDANCE_ROSTER_INVALID from the snapshot builder", async () => {
    const classId = makeObjectId();
    seedMembership(classId, "orphaned-user");
    setupMembershipFindChain(
      Array.from(membershipStore.values()).filter((m) =>
        m.classId.toHexString() === classId.toHexString(),
      ),
    );
    setupProfileBatch([]);

    await expect(
      createAttendanceSession({
        classId,
        startedByUserId: "teacher-1",
      }),
    ).rejects.toMatchObject({
      code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_ROSTER_INVALID,
    });
  });
});

// =============================================================================
// 18..21 — Atomic stop CAS
// =============================================================================

describe("closeActiveAttendanceSessionForClass", () => {
  it("18. CAS filter requires status = active; closed sessions are not touched", async () => {
    const classId = makeObjectId();
    setupSessionFindOneAndUpdateChain(async (filter, _update) => {
      expect(filter.classId?.toHexString()).toBe(classId.toHexString());
      expect(filter.status).toBe("active");
      return null;
    });

    await expect(
      closeActiveAttendanceSessionForClass(classId),
    ).rejects.toMatchObject({
      code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_SESSION_NOT_ACTIVE,
    });
    expect(mockSessionFindOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("19/20. successful close sets status='closed' and endedAt; preserves rosterSnapshot", async () => {
    const classId = makeObjectId();
    const sessionId = makeObjectId();
    const roster: StoredRosterItem[] = [
      {
        studentUserId: "u1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "S-1",
      },
    ];
    setupSessionFindOneAndUpdateChain(async (_filter, update) => {
      expect(update.$set?.status).toBe("closed");
      expect(update.$set?.endedAt).toBeInstanceOf(Date);
      return {
        _id: sessionId,
        classId,
        status: "closed",
        startedAt: new Date("2026-09-16T10:00:00Z"),
        endedAt: update.$set?.endedAt ?? new Date(),
        startedByUserId: "teacher-1",
        rosterSnapshot: roster,
        createdAt: new Date("2026-09-16T10:00:00Z"),
        updatedAt: new Date("2026-09-16T10:00:00Z"),
      };
    });

    const closed = await closeActiveAttendanceSessionForClass(classId);
    expect(closed.status).toBe("closed");
    expect(closed.endedAt).toBeInstanceOf(Date);
    // rosterSnapshot is preserved verbatim — close NEVER mutates it.
    expect(closed.rosterSnapshot).toEqual(roster);
  });

  it("21. returned AttendanceSessionServiceError carries the typed NOT_ACTIVE code", async () => {
    const classId = makeObjectId();
    setupSessionFindOneAndUpdateChain(async () => null);

    try {
      await closeActiveAttendanceSessionForClass(classId);
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(AttendanceSessionServiceError);
      expect((err as AttendanceSessionServiceError).code).toBe(
        ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_SESSION_NOT_ACTIVE,
      );
    }
  });
});

// =============================================================================
// findActiveAttendanceSessionByClassId — basic shape
// =============================================================================

describe("findActiveAttendanceSessionByClassId", () => {
  it("returns null when no active session exists", async () => {
    const classId = makeObjectId();
    setupSessionFindOneChain(null);

    const result = await findActiveAttendanceSessionByClassId(classId);
    expect(result).toBeNull();
  });

  it("encodes the active status into the query filter", async () => {
    const classId = makeObjectId();
    mockSessionFindOne.mockImplementationOnce((filter: {
      classId?: Types.ObjectId;
      status?: string;
    }) => {
      expect(filter.classId?.toHexString()).toBe(classId.toHexString());
      expect(filter.status).toBe("active");
      const query = {
        lean: () => query,
        exec: async () => null,
      };
      return query;
    });

    await findActiveAttendanceSessionByClassId(classId);
    expect(mockSessionFindOne).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// toSafeAttendanceSessionSummary — projection shape
// =============================================================================

describe("toSafeAttendanceSessionSummary", () => {
  it("projects only the documented safe keys (no rosterSnapshot, no startedByUserId)", () => {
    const doc = {
      _id: { toString: () => "65f0000000000000000000a1" } as unknown,
      classId: new Types.ObjectId("507f1f77bcf86cd799439011"),
      status: "active" as const,
      startedAt: new Date("2026-09-16T10:00:00Z"),
      endedAt: null,
      startedByUserId: "teacher-1",
      rosterSnapshot: [
        {
          studentUserId: "u1",
          fullNameSnapshot: "Alice",
          identificationCodeSnapshot: "S-1",
        },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const safe = toSafeAttendanceSessionSummary(
      doc as unknown as Parameters<typeof toSafeAttendanceSessionSummary>[0],
    );
    const keys = Object.keys(safe).sort();
    expect(keys).toEqual([
      "endedAt",
      "id",
      "rosterCount",
      "startedAt",
      "status",
    ]);
    expect(safe.id).toBe("65f0000000000000000000a1");
    expect(safe.status).toBe("active");
    expect(safe.rosterCount).toBe(1);
    expect(safe.endedAt).toBeNull();
    expect(safe.startedAt).toBe("2026-09-16T10:00:00.000Z");
  });

  it("returns rosterCount = 0 when snapshot is empty", () => {
    const doc = {
      _id: { toString: () => "65f0000000000000000000a2" } as unknown,
      classId: new Types.ObjectId("507f1f77bcf86cd799439012"),
      status: "closed" as const,
      startedAt: new Date(),
      endedAt: new Date(),
      startedByUserId: "teacher-1",
      rosterSnapshot: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const safe = toSafeAttendanceSessionSummary(
      doc as unknown as Parameters<typeof toSafeAttendanceSessionSummary>[0],
    );
    expect(safe.rosterCount).toBe(0);
    expect(safe.status).toBe("closed");
  });
});
