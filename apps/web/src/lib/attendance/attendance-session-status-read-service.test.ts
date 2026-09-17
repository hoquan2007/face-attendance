/**
 * Tests for the PHASE 6.2 server-only
 * `getAttendanceSessionStatusForCurrentTeacher` read boundary.
 *
 * The boundary is the read-side counterpart of the
 * `startAttendanceSessionAction` / `stopAttendanceSessionAction`
 * Server Actions. It is a server-only `async` function (NOT a
 * Server Action), intentionally importable by a Server Component
 * so the `/classes/[classId]` page can render the teacher
 * Attendance section without introducing a REST route.
 *
 * Contract matrix (1..11):
 *
 *   ## Auth + profile (1..4)
 *     1.  no session        → UNAUTHENTICATED.
 *     2.  incomplete profile → PROFILE_INCOMPLETE.
 *     3.  student role       → TEACHER_REQUIRED (NO class /
 *         session query performed).
 *     4.  accepts classId ONLY (no teacherUserId, no userId,
 *         no role on input).
 *
 *   ## Authorization (5..7)
 *     5.  non-owner teacher    → CLASS_NOT_ACCESSIBLE
 *         (indistinguishable from missing class).
 *     6.  malformed classId    → CLASS_NOT_ACCESSIBLE
 *         (no DB call performed).
 *     7.  active session wins  — when both active AND closed
 *         sessions exist for the class, the ACTIVE one is
 *         returned with `state = "active"`.
 *
 *   ## Session selection (8..10)
 *     8.  no session           → `state = "none"` and
 *         `session = null`.
 *     9.  latest closed session → returned deterministically by
 *         `startedAt DESC`.
 *     10. `rosterCount` is computed from the stored snapshot
 *         length, NOT recomputed from current class membership.
 *
 *   ## Privacy (11..16)
 *     11. `rosterSnapshot` is NEVER projected.
 *     12. `studentUserId` is NEVER projected.
 *     13. `startedByUserId` is NEVER projected.
 *     14. `teacherUserId` is NEVER projected.
 *     15. Password hash / email / phone is NEVER projected.
 *     16. Biometric data (embedding / centroid / FaceProfile) is
 *         NEVER projected; the function does NOT import any
 *         biometric module.
 *
 * Implementation notes:
 *   - All collaborators (`@/lib/session`,
 *     `@/lib/profile-service`, `@/lib/classes/class-model`,
 *     `@/lib/attendance/attendance-session-model`) are mocked at
 *     module boundaries. No MongoDB / Mongoose / Face Service /
 *     Better Auth is touched.
 *   - The class + session mocks are in-memory stores with
 *     `findOne` / `find` chains modeled like Mongoose.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Mocks
// =============================================================================

const mockGetSession = vi.fn();
const mockGetProfileByUserId = vi.fn();
const mockClassFindOne = vi.fn();
const mockActiveSessionFindOne = vi.fn();
const mockClosedSessionFind = vi.fn();

vi.mock("@/lib/session", () => ({
  getSession: () => mockGetSession(),
}));

vi.mock("@/lib/profile-service", () => ({
  getProfileByUserId: (...args: unknown[]) =>
    mockGetProfileByUserId(...args),
}));

vi.mock("@/lib/classes/class-model", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/classes/class-model")>(
      "@/lib/classes/class-model",
    );
  return {
    ...actual,
    ClassModel: {
      findOne: (...args: unknown[]) => mockClassFindOne(...args),
    },
  };
});

vi.mock("@/lib/attendance/attendance-session-model", async () => {
  const actual =
    await vi.importActual<
      typeof import("@/lib/attendance/attendance-session-model")
    >("@/lib/attendance/attendance-session-model");
  return {
    ...actual,
    AttendanceSessionModel: {
      findOne: (...args: unknown[]) => mockActiveSessionFindOne(...args),
      find: (...args: unknown[]) => mockClosedSessionFind(...args),
    },
  };
});

// =============================================================================
// Imports under test
// =============================================================================

import { getAttendanceSessionStatusForCurrentTeacher } from "./attendance-session-status-read-service";
import { ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES } from "./attendance-session-status-read-service";

// =============================================================================
// Fixtures
// =============================================================================

const TEACHER_USER_ID = "teacher-better-auth-id-001";
const OTHER_TEACHER_USER_ID = "teacher-better-auth-id-002";
const STUDENT_USER_ID = "student-better-auth-id-003";
const OWNED_CLASS_ID = "65f000000000000000000abc";
const NON_HEX_ID = "not-a-canonical-hex";

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
    userId: TEACHER_USER_ID,
    emailSnapshot: "teacher@example.com",
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
}> = {}) {
  return {
    userId: STUDENT_USER_ID,
    emailSnapshot: "student@example.com",
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

function makeOwnedClassDoc(overrides: Partial<{
  status: "active" | "archived";
  teacherUserId: string;
}> = {}) {
  return {
    _id: { toString: () => OWNED_CLASS_ID },
    name: "Web Dev",
    classCode: "ABCDEFG",
    passwordHash: "secret-pbkdf2-hash",
    status: "active" as const,
    teacherUserId: TEACHER_USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeSessionDoc(overrides: Partial<{
  classId: string;
  status: "active" | "closed";
  startedAt: Date;
  endedAt: Date | null;
  rosterCount: number;
}> = {}) {
  const classId = overrides.classId ?? OWNED_CLASS_ID;
  return {
    _id: { toString: () => "65f000000000000000000fff" },
    classId: { toString: () => classId } as unknown,
    status: overrides.status ?? ("active" as const),
    startedAt: overrides.startedAt ?? new Date("2026-09-16T10:00:00Z"),
    endedAt: overrides.endedAt ?? null,
    startedByUserId: TEACHER_USER_ID,
    teacherUserId: TEACHER_USER_ID,
    rosterSnapshot: Array.from(
      { length: overrides.rosterCount ?? 0 },
      (_, i) => ({
        studentUserId: `s-${i + 1}`,
        fullNameSnapshot: `Student ${i + 1}`,
        identificationCodeSnapshot: `S-${i + 1}`,
      }),
    ),
    createdAt: overrides.startedAt ?? new Date("2026-09-16T10:00:00Z"),
    updatedAt: overrides.startedAt ?? new Date("2026-09-16T10:00:00Z"),
  };
}

function setupClassFindOneChain(
  result: ReturnType<typeof makeOwnedClassDoc> | null,
) {
  mockClassFindOne.mockImplementationOnce(() => {
    const query = {
      select: () => query,
      lean: () => query,
      exec: async () => result,
    };
    return query;
  });
}

function setupActiveSessionFindOneChain(
  result: ReturnType<typeof makeSessionDoc> | null,
) {
  mockActiveSessionFindOne.mockImplementationOnce(() => {
    const query = {
      lean: () => query,
      exec: async () => result,
    };
    return query;
  });
}

function setupClosedSessionFindChain(
  results: Array<ReturnType<typeof makeSessionDoc>>,
) {
  mockClosedSessionFind.mockImplementationOnce(() => {
    const query = {
      sort: () => query,
      limit: () => query,
      lean: () => query,
      exec: async () => results,
    };
    return query;
  });
}

// =============================================================================
// Setup / teardown
// =============================================================================

beforeEach(() => {
  vi.resetAllMocks();
  // Default happy-path mocks. Each test sets its own class /
  // session mock chains.
  mockGetSession.mockResolvedValue(makeSession(TEACHER_USER_ID));
  mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
  mockClassFindOne.mockImplementation(() => {
    const query = {
      select: () => query,
      lean: () => query,
      exec: async () => makeOwnedClassDoc(),
    };
    return query;
  });
  mockActiveSessionFindOne.mockImplementation(() => {
    const query = {
      lean: () => query,
      exec: async () => null,
    };
    return query;
  });
  mockClosedSessionFind.mockImplementation(() => {
    const query = {
      sort: () => query,
      limit: () => query,
      lean: () => query,
      exec: async () => [],
    };
    return query;
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// 1..4 — Auth + profile
// =============================================================================

describe("getAttendanceSessionStatusForCurrentTeacher — auth + profile", () => {
  it("1. no session → UNAUTHENTICATED (no DB call performed)", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const result = await getAttendanceSessionStatusForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.UNAUTHENTICATED,
      );
    }
    expect(mockClassFindOne).not.toHaveBeenCalled();
    expect(mockActiveSessionFindOne).not.toHaveBeenCalled();
    expect(mockClosedSessionFind).not.toHaveBeenCalled();
  });

  it("2. incomplete profile → PROFILE_INCOMPLETE (no DB call performed)", async () => {
    mockGetProfileByUserId.mockResolvedValueOnce(
      makeTeacherProfile({ onboardingCompleted: false }),
    );
    const result = await getAttendanceSessionStatusForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.PROFILE_INCOMPLETE,
      );
    }
    expect(mockClassFindOne).not.toHaveBeenCalled();
  });

  it("3. student → TEACHER_REQUIRED (NO class / session query)", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession(STUDENT_USER_ID));
    mockGetProfileByUserId.mockResolvedValueOnce(makeStudentProfile());
    const result = await getAttendanceSessionStatusForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.TEACHER_REQUIRED,
      );
    }
    // The student path MUST NOT probe whether attendance is
    // running for any class.
    expect(mockClassFindOne).not.toHaveBeenCalled();
    expect(mockActiveSessionFindOne).not.toHaveBeenCalled();
    expect(mockClosedSessionFind).not.toHaveBeenCalled();
  });

  it("4. accepts classId ONLY (smuggled identity / role are silently ignored)", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    // No active / no closed.
    const result = await (getAttendanceSessionStatusForCurrentTeacher as unknown as (
      classId: string,
      teacherUserId: string,
      role: string,
    ) => Promise<ReturnType<typeof getAttendanceSessionStatusForCurrentTeacher>>)(
      OWNED_CLASS_ID,
      "attacker-supplied-user-id",
      "student",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The smuggled identity and role are NEVER used — the
      // bound function reads the BETTER AUTH SESSION only.
      expect(result.result.state).toBe("none");
    }
    // The smuggled args did not bypass the session-derived
    // identity.
    expect(mockGetSession).toHaveBeenCalledTimes(1);
    expect(mockGetSession).toHaveBeenCalledWith();
  });
});

// =============================================================================
// 5..7 — Authorization
// =============================================================================

describe("getAttendanceSessionStatusForCurrentTeacher — authorization", () => {
  it("5. non-owner teacher → CLASS_NOT_ACCESSIBLE (no attendance probe)", async () => {
    // The teacher-ownership filter returns null because the
    // class is owned by a different teacher.
    setupClassFindOneChain(null);
    const result = await getAttendanceSessionStatusForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    // Critically: NO active / closed session lookup is
    // performed — the non-owner teacher cannot probe whether
    // attendance is running.
    expect(mockActiveSessionFindOne).not.toHaveBeenCalled();
    expect(mockClosedSessionFind).not.toHaveBeenCalled();
  });

  it("6. malformed classId → CLASS_NOT_ACCESSIBLE (no DB call)", async () => {
    const result = await getAttendanceSessionStatusForCurrentTeacher(
      NON_HEX_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    expect(mockClassFindOne).not.toHaveBeenCalled();
    expect(mockActiveSessionFindOne).not.toHaveBeenCalled();
    expect(mockClosedSessionFind).not.toHaveBeenCalled();
  });

  it("7. active session wins over closed", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    // Both an active AND a closed session exist.
    setupActiveSessionFindOneChain(
      makeSessionDoc({
        status: "active",
        rosterCount: 7,
        startedAt: new Date("2026-09-16T10:00:00Z"),
      }),
    );
    // No expectation that closed is called — but if it is, it
    // must NOT be relied on to return a session.
    setupClosedSessionFindChain([
      makeSessionDoc({
        status: "closed",
        rosterCount: 5,
        startedAt: new Date("2026-09-15T10:00:00Z"),
        endedAt: new Date("2026-09-15T11:00:00Z"),
      }),
    ]);
    const result = await getAttendanceSessionStatusForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.state).toBe("active");
      expect(result.result.session).not.toBeNull();
      expect(result.result.session?.status).toBe("active");
      expect(result.result.session?.rosterCount).toBe(7);
    }
  });
});

// =============================================================================
// 8..10 — Session selection
// =============================================================================

describe("getAttendanceSessionStatusForCurrentTeacher — session selection", () => {
  it("8. no session → state = 'none' and session = null", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    setupActiveSessionFindOneChain(null);
    setupClosedSessionFindChain([]);
    const result = await getAttendanceSessionStatusForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.state).toBe("none");
      expect(result.result.session).toBeNull();
    }
  });

  it("9. latest closed session returned deterministically", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    setupActiveSessionFindOneChain(null);
    setupClosedSessionFindChain([
      makeSessionDoc({
        status: "closed",
        rosterCount: 9,
        startedAt: new Date("2026-09-15T12:00:00Z"),
        endedAt: new Date("2026-09-15T13:00:00Z"),
      }),
    ]);
    const result = await getAttendanceSessionStatusForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.state).toBe("closed");
      expect(result.result.session?.status).toBe("closed");
      expect(result.result.session?.rosterCount).toBe(9);
    }
  });

  it("10. rosterCount calculated from stored snapshot length, NOT current membership", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    setupActiveSessionFindOneChain(
      makeSessionDoc({ status: "active", rosterCount: 3 }),
    );
    const result = await getAttendanceSessionStatusForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Snapshot size at session start. The boundary does
      // NOT query ClassMembership to recompute it.
      expect(result.result.session?.rosterCount).toBe(3);
    }
  });
});

// =============================================================================
// 11..16 — Privacy
// =============================================================================

describe("getAttendanceSessionStatusForCurrentTeacher — privacy", () => {
  it("11. rosterSnapshot is NEVER projected", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    setupActiveSessionFindOneChain(
      makeSessionDoc({ status: "active", rosterCount: 4 }),
    );
    const result = await getAttendanceSessionStatusForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const session = result.result.session as unknown as Record<
        string,
        unknown
      >;
      expect(session).not.toHaveProperty("rosterSnapshot");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("rosterSnapshot");
      expect(serialized).not.toContain("fullNameSnapshot");
      expect(serialized).not.toContain("identificationCodeSnapshot");
    }
  });

  it("12. studentUserId is NEVER projected", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    setupActiveSessionFindOneChain(
      makeSessionDoc({ status: "active", rosterCount: 2 }),
    );
    const result = await getAttendanceSessionStatusForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const session = result.result.session as unknown as Record<
        string,
        unknown
      >;
      expect(session).not.toHaveProperty("studentUserId");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("studentUserId");
      expect(serialized).not.toContain("s-1");
    }
  });

  it("13. startedByUserId is NEVER projected", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    setupActiveSessionFindOneChain(
      makeSessionDoc({ status: "active", rosterCount: 2 }),
    );
    const result = await getAttendanceSessionStatusForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const session = result.result.session as unknown as Record<
        string,
        unknown
      >;
      expect(session).not.toHaveProperty("startedByUserId");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("startedByUserId");
    }
  });

  it("14. teacherUserId is NEVER projected", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    setupActiveSessionFindOneChain(
      makeSessionDoc({ status: "active", rosterCount: 2 }),
    );
    const result = await getAttendanceSessionStatusForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const session = result.result.session as unknown as Record<
        string,
        unknown
      >;
      expect(session).not.toHaveProperty("teacherUserId");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("teacherUserId");
    }
  });

  it("15. password / email / phone are NEVER projected", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    setupActiveSessionFindOneChain(
      makeSessionDoc({ status: "active", rosterCount: 2 }),
    );
    const result = await getAttendanceSessionStatusForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("passwordHash");
      expect(serialized).not.toContain("password");
      expect(serialized).not.toContain("pbkdf2");
      expect(serialized).not.toContain("emailSnapshot");
      expect(serialized).not.toContain("phone");
    }
  });

  it("16. module never imports biometric / Face Service / FaceProfile", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/lib/attendance/attendance-session-status-read-service.ts",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/embedding/);
    expect(stripped).not.toMatch(/centroid/);
    expect(stripped).not.toMatch(/FaceProfile/);
    expect(stripped).not.toMatch(/biometrics/);
    expect(stripped).not.toMatch(/face-service/);
    expect(stripped).not.toMatch(/FaceService/);
    expect(stripped).not.toMatch(/getUserMedia/);
    expect(stripped).not.toMatch(/MediaStream/);
    expect(stripped).not.toMatch(/recognizedAt/);
    expect(stripped).not.toMatch(/confidence/);
    // The docstring is allowed to mention the keywords for
    // architectural documentation purposes.
    expect(source).toMatch(/biometric/);
  });

  it("16b. failure paths never leak Mongo / stack / internals", async () => {
    // Force the active-session lookup to throw.
    mockActiveSessionFindOne.mockImplementationOnce(() => {
      const query = {
        lean: () => query,
        exec: async () => {
          throw new Error(
            "MongoServerSelectionError: ECONNREFUSED 10.0.0.1:27017 stack-trace-line-1",
          );
        },
      };
      return query;
    });
    const result = await getAttendanceSessionStatusForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("ECONNREFUSED");
      expect(serialized).not.toContain("10.0.0.1");
      expect(serialized).not.toContain("27017");
      expect(serialized).not.toContain("MongoServerSelectionError");
      expect(serialized).not.toContain("stack-trace-line-1");
      expect(result.code).toBe(
        ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES.ATTENDANCE_READ_FAILED,
      );
    }
  });
});

// =============================================================================
// Module surface / privacy (static)
// =============================================================================

describe("getAttendanceSessionStatusForCurrentTeacher — module surface", () => {
  it("module opens with 'server-only' import", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/lib/attendance/attendance-session-status-read-service.ts",
      ),
      "utf-8",
    );
    expect(source).toMatch(/^import "server-only";/m);
  });

  it("module does NOT export any Server Action / route handler", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/lib/attendance/attendance-session-status-read-service.ts",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/"use server"/);
    expect(stripped).not.toMatch(/NextResponse/);
    expect(stripped).not.toMatch(/\/api\/attendance/);
  });

  it("function signature accepts a single classId argument", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/lib/attendance/attendance-session-status-read-service.ts",
      ),
      "utf-8",
    );
    // The exported function's signature must accept a single
    // `classId: string` parameter — never `userId`, `role`, or
    // `teacherUserId`.
    expect(source).toMatch(
      /export async function getAttendanceSessionStatusForCurrentTeacher\(\s*classId:\s*string,?\s*\)/,
    );
  });
});
