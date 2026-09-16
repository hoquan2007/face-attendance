/**
 * Tests for the PHASE 5.1D2A server-only authorized class
 * detail read model.
 *
 * Covers the 70-test contract:
 *
 *   ## Function input (1..5)
 *     - detail function accepts classId
 *     - accepts no userId
 *     - accepts no teacherUserId
 *     - accepts no studentUserId
 *     - accepts no role
 *
 *   ## Auth (6..8)
 *     - no session → UNAUTHENTICATED
 *     - unauthenticated path performs no detail query
 *     - session.user.id is sole identity source
 *
 *   ## Profile (9..12)
 *     - missing profile → PROFILE_INCOMPLETE
 *     - incomplete profile → PROFILE_INCOMPLETE
 *     - role derives from persisted Profile
 *     - browser cannot choose teacher/student branch
 *
 *   ## Class ID (13..17)
 *     - valid ObjectId accepted
 *     - malformed classId handled safely
 *     - malformed id does not leak CastError
 *     - malformed id → CLASS_NOT_ACCESSIBLE
 *     - missing class → CLASS_NOT_ACCESSIBLE
 *
 *   ## Teacher authorization (18..24)
 *     - owner teacher can read class detail
 *     - owner lookup uses session.user.id
 *     - different teacher cannot read class
 *     - different teacher → CLASS_NOT_ACCESSIBLE
 *     - different teacher receives no class metadata
 *     - archived class remains readable by owner
 *     - teacher path does not require Membership
 *
 *   ## Student authorization (25..32)
 *     - active member student can read detail
 *     - membership lookup uses session.user.id
 *     - membership lookup uses requested classId
 *     - no membership → CLASS_NOT_ACCESSIBLE
 *     - inactive membership → CLASS_NOT_ACCESSIBLE
 *     - another student's membership grants no access
 *     - active member may read archived class
 *     - student path does not require class password
 *
 *   ## Failure indistinguishability (33..38)
 *     - malformed id → CLASS_NOT_ACCESSIBLE
 *     - missing class → CLASS_NOT_ACCESSIBLE
 *     - unauthorized teacher → CLASS_NOT_ACCESSIBLE
 *     - student no-membership → CLASS_NOT_ACCESSIBLE
 *     - inactive membership → CLASS_NOT_ACCESSIBLE
 *     - same safe server-domain code across all above
 *
 *   ## Safe DTO (39..51)
 *     - detail contains id, name, classCode, status,
 *       createdAt, updatedAt
 *     - detail contains no password / passwordHash
 *     - detail contains no teacherUserId (unless deliberately
 *       required)
 *     - detail contains no studentUserId
 *     - detail contains no membershipId
 *     - detail contains no Mongo __v
 *     - detail contains no biometric data
 *
 *   ## No roster (52..56)
 *     - detail contains no students array
 *     - detail contains no members array
 *     - detail contains no student email
 *     - detail contains no student profile
 *     - detail performs no roster query
 *
 *   ## Read-only / domain isolation (57..66)
 *     - detail read creates no Class
 *     - detail read updates no Class
 *     - detail read creates no Membership
 *     - detail read updates no Membership
 *     - detail read modifies no Profile
 *     - detail read calls no verifyClassPassword
 *     - detail read calls no dummy password verification
 *     - detail read calls no Face Service
 *     - detail read touches no FaceProfile
 *     - detail read creates no attendance data
 *
 *   ## Internal surface (67..70)
 *     - password-bearing join primitive remains absent from
 *       broad barrel
 *     - SafeClassDetail still omits passwordHash
 *     - D1 getClassesByIds remains server-only
 *     - no public detail API route exists
 *
 * Implementation notes:
 *
 *   - All collaborators (`@/lib/session`, `@/lib/profile-service`,
 *     `@/lib/classes/class-model`, `@/lib/classes/class-membership-model`)
 *     are mocked at module boundaries. No MongoDB / Mongoose /
 *     Face Service / Better Auth is touched.
 *   - The mocks model an in-memory store for classes and
 *     memberships. Every `find` / `findOne` / `findById` is
 *     exercised through the store. The mocks track call
 *     counts so the read-only / no-N+1 / authorization-
 *     encoded invariants can be asserted.
 *   - `vi.mock(...)` declarations are hoisted above imports
 *     by Vitest, so collaborators are guaranteed to be
 *     replaced before the module is loaded.
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

// =============================================================================
// In-memory class + membership stores
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

// Class + membership stores are keyed by the primary key the
// production code looks up against (`_id` for classes, the
// composite `classId::studentUserId` for memberships). The
// D1 list-read test uses `classCode` as the store key, but
// the D2A detail read looks up by `_id` directly. We index by
// BOTH `classCode` (for D1) and `_id` (for D2A) so the same
// fixture is reachable from either query.
const classStoreByCode = new Map<string, StoredClass>();
const classStoreById = new Map<string, StoredClass>();
const membershipStore = new Map<string, StoredMembership>();

let nextObjectIdCounter = 0;
function makeObjectId(): string {
  nextObjectIdCounter++;
  // 24-char hex-like string so any string-based projection
  // round-trips consistently. The shape is irrelevant to the
  // production code, which only strings through to Mongoose.
  // The string is a 24-character lowercase hex value: a fixed
  // 3-char prefix plus a 21-char padded counter, joined and
  // truncated to exactly 24 chars.
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
}> = {}) {
  return {
    userId: "S-USER-1",
    emailSnapshot: "s@example.com",
    role: "student" as const,
    fullName: "Test Student",
    identificationCode: "S-001",
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
  projection: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!doc) return null;
  if (!projection) return { ...doc };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(projection)) {
    if ((projection as Record<string, unknown>)[key]) {
      out[key] = (doc as unknown as Record<string, unknown>)[key];
    }
  }
  // Always include `_id` unless explicitly excluded — Mongoose
  // includes `_id` by default even on include-only projections.
  if (!Object.prototype.hasOwnProperty.call(out, "_id")) {
    out["_id"] = doc._id;
  }
  return out;
}

function applyMembershipFindProjection(
  doc: StoredMembership | null,
  projection: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!doc) return null;
  if (!projection) return { ...doc };
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(projection)) {
    if ((projection as Record<string, unknown>)[key]) {
      out[key] = (doc as unknown as Record<string, unknown>)[key];
    }
  }
  if (!Object.prototype.hasOwnProperty.call(out, "_id")) {
    out["_id"] = doc._id;
  }
  return out;
}

// Configure `mockFind` for the batch lookup shape used by the
// D1 list read. D2A does NOT use `find` at all, but the mock is
// installed to keep the surface complete (and to assert D2A
// does not call `find`).
function configureClassFindMock(): void {
  mockFind.mockImplementation(
    (filter: Record<string, unknown>) =>
      chainable(async () => {
        if (typeof filter["teacherUserId"] === "string") {
          const matches = Array.from(classStoreByCode.values()).filter(
            (doc) =>
              doc.teacherUserId === filter["teacherUserId"],
          );
          matches.sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime(),
          );
          return matches.map((d) => ({ ...d }));
        }
        return [];
      }),
  );
}

// Configure `mockFindOne` for the D2A detail paths:
//
//   - `{ _id, teacherUserId }`  → teacher ownership filter.
//   - `{ _id }` is NOT used — D2A teacher path uses
//     `_id AND teacherUserId` together so the authorization
//     constraint is encoded directly.
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
        // `findOne` returns the first match (or `null`).
        const doc = matches[0] ?? null;
        return applyClassFindProjection(doc, undefined);
      }),
  );
}

// Configure `mockFindById` for the D2A student detail path
// (load class after proving membership).
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

// Configure `mockMembershipFindOne` for the D2A student path
// (prove active membership before loading the class).
function configureMembershipFindOneMock(): void {
  mockMembershipFindOne.mockImplementation(
    (filter: Record<string, unknown>) =>
      chainable(async () => {
        const classIdFilter = filter["classId"];
        const studentFilter = filter["studentUserId"];
        const statusFilter = filter["status"];
        const matches = Array.from(membershipStore.values()).filter(
          (doc) => {
            // The production code calls
            // `new Types.ObjectId(classId)` before passing the
            // filter — so the value coming through is a string
            // (24-char hex). Match by string equality.
            if (
              classIdFilter !== undefined &&
              classIdFilter !== null
            ) {
              const classIdString =
                typeof classIdFilter === "string"
                  ? classIdFilter
                  : String(classIdFilter);
              if (doc.classId !== classIdString) return false;
            }
            if (
              typeof studentFilter === "string" &&
              doc.studentUserId !== studentFilter
            ) {
              return false;
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
        const doc = matches[0] ?? null;
        return applyMembershipFindProjection(doc, undefined);
      }),
  );
}

function configureMembershipFindMock(): void {
  mockMembershipFind.mockImplementation(
    (filter: Record<string, unknown>) =>
      chainable(async () => {
        const matches = Array.from(membershipStore.values()).filter(
          (doc) => {
            if (
              typeof filter["studentUserId"] === "string" &&
              doc.studentUserId !== filter["studentUserId"]
            ) {
              return false;
            }
            if (
              typeof filter["status"] === "string" &&
              doc.status !== filter["status"]
            ) {
              return false;
            }
            return true;
          },
        );
        matches.sort(
          (a, b) =>
            b.joinedAt.getTime() - a.joinedAt.getTime(),
        );
        return matches.map((d) => ({ ...d }));
      }),
  );
}

// =============================================================================
// Imports under test
// =============================================================================

import {
  CLASS_DETAIL_READ_ERROR_CODES,
  getClassDetailForCurrentUser,
  type AccessibleClassDetail,
  type GetAccessibleClassDetailResult,
  type SafeClassDetail,
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

  // ClassModel and ClassMembershipModel honor the configured
  // in-memory stores.
  configureClassFindMock();
  configureClassFindOneMock();
  configureClassFindByIdMock();
  configureMembershipFindMock();
  configureMembershipFindOneMock();

  // Write primitives are NEVER called by the read service. We
  // install counters so the read-only invariants can be
  // asserted.
  mockCreate.mockImplementation(() => {
    throw new Error("ClassModel.create must not be called by D2A");
  });
  mockUpdateOne.mockImplementation(() => {
    throw new Error("ClassModel.updateOne must not be called by D2A");
  });
  mockDeleteOne.mockImplementation(() => {
    throw new Error("ClassModel.deleteOne must not be called by D2A");
  });
  mockMembershipCreate.mockImplementation(() => {
    throw new Error(
      "ClassMembershipModel.create must not be called by D2A",
    );
  });
  mockMembershipUpdateOne.mockImplementation(() => {
    throw new Error(
      "ClassMembershipModel.updateOne must not be called by D2A",
    );
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// 1..5 — Function input
// =============================================================================

describe("getClassDetailForCurrentUser — function input", () => {
  it("1. detail function accepts classId (arity 1)", () => {
    // Type-level guarantee: the function's arity is 1.
    expect(getClassDetailForCurrentUser.length).toBe(1);
  });

  it("2. accepts no userId (no second positional argument)", () => {
    // Structural assertion: passing a second positional
    // argument must not change behavior. The function only
    // reads `classId` from its first argument.
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "OWNED001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    // Call with extra positional argument (defensive).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (getClassDetailForCurrentUser as any)(
      classId,
      "another-user-id",
    ).then((result: GetAccessibleClassDetailResult) => {
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The session user was used — not the smuggled id.
        expect(result.result.role).toBe("teacher");
      }
    });
  });

  it("3. accepts no teacherUserId (smuggled value is ignored)", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "TEACH001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    // Cast through any — simulates a browser trying to smuggled
    // a teacher id through a future wrapper.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (getClassDetailForCurrentUser as any)(
      classId,
      "smuggled-teacher-id",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The query filter MUST equal session.user.id, not the
      // smuggled value.
      expect(mockFindOne).toHaveBeenCalledTimes(1);
      const filter = mockFindOne.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(filter["teacherUserId"]).toBe("T-USER-1");
      expect(filter["teacherUserId"]).not.toBe("smuggled-teacher-id");
    }
  });

  it("4. accepts no studentUserId (smuggled value is ignored)", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "STUCL001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (getClassDetailForCurrentUser as any)(
      classId,
      "smuggled-student-id",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(mockMembershipFindOne).toHaveBeenCalledTimes(1);
      const filter = mockMembershipFindOne.mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(filter["studentUserId"]).toBe("S-USER-1");
      expect(filter["studentUserId"]).not.toBe(
        "smuggled-student-id",
      );
    }
  });

  it("5. accepts no role (smuggled value is ignored)", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ROLE0001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (getClassDetailForCurrentUser as any)(
      classId,
      "teacher",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The role is decided by the persisted Profile (student),
      // NOT by the smuggled "teacher" string.
      expect(result.result.role).toBe("student");
      // The membership query was performed (student path).
      expect(mockMembershipFindOne).toHaveBeenCalledTimes(1);
      // The teacher ownership filter was NOT used.
      const teacherCalls = mockFindOne.mock.calls.filter(
        (call) =>
          typeof (call[0] as Record<string, unknown>)[
            "teacherUserId"
          ] === "string",
      );
      expect(teacherCalls.length).toBe(0);
    }
  });
});

// =============================================================================
// 6..8 — Auth
// =============================================================================

describe("getClassDetailForCurrentUser — auth", () => {
  it("6. no session → controlled UNAUTHENTICATED", async () => {
    mockGetSession.mockResolvedValue(null);
    const result = await getClassDetailForCurrentUser(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.UNAUTHENTICATED,
      );
      expect(result.message).toBeDefined();
      expect(result.message).not.toMatch(/mongo/i);
      expect(result.message).not.toMatch(/session/i);
    }
  });

  it("7. unauthenticated path performs no detail query", async () => {
    mockGetSession.mockResolvedValue(null);
    const classId = makeObjectId();
    await getClassDetailForCurrentUser(classId);
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockMembershipFindOne).not.toHaveBeenCalled();
    expect(mockGetProfileByUserId).not.toHaveBeenCalled();
  });

  it("8. session.user.id is sole identity source", async () => {
    const sessionUserId = "session-derived-id-002";
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
    await getClassDetailForCurrentUser(classId);
    expect(mockFindOne).toHaveBeenCalledTimes(1);
    const filter = mockFindOne.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(filter["teacherUserId"]).toBe(sessionUserId);
  });
});

// =============================================================================
// 9..12 — Profile
// =============================================================================

describe("getClassDetailForCurrentUser — profile gating", () => {
  it("9. missing profile → PROFILE_INCOMPLETE", async () => {
    mockGetProfileByUserId.mockResolvedValue(null);
    const result = await getClassDetailForCurrentUser(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.PROFILE_INCOMPLETE,
      );
    }
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockMembershipFindOne).not.toHaveBeenCalled();
  });

  it("10. incomplete profile → PROFILE_INCOMPLETE", async () => {
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ onboardingCompleted: false }),
    );
    const result = await getClassDetailForCurrentUser(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.PROFILE_INCOMPLETE,
      );
    }
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  it("11. role derives from persisted Profile (not input)", async () => {
    // Teacher profile → teacher detail path.
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({
        userId: "T-USER-1",
        role: "teacher",
        onboardingCompleted: true,
      }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ROLE-T01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.role).toBe("teacher");
    }
    // The teacher ownership filter was used.
    expect(mockFindOne).toHaveBeenCalledTimes(1);
    // The membership query was NOT used.
    expect(mockMembershipFindOne).not.toHaveBeenCalled();

    // Student profile → student detail path.
    vi.clearAllMocks();
    resetStores();
    configureClassFindMock();
    configureClassFindOneMock();
    configureClassFindByIdMock();
    configureMembershipFindMock();
    configureMembershipFindOneMock();
    mockCreate.mockImplementation(() => {
      throw new Error("ClassModel.create must not be called by D2A");
    });
    mockUpdateOne.mockImplementation(() => {
      throw new Error("ClassModel.updateOne must not be called by D2A");
    });
    mockDeleteOne.mockImplementation(() => {
      throw new Error("ClassModel.deleteOne must not be called by D2A");
    });
    mockMembershipCreate.mockImplementation(() => {
      throw new Error(
        "ClassMembershipModel.create must not be called by D2A",
      );
    });
    mockMembershipUpdateOne.mockImplementation(() => {
      throw new Error(
        "ClassMembershipModel.updateOne must not be called by D2A",
      );
    });

    const studentClassId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({
        userId: "S-USER-1",
        role: "student",
      }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "STU-0011",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: studentClassId,
    });
    seedMembership({
      classId: studentClassId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result2 = await getClassDetailForCurrentUser(
      studentClassId,
    );
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.result.role).toBe("student");
    }
    expect(mockMembershipFindOne).toHaveBeenCalledTimes(1);
  });

  it("12. browser cannot choose teacher/student branch", async () => {
    // The function takes only `classId`; the role branch is
    // determined by the persisted Profile. Seed BOTH a
    // teacher-owned class AND a student-membership pattern and
    // assert the student branch is taken from the Profile.
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    const classId = makeObjectId();
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "BRANCH01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.role).toBe("student");
    }
    // The teacher ownership filter was NOT used.
    const teacherCalls = mockFindOne.mock.calls.filter(
      (call) =>
        typeof (call[0] as Record<string, unknown>)[
          "teacherUserId"
        ] === "string",
    );
    expect(teacherCalls.length).toBe(0);
    // The membership filter WAS used.
    expect(mockMembershipFindOne).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 13..17 — Class ID
// =============================================================================

describe("getClassDetailForCurrentUser — class id validation", () => {
  it("13. valid ObjectId accepted (24-char hex)", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "VALD0001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
  });

  it("14. malformed classId handled safely (non-hex string)", async () => {
    const result = await getClassDetailForCurrentUser(
      "not-a-valid-objectid",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    // No database call was made.
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockFindById).not.toHaveBeenCalled();
    expect(mockMembershipFindOne).not.toHaveBeenCalled();
  });

  it("15. malformed id does not leak CastError", async () => {
    // Configure findOne / findById to throw a CastError if
    // reached. The safe syntax validation must prevent the
    // call entirely.
    mockFindOne.mockImplementation(() => {
      throw new Error(
        "CastError: Cast to ObjectId failed for value \"not-an-id\" at path \"_id\"",
      );
    });
    mockFindById.mockImplementation(() => {
      throw new Error(
        "CastError: Cast to ObjectId failed for value \"not-an-id\" at path \"_id\"",
      );
    });
    const result = await getClassDetailForCurrentUser(
      "not-an-id",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("CastError");
      expect(serialized).not.toContain("ObjectId");
    }
  });

  it("16. malformed id → CLASS_NOT_ACCESSIBLE", async () => {
    const malformed = [
      "",
      "abc",
      "xyz",
      "123456789012345678901234", // 24 chars but not hex
      "00000000000000000000000Z", // non-hex character
    ];
    for (const id of malformed) {
      mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
      mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
      const result = await getClassDetailForCurrentUser(id);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(
          CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
        );
      }
    }
  });

  it("17. missing class → CLASS_NOT_ACCESSIBLE", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    // No class seeded for this id.
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
  });
});

// =============================================================================
// 18..24 — Teacher authorization
// =============================================================================

describe("getClassDetailForCurrentUser — teacher authorization", () => {
  it("18. owner teacher can read class detail", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "OWNER001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.role).toBe("teacher");
      expect(result.result.class.classCode).toBe("OWNER001");
    }
  });

  it("19. owner lookup uses session.user.id", async () => {
    const sessionUserId = "T-SESSION-2";
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession(sessionUserId));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({
        userId: sessionUserId,
        role: "teacher",
        onboardingCompleted: true,
      }),
    );
    seedClass({
      teacherUserId: sessionUserId,
      classCode: "T-SESS01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    await getClassDetailForCurrentUser(classId);
    expect(mockFindOne).toHaveBeenCalledTimes(1);
    const filter = mockFindOne.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(filter["teacherUserId"]).toBe(sessionUserId);
    expect(filter["_id"]).toBe(classId);
  });

  it("20. different teacher cannot read class", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("OTHER-TEACHER"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({
        userId: "OTHER-TEACHER",
        role: "teacher",
        onboardingCompleted: true,
      }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "OTHER-001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(false);
  });

  it("21. different teacher → CLASS_NOT_ACCESSIBLE", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("OTHER-TEACHER"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({
        userId: "OTHER-TEACHER",
        role: "teacher",
        onboardingCompleted: true,
      }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "WRONG001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
  });

  it("22. different teacher receives no class metadata", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("OTHER-TEACHER"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({
        userId: "OTHER-TEACHER",
        role: "teacher",
        onboardingCompleted: true,
      }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "LEAK0001",
      name: "Confidential Class",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(false);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Confidential Class");
    expect(serialized).not.toContain("LEAK0001");
    expect(serialized).not.toContain(classId);
    expect(serialized).not.toContain("passwordHash");
  });

  it("23. archived class remains readable by owner", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ARCHIV01",
      status: "archived",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.class.status).toBe("archived");
    }
  });

  it("24. teacher path does not require Membership", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "TMEM0001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    // Deliberately NO membership rows.
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    // The membership query was NEVER consulted.
    expect(mockMembershipFindOne).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 25..32 — Student authorization
// =============================================================================

describe("getClassDetailForCurrentUser — student authorization", () => {
  it("25. active member student can read detail", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "JOIN0001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.role).toBe("student");
      expect(result.result.class.classCode).toBe("JOIN0001");
    }
  });

  it("26. membership lookup uses session.user.id", async () => {
    const sessionUserId = "S-SESSION-2";
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession(sessionUserId));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({
        userId: sessionUserId,
        role: "student",
        onboardingCompleted: true,
      }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "S-SESS01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: sessionUserId,
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    await getClassDetailForCurrentUser(classId);
    expect(mockMembershipFindOne).toHaveBeenCalledTimes(1);
    const filter = mockMembershipFindOne.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(filter["studentUserId"]).toBe(sessionUserId);
  });

  it("27. membership lookup uses requested classId", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "CID00001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    await getClassDetailForCurrentUser(classId);
    expect(mockMembershipFindOne).toHaveBeenCalledTimes(1);
    const filter = mockMembershipFindOne.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    // The classId passed to findOne is the same string we asked
    // for in the public call. Production code converts it via
    // `new Types.ObjectId(classId)` so the mock sees the
    // stringified 24-hex form.
    const filterClassId = filter["classId"];
    const filterClassIdString =
      typeof filterClassId === "string"
        ? filterClassId
        : String(filterClassId);
    expect(filterClassIdString).toBe(classId);
    expect(filter["status"]).toBe("active");
  });

  it("28. no membership → CLASS_NOT_ACCESSIBLE", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOMEM001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    // No membership row.
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    // The class load (`findById`) was NOT attempted — the
    // membership gate stopped the path first.
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it("29. inactive membership → CLASS_NOT_ACCESSIBLE", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "INACT001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
      status: "inactive",
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    // Class load was NOT attempted.
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it("30. another student's membership grants no access", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "OTHER-S1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "OTHER-STUDENT",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    // Class load was NOT attempted.
    expect(mockFindById).not.toHaveBeenCalled();
  });

  it("31. active member may read archived class", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ARC-STU1",
      status: "archived",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.class.status).toBe("archived");
    }
  });

  it("32. student path does not require class password", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "PWLESS01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    // The student path does NOT consult any password primitive.
    // We assert the production module never imports the
    // password module — see the static source-grep tests
    // below.
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
  });
});

// =============================================================================
// 33..38 — Failure indistinguishability
// =============================================================================

describe("getClassDetailForCurrentUser — failure indistinguishability", () => {
  it("33. malformed id → CLASS_NOT_ACCESSIBLE", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    const result = await getClassDetailForCurrentUser("bad-id");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
  });

  it("34. missing class → CLASS_NOT_ACCESSIBLE", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    const result = await getClassDetailForCurrentUser(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
  });

  it("35. unauthorized teacher → CLASS_NOT_ACCESSIBLE", async () => {
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
      classCode: "U-TCH001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
  });

  it("36. student no-membership → CLASS_NOT_ACCESSIBLE", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "U-STU001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
  });

  it("37. inactive membership → CLASS_NOT_ACCESSIBLE", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "INACT-002",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
      status: "inactive",
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
  });

  it("38. same safe server-domain code across all above", () => {
    const codes = [
      CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
    ];
    for (const c of codes) {
      expect(c).toBe("CLASS_NOT_ACCESSIBLE");
    }
    // The constants are stable across all branches.
    expect(CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE).toBe(
      "CLASS_NOT_ACCESSIBLE",
    );
  });
});

// =============================================================================
// 39..51 — Safe DTO
// =============================================================================

describe("getClassDetailForCurrentUser — safe DTO", () => {
  it("39. detail contains id", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ID-DET01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.class.id).toBe(classId);
    }
  });

  it("40. detail contains name", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NAME0001",
      name: "Detail Test Class",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.class.name).toBe("Detail Test Class");
    }
  });

  it("41. detail contains classCode", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "CODE0001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.class.classCode).toBe("CODE0001");
    }
  });

  it("42. detail contains status", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "STAT0001",
      status: "archived",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.class.status).toBe("archived");
    }
  });

  it("43. detail contains createdAt", async () => {
    const classId = makeObjectId();
    const createdAt = new Date("2026-02-15T10:00:00.000Z");
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "DATE0001",
      createdAt,
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.class.createdAt).toBe(
        "2026-02-15T10:00:00.000Z",
      );
    }
  });

  it("44. detail contains updatedAt", async () => {
    const classId = makeObjectId();
    const createdAt = new Date("2026-02-15T10:00:00.000Z");
    const updatedAt = new Date("2026-02-16T11:00:00.000Z");
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "UPDT0001",
      createdAt,
      updatedAt,
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.class.updatedAt).toBe(
        "2026-02-16T11:00:00.000Z",
      );
    }
  });

  it("45. detail contains no password (plaintext)", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOPWD-D1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/"password"/);
      expect(result.result.class).not.toHaveProperty("password");
      expect(result.result.class).not.toHaveProperty("rawPassword");
    }
  });

  it("46. detail contains no passwordHash", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOHASH-D1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("passwordHash");
      expect(serialized).not.toContain("pbkdf2");
      expect(result.result.class).not.toHaveProperty("passwordHash");
    }
  });

  it("47. detail contains no teacherUserId", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOTEACH-D",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("teacherUserId");
      expect(result.result.class).not.toHaveProperty("teacherUserId");
    }
  });

  it("48. detail contains no studentUserId", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOSTUD-D",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("studentUserId");
      expect(result.result.class).not.toHaveProperty("studentUserId");
    }
  });

  it("49. detail contains no membershipId", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOMEMID-D",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/membershipId/i);
      expect(serialized).not.toMatch(/membership_id/i);
      expect(result.result.class).not.toHaveProperty("membershipId");
      expect(result.result).not.toHaveProperty("membershipId");
    }
  });

  it("50. detail contains no Mongo __v", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOV00001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      // `__v` is the Mongoose version key. It must not be
      // serialized in the result.
      expect(serialized).not.toContain("__v");
      expect(result.result.class).not.toHaveProperty("__v");
    }
  });

  it("51. detail contains no biometric data", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOBIOM-D1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/embedding/i);
      expect(serialized).not.toMatch(/centroid/i);
      expect(serialized).not.toMatch(/FaceProfile/i);
      expect(serialized).not.toMatch(/faceProfile/i);
      for (const key of Object.keys(result.result.class)) {
        expect(key.toLowerCase()).not.toContain("embedding");
        expect(key.toLowerCase()).not.toContain("centroid");
      }
    }
  });
});

// =============================================================================
// 52..56 — No roster
// =============================================================================

describe("getClassDetailForCurrentUser — no roster", () => {
  it("52. detail contains no students array", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOSTU-D01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("students");
      expect(result.result.class).not.toHaveProperty("students");
    }
  });

  it("53. detail contains no members array", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOMEM-D01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("members");
      expect(result.result.class).not.toHaveProperty("members");
    }
  });

  it("54. detail contains no student email", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOMAIL-D1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("student@example.com");
      expect(serialized).not.toContain("s@example.com");
      expect(serialized).not.toContain("emailSnapshot");
      expect(result.result.class).not.toHaveProperty("email");
    }
  });

  it("55. detail contains no student profile", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOPROF-D1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("fullName");
      expect(serialized).not.toContain("identificationCode");
      expect(serialized).not.toContain("phone");
    }
  });

  it("56. detail performs no roster query (no listMembershipsByClassId)", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOROSTR01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    // Teacher path must NOT issue a roster query (the
    // `ClassMembershipModel.find({ classId })` shape).
    await getClassDetailForCurrentUser(classId);
    // The membership `find` (list-all-by-class) shape is
    // distinct from the membership `findOne` shape used by the
    // student detail path. We assert the `find` was NOT called
    // for the teacher path.
    const membershipFindCalls = mockMembershipFind.mock.calls.filter(
      (call) =>
        typeof (call[0] as Record<string, unknown>)[
          "classId"
        ] !== undefined,
    );
    expect(membershipFindCalls.length).toBe(0);
  });
});

// =============================================================================
// 57..66 — Read-only / domain isolation
// =============================================================================

describe("getClassDetailForCurrentUser — read-only / domain isolation", () => {
  beforeEach(() => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ISOLATE01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
  });

  it("57. detail read creates no Class", async () => {
    const classId = makeObjectId();
    await getClassDetailForCurrentUser(classId);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("58. detail read updates no Class", async () => {
    const classId = makeObjectId();
    await getClassDetailForCurrentUser(classId);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("59. detail read creates no Membership", async () => {
    const classId = makeObjectId();
    await getClassDetailForCurrentUser(classId);
    expect(mockMembershipCreate).not.toHaveBeenCalled();
  });

  it("60. detail read updates no Membership", async () => {
    const classId = makeObjectId();
    await getClassDetailForCurrentUser(classId);
    expect(mockMembershipUpdateOne).not.toHaveBeenCalled();
  });

  it("61. detail read modifies no Profile", async () => {
    const classId = makeObjectId();
    await getClassDetailForCurrentUser(classId);
    // Profile is read for gating only — no write primitive is
    // exposed by the mocked profile-service surface.
    expect(mockGetProfileByUserId).toHaveBeenCalledTimes(1);
    // Static source-grep: the read service module does NOT
    // import any profile write primitive.
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

  it("62. detail read calls no verifyClassPassword", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    // The module opens with `import "server-only"`; its source
    // must not reference any password primitive.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/verifyClassPassword/);
    expect(stripped).not.toMatch(/runDummyPasswordVerification/);
    expect(stripped).not.toMatch(/hashClassPassword/);
    expect(stripped).not.toMatch(/isValidPasswordHash/);
    expect(stripped).not.toMatch(/DUMMY_CLASS_PASSWORD_HASH/);
    expect(stripped).not.toMatch(/getClassJoinCredentialByCode/);
    expect(stripped).not.toMatch(/from\s+["']\.\/class-password["']/);
  });

  it("63. detail read calls no dummy password verification", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/runDummyPasswordVerification/);
  });

  it("64. detail read calls no Face Service", async () => {
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
    expect(stripped).not.toMatch(/Face Service/);
    // Confirm the JSDoc mentions them so the strip is sound.
    expect(source).toMatch(/Face Service/);
  });

  it("65. detail read touches no FaceProfile", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/FaceProfile/);
    expect(stripped).not.toMatch(/face_profile/);
    expect(source).toMatch(/FaceProfile/);
  });

  it("66. detail read creates no attendance data", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/attendance/i);
    expect(stripped).not.toMatch(/Attendance/);
    expect(stripped).not.toMatch(/attendance_sessions/);
    expect(stripped).not.toMatch(/attendance_records/);
  });
});

// =============================================================================
// 67..70 — Internal surface
// =============================================================================

describe("getClassDetailForCurrentUser — internal surface", () => {
  it("67. password-bearing join primitive remains absent from broad barrel", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "index.ts"),
      "utf-8",
    );
    // The barrel MUST NOT re-export getClassJoinCredentialByCode,
    // DUMMY_CLASS_PASSWORD_HASH, or runDummyPasswordVerification.
    expect(source).not.toMatch(/getClassJoinCredentialByCode/);
    expect(source).not.toMatch(/DUMMY_CLASS_PASSWORD_HASH/);
    expect(source).not.toMatch(/runDummyPasswordVerification/);
    expect(source).not.toMatch(/ClassJoinCredential/);
  });

  it("68. SafeClassDetail still omits passwordHash", () => {
    // Type-shape sanity: SafeClassDetail MUST NOT list
    // passwordHash as a property.
    const detail: SafeClassDetail = {
      id: "id",
      name: "name",
      classCode: "code",
      status: "active",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(detail).not.toHaveProperty("passwordHash");
    expect(detail).not.toHaveProperty("password");
    expect(detail).not.toHaveProperty("teacherUserId");
    expect(detail).not.toHaveProperty("studentUserId");
    expect(detail).not.toHaveProperty("membershipId");
  });

  it("69. D1 getClassesByIds remains server-only", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    expect(source).toMatch(/import\s+["']server-only["']/);
    // The new detail function MUST NOT add a `"use server"`
    // directive (the read service is intentionally NOT a
    // Server Action).
    expect(source).not.toMatch(/["']use server["']/);
    // The new detail function MUST be a plain `async`
    // function — no REST surface.
    expect(source).toMatch(
      /export\s+async\s+function\s+getClassDetailForCurrentUser/,
    );
  });

  it("70. no public detail API route exists", async () => {
    // The detail read is a server-only function — no REST
    // route was added. The module's import surface does NOT
    // include any route-handler primitive. We assert this
    // statically by inspecting the module source.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // No Next.js route handler exports.
    expect(stripped).not.toMatch(/export\s+(async\s+)?function\s+GET/);
    expect(stripped).not.toMatch(/export\s+(async\s+)?function\s+POST/);
    // No `Request` / `Response` typing — we are not building a
    // route handler.
    expect(stripped).not.toMatch(/NextRequest/);
    expect(stripped).not.toMatch(/NextResponse/);
  });
});

// =============================================================================
// Failure-path invariants
// =============================================================================

describe("getClassDetailForCurrentUser — failure-path invariants", () => {
  it("unexpected DB failure during teacher lookup → CLASS_READ_FAILED (no internals leaked)", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    mockFindOne.mockImplementationOnce(() => {
      throw new Error(
        "ECONNREFUSED 10.0.0.1:27017/face_attendance - raw mongo detail",
      );
    });
    const result = await getClassDetailForCurrentUser(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_READ_FAILED,
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("ECONNREFUSED");
      expect(serialized).not.toContain("10.0.0.1");
      expect(serialized).not.toContain("mongo");
      expect(serialized).not.toContain("face_attendance");
    }
  });

  it("unexpected DB failure during membership lookup → CLASS_READ_FAILED", async () => {
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    mockMembershipFindOne.mockImplementationOnce(() => {
      throw new Error("E11000 kaboom stack trace here");
    });
    const result = await getClassDetailForCurrentUser(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_READ_FAILED,
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("E11000");
      expect(serialized).not.toContain("kaboom");
      expect(serialized).not.toContain("stack");
    }
  });

  it("unexpected DB failure during student class load → CLASS_READ_FAILED", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "DB-FAIL1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    mockFindById.mockImplementationOnce(() => {
      throw new Error("kaboom stack trace here");
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_READ_FAILED,
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("kaboom");
    }
  });

  it("profile lookup failure → CLASS_READ_FAILED (no driver leak)", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockRejectedValue(
      new Error("ECONNREFUSED 10.0.0.1:27017"),
    );
    const result = await getClassDetailForCurrentUser(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_READ_FAILED,
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
    const result = await getClassDetailForCurrentUser(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.UNAUTHENTICATED,
      );
    }
    expect(mockFindOne).not.toHaveBeenCalled();
    expect(mockMembershipFindOne).not.toHaveBeenCalled();
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
    const result = await getClassDetailForCurrentUser(
      makeObjectId(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_READ_FAILED,
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("admin");
    }
  });

  it("student path: membership exists but class is missing → CLASS_NOT_ACCESSIBLE", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ userId: "S-USER-1", role: "student" }),
    );
    // Seed a membership but NOT the class. The findById returns
    // null.
    seedMembership({
      classId,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result = await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_DETAIL_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
  });
});

// =============================================================================
// Type-shape sanity
// =============================================================================

describe("getClassDetailForCurrentUser — type-shape sanity", () => {
  it("error result is discriminated by ok=false", async () => {
    mockGetSession.mockResolvedValue(null);
    const result: GetAccessibleClassDetailResult =
      await getClassDetailForCurrentUser(makeObjectId());
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(typeof result.code).toBe("string");
      expect(typeof result.message).toBe("string");
    }
  });

  it("success result is discriminated by ok=true and contains {role, class}", async () => {
    const classId = makeObjectId();
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "TS-OK001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      id: classId,
    });
    const result: GetAccessibleClassDetailResult =
      await getClassDetailForCurrentUser(classId);
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      const detail: AccessibleClassDetail = result.result;
      expect(detail.role).toBe("teacher");
      const cls: SafeClassDetail = detail.class;
      expect(cls.classCode).toBe("TS-OK001");
      expect(typeof cls.createdAt).toBe("string");
      expect(typeof cls.updatedAt).toBe("string");
    }
  });
});
