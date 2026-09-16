/**
 * Tests for the PHASE 5.1D1 server-only authenticated class list
 * read service.
 *
 * Covers the 48-test contract:
 *
 *   ## Auth (1..5)
 *     - read function accepts no userId
 *     - no session → controlled UNAUTHENTICATED
 *     - unauthenticated path performs no class query
 *     - session.user.id is sole identity source
 *     - browser cannot select another user
 *
 *   ## Profile (6..9)
 *     - missing profile → PROFILE_INCOMPLETE
 *     - incomplete profile → PROFILE_INCOMPLETE
 *     - profile role comes from server profile
 *     - browser cannot choose viewer role
 *
 *   ## Teacher (10..16)
 *     - teacher receives owned classes
 *     - teacher does not receive another teacher's classes
 *     - teacher query uses session.user.id
 *     - multiple owned classes returned
 *     - status safely projected
 *     - deterministic ordering
 *     - teacher list contains no passwordHash
 *
 *   ## Student (17..25)
 *     - student receives classes from own memberships
 *     - student does not receive another student's memberships
 *     - student does not receive class without membership
 *     - studentUserId query uses session.user.id
 *     - multiple memberships resolve multiple classes
 *     - duplicate class ids, if corrupt data appears, do not
 *       produce duplicate class summaries
 *     - missing referenced class is skipped safely
 *     - inactive membership does not grant visibility if supported
 *     - deterministic ordering
 *
 *   ## Query behavior (26..29)
 *     - student implementation does not fetch all classes and
 *       filter client-side
 *     - no obvious N+1 one-query-per-class loop if a batch lookup
 *       primitive is used
 *     - empty membership set returns empty classes array
 *     - teacher with no classes returns empty classes array
 *
 *   ## Safe DTO (30..40)
 *     - result includes id
 *     - result includes name
 *     - result includes classCode
 *     - result includes status
 *     - result includes createdAt
 *     - result contains no password
 *     - result contains no passwordHash
 *     - result contains no teacherUserId unless deliberately required
 *     - result contains no studentUserId
 *     - result contains no membership id
 *     - result contains no biometric fields
 *
 *   ## Read only (41..48)
 *     - list read creates no Class
 *     - list read updates no Class
 *     - list read creates no Membership
 *     - list read updates no Membership
 *     - list read modifies no Profile
 *     - list read calls no Face Service
 *     - list read touches no FaceProfile
 *     - list read creates no attendance data
 *
 * Implementation notes:
 *
 *   - All collaborators (`@/lib/session`, `@/lib/profile-service`,
 *     `@/lib/classes/class-model`, `@/lib/classes/class-membership-model`)
 *     are mocked at module boundaries. No MongoDB / Mongoose / Face
 *     Service / Better Auth is touched.
 *   - The mocks model an in-memory store for classes and
 *     memberships. Every `find` / `findOne` is exercised through
 *     the store. The mocks track call counts so the
 *     read-only / no-N+1 invariants can be asserted.
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
}

interface StoredMembership {
  _id: string;
  classId: string;
  studentUserId: string;
  joinedAt: Date;
  status: "active" | "inactive";
}

const classStore = new Map<string, StoredClass>();
const membershipStore = new Map<string, StoredMembership>();

let nextObjectIdCounter = 0;
function makeObjectId(): string {
  nextObjectIdCounter++;
  // Pad to a 24-char hex-like string so it looks like a Mongo
  // ObjectId for any string-based projection. The actual
  // implementation does NOT depend on the format — it only
  // strings through to Mongoose — but a real-ish shape keeps
  // round-trips consistent.
  return "65f".padEnd(24, "0").slice(0, 24).replace(
    /^../,
    `65`,
  ) + String(nextObjectIdCounter).padStart(20, "0");
}

function classKey(classCode: string): string {
  return classCode;
}

function membershipKey(classId: string, studentUserId: string): string {
  return `${classId}::${studentUserId}`;
}

function resetStores(): void {
  classStore.clear();
  membershipStore.clear();
  nextObjectIdCounter = 0;
}

// =============================================================================
// Mock ClassModel
// =============================================================================

const mockFind = vi.fn();
const mockFindById = vi.fn();
const mockCreate = vi.fn();
const mockUpdateOne = vi.fn();
const mockDeleteOne = vi.fn();

vi.mock("@/lib/classes/class-model", async () => {
  // Re-export the real `toSafeClassDto` and `CLASS_STATUSES` /
  // types so the production module can compose them if it needs
  // to. The mocked model itself does NOT use them; this is just
  // to keep the module surface compatible.
  const actual =
    await vi.importActual<typeof import("./class-model")>(
      "./class-model",
    );
  return {
    ...actual,
    ClassModel: {
      find: (...args: unknown[]) => mockFind(...args),
      findById: (...args: unknown[]) => mockFindById(...args),
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
  };
  classStore.set(classKey(opts.classCode), stored);
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
  docs: StoredClass[],
  projection: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  return docs.map((doc) => {
    if (!projection) return { ...doc };
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(projection)) {
      // `0`/`false`/absent means EXCLUDE in Mongoose; `1`/`true`
      // means INCLUDE. We model include-only projections here
      // (the production code always uses positive selections).
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
  });
}

function applyMembershipFindProjection(
  docs: StoredMembership[],
  projection: Record<string, unknown> | undefined,
): Record<string, unknown>[] {
  return docs.map((doc) => {
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
  });
}

// Configure `mockFind` based on the filter passed in. We support
// the two filter shapes the production code uses:
//
//   - `{ teacherUserId }`                 → teacher path
//   - `{ _id: { $in: [...] } }`           → student batch lookup
function configureClassFindMock(): void {
  mockFind.mockImplementation(
    (filter: Record<string, unknown>) =>
      chainable(async () => {
        if (
          typeof filter["teacherUserId"] === "string"
        ) {
          const matches = Array.from(classStore.values()).filter(
            (doc) =>
              doc.teacherUserId === filter["teacherUserId"],
          );
          // Sort by createdAt DESC.
          matches.sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime(),
          );
          // Default projection (when the caller didn't chain
          // `.select(...)`) returns the full document. The
          // production code always chains `.select(...)` first,
          // so this branch is only used as a fallback.
          return applyClassFindProjection(matches, undefined);
        }
        const idFilter = filter["_id"];
        if (
          idFilter &&
          typeof idFilter === "object" &&
          "$in" in (idFilter as Record<string, unknown>)
        ) {
          const inList = (idFilter as { $in: unknown[] }).$in;
          const ids = new Set(
            inList.map((value) =>
              typeof value === "string"
                ? value
                : (value as { toString?: () => string }).toString?.() ??
                  String(value),
            ),
          );
          const matches = Array.from(classStore.values()).filter(
            (doc) => ids.has(doc._id),
          );
          matches.sort(
            (a, b) =>
              b.createdAt.getTime() - a.createdAt.getTime(),
          );
          return applyClassFindProjection(matches, undefined);
        }
        return [];
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
        // Sort by joinedAt DESC.
        matches.sort(
          (a, b) =>
            b.joinedAt.getTime() - a.joinedAt.getTime(),
        );
        return applyMembershipFindProjection(matches, undefined);
      }),
  );
}

// =============================================================================
// Imports under test
// =============================================================================

import {
  CLASS_READ_ERROR_CODES,
  getClassesByIds,
  getVisibleClassesForCurrentUser,
  type GetVisibleClassesResult,
  type SafeClassSummary,
  type VisibleClassesResult,
} from "./class-read-service";

// =============================================================================
// Setup / teardown
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  resetStores();

  // Default happy-path mocks.
  mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
  mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());

  // ClassModel.find / ClassMembershipModel.find honor the
  // configured in-memory stores.
  configureClassFindMock();
  configureMembershipFindMock();

  // Write primitives are NEVER called by the read service. We
  // install counters so the read-only invariants can be asserted.
  mockCreate.mockImplementation(() => {
    throw new Error("ClassModel.create must not be called by D1");
  });
  mockUpdateOne.mockImplementation(() => {
    throw new Error("ClassModel.updateOne must not be called by D1");
  });
  mockDeleteOne.mockImplementation(() => {
    throw new Error("ClassModel.deleteOne must not be called by D1");
  });
  mockMembershipCreate.mockImplementation(() => {
    throw new Error(
      "ClassMembershipModel.create must not be called by D1",
    );
  });
  mockMembershipUpdateOne.mockImplementation(() => {
    throw new Error(
      "ClassMembershipModel.updateOne must not be called by D1",
    );
  });
  mockFindById.mockImplementation(() =>
    chainable(async () => null),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// 1..5 — Authentication
// =============================================================================

describe("getVisibleClassesForCurrentUser — auth", () => {
  it("1. read function accepts no userId (zero arguments)", async () => {
    // Type-level guarantee: the function's arity is 0.
    expect(getVisibleClassesForCurrentUser.length).toBe(0);
  });

  it("2. no session → controlled UNAUTHENTICATED", async () => {
    mockGetSession.mockResolvedValue(null);
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_READ_ERROR_CODES.UNAUTHENTICATED,
      );
      expect(result.message).toBeDefined();
      // The message must not leak any session / driver detail.
      expect(result.message).not.toMatch(/mongo/i);
      expect(result.message).not.toMatch(/session/i);
    }
  });

  it("3. unauthenticated path performs no class query", async () => {
    mockGetSession.mockResolvedValue(null);
    await getVisibleClassesForCurrentUser();
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockMembershipFind).not.toHaveBeenCalled();
    expect(mockGetProfileByUserId).not.toHaveBeenCalled();
  });

  it("4. session.user.id is sole identity source", async () => {
    const sessionUserId = "session-derived-id-001";
    mockGetSession.mockResolvedValue(makeSession(sessionUserId));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({
        role: "teacher",
        onboardingCompleted: true,
      }),
    );
    // Pre-seed an owned class so the read returns something.
    seedClass({
      teacherUserId: sessionUserId,
      classCode: "OWNED01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    await getVisibleClassesForCurrentUser();
    // The teacher query filter MUST equal session.user.id.
    expect(mockFind).toHaveBeenCalledTimes(1);
    const filter = mockFind.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(filter["teacherUserId"]).toBe(sessionUserId);
  });

  it("5. browser cannot select another user (no userId argument)", async () => {
    // The function takes no arguments; this is a structural
    // assertion. The TypeScript signature is the source of truth
    // — but we also assert at runtime that calling with an
    // argument is a no-op (the function ignores extra args).
    const otherUser = "another-user-id";
    seedClass({
      teacherUserId: otherUser,
      classCode: "OTHER01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    mockGetSession.mockResolvedValue(makeSession("session-user-001"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ role: "teacher" }),
    );
    // Call with an extra positional argument (defensive).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (getVisibleClassesForCurrentUser as any)(otherUser);
    // The query filter MUST be the session user id, not `otherUser`.
    expect(mockFind).toHaveBeenCalledTimes(1);
    const filter = mockFind.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(filter["teacherUserId"]).toBe("session-user-001");
    expect(filter["teacherUserId"]).not.toBe(otherUser);
  });
});

// =============================================================================
// 6..9 — Profile gating
// =============================================================================

describe("getVisibleClassesForCurrentUser — profile gating", () => {
  it("6. missing profile → PROFILE_INCOMPLETE", async () => {
    mockGetProfileByUserId.mockResolvedValue(null);
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_READ_ERROR_CODES.PROFILE_INCOMPLETE,
      );
    }
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockMembershipFind).not.toHaveBeenCalled();
  });

  it("7. incomplete profile → PROFILE_INCOMPLETE", async () => {
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ onboardingCompleted: false }),
    );
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_READ_ERROR_CODES.PROFILE_INCOMPLETE,
      );
    }
    expect(mockFind).not.toHaveBeenCalled();
  });

  it("8. profile role comes from server profile (not from input)", async () => {
    // Teacher profile → teacher path (teacherUserId query).
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ role: "teacher" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "OWNED01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.role).toBe("teacher");
    }
    expect(mockFind).toHaveBeenCalledTimes(1);
    expect(mockMembershipFind).not.toHaveBeenCalled();

    // Student profile → student path (membership query).
    vi.clearAllMocks();
    configureClassFindMock();
    configureMembershipFindMock();
    // Default write mocks throw — re-install.
    mockCreate.mockImplementation(() => {
      throw new Error("ClassModel.create must not be called by D1");
    });
    mockUpdateOne.mockImplementation(() => {
      throw new Error("ClassModel.updateOne must not be called by D1");
    });
    mockDeleteOne.mockImplementation(() => {
      throw new Error("ClassModel.deleteOne must not be called by D1");
    });
    mockMembershipCreate.mockImplementation(() => {
      throw new Error(
        "ClassMembershipModel.create must not be called by D1",
      );
    });
    mockMembershipUpdateOne.mockImplementation(() => {
      throw new Error(
        "ClassMembershipModel.updateOne must not be called by D1",
      );
    });
    mockFindById.mockImplementation(() =>
      chainable(async () => null),
    );
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ role: "student" }),
    );
    const cls = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "STU-CLS1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    seedMembership({
      classId: cls._id,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result2 = await getVisibleClassesForCurrentUser();
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.result.role).toBe("student");
    }
    expect(mockMembershipFind).toHaveBeenCalledTimes(1);
    expect(mockFind).toHaveBeenCalledTimes(1); // batch lookup
  });

  it("9. browser cannot choose viewer role (no role argument)", async () => {
    // The function takes no arguments and never inspects any
    // browser-supplied role. We seed both a teacher-owned class
    // AND a student-membership pattern and assert the role is
    // picked from the Profile alone.
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ role: "student" }),
    );
    const cls = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ABCDEFG",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    seedMembership({
      classId: cls._id,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.role).toBe("student");
    }
    // The teacher branch was NOT taken: no teacherUserId filter.
    const callsWithTeacher = mockFind.mock.calls.filter(
      (call) =>
        typeof (call[0] as Record<string, unknown>)[
          "teacherUserId"
        ] === "string",
    );
    expect(callsWithTeacher.length).toBe(0);
  });
});

// =============================================================================
// 10..16 — Teacher
// =============================================================================

describe("getVisibleClassesForCurrentUser — teacher path", () => {
  it("10. teacher receives owned classes", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ role: "teacher" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "OWNED01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.classes.length).toBe(1);
      expect(result.result.classes[0]?.classCode).toBe("OWNED01");
    }
  });

  it("11. teacher does not receive another teacher's classes", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ role: "teacher" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "MINE001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    seedClass({
      teacherUserId: "OTHER-TEACHER",
      classCode: "OTHER01",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.classes.length).toBe(1);
      expect(result.result.classes[0]?.classCode).toBe("MINE001");
      const codes = result.result.classes.map((c) => c.classCode);
      expect(codes).not.toContain("OTHER01");
    }
  });

  it("12. teacher query uses session.user.id", async () => {
    const sessionUserId = "T-SESSION-1";
    mockGetSession.mockResolvedValue(makeSession(sessionUserId));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ role: "teacher" }),
    );
    await getVisibleClassesForCurrentUser();
    expect(mockFind).toHaveBeenCalledTimes(1);
    const filter = mockFind.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(filter["teacherUserId"]).toBe(sessionUserId);
  });

  it("13. multiple owned classes returned", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ role: "teacher" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "MINE001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "MINE002",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "MINE003",
      createdAt: new Date("2026-01-03T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.classes.length).toBe(3);
      const codes = result.result.classes
        .map((c) => c.classCode)
        .sort();
      expect(codes).toEqual(["MINE001", "MINE002", "MINE003"]);
    }
  });

  it("14. status safely projected", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ role: "teacher" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ACTIVE1",
      status: "active",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ARCHIV1",
      status: "archived",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const byCode = Object.fromEntries(
        result.result.classes.map((c) => [c.classCode, c]),
      );
      expect(byCode["ACTIVE1"]?.status).toBe("active");
      expect(byCode["ARCHIV1"]?.status).toBe("archived");
    }
  });

  it("15. deterministic ordering — newest first (createdAt DESC)", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ role: "teacher" }),
    );
    // Seed out of order to confirm the service sorts, not the
    // caller.
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "MIDDLE1",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NEWEST1",
      createdAt: new Date("2026-01-03T00:00:00Z"),
    });
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "OLDEST1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.classes.map((c) => c.classCode)).toEqual([
        "NEWEST1",
        "MIDDLE1",
        "OLDEST1",
      ]);
    }
  });

  it("16. teacher list contains no passwordHash", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ role: "teacher" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "SAFE001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("passwordHash");
      expect(serialized).not.toContain("pbkdf2");
      for (const cls of result.result.classes) {
        expect(cls).not.toHaveProperty("passwordHash");
        expect(cls).not.toHaveProperty("password");
        expect(cls).not.toHaveProperty("teacherUserId");
      }
    }
  });
});

// =============================================================================
// 17..25 — Student
// =============================================================================

describe("getVisibleClassesForCurrentUser — student path", () => {
  it("17. student receives classes from own memberships", async () => {
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ role: "student" }),
    );
    const cls = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "JOINED1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    seedMembership({
      classId: cls._id,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.role).toBe("student");
      expect(result.result.classes.length).toBe(1);
      expect(result.result.classes[0]?.classCode).toBe("JOINED1");
    }
  });

  it("18. student does not receive another student's memberships", async () => {
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ role: "student" }),
    );
    const cls1 = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "ALICE1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const cls2 = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "BOB0001",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedMembership({
      classId: cls1._id,
      studentUserId: "OTHER-STUDENT",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedMembership({
      classId: cls2._id,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-03T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const codes = result.result.classes.map((c) => c.classCode);
      expect(codes).toContain("BOB0001");
      expect(codes).not.toContain("ALICE1");
    }
  });

  it("19. student does not receive class without membership", async () => {
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ role: "student" }),
    );
    // Seed two classes — only one has a membership for S-USER-1.
    const joined = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "JOINED2",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOTJOIN",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedMembership({
      classId: joined._id,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-03T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const codes = result.result.classes.map((c) => c.classCode);
      expect(codes).toContain("JOINED2");
      expect(codes).not.toContain("NOTJOIN");
    }
  });

  it("20. studentUserId query uses session.user.id", async () => {
    const sessionUserId = "S-SESSION-1";
    mockGetSession.mockResolvedValue(makeSession(sessionUserId));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ role: "student" }),
    );
    await getVisibleClassesForCurrentUser();
    // The first find call is the membership query; the second
    // is the class batch lookup. The membership filter MUST use
    // the session id.
    expect(mockMembershipFind).toHaveBeenCalledTimes(1);
    const filter = mockMembershipFind.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(filter["studentUserId"]).toBe(sessionUserId);
    expect(filter["status"]).toBe("active");
  });

  it("21. multiple memberships resolve multiple classes", async () => {
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ role: "student" }),
    );
    const cls1 = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "CLASSA1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const cls2 = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "CLASSB1",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    const cls3 = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "CLASSC1",
      createdAt: new Date("2026-01-03T00:00:00Z"),
    });
    seedMembership({
      classId: cls1._id,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-01T00:00:00Z"),
    });
    seedMembership({
      classId: cls2._id,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedMembership({
      classId: cls3._id,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-03T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const codes = result.result.classes
        .map((c) => c.classCode)
        .sort();
      expect(codes).toEqual(["CLASSA1", "CLASSB1", "CLASSC1"]);
    }
  });

  it("22. duplicate class ids do not produce duplicate summaries", async () => {
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ role: "student" }),
    );
    const cls = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "DUPCLASS",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    // Seed two membership rows for the SAME class (compound
    // unique index normally prevents this; we deliberately
    // bypass it to model corrupt legacy data).
    membershipStore.set(
      membershipKey(cls._id, "S-USER-1"),
      {
        _id: makeObjectId(),
        classId: cls._id,
        studentUserId: "S-USER-1",
        joinedAt: new Date("2026-01-02T00:00:00Z"),
        status: "active",
      },
    );
    membershipStore.set(
      `${cls._id}::S-USER-1::dup`,
      {
        _id: makeObjectId(),
        classId: cls._id,
        studentUserId: "S-USER-1",
        joinedAt: new Date("2026-01-03T00:00:00Z"),
        status: "active",
      },
    );
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The same class id should appear exactly once.
      expect(result.result.classes.length).toBe(1);
      expect(result.result.classes[0]?.classCode).toBe("DUPCLASS");
    }
  });

  it("23. missing referenced class is skipped safely", async () => {
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ role: "student" }),
    );
    // Seed one present class with a real membership.
    const present = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "PRESENT1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    seedMembership({
      classId: present._id,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    // Seed a membership that points at a non-existent class.
    seedMembership({
      classId: "65ffffffffffffffffffffff", // not in classStore
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-03T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const codes = result.result.classes.map((c) => c.classCode);
      expect(codes).toEqual(["PRESENT1"]);
    }
  });

  it("24. inactive membership does not grant visibility (forward-compatible)", async () => {
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ role: "student" }),
    );
    const cls = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "INACTIVE",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    // Membership row with `status: "inactive"` (forward-compatible
    // with a future status enum expansion).
    seedMembership({
      classId: cls._id,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
      status: "inactive",
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.classes.length).toBe(0);
    }
  });

  it("25. deterministic ordering — newest first (createdAt DESC)", async () => {
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ role: "student" }),
    );
    const cls1 = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "STU-A01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const cls2 = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "STU-B01",
      createdAt: new Date("2026-01-03T00:00:00Z"),
    });
    const cls3 = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "STU-C01",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedMembership({
      classId: cls1._id,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-01T00:00:00Z"),
    });
    seedMembership({
      classId: cls2._id,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });
    seedMembership({
      classId: cls3._id,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-03T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.classes.map((c) => c.classCode)).toEqual([
        "STU-B01",
        "STU-C01",
        "STU-A01",
      ]);
    }
  });
});

// =============================================================================
// 26..29 — Query behavior
// =============================================================================

describe("getVisibleClassesForCurrentUser — query behavior", () => {
  it("26. student implementation does not fetch all classes and filter client-side", async () => {
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ role: "student" }),
    );
    // Seed 50 classes total; only one is joined. A naive
    // "fetch all, filter in memory" implementation would issue
    // ONE unfiltered ClassModel.find. The D1 contract forbids
    // that — the implementation MUST batch-fetch only the
    // referenced ids.
    for (let i = 0; i < 50; i++) {
      const code = `ALL${String(i).padStart(3, "0")}`;
      seedClass({
        teacherUserId: "T-USER-1",
        classCode: code,
        createdAt: new Date(2026, 0, 1, 0, i, 0),
      });
    }
    const cls = classStore.get("ALL000")!;
    seedMembership({
      classId: cls._id,
      studentUserId: "S-USER-1",
      joinedAt: new Date("2026-01-02T00:00:00Z"),
    });

    await getVisibleClassesForCurrentUser();

    // The class find MUST be filtered by `_id: { $in: [...] }`
    // (a single batched lookup). It MUST NOT be unfiltered.
    const classCalls = mockFind.mock.calls.filter(
      (call) =>
        !(
          typeof (call[0] as Record<string, unknown>)[
            "teacherUserId"
          ] === "string"
        ),
    );
    expect(classCalls.length).toBeGreaterThanOrEqual(1);
    const batchCall = classCalls[0];
    const filter = batchCall?.[0] as Record<string, unknown>;
    expect(filter["_id"]).toBeDefined();
    expect(
      (filter["_id"] as Record<string, unknown>)["$in"],
    ).toBeDefined();
    // The batched `$in` MUST NOT contain all 50 class ids — it
    // MUST contain exactly the joined class id.
    const inList = ((filter["_id"] as Record<string, unknown>)[
      "$in"
    ] as unknown[]) ?? [];
    expect(inList.length).toBe(1);
    expect(inList[0]).toBe(cls._id);
  });

  it("27. no obvious N+1 — uses a single batched class lookup", async () => {
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ role: "student" }),
    );
    // Seed 5 memberships → 5 distinct classes.
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const cls = seedClass({
        teacherUserId: "T-USER-1",
        classCode: `BATCH${String(i).padStart(2, "0")}`,
        createdAt: new Date(2026, 0, 1, 0, i, 0),
      });
      seedMembership({
        classId: cls._id,
        studentUserId: "S-USER-1",
        joinedAt: new Date("2026-01-02T00:00:00Z"),
      });
      ids.push(cls._id);
    }
    await getVisibleClassesForCurrentUser();

    // The class-side find MUST be exactly ONE call (batched),
    // not one call per membership.
    const classCalls = mockFind.mock.calls.filter(
      (call) =>
        !(
          typeof (call[0] as Record<string, unknown>)[
            "teacherUserId"
          ] === "string"
        ),
    );
    expect(classCalls.length).toBe(1);
    const filter = classCalls[0]?.[0] as Record<string, unknown>;
    const inList =
      ((filter["_id"] as Record<string, unknown>)["$in"] as
        | unknown[]
        | undefined) ?? [];
    expect(new Set(inList)).toEqual(new Set(ids));
  });

  it("28. empty membership set returns empty classes array", async () => {
    mockGetSession.mockResolvedValue(makeSession("S-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ role: "student" }),
    );
    // No memberships seeded.
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.classes).toEqual([]);
    }
  });

  it("29. teacher with no classes returns empty classes array", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ role: "teacher" }),
    );
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.classes).toEqual([]);
    }
  });
});

// =============================================================================
// 30..40 — Safe DTO
// =============================================================================

describe("getVisibleClassesForCurrentUser — safe DTO", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ role: "teacher" }),
    );
  });

  it("30. result includes id", async () => {
    const cls = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "IDFIELD1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.classes[0]?.id).toBe(cls._id);
    }
  });

  it("31. result includes name", async () => {
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NAME001",
      name: "Intro to CS",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.classes[0]?.name).toBe("Intro to CS");
    }
  });

  it("32. result includes classCode", async () => {
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "CODE001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.classes[0]?.classCode).toBe("CODE001");
    }
  });

  it("33. result includes status", async () => {
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "STATUS1",
      status: "archived",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.classes[0]?.status).toBe("archived");
    }
  });

  it("34. result includes createdAt as ISO string", async () => {
    const createdAt = new Date("2026-02-15T10:00:00.000Z");
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "DATE001",
      createdAt,
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.classes[0]?.createdAt).toBe(
        "2026-02-15T10:00:00.000Z",
      );
    }
  });

  it("35. result contains no password (plaintext)", async () => {
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOPWD01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/"password"/);
      for (const cls of result.result.classes) {
        expect(cls).not.toHaveProperty("password");
        expect(cls).not.toHaveProperty("rawPassword");
      }
    }
  });

  it("36. result contains no passwordHash", async () => {
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOHASH1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("passwordHash");
      expect(serialized).not.toContain("pbkdf2");
      for (const cls of result.result.classes) {
        expect(cls).not.toHaveProperty("passwordHash");
      }
    }
  });

  it("37. result contains no teacherUserId unless deliberately required", async () => {
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOTEACH1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("teacherUserId");
      for (const cls of result.result.classes) {
        expect(cls).not.toHaveProperty("teacherUserId");
      }
    }
  });

  it("38. result contains no studentUserId", async () => {
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOSTUD1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("studentUserId");
      for (const cls of result.result.classes) {
        expect(cls).not.toHaveProperty("studentUserId");
      }
    }
  });

  it("39. result contains no membership id", async () => {
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOMEMID",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/membershipId/i);
      expect(serialized).not.toMatch(/membership_id/i);
    }
  });

  it("40. result contains no biometric fields", async () => {
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "NOBIOM1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/embedding/i);
      expect(serialized).not.toMatch(/centroid/i);
      expect(serialized).not.toMatch(/FaceProfile/i);
      expect(serialized).not.toMatch(/faceProfile/i);
      for (const cls of result.result.classes) {
        expect(cls).not.toHaveProperty("embedding");
        expect(cls).not.toHaveProperty("centroid");
        expect(cls).not.toHaveProperty("faceProfile");
      }
    }
  });
});

// =============================================================================
// 41..48 — Read only
// =============================================================================

describe("getVisibleClassesForCurrentUser — read only", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ role: "teacher" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "READ001",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
  });

  it("41. list read creates no Class", async () => {
    await getVisibleClassesForCurrentUser();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("42. list read updates no Class", async () => {
    await getVisibleClassesForCurrentUser();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it("43. list read creates no Membership", async () => {
    await getVisibleClassesForCurrentUser();
    expect(mockMembershipCreate).not.toHaveBeenCalled();
  });

  it("44. list read updates no Membership", async () => {
    await getVisibleClassesForCurrentUser();
    expect(mockMembershipUpdateOne).not.toHaveBeenCalled();
  });

  it("45. list read modifies no Profile (read-only)", async () => {
    // Profile is loaded via `getProfileByUserId`. The read
    // service does NOT call any profile write primitive. We
    // assert the mock is consulted exactly once (gating) and
    // that no profile-service WRITE primitive is reachable
    // through the module's static import surface.
    await getVisibleClassesForCurrentUser();
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

  it("46. list read calls no Face Service", async () => {
    // The class-read-service module's import surface does not
    // touch the Face Service. We assert this statically by
    // inspecting the module source.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    // Strip JSDoc comments — the architectural docstring is
    // allowed to MENTION these primitives to assert they are
    // NOT touched at runtime.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/face-service-client/);
    expect(stripped).not.toMatch(/FaceServiceClient/);
    expect(stripped).not.toMatch(/biometrics/);
    expect(stripped).not.toMatch(/Face Service/);
    // And confirm the JSDoc itself DOES mention them so the
    // stripping is correct.
    expect(source).toMatch(/Face Service/);
  });

  it("47. list read touches no FaceProfile", async () => {
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
    // And confirm the JSDoc mentions it (so the strip is sound).
    expect(source).toMatch(/FaceProfile/);
  });

  it("48. list read creates no attendance data", async () => {
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
// Extra invariants
// =============================================================================

describe("getVisibleClassesForCurrentUser — extra invariants", () => {
  it("no password verification primitive is reached", async () => {
    // The read service does NOT consult any password primitive.
    // The class-password module is not in the import surface.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    // Strip JSDoc comments — the architectural docstring is
    // allowed to MENTION these primitives to assert they are NOT
    // touched at runtime.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/verifyClassPassword/);
    expect(stripped).not.toMatch(/runDummyPasswordVerification/);
    expect(stripped).not.toMatch(/hashClassPassword/);
    expect(stripped).not.toMatch(/isValidPasswordHash/);
    expect(stripped).not.toMatch(/DUMMY_CLASS_PASSWORD_HASH/);
    expect(stripped).not.toMatch(/getClassJoinCredentialByCode/);
  });

  it("no Class write primitive is reached", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/createClass\s*\(/);
    expect(source).not.toMatch(/updateClass\s*\(/);
    expect(source).not.toMatch(/deleteClass\s*\(/);
    expect(source).not.toMatch(/archiveClass\s*\(/);
  });

  it("opens with import 'server-only'", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    expect(source).toMatch(/import\s+["']server-only["']/);
  });

  it("does not declare a `\"use server\"` directive (it is not a Server Action)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/["']use server["']/);
  });

  it("does not import the public barrel (`@/lib/classes`) for the credential lookup or password helper", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-read-service.ts"),
      "utf-8",
    );
    // The module imports from `./class-model` and
    // `./class-membership-model`. It MUST NOT import from
    // `./class-service` (the credential / password home) or
    // from `./index` (the public barrel).
    expect(source).not.toMatch(
      /from\s+["']\.\/class-service["']/,
    );
    expect(source).not.toMatch(
      /from\s+["']\.\/index["']/,
    );
    expect(source).not.toMatch(
      /from\s+["']@\/lib\/classes["']/,
    );
  });

  it("unexpected DB failure during class lookup → CLASS_READ_FAILED (no internals leaked)", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ role: "teacher" }),
    );
    mockFind.mockImplementationOnce(() => {
      throw new Error(
        "ECONNREFUSED 10.0.0.1:27017/face_attendance - raw mongo detail",
      );
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_READ_ERROR_CODES.CLASS_READ_FAILED,
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
      makeStudentProfile({ role: "student" }),
    );
    mockMembershipFind.mockImplementationOnce(() => {
      throw new Error("E11000 kaboom stack trace here");
    });
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_READ_ERROR_CODES.CLASS_READ_FAILED,
      );
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("E11000");
      expect(serialized).not.toContain("kaboom");
      expect(serialized).not.toContain("stack");
    }
  });

  it("profile lookup failure → CLASS_READ_FAILED (no driver leak)", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockRejectedValue(
      new Error("ECONNREFUSED 10.0.0.1:27017"),
    );
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_READ_ERROR_CODES.CLASS_READ_FAILED,
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
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_READ_ERROR_CODES.UNAUTHENTICATED,
      );
    }
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockMembershipFind).not.toHaveBeenCalled();
  });

  it("unknown profile.role collapses to CLASS_READ_FAILED (defensive)", async () => {
    mockGetSession.mockResolvedValue(makeSession("X-USER-1"));
    mockGetProfileByUserId.mockResolvedValue({
      // An unexpected role value — the schema would normally
      // prevent this, but a legacy document could carry it.
      userId: "X-USER-1",
      role: "admin" as unknown as "teacher",
      onboardingCompleted: true,
    } as unknown as Awaited<ReturnType<typeof mockGetProfileByUserId>>);
    const result = await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CLASS_READ_ERROR_CODES.CLASS_READ_FAILED,
      );
      const serialized = JSON.stringify(result);
      // The unknown role value MUST NOT be leaked.
      expect(serialized).not.toContain("admin");
    }
  });
});

// =============================================================================
// getClassesByIds primitive — exposed for future use
// =============================================================================

describe("getClassesByIds — multi-id primitive", () => {
  it("returns safe summaries for the supplied ids, sorted createdAt DESC", async () => {
    const cls1 = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "PRIM-A",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const cls2 = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "PRIM-B",
      createdAt: new Date("2026-01-03T00:00:00Z"),
    });
    const cls3 = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "PRIM-C",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    });
    // Pre-seed so the class ids are stable.
    void cls1;
    void cls2;
    void cls3;
    const summaries = await getClassesByIds([cls1._id, cls2._id, cls3._id]);
    expect(summaries.length).toBe(3);
    expect(summaries.map((s) => s.classCode)).toEqual([
      "PRIM-B",
      "PRIM-C",
      "PRIM-A",
    ]);
    // Safe DTO sanity.
    for (const s of summaries) {
      expect(s).not.toHaveProperty("passwordHash");
      expect(s).not.toHaveProperty("teacherUserId");
    }
  });

  it("skips non-existent ids safely", async () => {
    const cls = seedClass({
      teacherUserId: "T-USER-1",
      classCode: "EXIST01",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const summaries = await getClassesByIds([
      cls._id,
      "65ffffffffffffffffffffff",
    ]);
    expect(summaries.length).toBe(1);
    expect(summaries[0]?.classCode).toBe("EXIST01");
  });

  it("empty input returns empty array", async () => {
    const summaries = await getClassesByIds([]);
    expect(summaries).toEqual([]);
  });
});

// =============================================================================
// Type-shape sanity (compile-time guarantees verified at runtime)
// =============================================================================

describe("type-shape sanity", () => {
  it("error result is discriminated by ok=false", async () => {
    mockGetSession.mockResolvedValue(null);
    const result: GetVisibleClassesResult =
      await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      // TS narrowing — `code` and `message` exist.
      expect(typeof result.code).toBe("string");
      expect(typeof result.message).toBe("string");
    }
  });

  it("success result is discriminated by ok=true and contains {role, classes[]}", async () => {
    mockGetSession.mockResolvedValue(makeSession("T-USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ role: "teacher" }),
    );
    seedClass({
      teacherUserId: "T-USER-1",
      classCode: "TYPECHK1",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    });
    const result: GetVisibleClassesResult =
      await getVisibleClassesForCurrentUser();
    expect(result.ok).toBe(true);
    if (result.ok === true) {
      const visible: VisibleClassesResult = result.result;
      expect(visible.role).toBe("teacher");
      const first: SafeClassSummary | undefined =
        visible.classes[0];
      expect(first?.classCode).toBe("TYPECHK1");
      expect(typeof first?.createdAt).toBe("string");
    }
  });
});