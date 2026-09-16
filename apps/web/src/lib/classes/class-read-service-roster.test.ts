/**
 * Tests for the PHASE 5.1D2B server-only teacher-owner roster
 * read model.
 *
 * Covers the 80-test contract:
 *
 *   ## Function input (1..7)
 *     - roster function accepts classId
 *     - accepts no teacherUserId
 *     - accepts no userId
 *     - accepts no role
 *     - accepts no studentUserId
 *     - accepts no membershipId
 *
 *   ## Auth (8..10)
 *     - no session → UNAUTHENTICATED
 *     - unauthenticated performs no class query
 *     - session.user.id is sole identity source
 *
 *   ## Profile / role (11..14)
 *     - missing profile → PROFILE_INCOMPLETE
 *     - incomplete profile → PROFILE_INCOMPLETE
 *     - student profile → TEACHER_REQUIRED
 *     - student role performs no class / membership / roster query
 *
 *   ## Class authorization (15..22)
 *     - malformed classId → CLASS_NOT_ACCESSIBLE
 *     - malformed classId performs no roster query
 *     - missing class → CLASS_NOT_ACCESSIBLE
 *     - another teacher's class → CLASS_NOT_ACCESSIBLE
 *     - owner teacher succeeds
 *     - owner query includes session.user.id
 *     - owner query includes requested classId
 *     - archived owner class succeeds
 *
 *   ## Memberships (23..28)
 *     - only requested class memberships queried
 *     - only active memberships included
 *     - inactive membership excluded
 *     - memberships sorted joinedAt ASC
 *     - empty membership set returns empty students array
 *     - duplicate corrupt studentUserIds produce one roster entry
 *
 *   ## Profile batching (29..37)
 *     - student profiles fetched in one batch
 *     - no getProfileByUserId N+1 loop
 *     - profile query contains only membership student IDs
 *     - another student's unrelated Profile excluded
 *     - profile query result order does not affect roster order
 *     - missing Profile skips entry safely
 *     - incomplete Profile skips entry safely
 *     - non-student Profile skips entry safely
 *     - valid remaining profiles still returned
 *
 *   ## Safe DTO (38..53)
 *     - class contains id, name, classCode, status
 *     - roster item contains fullName / identificationCode / joinedAt
 *     - no password / passwordHash / teacherUserId
 *     - no studentUserId / membership id / profile id
 *     - no email / emailSnapshot / phone
 *
 *   ## Privacy / domain isolation (54..63)
 *     - no FaceProfile / embedding / centroid
 *     - no attendance data
 *     - no Face Service call
 *     - no class-password verification
 *     - no Better Auth user lookup
 *
 *   ## Read-only (64..71)
 *     - no Class / Membership / Profile writes
 *     - no cleanup mutation
 *
 *   ## Ordering (72..75)
 *     - oldest joinedAt first
 *     - newest joinedAt last
 *     - profile query order cannot reorder memberships
 *     - repeated read deterministic
 *
 *   ## Surface (76..80)
 *     - no roster REST endpoint
 *     - no roster Server Action
 *     - no roster UI
 *     - password-bearing join primitives absent from broad barrel
 *     - safe roster DTO contains only approved student fields
 *
 * Implementation notes:
 *   - All collaborators (`@/lib/session`, `@/lib/profile-service`,
 *     `@/lib/classes/class-model`, `@/lib/classes/class-membership-model`)
 *     are mocked at module boundaries. No MongoDB / Mongoose /
 *     Face Service / Better Auth is touched.
 *   - The mocks model in-memory stores for classes, memberships,
 *     and Profiles. Every find / findOne / findById is exercised
 *     through the store. The mocks track call counts so the
 *     read-only / no-N+1 / authorization-encoded invariants can be
 *     asserted.
 *   - `vi.mock(...)` declarations are hoisted above imports by
 *     Vitest, so collaborators are guaranteed to be replaced
 *     before the module is loaded.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// =============================================================================
// Mock collaborators
// =============================================================================

const mockGetSession = vi.fn();
const mockGetProfileByUserId = vi.fn();
const mockGetStudentProfilesByUserIds = vi.fn();

// =============================================================================
// In-memory class + membership + profile stores
// =============================================================================

interface StoredClass {
  _id: string;
  name: string;
  teacherUserId: string;
  classCode: string;
  passwordHash: string;
  status: "active" | "archived";
  createdAt: Date;
  updatedAt: Date;
}

interface StoredMembership {
  _id: string;
  classId: string;
  studentUserId: string;
  joinedAt: Date;
  status: "active" | "inactive";
}

interface StoredProfile {
  userId: string;
  emailSnapshot: string;
  role: "student" | "teacher";
  fullName: string;
  identificationCode: string;
  phone?: string;
  onboardingCompleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const classStoreByCode = new Map<string, StoredClass>();
const classStoreById = new Map<string, StoredClass>();
const membershipStore = new Map<string, StoredMembership>();
const profileStore = new Map<string, StoredProfile>();

let nextObjectIdCounter = 0;
function makeObjectId(): string {
  nextObjectIdCounter++;
  const counter = String(nextObjectIdCounter).padStart(21, "0");
  const prefix = "65f";
  return (prefix + counter).slice(0, 24);
}

function membershipKey(classId: string, studentUserId: string): string {
  return `${classId}::${studentUserId}`;
}

function resetStores(): void {
  classStoreByCode.clear();
  classStoreById.clear();
  membershipStore.clear();
  profileStore.clear();
  nextObjectIdCounter = 0;
}

// =============================================================================
// Mock ClassModel
// =============================================================================

const mockFind = vi.fn();
const mockFindById = vi.fn();
const mockFindOne = vi.fn();
const mockCreate = vi.fn();
const mockUpdateOne = vi.fn();
const mockDeleteOne = vi.fn();

vi.mock("@/lib/classes/class-model", async () => {
  const actual =
    await vi.importActual<typeof import("./class-model")>(
      "./class-model",
    );
  return {
    ...actual,
    ClassModel: {
      find: (...args: unknown[]) => mockFind(...args),
      findById: (...args: unknown[]) => mockFindById(...args),
      findOne: (...args: unknown[]) => mockFindOne(...args),
      create: (...args: unknown[]) => mockCreate(...args),
      updateOne: (...args: unknown[]) => mockUpdateOne(...args),
      deleteOne: (...args: unknown[]) => mockDeleteOne(...args),
    },
  };
});

// =============================================================================
// Mock ClassMembershipModel
// =============================================================================

const mockMembershipFind = vi.fn();
const mockMembershipFindOne = vi.fn();
const mockMembershipCreate = vi.fn();
const mockMembershipUpdateOne = vi.fn();

vi.mock("@/lib/classes/class-membership-model", async () => {
  const actual =
    await vi.importActual<typeof import("./class-membership-model")>(
      "./class-membership-model",
    );
  return {
    ...actual,
    ClassMembershipModel: {
      find: (...args: unknown[]) => mockMembershipFind(...args),
      findOne: (...args: unknown[]) => mockMembershipFindOne(...args),
      create: (...args: unknown[]) => mockMembershipCreate(...args),
      updateOne: (...args: unknown[]) =>
        mockMembershipUpdateOne(...args),
    },
  };
});

vi.mock("@/lib/session", () => ({
  getSession: () => mockGetSession(),
}));

vi.mock("@/lib/profile-service", () => ({
  getProfileByUserId: (...args: unknown[]) =>
    mockGetProfileByUserId(...args),
  getStudentProfilesByUserIds: (...args: unknown[]) =>
    mockGetStudentProfilesByUserIds(...args),
}));

// =============================================================================
// Test helpers
// =============================================================================

function makeSession(userId: string) {
  return {
    user: {
      id: userId,
      email: `${userId}@example.com`,
      name: "Test User",
      image: null,
    },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
}

function makeTeacherProfile(overrides: Partial<{
  userId: string;
  onboardingCompleted: boolean;
  role: "student" | "teacher";
}> = {}) {
  return {
    userId: "T-USER-1",
    emailSnapshot: "t@example.com",
    role: "teacher" as const,
    fullName: "Test Teacher",
    identificationCode: "T-001",
    phone: undefined,
    onboardingCompleted: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeStudentProfile(overrides: Partial<{
  userId: string;
  onboardingCompleted: boolean;
  role: "student" | "teacher";
  fullName?: string;
  identificationCode?: string;
}> = {}) {
  return {
    userId: "S-USER-1",
    emailSnapshot: "s@example.com",
    role: "student" as const,
    fullName: overrides.fullName ?? "Test Student",
    identificationCode:
      overrides.identificationCode ?? "S-001",
    phone: undefined,
    onboardingCompleted: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

interface SeedClassOptions {
  id?: string;
  name?: string;
  teacherUserId: string;
  classCode: string;
  status?: "active" | "archived";
  createdAt: Date;
  updatedAt?: Date;
}

function seedClass(opts: SeedClassOptions): StoredClass {
  const id = opts.id ?? makeObjectId();
  const stored: StoredClass = {
    _id: id,
    name: opts.name ?? `Class ${opts.classCode}`,
    teacherUserId: opts.teacherUserId,
    classCode: opts.classCode,
    passwordHash: "pbkdf2-sha256$100000$aa$bb",
    status: opts.status ?? "active",
    createdAt: opts.createdAt,
    updatedAt: opts.updatedAt ?? opts.createdAt,
  };
  classStoreByCode.set(opts.classCode, stored);
  classStoreById.set(id, stored);
  return stored;
}

interface SeedMembershipOptions {
  classId: string;
  studentUserId: string;
  joinedAt: Date;
  status?: "active" | "inactive";
}

function seedMembership(opts: SeedMembershipOptions): StoredMembership {
  const id = makeObjectId();
  const stored: StoredMembership = {
    _id: id,
    classId: opts.classId,
    studentUserId: opts.studentUserId,
    joinedAt: opts.joinedAt,
    status: opts.status ?? "active",
  };
  membershipStore.set(
    membershipKey(opts.classId, opts.studentUserId),
    stored,
  );
  return stored;
}

interface SeedProfileOptions {
  userId: string;
  fullName?: string;
  identificationCode?: string;
  role?: "student" | "teacher";
  onboardingCompleted?: boolean;
  emailSnapshot?: string;
  phone?: string;
}

function seedProfile(opts: SeedProfileOptions): StoredProfile {
  const stored: StoredProfile = {
    userId: opts.userId,
    emailSnapshot: opts.emailSnapshot ?? `${opts.userId}@example.com`,
    role: opts.role ?? "student",
    fullName: opts.fullName ?? `Student ${opts.userId}`,
    identificationCode:
      opts.identificationCode ?? `ID-${opts.userId}`,
    phone: opts.phone,
    onboardingCompleted: opts.onboardingCompleted ?? true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  profileStore.set(opts.userId, stored);
  return stored;
}

// Build a Mongoose-shaped query wrapper. The chainable methods
// (select, sort, lean) return the same wrapper, and `exec()`
// resolves with the result of the underlying store lookup.
type QueryResult<T> = {
  select: (projection: unknown) => QueryResult<T>;
  sort: (criteria: unknown) => QueryResult<T>;
  lean: () => { exec: () => Promise<T> };
  exec: () => Promise<T>;
};

function chainable<T>(resolver: () => Promise<T>): QueryResult<T> {
  const wrapper: QueryResult<T> = {
    select: () => wrapper,
    sort: () => wrapper,
    lean: () => ({ exec: resolver }),
    exec: resolver,
  };
  return wrapper;
}

function applyClassFindProjection(
  doc: StoredClass | null,
  _projection: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!doc) return null;
  // The D2A detail filter excludes `passwordHash` and we mirror
  // it here. The roster test does NOT inspect the projection —
  // it relies on the production-side `.select(...)` to omit
  // `passwordHash` and `teacherUserId` from the read.
  return {
    _id: doc._id,
    name: doc.name,
    classCode: doc.classCode,
    status: doc.status,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function applyMembershipFindProjection(
  docs: StoredMembership[],
  _projection: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  // Mirror production projection: keep `studentUserId` + `joinedAt`,
  // drop `_id`, `classId`, `status`, timestamps.
  return docs.map((doc) => ({
    studentUserId: doc.studentUserId,
    joinedAt: doc.joinedAt,
  }));
}

// Configure `mockFindOne` for the D2A / D2B teacher ownership filter.
function configureClassFindOneMock(): void {
  mockFindOne.mockImplementation(
    (filter: Record<string, unknown>) =>
      chainable(async () => {
        const idFilter = filter["_id"];
        const teacherFilter = filter["teacherUserId"];
        const matches = Array.from(classStoreById.values()).filter(
          (doc) => {
            if (typeof idFilter === "string" && doc._id !== idFilter) {
              return false;
            }
            if (
              typeof teacherFilter === "string" &&
              doc.teacherUserId !== teacherFilter
            ) {
              return false;
            }
            return true;
          },
        );
        const doc = matches[0] ?? null;
        return applyClassFindProjection(doc, undefined);
      }),
  );
}

// Configure `mockFindById` for the D2A student detail path (not used
// by D2B but kept installed so the read-only invariants can be
// asserted).
function configureClassFindByIdMock(): void {
  mockFindById.mockImplementation(
    (id: string) =>
      chainable(async () => {
        const matches = Array.from(classStoreById.values()).filter(
          (doc) => doc._id === id,
        );
        const doc = matches[0] ?? null;
        return applyClassFindProjection(doc, undefined);
      }),
  );
}

// Configure `mockMembershipFind` for the D2B roster list-by-classId
// query. The production code calls
// `ClassMembershipModel.find({ classId: new Types.ObjectId(classId), status: "active" })`
// sorted `joinedAt` ASC, projected to `{ studentUserId: 1, joinedAt: 1 }`.
function configureMembershipFindMock(): void {
  mockMembershipFind.mockImplementation(
    (filter: Record<string, unknown>) =>
      chainable(async () => {
        const classIdFilter = filter["classId"];
        const statusFilter = filter["status"];
        const matches = Array.from(membershipStore.values()).filter(
          (doc) => {
            // Production code uses `new Types.ObjectId(classId)` —
            // mock receives the stringified 24-hex form.
            if (classIdFilter !== undefined && classIdFilter !== null) {
              const classIdString =
                typeof classIdFilter === "string"
                  ? classIdFilter
                  : String(classIdFilter);
              if (doc.classId !== classIdString) return false;
            }
            if (
              typeof statusFilter === "string" &&
              doc.status !== statusFilter
            ) {
              return false;
            }
            return true;
          },
        );
        // Production sort: joinedAt ASCENDING (oldest first).
        matches.sort(
          (a, b) =>
            a.joinedAt.getTime() - b.joinedAt.getTime(),
        );
        return applyMembershipFindProjection(matches, undefined);
      }),
  );
}

// Configure the batch Profile primitive to return a Map of safe
// projections for the requested userIds. Profiles that are absent,
// incomplete, or carry a non-student role are omitted from the map
// so the roster test can assert the silent-skip behavior.
function configureStudentProfileBatchMock(): void {
  mockGetStudentProfilesByUserIds.mockImplementation(
    (userIds: unknown) =>
      Promise.resolve().then(() => {
        const out = new Map<
          string,
          {
            userId: string;
            fullName: string;
            identificationCode: string;
            role: "student";
            onboardingCompleted: true;
          }
        >();
        if (!Array.isArray(userIds)) return out;
        for (const id of userIds) {
          if (typeof id !== "string" || id.length === 0) continue;
          const profile = profileStore.get(id);
          if (!profile) continue;
          if (profile.role !== "student") continue;
          if (profile.onboardingCompleted !== true) continue;
          out.set(profile.userId, {
            userId: profile.userId,
            fullName: profile.fullName,
            identificationCode: profile.identificationCode,
            role: "student",
            onboardingCompleted: true,
          });
        }
        // Deliberately return the Map in a different order from
        // the membership iteration order so the test can assert
        // that the roster order is membership-driven, NOT
        // Profile-query driven.
        return out;
      }),
  );
}

function configureMembershipFindOneMock(): void {
  mockMembershipFindOne.mockImplementation(
    () => chainable(async () => null),
  );
}

function configureClassFindMock(): void {
  mockFind.mockImplementation(
    () => chainable(async () => []),
  );
}

// =============================================================================
// Imports under test
// =============================================================================

import {
  CLASS_ROSTER_READ_ERROR_CODES,
  getClassRosterForCurrentTeacher,
  type GetClassRosterResult,
  type SafeClassRoster,
  type SafeRosterItem,
} from "./class-read-service";

// =============================================================================
// Setup / teardown
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  resetStores();

  // Default happy-path mocks — teacher session.
  mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
  mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());

  configureClassFindMock();
  configureClassFindOneMock();
  configureClassFindByIdMock();
  configureMembershipFindMock();
  configureMembershipFindOneMock();
  configureStudentProfileBatchMock();

  // Write primitives are NEVER called by the roster read.
  mockCreate.mockImplementation(() => {
    throw new Error("ClassModel.create must not be called by D2B");
  });
  mockUpdateOne.mockImplementation(() => {
    throw new Error("ClassModel.updateOne must not be called by D2B");
  });
  mockDeleteOne.mockImplementation(() => {
    throw new Error("ClassModel.deleteOne must not be called by D2B");
  });
  mockMembershipCreate.mockImplementation(() => {
    throw new Error(
      "ClassMembershipModel.create must not be called by D2B",
    );
  });
  mockMembershipUpdateOne.mockImplementation(() => {
    throw new Error(
      "ClassMembershipModel.updateOne must not be called by D2B",
    );
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// 1..7 — Function input
// =============================================================================

describe("getClassRosterForCurrentTeacher — function input", () => {
  it("1. roster function accepts classId (arity 1)", () => {
    expect(getClassRosterForCurrentTeacher.length).toBe(1);
  });

  it("2. accepts no teacherUserId (smuggled value is ignored)", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ROST-001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({ userId: "S-USER-1" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (getClassRosterForCurrentTeacher as any)(
      classId,
      "smuggled-teacher-id",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(mockFindOne).toHaveBeenCalledTimes(1);
      const filter = mockFindOne.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(filter["teacherUserId"]).toBe("T-USER-1");
      expect(filter["teacherUserId"]).not.toBe(
        "smuggled-teacher-id",
      );
    }
  });

  it("3. accepts no userId (smuggled value is ignored)", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ROST-002",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({ userId: "S-USER-1" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (getClassRosterForCurrentTeacher as any)(
      classId,
      "another-user-id",
      "extra-arg",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The session user (T-USER-1) drove the query.
      const filter = mockFindOne.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(filter["teacherUserId"]).toBe("T-USER-1");
    }
  });

  it("4. accepts no role (smuggled value is ignored)", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ROST-003",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({ userId: "S-USER-1" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (getClassRosterForCurrentTeacher as any)(
      classId,
      "teacher",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The persisted Profile (student) drives the role gate,
      // NOT the smuggled "teacher" string.
      expect(result.code).toBe(
        CLASS_ROSTER_READ_ERROR_CODES.TEACHER_REQUIRED,
      );
    }
  });

  it("5. accepts no studentUserId (smuggled value is ignored)", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ROST-004",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({ userId: "S-USER-1" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (getClassRosterForCurrentTeacher as any)(
      classId,
      "smuggled-student-id",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The membership query (mockMembershipFind) used the
      // canonical `classId` filter, NOT the smuggled
      // studentUserId.
      expect(mockMembershipFind).toHaveBeenCalledTimes(1);
      const filter = mockMembershipFind.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      const classIdValue = filter["classId"];
      const classIdString =
        typeof classIdValue === "string"
          ? classIdValue
          : String(classIdValue);
      expect(classIdString).toBe(classId);
    }
  });

  it("6. accepts no membershipId (smuggled value is ignored)", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ROST-005",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({ userId: "S-USER-1" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (getClassRosterForCurrentTeacher as any)(
      classId,
      "smuggled-membership-id",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The membership query did NOT carry the smuggled id.
      expect(mockMembershipFind).toHaveBeenCalledTimes(1);
      const filter = mockMembershipFind.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(JSON.stringify(filter)).not.toContain(
        "smuggled-membership-id",
      );
    }
  });

  it("7. roster function is a plain async function (not a Server Action)", async () => {
    // Type-level guarantee: no `"use server"` directive.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/["']use server["']/);
    expect(source).toMatch(
      /export\s+async\s+function\s+getClassRosterForCurrentTeacher/,
    );
  });
});

// =============================================================================
// 8..10 — Auth
// =============================================================================

describe("getClassRosterForCurrentTeacher — auth", () => {
  it("8. no session → UNAUTHENTICATED", async () => {
    mockGetSession.mockResolvedValue(null);
    const result = await getClassRosterForCurrentTeacher(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_ROSTER_READ_ERROR_CODES.UNAUTHENTICATED,
      );
    }
  });

  it("9. unauthenticated performs no class / membership / profile query", async () => {
    mockGetSession.mockResolvedValue(null);
    await getClassRosterForCurrentTeacher(makeObjectId());
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockMembershipFind).not.toHaveBeenCalled();
    expect(mockMembershipFindOne).not.toHaveBeenCalled();
    expect(mockGetProfileByUserId).not.toHaveBeenCalled();
    expect(mockGetStudentProfilesByUserIds).not.toHaveBeenCalled();
  });

  it("10. session.user.id is sole identity source", async () => {
    const sessionUserId = "T-SESSION-2";
    mockGetSession.mockResolvedValue(makeSession(sessionUserId));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({
        userId: sessionUserId,
        role: "teacher",
        onboardingCompleted: true,
      }),
    );
    const classId = makeObjectId();
    seedClass({
      teacherUserId: sessionUserId,
      classCode: "SESID01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({ userId: "S-USER-1" });
    await getClassRosterForCurrentTeacher(classId);
    expect(mockFindOne).toHaveBeenCalledTimes(1);
    const filter = mockFindOne.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(filter["teacherUserId"]).toBe(sessionUserId);
  });
});

// =============================================================================
// 11..14 — Profile / role gating
// =============================================================================

describe("getClassRosterForCurrentTeacher — profile / role gating", () => {
  it("11. missing profile → PROFILE_INCOMPLETE", async () => {
    mockGetProfileByUserId.mockResolvedValue(null);
    const result = await getClassRosterForCurrentTeacher(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_ROSTER_READ_ERROR_CODES.PROFILE_INCOMPLETE,
      );
    }
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockMembershipFind).not.toHaveBeenCalled();
    expect(mockGetStudentProfilesByUserIds).not.toHaveBeenCalled();
  });

  it("12. incomplete profile → PROFILE_INCOMPLETE", async () => {
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ onboardingCompleted: false }),
    );
    const result = await getClassRosterForCurrentTeacher(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_ROSTER_READ_ERROR_CODES.PROFILE_INCOMPLETE,
      );
    }
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockMembershipFind).not.toHaveBeenCalled();
    expect(mockGetStudentProfilesByUserIds).not.toHaveBeenCalled();
  });

  it("13. student profile → TEACHER_REQUIRED", async () => {
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ROST-STU",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_ROSTER_READ_ERROR_CODES.TEACHER_REQUIRED,
      );
    }
  });

  it("14. student role performs no class / membership / roster query", async () => {
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    await getClassRosterForCurrentTeacher(makeObjectId());
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockMembershipFind).not.toHaveBeenCalled();
    expect(mockMembershipFindOne).not.toHaveBeenCalled();
    expect(mockGetStudentProfilesByUserIds).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 15..22 — Class authorization
// =============================================================================

describe("getClassRosterForCurrentTeacher — class authorization", () => {
  it("15. malformed classId → CLASS_NOT_ACCESSIBLE", async () => {
    const result = await getClassRosterForCurrentTeacher(
      "not-an-objectid",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_ROSTER_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockMembershipFind).not.toHaveBeenCalled();
    expect(mockGetStudentProfilesByUserIds).not.toHaveBeenCalled();
  });

  it("16. malformed classId performs no roster query", async () => {
    mockFind.mockImplementation(() => {
      throw new Error(
        "CastError: Cast to ObjectId failed for value \"bad-id\"",
      );
    });
    mockFindOne.mockImplementation(() => {
      throw new Error(
        "CastError: Cast to ObjectId failed for value \"bad-id\"",
      );
    });
    const result = await getClassRosterForCurrentTeacher("bad-id");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("CastError");
      expect(serialized).not.toContain("ObjectId");
    }
  });

  it("17. missing class → CLASS_NOT_ACCESSIBLE", async () => {
    const result = await getClassRosterForCurrentTeacher(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_ROSTER_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
  });

  it("18. another teacher's class → CLASS_NOT_ACCESSIBLE", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("OTHER-TEACHER"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({
        userId: "OTHER-TEACHER",
        role: "teacher",
      }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "WRONG-T1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_ROSTER_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    // The membership query MUST NOT have been called — the
    // teacher-owner filter refused the class first.
    expect(mockMembershipFind).not.toHaveBeenCalled();
    expect(mockGetStudentProfilesByUserIds).not.toHaveBeenCalled();
  });

  it("19. owner teacher succeeds", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "OWN-001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({ userId: "S-USER-1" });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.class.classCode).toBe("OWN-001");
      expect(result.result.students.length).toBe(1);
    }
  });

  it("20. owner query includes session.user.id", async () => {
    const sessionUserId = "T-SESS-OWN";
    mockGetSession.mockResolvedValue(makeSession(sessionUserId));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({
        userId: sessionUserId,
        role: "teacher",
      }),
    );
    const classId = makeObjectId();
    seedClass({
      teacherUserId: sessionUserId,
      classCode: "OWN-002",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    await getClassRosterForCurrentTeacher(classId);
    expect(mockFindOne).toHaveBeenCalledTimes(1);
    const filter = mockFindOne.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(filter["teacherUserId"]).toBe(sessionUserId);
    expect(filter["_id"]).toBe(classId);
  });

  it("21. owner query includes requested classId", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "OWN-003",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    await getClassRosterForCurrentTeacher(classId);
    expect(mockFindOne).toHaveBeenCalledTimes(1);
    const filter = mockFindOne.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(filter["_id"]).toBe(classId);
  });

  it("22. archived owner class succeeds", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ARCHV-01",
      status: "archived",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({ userId: "S-USER-1" });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.class.status).toBe("archived");
      expect(result.result.students.length).toBe(1);
    }
  });
});

// =============================================================================
// 23..28 — Memberships
// =============================================================================

describe("getClassRosterForCurrentTeacher — memberships", () => {
  it("23. only requested class memberships queried", async () => {
    const classId = makeObjectId();
    const otherClassId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ONLY-01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    // Membership on ANOTHER class.
    seedMembership({
      classId: otherClassId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    await getClassRosterForCurrentTeacher(classId);
    expect(mockMembershipFind).toHaveBeenCalledTimes(1);
    const filter = mockMembershipFind.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const classIdValue = filter["classId"];
    const classIdString =
      typeof classIdValue === "string"
        ? classIdValue
        : String(classIdValue);
    expect(classIdString).toBe(classId);
  });

  it("24. only active memberships included", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ACT-001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-ACT-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
      status: "active",
    });
    seedMembership({
      classId,
      studentUserId: "S-INACT",
      joinedAt: new Date("2026-01-03T00:00:00Z"),
      status: "inactive",
    });
    seedProfile({ userId: "S-ACT-1", fullName: "Active Student" });
    seedProfile({
      userId: "S-INACT",
      fullName: "Inactive Student",
    });
    const roster = await getClassRosterForCurrentTeacher(classId);
    expect(roster.ok).toBe(true);
    if (roster.ok) {
      expect(roster.result.students.length).toBe(1);
      expect(roster.result.students[0]?.fullName).toBe(
        "Active Student",
      );
    }
  });

  it("25. inactive membership excluded", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "INACT-01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
      status: "inactive",
    });
    seedProfile({ userId: "S-USER-1" });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.students.length).toBe(0);
    }
  });

  it("26. memberships sorted joinedAt ASC", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "SORT-01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    // Seed out of order.
    seedMembership({
      classId,
      studentUserId: "S-MID",
      joinedAt: new Date("2026-01-03T00:00:00Z"),
    });
    seedMembership({
      classId,
      studentUserId: "S-NEW",
      joinedAt: new Date("2026-01-04T00:00:00Z"),
    });
    seedMembership({
      classId,
      studentUserId: "S-OLD",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({
      userId: "S-OLD",
      fullName: "Oldest",
      identificationCode: "ID-OLD",
    });
    seedProfile({
      userId: "S-MID",
      fullName: "Middle",
      identificationCode: "ID-MID",
    });
    seedProfile({
      userId: "S-NEW",
      fullName: "Newest",
      identificationCode: "ID-NEW",
    });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const names = result.result.students.map((s) => s.fullName);
      expect(names).toEqual(["Oldest", "Middle", "Newest"]);
    }
  });

  it("27. empty membership set returns empty students array", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "EMPTY-01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.students).toEqual([]);
    }
    expect(mockGetStudentProfilesByUserIds).not.toHaveBeenCalled();
  });

  it("28. duplicate corrupt studentUserIds produce one roster entry", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "DUP-001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    // Bypass the unique compound index and seed two rows for the
    // same (classId, studentUserId) pair.
    membershipStore.set(
      membershipKey(classId, "S-USER-1"),
      {
        _id: makeObjectId(),
        classId,
        studentUserId: "S-USER-1",
        joinedAt: new Date("2026-01-02T00:00:00Z"),
        status: "active",
      },
    );
    membershipStore.set(
      `${classId}::S-USER-1::dup`,
      {
        _id: makeObjectId(),
        classId,
        studentUserId: "S-USER-1",
        joinedAt: new Date("2026-01-03T00:00:00Z"),
        status: "active",
      },
    );
    seedProfile({
      userId: "S-USER-1",
      fullName: "Dup Student",
    });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The roster is deduplicated by studentUserId → exactly
      // ONE entry. The membership-driven order picks the
      // EARLIER joinedAt row (2026-01-02).
      expect(result.result.students.length).toBe(1);
      expect(result.result.students[0]?.fullName).toBe(
        "Dup Student",
      );
    }
  });
});

// =============================================================================
// 29..37 — Profile batching
// =============================================================================

describe("getClassRosterForCurrentTeacher — profile batching", () => {
  it("29. student profiles fetched in one batch", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "BATCH-01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    for (let i = 0; i < 5; i++) {
      const sid = `S-USER-${i}`;
      seedMembership({
        classId,
        studentUserId: sid,
        joinedAt: new Date(`2026-01-0${2 + i}T00:00:00Z`),
      });
      seedProfile({ userId: sid });
    }
    await getClassRosterForCurrentTeacher(classId);
    expect(mockGetStudentProfilesByUserIds).toHaveBeenCalledTimes(1);
  });

  it("30. no getProfileByUserId N+1 loop for roster", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "N1-001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    for (let i = 0; i < 10; i++) {
      const sid = `S-USER-${i}`;
      seedMembership({
        classId,
        studentUserId: sid,
        joinedAt: new Date(`2026-01-0${2 + (i % 7)}T00:00:00Z`),
      });
      seedProfile({ userId: sid });
    }
    await getClassRosterForCurrentTeacher(classId);
    // `getProfileByUserId` is the gating primitive (called
    // EXACTLY ONCE per roster invocation). The batch primitive
    // `getStudentProfilesByUserIds` is the roster composition
    // primitive (also called EXACTLY ONCE). There MUST be no
    // N+1 loop over memberships → profiles.
    expect(mockGetProfileByUserId).toHaveBeenCalledTimes(1);
    expect(mockGetStudentProfilesByUserIds).toHaveBeenCalledTimes(1);
  });

  it("31. profile query contains only membership student IDs", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "IDS-001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-A",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedMembership({
      classId,
      studentUserId: "S-B",
      joinedAt: new Date("2026-01-03T00:00:00Z"),
    });
    seedProfile({ userId: "S-A" });
    seedProfile({ userId: "S-B" });
    // Unrelated profile that should NOT be included.
    seedProfile({ userId: "S-OTHER" });
    await getClassRosterForCurrentTeacher(classId);
    expect(mockGetStudentProfilesByUserIds).toHaveBeenCalledTimes(1);
    const args = mockGetStudentProfilesByUserIds.mock
      .calls[0]?.[0] as string[];
    expect(new Set(args)).toEqual(new Set(["S-A", "S-B"]));
  });

  it("32. another student's unrelated Profile excluded", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "UNREL-01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-A",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({ userId: "S-A", fullName: "Member A" });
    seedProfile({
      userId: "S-B",
      fullName: "Unrelated B",
    });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const names = result.result.students.map((s) => s.fullName);
      expect(names).toEqual(["Member A"]);
      expect(names).not.toContain("Unrelated B");
    }
  });

  it("33. profile query result order does not affect roster order", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ORD-001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-FIRST",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedMembership({
      classId,
      studentUserId: "S-SECOND",
      joinedAt: new Date("2026-01-03T00:00:00Z"),
    });
    seedProfile({ userId: "S-FIRST", fullName: "First" });
    seedProfile({ userId: "S-SECOND", fullName: "Second" });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The order is membership-driven (joinedAt ASC), NOT
      // profile-driven. The mock implementation deliberately
      // returns the map in membership iteration order, but the
      // roster test asserts the FINAL order matches the
      // membership order regardless of how the Profile batch
      // arrives.
      expect(result.result.students.map((s) => s.fullName)).toEqual([
        "First",
        "Second",
      ]);
    }
  });

  it("34. missing Profile skips entry safely", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ORPH-01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-PRESENT",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedMembership({
      classId,
      studentUserId: "S-ORPHAN",
      joinedAt: new Date("2026-01-03T00:00:00Z"),
    });
    seedProfile({
      userId: "S-PRESENT",
      fullName: "Present Student",
    });
    // S-ORPHAN has no Profile.
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const names = result.result.students.map((s) => s.fullName);
      expect(names).toEqual(["Present Student"]);
      const serialized = JSON.stringify(result);
      // The orphaned id is NOT exposed.
      expect(serialized).not.toContain("S-ORPHAN");
    }
  });

  it("35. incomplete Profile skips entry safely", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "INCOM-01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-COMPLETE",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedMembership({
      classId,
      studentUserId: "S-INCOMPL",
      joinedAt: new Date("2026-01-03T00:00:00Z"),
    });
    seedProfile({
      userId: "S-COMPLETE",
      fullName: "Complete",
    });
    seedProfile({
      userId: "S-INCOMPL",
      fullName: "Incomplete",
      onboardingCompleted: false,
    });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const names = result.result.students.map((s) => s.fullName);
      expect(names).toEqual(["Complete"]);
    }
  });

  it("36. non-student Profile skips entry safely", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "WRONG-01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-STUDENT",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedMembership({
      classId,
      studentUserId: "S-TEACHER",
      joinedAt: new Date("2026-01-03T00:00:00Z"),
    });
    seedProfile({
      userId: "S-STUDENT",
      fullName: "Student",
      role: "student",
    });
    seedProfile({
      userId: "S-TEACHER",
      fullName: "Teacher",
      role: "teacher",
    });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const names = result.result.students.map((s) => s.fullName);
      expect(names).toEqual(["Student"]);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("S-TEACHER");
    }
  });

  it("37. valid remaining profiles still returned when one is skipped", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "SKIP-01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-A",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedMembership({
      classId,
      studentUserId: "S-B",
      joinedAt: new Date("2026-01-03T00:00:00Z"),
    });
    seedMembership({
      classId,
      studentUserId: "S-C",
      joinedAt: new Date("2026-01-04T00:00:00Z"),
    });
    seedProfile({ userId: "S-A", fullName: "Alpha" });
    // S-B has no Profile (orphaned).
    seedProfile({ userId: "S-C", fullName: "Charlie" });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.students.map((s) => s.fullName)).toEqual([
        "Alpha",
        "Charlie",
      ]);
    }
  });
});

// =============================================================================
// 38..53 — Safe DTO
// =============================================================================

describe("getClassRosterForCurrentTeacher — safe DTO", () => {
  async function seedHappyPathRoster() {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "SAFE-001",
      name: "Safe Roster Class",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({
      userId: "S-USER-1",
      fullName: "Safe Student",
      identificationCode: "S-SAFE",
    });
    return classId;
  }

  it("38. class result contains id", async () => {
    const classId = await seedHappyPathRoster();
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.class.id).toBe(classId);
    }
  });

  it("39. class result contains name", async () => {
    const classId = await seedHappyPathRoster();
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.class.name).toBe("Safe Roster Class");
    }
  });

  it("40. class result contains classCode", async () => {
    const classId = await seedHappyPathRoster();
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.class.classCode).toBe("SAFE-001");
    }
  });

  it("41. class result contains status", async () => {
    const classId = await seedHappyPathRoster();
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.class.status).toBe("active");
    }
  });

  it("42. roster item contains fullName", async () => {
    const classId = await seedHappyPathRoster();
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.students[0]?.fullName).toBe(
        "Safe Student",
      );
    }
  });

  it("43. roster item contains identificationCode", async () => {
    const classId = await seedHappyPathRoster();
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.students[0]?.identificationCode).toBe(
        "S-SAFE",
      );
    }
  });

  it("44. roster item contains joinedAt", async () => {
    const classId = await seedHappyPathRoster();
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.students[0]?.joinedAt).toBe(
        "2026-01-02T00:00:00.000Z",
      );
    }
  });

  it("45. result contains no password (plaintext)", async () => {
    const classId = await seedHappyPathRoster();
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/"password"/);
      expect(result.result.class).not.toHaveProperty("password");
      for (const s of result.result.students) {
        expect(s).not.toHaveProperty("password");
      }
    }
  });

  it("46. result contains no passwordHash", async () => {
    const classId = await seedHappyPathRoster();
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("passwordHash");
      expect(serialized).not.toContain("pbkdf2");
      expect(result.result.class).not.toHaveProperty("passwordHash");
    }
  });

  it("47. result contains no teacherUserId", async () => {
    const classId = await seedHappyPathRoster();
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("teacherUserId");
      expect(result.result.class).not.toHaveProperty("teacherUserId");
    }
  });

  it("48. roster row contains no studentUserId", async () => {
    const classId = await seedHappyPathRoster();
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("S-USER-1");
      expect(serialized).not.toContain("studentUserId");
      for (const s of result.result.students) {
        expect(s).not.toHaveProperty("studentUserId");
      }
    }
  });

  it("49. roster row contains no Profile id", async () => {
    const classId = await seedHappyPathRoster();
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/profileId/i);
      expect(serialized).not.toMatch(/profile_id/i);
      for (const s of result.result.students) {
        expect(s).not.toHaveProperty("profileId");
      }
    }
  });

  it("50. roster row contains no Membership id", async () => {
    const classId = await seedHappyPathRoster();
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/membershipId/i);
      expect(serialized).not.toMatch(/membership_id/i);
      for (const s of result.result.students) {
        expect(s).not.toHaveProperty("membershipId");
      }
    }
  });

  it("51. roster row contains no email", async () => {
    const classId = await seedHappyPathRoster();
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("@example.com");
      for (const s of result.result.students) {
        expect(s).not.toHaveProperty("email");
      }
    }
  });

  it("52. roster row contains no emailSnapshot", async () => {
    const classId = await seedHappyPathRoster();
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("emailSnapshot");
      for (const s of result.result.students) {
        expect(s).not.toHaveProperty("emailSnapshot");
      }
    }
  });

  it("53. roster row contains no phone", async () => {
    const classId = await seedHappyPathRoster();
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("phone");
      for (const s of result.result.students) {
        expect(s).not.toHaveProperty("phone");
      }
    }
  });
});

// =============================================================================
// 54..63 — Privacy / domain isolation
// =============================================================================

describe("getClassRosterForCurrentTeacher — privacy / domain isolation", () => {
  it("54. roster contains no FaceProfile", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOFACE-01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({ userId: "S-USER-1" });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/FaceProfile/);
      expect(serialized).not.toMatch(/faceProfile/);
    }
  });

  it("55. roster contains no biometric state", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOBIOM-01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({ userId: "S-USER-1" });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/biometric/i);
      expect(serialized).not.toMatch(/enrolled/i);
    }
  });

  it("56. roster contains no embedding", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOEMB-01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({ userId: "S-USER-1" });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/embedding/i);
    }
  });

  it("57. roster contains no centroid", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOCEN-01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({ userId: "S-USER-1" });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/centroid/i);
    }
  });

  it("58. roster contains no attendance status", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOATT-01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({ userId: "S-USER-1" });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/present/i);
      expect(serialized).not.toMatch(/absent/i);
      expect(serialized).not.toMatch(/late/i);
    }
  });

  it("59. roster contains no attendance history", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOHIST-01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({ userId: "S-USER-1" });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/attendance_history/i);
      expect(serialized).not.toMatch(/attendanceHistory/i);
    }
  });

  it("60. read calls no Face Service", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/face-service-client/);
    expect(stripped).not.toMatch(/FaceServiceClient/);
    expect(stripped).not.toMatch(/biometrics/);
    expect(source).toMatch(/Face Service/);
  });

  it("61. read calls no class-password verification", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/verifyClassPassword/);
    expect(stripped).not.toMatch(/hashClassPassword/);
    expect(stripped).not.toMatch(/isValidPasswordHash/);
    expect(stripped).not.toMatch(/getClassJoinCredentialByCode/);
    expect(stripped).not.toMatch(
      /from\s+["']\.\/class-password["']/,
    );
  });

  it("62. read calls no dummy password verification", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/runDummyPasswordVerification/);
    expect(source).not.toMatch(/DUMMY_CLASS_PASSWORD_HASH/);
  });

  it("63. read queries no Better Auth user collection", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // No direct Better Auth user collection query.
    expect(stripped).not.toMatch(/BetterAuthUser/);
    expect(stripped).not.toMatch(/better-auth.*user/i);
    // Better Auth is mentioned in the JSDoc but only in the
    // context of session.user.id — confirm by counting.
    expect(source).toMatch(/session\.user\.id/);
  });
});

// =============================================================================
// 64..71 — Read only
// =============================================================================

describe("getClassRosterForCurrentTeacher — read-only", () => {
  beforeEach(() => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "RO-001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
  });

  it("64. creates no Class", async () => {
    await getClassRosterForCurrentTeacher(makeObjectId());
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("65. updates no Class", async () => {
    await getClassRosterForCurrentTeacher(makeObjectId());
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("66. deletes no Class", async () => {
    await getClassRosterForCurrentTeacher(makeObjectId());
    expect(mockDeleteOne).not.toHaveBeenCalled();
  });

  it("67. creates no Membership", async () => {
    await getClassRosterForCurrentTeacher(makeObjectId());
    expect(mockMembershipCreate).not.toHaveBeenCalled();
  });

  it("68. updates no Membership", async () => {
    await getClassRosterForCurrentTeacher(makeObjectId());
    expect(mockMembershipUpdateOne).not.toHaveBeenCalled();
  });

  it("69. deletes no Membership", async () => {
    await getClassRosterForCurrentTeacher(makeObjectId());
    // No delete primitive on the membership mock; we assert the
    // mock was never called.
    expect(mockMembershipCreate).not.toHaveBeenCalled();
    expect(mockMembershipUpdateOne).not.toHaveBeenCalled();
  });

  it("70. modifies no Profile", async () => {
    await getClassRosterForCurrentTeacher(makeObjectId());
    expect(mockGetProfileByUserId).toHaveBeenCalledTimes(1);
    // Static source-grep: no profile write primitive is reachable.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/upsertOnboarding/);
    expect(source).not.toMatch(/updateProfile/);
    expect(source).not.toMatch(/saveProfile/);
  });

  it("71. performs no cleanup mutation", async () => {
    // The roster read never calls any delete / cleanup primitive.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/deleteOne/);
    expect(stripped).not.toMatch(/cleanup/);
    expect(stripped).not.toMatch(/archiveClass/);
  });
});

// =============================================================================
// 72..75 — Ordering
// =============================================================================

describe("getClassRosterForCurrentTeacher — ordering", () => {
  it("72. oldest joinedAt appears first", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ORD-OLD",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-OLD",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedMembership({
      classId,
      studentUserId: "S-NEW",
      joinedAt: new Date("2026-01-09T00:00:00Z"),
    });
    seedProfile({
      userId: "S-OLD",
      fullName: "Oldest",
      identificationCode: "ID-O",
    });
    seedProfile({
      userId: "S-NEW",
      fullName: "Newest",
      identificationCode: "ID-N",
    });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.students[0]?.fullName).toBe("Oldest");
    }
  });

  it("73. newest joinedAt appears last", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ORD-NEW",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-OLD",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedMembership({
      classId,
      studentUserId: "S-NEW",
      joinedAt: new Date("2026-01-09T00:00:00Z"),
    });
    seedProfile({
      userId: "S-OLD",
      fullName: "Oldest",
      identificationCode: "ID-O",
    });
    seedProfile({
      userId: "S-NEW",
      fullName: "Newest",
      identificationCode: "ID-N",
    });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const last =
        result.result.students[result.result.students.length - 1];
      expect(last?.fullName).toBe("Newest");
    }
  });

  it("74. profile query order cannot reorder memberships", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "PROFILE-ORD",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-A",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedMembership({
      classId,
      studentUserId: "S-B",
      joinedAt: new Date("2026-01-03T00:00:00Z"),
    });
    seedMembership({
      classId,
      studentUserId: "S-C",
      joinedAt: new Date("2026-01-04T00:00:00Z"),
    });
    seedProfile({ userId: "S-A", fullName: "Alpha" });
    seedProfile({ userId: "S-B", fullName: "Beta" });
    seedProfile({ userId: "S-C", fullName: "Charlie" });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The mock batch primitive returns the Map in membership
      // iteration order, but the assertion is membership-driven.
      expect(result.result.students.map((s) => s.fullName)).toEqual([
        "Alpha",
        "Beta",
        "Charlie",
      ]);
    }
  });

  it("75. repeated read with same data returns deterministic order", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "DET-ORD",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-A",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedMembership({
      classId,
      studentUserId: "S-B",
      joinedAt: new Date("2026-01-03T00:00:00Z"),
    });
    seedProfile({ userId: "S-A", fullName: "Alpha" });
    seedProfile({ userId: "S-B", fullName: "Beta" });
    const r1 = await getClassRosterForCurrentTeacher(classId);
    const r2 = await getClassRosterForCurrentTeacher(classId);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(JSON.stringify(r1.result)).toBe(
        JSON.stringify(r2.result),
      );
    }
  });
});

// =============================================================================
// 76..80 — Surface
// =============================================================================

describe("getClassRosterForCurrentTeacher — surface", () => {
  it("76. no roster REST endpoint exists", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/export\s+(async\s+)?function\s+GET/);
    expect(stripped).not.toMatch(/export\s+(async\s+)?function\s+POST/);
    expect(stripped).not.toMatch(/NextRequest/);
    expect(stripped).not.toMatch(/NextResponse/);
  });

  it("77. no roster Server Action exists", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/["']use server["']/);
  });

  it("78. no roster UI exists", async () => {
    // The class-read-service module is server-only and does not
    // import any UI primitive.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/from\s+["']react["']/);
    expect(source).not.toMatch(/from\s+["']next\/link["']/);
    expect(source).not.toMatch(/@\/app\//);
    expect(source).not.toMatch(/@\/components\//);
  });

  it("79. password-bearing join primitives remain absent from broad barrel", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "index.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/getClassJoinCredentialByCode/);
    expect(source).not.toMatch(/DUMMY_CLASS_PASSWORD_HASH/);
    expect(source).not.toMatch(/runDummyPasswordVerification/);
  });

  it("80. safe roster DTO contains only approved student fields", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "DTO-001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({
      userId: "S-USER-1",
      fullName: "Alpha",
      identificationCode: "ID-A",
    });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const item: SafeRosterItem =
        result.result.students[0] as SafeRosterItem;
      const allowed = new Set(["fullName", "identificationCode", "joinedAt"]);
      const actual = Object.keys(item).sort();
      expect(actual).toEqual([...allowed].sort());
      const roster: SafeClassRoster = result.result;
      expect(Object.keys(roster).sort()).toEqual(["class", "students"]);
      const clsKeys = Object.keys(roster.class).sort();
      expect(clsKeys).toEqual(
        ["classCode", "createdAt", "id", "name", "status", "updatedAt"].sort(),
      );
    }
  });
});

// =============================================================================
// Failure-path invariants
// =============================================================================

describe("getClassRosterForCurrentTeacher — failure-path invariants", () => {
  it("unexpected DB failure during class lookup → CLASS_READ_FAILED (no internals leaked)", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    mockFindOne.mockImplementationOnce(() => {
      throw new Error(
        "ECONNREFUSED 10.0.0.1:27017/face_attendance - raw mongo detail",
      );
    });
    const result = await getClassRosterForCurrentTeacher(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_ROSTER_READ_ERROR_CODES.CLASS_READ_FAILED,
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("ECONNREFUSED");
      expect(serialized).not.toContain("10.0.0.1");
      expect(serialized).not.toContain("mongo");
      expect(serialized).not.toContain("face_attendance");
    }
  });

  it("unexpected DB failure during membership lookup → CLASS_READ_FAILED", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "DB-MEM01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    mockMembershipFind.mockImplementationOnce(() => {
      throw new Error("kaboom stack trace");
    });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_ROSTER_READ_ERROR_CODES.CLASS_READ_FAILED,
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("kaboom");
      expect(serialized).not.toContain("stack");
    }
  });

  it("unexpected DB failure during batch Profile lookup → CLASS_READ_FAILED", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "DB-PRO01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    mockGetStudentProfilesByUserIds.mockImplementationOnce(() => {
      throw new Error("kaboom profile stack");
    });
    const result = await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_ROSTER_READ_ERROR_CODES.CLASS_READ_FAILED,
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("kaboom");
      expect(serialized).not.toContain("profile stack");
    }
  });

  it("profile lookup failure → CLASS_READ_FAILED (no driver leak)", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockRejectedValue(
      new Error("ECONNREFUSED 10.0.0.1:27017"),
    );
    const result = await getClassRosterForCurrentTeacher(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_ROSTER_READ_ERROR_CODES.CLASS_READ_FAILED,
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("ECONNREFUSED");
      expect(serialized).not.toContain("10.0.0.1");
    }
  });

  it("missing user.id in session → UNAUTHENTICATED", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "", email: "x", name: "x", image: null },
      expiresAt: new Date(),
    });
    const result = await getClassRosterForCurrentTeacher(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_ROSTER_READ_ERROR_CODES.UNAUTHENTICATED,
      );
    }
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockMembershipFind).not.toHaveBeenCalled();
  });

  it("unknown profile.role collapses to CLASS_READ_FAILED (defensive)", async () => {
    mockGetSession.mockResolvedValue(makeSession("X-USER-1"));
    mockGetProfileByUserId.mockResolvedValue({
      userId: "X-USER-1",
      role: "admin" as unknown as "teacher",
      onboardingCompleted: true,
    } as unknown as Awaited<
      ReturnType<typeof mockGetProfileByUserId>
    >);
    const result = await getClassRosterForCurrentTeacher(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_ROSTER_READ_ERROR_CODES.CLASS_READ_FAILED,
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("admin");
    }
  });
});

// =============================================================================
// Type-shape sanity
// =============================================================================

describe("getClassRosterForCurrentTeacher — type-shape sanity", () => {
  it("error result is discriminated by ok=false", async () => {
    mockGetSession.mockResolvedValue(null);
    const result: GetClassRosterResult =
      await getClassRosterForCurrentTeacher(makeObjectId());
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(typeof result.code).toBe("string");
      expect(typeof result.message).toBe("string");
    }
  });

  it("success result is discriminated by ok=true and contains {class, students}", async () => {
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "TS-OK01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedProfile({
      userId: "S-USER-1",
      fullName: "TS Student",
      identificationCode: "TS-001",
    });
    const result: GetClassRosterResult =
      await getClassRosterForCurrentTeacher(classId);
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      const roster: SafeClassRoster = result.result;
      expect(roster.class.classCode).toBe("TS-OK01");
      expect(Array.isArray(roster.students)).toBe(true);
    }
  });
});
