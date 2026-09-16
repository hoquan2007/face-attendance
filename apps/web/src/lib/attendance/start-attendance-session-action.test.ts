/**
 * Tests for the PHASE 6.1E authenticated Teacher start-attendance
 * Server Action.
 *
 * Covers the 27-test contract:
 *
 *   ## Auth + profile (1..4)
 *     1.  no session → UNAUTHENTICATED
 *     2.  incomplete profile → PROFILE_INCOMPLETE
 *     3.  student → TEACHER_REQUIRED
 *     4.  teacher owner of active class may start
 *
 *   ## Authorization (5..7)
 *     5.  non-owner cannot start
 *     6.  archived class cannot start
 *     7.  malformed classId → CLASS_NOT_ACCESSIBLE
 *
 *   ## Input (8..9)
 *     8.  browser only supplies classId
 *     9.  roster is server-built (no rosterSnapshot on input)
 *
 *   ## Success (10..12)
 *     10. successful start creates one active session
 *     11. result returns rosterCount
 *     12. result does NOT return rosterSnapshot / studentUserId /
 *         startedByUserId / teacherUserId / passwordHash
 *
 *   ## Idempotency + concurrency (13..15)
 *     13. second explicit start is idempotent success
 *         (alreadyActive: true)
 *     14. concurrent unique collision (11000) folds to
 *         alreadyActive: true
 *     15. concurrent collision does NOT expose E11000
 *
 *   ## Failures (16..17)
 *     16. invalid roster returns ATTENDANCE_ROSTER_INVALID
 *     17. generic persistence failure maps to
 *         ATTENDANCE_SESSION_CREATE_FAILED
 *
 *   ## Domain isolation (18..27)
 *     18. no Face Service call
 *     19. no FaceProfile lookup
 *     20. no embedding / centroid access
 *     21. no camera code
 *     22. no present / absent records
 *     23. no Attendance UI route
 *     24. no public REST attendance API
 *     25. action opens with "use server"
 *     26. action does NOT create AttendanceRecord
 *     27. rosterSnapshot payload never appears in result
 *
 * Implementation notes:
 *   - All collaborators (`@/lib/session`, `@/lib/profile-service`,
 *     `@/lib/classes/class-model`, `@/lib/attendance/...`) are
 *     mocked at module boundaries. No MongoDB / Mongoose / Face
 *     Service / Better Auth is touched.
 *   - The class + session mocks are in-memory stores with
 *     `findOne` chains modeled like Mongoose.
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
const mockCreateAttendanceSession = vi.fn();
const mockFindActiveAttendanceSessionByClassId = vi.fn();

vi.mock("@/lib/session", () => ({
  getSession: () => mockGetSession(),
}));

vi.mock("@/lib/profile-service", () => ({
  getProfileByUserId: (...args: unknown[]) =>
    mockGetProfileByUserId(...args),
}));

vi.mock("@/lib/attendance/attendance-session-service", async () => {
  class AttendanceSessionServiceError extends Error {
    code: string;
    constructor(opts: { code: string; message: string }) {
      super(opts.message);
      this.name = "AttendanceSessionServiceError";
      this.code = opts.code;
    }
  }
  return {
    AttendanceSessionServiceError,
    ATTENDANCE_SESSION_ERROR_CODES: {
      ATTENDANCE_SESSION_NOT_FOUND: "ATTENDANCE_SESSION_NOT_FOUND",
      ATTENDANCE_SESSION_ALREADY_ACTIVE:
        "ATTENDANCE_SESSION_ALREADY_ACTIVE",
      ATTENDANCE_SESSION_NOT_ACTIVE: "ATTENDANCE_SESSION_NOT_ACTIVE",
      ATTENDANCE_ROSTER_INVALID: "ATTENDANCE_ROSTER_INVALID",
      ATTENDANCE_SESSION_CREATE_FAILED:
        "ATTENDANCE_SESSION_CREATE_FAILED",
      ATTENDANCE_SESSION_STOP_FAILED: "ATTENDANCE_SESSION_STOP_FAILED",
    },
    createAttendanceSession: (...args: unknown[]) =>
      mockCreateAttendanceSession(...args),
    findActiveAttendanceSessionByClassId: (...args: unknown[]) =>
      mockFindActiveAttendanceSessionByClassId(...args),
    toSafeAttendanceSessionSummary: (doc: {
      _id?: unknown;
      status?: string;
      startedAt?: Date | string;
      endedAt?: Date | string | null;
      rosterSnapshot?: unknown[];
    }) => {
      const idSource = doc._id;
      const id =
        typeof idSource === "string"
          ? idSource
          : (idSource as { toString?: () => string } | undefined)
              ?.toString?.() ?? "";
      const status =
        doc.status === "closed" ? "closed" : "active";
      const startedAtRaw = doc.startedAt;
      const startedAt =
        startedAtRaw instanceof Date
          ? startedAtRaw.toISOString()
          : new Date(startedAtRaw as unknown as string).toISOString();
      const endedAtRaw = doc.endedAt;
      const endedAt =
        endedAtRaw instanceof Date
          ? endedAtRaw.toISOString()
          : endedAtRaw === null
            ? null
            : null;
      const rosterSnapshot = Array.isArray(doc.rosterSnapshot)
        ? doc.rosterSnapshot
        : [];
      return {
        id,
        status,
        startedAt,
        endedAt,
        rosterCount: rosterSnapshot.length,
      };
    },
  };
});

const mockClassFindOne = vi.fn();

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

// Capture console output for the "no logging" assertion.
const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = vi
  .spyOn(console, "error")
  .mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

// =============================================================================
// Imports under test
// =============================================================================

import { startAttendanceSessionAction } from "./start-attendance-session-action";
import { __testing } from "./attendance-session-action-testing";
import { ATTENDANCE_SESSION_ACTION_ERROR_CODES } from "./attendance-session-action-types";

// =============================================================================
// Fixtures
// =============================================================================

const TEACHER_USER_ID = "teacher-better-auth-id-001";
const STUDENT_USER_ID = "student-better-auth-id-002";
const OWNED_CLASS_ID = "65f000000000000000000abc";
const OTHER_CLASS_ID = "65f000000000000000000def";
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
    passwordHash: "secret",
    status: "active" as const,
    teacherUserId: TEACHER_USER_ID,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeActiveSessionDoc(overrides: Partial<{
  classId: string;
  status: "active" | "closed";
  rosterCount: number;
}> = {}) {
  const classId = overrides.classId ?? OWNED_CLASS_ID;
  return {
    _id: { toString: () => "65f000000000000000000fff" },
    classId: { toString: () => classId } as unknown,
    status: "active" as const,
    startedAt: new Date("2026-09-16T10:00:00Z"),
    endedAt: null,
    startedByUserId: TEACHER_USER_ID,
    rosterSnapshot: Array.from(
      { length: overrides.rosterCount ?? 0 },
      (_, i) => ({
        studentUserId: `s-${i + 1}`,
        fullNameSnapshot: `Student ${i + 1}`,
        identificationCodeSnapshot: `S-${i + 1}`,
      }),
    ),
    createdAt: new Date("2026-09-16T10:00:00Z"),
    updatedAt: new Date("2026-09-16T10:00:00Z"),
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

// =============================================================================
// Setup / teardown
// =============================================================================

beforeEach(() => {
  // `resetAllMocks` clears BOTH call history AND pending mock
  // implementations. `clearAllMocks` would only clear history,
  // which leaks `mockResolvedValueOnce` queues across tests.
  vi.resetAllMocks();
  consoleLogSpy.mockClear();
  consoleErrorSpy.mockClear();
  consoleWarnSpy.mockClear();

  // Default happy-path mocks. Tests MUST NOT rely on a default
  // service mock; every test that exercises the create path sets
  // its own `mockCreateAttendanceSession.mockResolvedValueOnce(...)`
  // so the queue cannot leak.
  mockGetSession.mockResolvedValue(makeSession(TEACHER_USER_ID));
  mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
  mockFindActiveAttendanceSessionByClassId.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// 1..4 — Auth + profile
// =============================================================================

describe("startAttendanceSessionAction — auth + profile", () => {
  it("1. no session → UNAUTHENTICATED", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.UNAUTHENTICATED,
      );
      expect(result.retryable).toBe(false);
    }
    expect(mockCreateAttendanceSession).not.toHaveBeenCalled();
  });

  it("2. incomplete profile → PROFILE_INCOMPLETE", async () => {
    mockGetProfileByUserId.mockResolvedValueOnce(
      makeTeacherProfile({ onboardingCompleted: false }),
    );
    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.PROFILE_INCOMPLETE,
      );
    }
    expect(mockCreateAttendanceSession).not.toHaveBeenCalled();
  });

  it("3. student → TEACHER_REQUIRED", async () => {
    mockGetSession.mockResolvedValueOnce(makeSession(STUDENT_USER_ID));
    mockGetProfileByUserId.mockResolvedValueOnce(makeStudentProfile());
    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.TEACHER_REQUIRED,
      );
      expect(result.retryable).toBe(false);
    }
    expect(mockCreateAttendanceSession).not.toHaveBeenCalled();
  });

  it("4. teacher owner of active class may start", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCreateAttendanceSession.mockResolvedValueOnce(
      makeActiveSessionDoc({ rosterCount: 3 }),
    );
    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyActive).toBe(false);
      expect(result.session.status).toBe("active");
      expect(result.session.rosterCount).toBe(3);
    }
  });
});

// =============================================================================
// 5..7 — Authorization
// =============================================================================

describe("startAttendanceSessionAction — authorization", () => {
  it("5. non-owner cannot start (CLASS_NOT_ACCESSIBLE)", async () => {
    // The teacher-ownership filter returns null when the class
    // belongs to another teacher.
    setupClassFindOneChain(null);
    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    expect(mockCreateAttendanceSession).not.toHaveBeenCalled();
  });

  it("6. archived class cannot start (CLASS_NOT_ACCESSIBLE)", async () => {
    // The class-model filter encodes `status: active` directly
    // for the start path; an archived class returns null and
    // collapses to the safe inaccessible boundary.
    setupClassFindOneChain(null);
    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    expect(mockCreateAttendanceSession).not.toHaveBeenCalled();
  });

  it("7. malformed classId → CLASS_NOT_ACCESSIBLE", async () => {
    const result = await startAttendanceSessionAction({
      classId: NON_HEX_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    expect(mockCreateAttendanceSession).not.toHaveBeenCalled();
    expect(mockClassFindOne).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 8..9 — Input
// =============================================================================

describe("startAttendanceSessionAction — input", () => {
  it("8. browser only supplies classId (smuggled fields are rejected)", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCreateAttendanceSession.mockResolvedValueOnce(
      makeActiveSessionDoc(),
    );
    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
      // @ts-expect: browser trying to impersonate
      teacherUserId: "attacker",
      // @ts-expect: browser trying to inject roster
      rosterSnapshot: [{ studentUserId: "x" }],
      // @ts-expect: browser trying to set startedAt
      startedAt: "1970-01-01T00:00:00Z",
      // @ts-expect: browser trying to set status
      status: "closed",
      // @ts-expect: browser trying to inject studentUserId
      studentUserId: "attacker",
      // @ts-expect: browser trying to inject role
      role: "student",
    });
    expect(result.ok).toBe(false);
    expect(mockCreateAttendanceSession).not.toHaveBeenCalled();
  });

  it("9. roster is server-built (no rosterSnapshot on input)", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCreateAttendanceSession.mockResolvedValueOnce(
      makeActiveSessionDoc({ rosterCount: 2 }),
    );
    await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(mockCreateAttendanceSession).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateAttendanceSession.mock.calls[0]?.[0];
    expect(callArgs).toBeDefined();
    expect(callArgs).not.toHaveProperty("rosterSnapshot");
    expect(callArgs).not.toHaveProperty("studentUserIds");
  });
});

// =============================================================================
// 10..12 — Success
// =============================================================================

describe("startAttendanceSessionAction — success", () => {
  it("10. successful start creates one active session", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCreateAttendanceSession.mockResolvedValueOnce(
      makeActiveSessionDoc({ rosterCount: 3 }),
    );
    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(mockCreateAttendanceSession).toHaveBeenCalledTimes(1);
      expect(result.session.id).toBeDefined();
      expect(result.session.status).toBe("active");
    }
  });

  it("11. result returns rosterCount", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCreateAttendanceSession.mockResolvedValueOnce(
      makeActiveSessionDoc({ rosterCount: 7 }),
    );
    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.rosterCount).toBe(7);
    }
  });

  it("12. result does NOT return rosterSnapshot / studentUserId / startedByUserId / teacherUserId / passwordHash", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCreateAttendanceSession.mockResolvedValueOnce(
      makeActiveSessionDoc({ rosterCount: 2 }),
    );
    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const session = result.session as unknown as Record<
        string,
        unknown
      >;
      expect(session).not.toHaveProperty("rosterSnapshot");
      expect(session).not.toHaveProperty("studentUserId");
      expect(session).not.toHaveProperty("startedByUserId");
      expect(session).not.toHaveProperty("teacherUserId");
      expect(session).not.toHaveProperty("passwordHash");
      expect(session).not.toHaveProperty("password");
      expect(session).not.toHaveProperty("emailSnapshot");

      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("rosterSnapshot");
      expect(serialized).not.toContain("studentUserId");
      expect(serialized).not.toContain("startedByUserId");
      expect(serialized).not.toContain("teacherUserId");
      expect(serialized).not.toContain("passwordHash");
      expect(serialized).not.toContain("pbkdf2");
      expect(serialized).not.toContain("embedding");
      expect(serialized).not.toContain("centroid");
      expect(serialized).not.toContain("biometric");
      expect(serialized).not.toContain("Alice");
      expect(serialized).not.toContain("Bob");
      expect(serialized).not.toContain("STU-1");
    }
  });
});

// =============================================================================
// 13..15 — Idempotency + concurrency
// =============================================================================

describe("startAttendanceSessionAction — idempotency", () => {
  it("13. pre-existing active session → alreadyActive: true (idempotent success)", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockFindActiveAttendanceSessionByClassId.mockResolvedValueOnce(
      makeActiveSessionDoc({ rosterCount: 4 }),
    );
    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyActive).toBe(true);
      expect(result.session.status).toBe("active");
      expect(result.session.rosterCount).toBe(4);
    }
    // No second insert was attempted.
    expect(mockCreateAttendanceSession).not.toHaveBeenCalled();
  });

  it("14. concurrent unique collision (11000) folds to alreadyActive: true on the next read", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());

    const { AttendanceSessionServiceError } = await import(
      "@/lib/attendance/attendance-session-service"
    );

    mockCreateAttendanceSession.mockImplementationOnce(async () => {
      throw new AttendanceSessionServiceError({
        code: "ATTENDANCE_SESSION_ALREADY_ACTIVE",
        message: "concurrent start lost the unique race",
      });
    });

    // The race-resolution re-read returns the now-existing session.
    mockFindActiveAttendanceSessionByClassId
      .mockResolvedValueOnce(null) // pre-check
      .mockResolvedValueOnce(makeActiveSessionDoc({ rosterCount: 5 })); // post-collision re-read

    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyActive).toBe(true);
      expect(result.session.id).toBeDefined();
      expect(result.session.rosterCount).toBe(5);
    }
  });

  it("15. concurrent collision does NOT expose E11000 / Mongo internals", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());

    const { AttendanceSessionServiceError } = await import(
      "@/lib/attendance/attendance-session-service"
    );

    mockCreateAttendanceSession.mockImplementationOnce(async () => {
      throw new AttendanceSessionServiceError({
        code: "ATTENDANCE_SESSION_ALREADY_ACTIVE",
        message: "raw E11000 from mongodb://internal:27017/face_attendance",
      });
    });
    mockFindActiveAttendanceSessionByClassId
      .mockResolvedValueOnce(null) // pre-check
      .mockResolvedValueOnce(null); // post-collision re-read — no session

    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("E11000");
      expect(serialized).not.toContain("mongodb://");
      expect(serialized).not.toContain("face_attendance");
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.ATTENDANCE_SESSION_CREATE_FAILED,
      );
    }
  });
});

// =============================================================================
// 16..17 — Failures
// =============================================================================

describe("startAttendanceSessionAction — failure paths", () => {
  it("16. invalid roster returns ATTENDANCE_ROSTER_INVALID", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const { AttendanceSessionServiceError } = await import(
      "@/lib/attendance/attendance-session-service"
    );
    mockCreateAttendanceSession.mockImplementationOnce(async () => {
      throw new AttendanceSessionServiceError({
        code: "ATTENDANCE_ROSTER_INVALID",
        message: "Cannot start attendance: an active membership points at a missing Profile.",
      });
    });
    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.ATTENDANCE_ROSTER_INVALID,
      );
      expect(result.retryable).toBe(false);
    }
  });

  it("17. generic persistence failure maps to ATTENDANCE_SESSION_CREATE_FAILED", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCreateAttendanceSession.mockImplementationOnce(async () => {
      throw new Error("ECONNREFUSED 10.0.0.1:27017");
    });
    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.ATTENDANCE_SESSION_CREATE_FAILED,
      );
      expect(result.retryable).toBe(true);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("ECONNREFUSED");
      expect(serialized).not.toContain("10.0.0.1");
    }
  });
});

// =============================================================================
// 18..27 — Domain isolation
// =============================================================================

describe("startAttendanceSessionAction — domain isolation", () => {
  it("18. action module does NOT import the Face Service client", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/lib/attendance/start-attendance-session-action.ts",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/face-service-client/);
    expect(stripped).not.toMatch(/FaceServiceClient/);
    expect(stripped).not.toMatch(/biometrics\/face-service/);
    expect(source).toMatch(/Face Service/); // docstring mention
  });

  it("19. action module does NOT import FaceProfile persistence", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/lib/attendance/start-attendance-session-action.ts",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/FaceProfile/);
    expect(stripped).not.toMatch(/face_profiles/);
    expect(source).toMatch(/FaceProfile/); // docstring mention
  });

  it("20. action module does NOT access embeddings / centroids", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/lib/attendance/start-attendance-session-action.ts",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/embedding/);
    expect(stripped).not.toMatch(/centroid/);
    expect(source).toMatch(/embedding/); // docstring mention
    expect(source).toMatch(/centroid/);
  });

  it("21. action module does NOT import any camera / MediaStream code", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/lib/attendance/start-attendance-session-action.ts",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/getUserMedia/);
    expect(stripped).not.toMatch(/MediaStream/);
    expect(stripped).not.toMatch(/capture/i);
  });

  it("22. action does NOT mark any student as present / absent / late", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/lib/attendance/start-attendance-session-action.ts",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/present/);
    expect(stripped).not.toMatch(/absent/);
    expect(stripped).not.toMatch(/late/);
    expect(stripped).not.toMatch(/recognizedAt/);
    expect(stripped).not.toMatch(/confidence/);
  });

  it("23. no Attendance UI route is introduced by this action module", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/lib/attendance/start-attendance-session-action.ts",
      ),
      "utf-8",
    );
    expect(source).not.toMatch(/redirect\(["']\/attendance/);
    expect(source).not.toMatch(/revalidatePath\(["']\/attendance/);
    // The module never navigates; it returns a discriminated
    // union only.
  });

  it("24. no public REST attendance API is introduced by this action module", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/lib/attendance/start-attendance-session-action.ts",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/\/api\/attendance/);
    expect(stripped).not.toMatch(/route handler/i);
    expect(stripped).not.toMatch(/NextResponse/);
  });

  it("25. action opens with 'use server' directive", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/lib/attendance/start-attendance-session-action.ts",
      ),
      "utf-8",
    );
    expect(source.includes('"use server"')).toBe(true);
  });

  it("26. action does NOT create AttendanceRecord", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/lib/attendance/start-attendance-session-action.ts",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/attendance_records/);
    expect(stripped).not.toMatch(/AttendanceRecord/);
  });

  it("27. rosterSnapshot payload never appears in serialized result", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCreateAttendanceSession.mockResolvedValueOnce(
      makeActiveSessionDoc({ rosterCount: 4 }),
    );
    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("fullNameSnapshot");
      expect(serialized).not.toContain("identificationCodeSnapshot");
      // rosterCount is the only roster-derived field.
      expect(result.session.rosterCount).toBe(4);
    }
  });
});

// =============================================================================
// Static guards
// =============================================================================

describe("startAttendanceSessionAction — module surface", () => {
  it("schema strips smuggled teacherUserId", () => {
    const schema = __testing.StartAttendanceInputSchema;
    const result = schema.safeParse({
      classId: OWNED_CLASS_ID,
      teacherUserId: "browser",
    });
    expect(result.success).toBe(false);
  });

  it("schema strips smuggled rosterSnapshot", () => {
    const schema = __testing.StartAttendanceInputSchema;
    const result = schema.safeParse({
      classId: OWNED_CLASS_ID,
      rosterSnapshot: [],
    });
    expect(result.success).toBe(false);
  });

  it("schema strips smuggled status", () => {
    const schema = __testing.StartAttendanceInputSchema;
    const result = schema.safeParse({
      classId: OWNED_CLASS_ID,
      status: "closed",
    });
    expect(result.success).toBe(false);
  });

  it("schema strips smuggled startedAt", () => {
    const schema = __testing.StartAttendanceInputSchema;
    const result = schema.safeParse({
      classId: OWNED_CLASS_ID,
      startedAt: "1970-01-01T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });
});
