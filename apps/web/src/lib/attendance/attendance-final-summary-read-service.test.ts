/**
 * Server-only authenticated Teacher Final Attendance Summary read
 * model tests.
 *
 * PHASE 6.6 — ATTENDANCE SESSION FINALIZATION (read model).
 *
 * These tests exercise `getAttendanceFinalSummaryForCurrentTeacher`
 * in isolation from MongoDB / Better Auth / Face Service. They
 * verify the safe DTO shape, authorization boundaries, ordering,
 * privacy (no internal IDs), and counter accuracy.
 *
 * Covers:
 *   16. final summary Teacher-only
 *   17. non-owner rejected
 *   18. Student rejected
 *   19. closed session required
 *   20. presentCount correct
 *   21. absentCount correct
 *   22. rosterCount correct
 *   23. historical snapshot name used
 *   24. historical identificationCode used
 *   25. no internal IDs returned
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
const mockClassFindOne = vi.fn();
const mockSessionFindOne = vi.fn();
const mockListAllAttendanceMarksForSession = vi.fn();

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
      findOne: (...args: unknown[]) => mockSessionFindOne(...args),
    },
  };
});

vi.mock("@/lib/attendance/attendance-mark-service", async () => {
  const actual =
    await vi.importActual<
      typeof import("@/lib/attendance/attendance-mark-service")
    >("@/lib/attendance/attendance-mark-service");
  return {
    ...actual,
    listAllAttendanceMarksForSession: (...args: unknown[]) =>
      mockListAllAttendanceMarksForSession(...args),
  };
});

// =============================================================================
// Fixtures
// =============================================================================

const TEACHER_USER_ID = "teacher-better-auth-id-001";
const OTHER_TEACHER_USER_ID = "teacher-better-auth-id-002";
const STUDENT_USER_ID = "student-better-auth-id-002";
const OWNED_CLASS_ID = "65f000000000000000000abc";
const NON_HEX_ID = "not-a-canonical-hex";
const SESSION_ID = "65f000000000000000000fff";

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

function makeStudentProfile() {
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
  };
}

function makeOwnedClassDoc(overrides: Partial<{
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

function makeClosedSessionDoc(
  rosterSnapshot: Array<{
    studentUserId: string;
    fullNameSnapshot: string;
    identificationCodeSnapshot: string;
  }> = [],
) {
  return {
    _id: { toString: () => SESSION_ID },
    classId: { toString: () => OWNED_CLASS_ID } as unknown,
    status: "closed" as const,
    startedAt: new Date("2026-09-16T10:00:00Z"),
    endedAt: new Date("2026-09-16T10:42:00Z"),
    startedByUserId: TEACHER_USER_ID,
    rosterSnapshot,
    createdAt: new Date("2026-09-16T10:00:00Z"),
    updatedAt: new Date("2026-09-16T10:42:00Z"),
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

function setupSessionFindOneChain(opts: {
  closedDoc?: ReturnType<typeof makeClosedSessionDoc>;
  status?: "closed" | "active";
  notFound?: boolean;
}) {
  mockSessionFindOne.mockImplementationOnce((filter: {
    _id?: string;
    classId?: string;
  }) => {
    const query = {
      select: () => query,
      lean: () => query,
      exec: async () => {
        // First call: scoped to classId+sessionId. Returns the
        // closed doc only when classId matches and doc is closed.
        if (!opts.closedDoc) {
          // The "findClosedSessionById" returned null — fall
          // through to the second findOne (any session) below.
          // We use one mock per findOne, so the test must
          // register a SECOND mock for the fallback.
          return null;
        }
        const filterClassId =
          typeof filter.classId === "string"
            ? filter.classId
            : String(filter.classId ?? "");
        if (filterClassId !== OWNED_CLASS_ID) return null;
        return opts.closedDoc;
      },
    };
    return query;
  });
}

function setupSessionFindOneActive() {
  // Session exists but is still active.
  mockSessionFindOne.mockImplementationOnce(() => {
    const query = {
      select: () => query,
      lean: () => query,
      exec: async () => null, // closed-session lookup returns null
    };
    return query;
  });
  // Fallback "any session" lookup returns the active doc.
  mockSessionFindOne.mockImplementationOnce(() => {
    const query = {
      select: () => query,
      lean: () => query,
      exec: async () => ({
        _id: { toString: () => SESSION_ID },
        status: "active",
      }),
    };
    return query;
  });
}

function setupSessionFindOneMissing() {
  mockSessionFindOne.mockImplementationOnce(() => {
    const query = {
      select: () => query,
      lean: () => query,
      exec: async () => null,
    };
    return query;
  });
  // Fallback: no session at all.
  mockSessionFindOne.mockImplementationOnce(() => {
    const query = {
      select: () => query,
      lean: () => query,
      exec: async () => null,
    };
    return query;
  });
}

function setupListAllMarks(
  docs: Array<{
    studentUserId: string;
    status: "present" | "absent";
    recognizedAt: string;
  }>,
) {
  mockListAllAttendanceMarksForSession.mockResolvedValueOnce(docs);
}

// =============================================================================
// Setup / teardown
// =============================================================================

const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = vi
  .spyOn(console, "error")
  .mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeEach(() => {
  vi.resetAllMocks();
  consoleLogSpy.mockClear();
  consoleErrorSpy.mockClear();
  consoleWarnSpy.mockClear();

  mockGetSession.mockResolvedValue(makeSession(TEACHER_USER_ID));
  mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// Imports under test
// =============================================================================

import {
  getAttendanceFinalSummaryForCurrentTeacher,
  ATTENDANCE_FINAL_SUMMARY_ERROR_CODES,
} from "./attendance-final-summary-read-service";

// =============================================================================
// Auth + role
// =============================================================================

describe("getAttendanceFinalSummaryForCurrentTeacher — auth + role", () => {
  it("16. unauthenticated → UNAUTHENTICATED", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.UNAUTHENTICATED,
      );
    }
    expect(mockClassFindOne).not.toHaveBeenCalled();
    expect(mockSessionFindOne).not.toHaveBeenCalled();
    expect(mockListAllAttendanceMarksForSession).not.toHaveBeenCalled();
  });

  it("incomplete profile → PROFILE_INCOMPLETE", async () => {
    mockGetProfileByUserId.mockResolvedValueOnce(
      makeTeacherProfile({ onboardingCompleted: false }),
    );
    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.PROFILE_INCOMPLETE,
      );
    }
    expect(mockClassFindOne).not.toHaveBeenCalled();
  });

  it("18. Student → TEACHER_REQUIRED", async () => {
    mockGetProfileByUserId.mockResolvedValueOnce(makeStudentProfile());
    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.TEACHER_REQUIRED,
      );
    }
    expect(mockClassFindOne).not.toHaveBeenCalled();
    expect(mockSessionFindOne).not.toHaveBeenCalled();
    expect(mockListAllAttendanceMarksForSession).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Authorization
// =============================================================================

describe("getAttendanceFinalSummaryForCurrentTeacher — authorization", () => {
  it("17. non-owner → CLASS_NOT_ACCESSIBLE", async () => {
    // Class lookup returns null because teacherUserId doesn't
    // match.
    setupClassFindOneChain(null);
    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    expect(mockSessionFindOne).not.toHaveBeenCalled();
    expect(mockListAllAttendanceMarksForSession).not.toHaveBeenCalled();
  });

  it("malformed classId → CLASS_NOT_ACCESSIBLE", async () => {
    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      NON_HEX_ID,
      SESSION_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    expect(mockClassFindOne).not.toHaveBeenCalled();
  });

  it("malformed sessionId → ATTENDANCE_SESSION_NOT_FOUND", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      NON_HEX_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SESSION_NOT_FOUND,
      );
    }
  });
});

// =============================================================================
// Session state
// =============================================================================

describe("getAttendanceFinalSummaryForCurrentTeacher — session state", () => {
  it("19. closed session required (active session → ATTENDANCE_SESSION_NOT_CLOSED)", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    setupSessionFindOneActive();
    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SESSION_NOT_CLOSED,
      );
    }
    expect(mockListAllAttendanceMarksForSession).not.toHaveBeenCalled();
  });

  it("session not found → ATTENDANCE_SESSION_NOT_FOUND", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    setupSessionFindOneMissing();
    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SESSION_NOT_FOUND,
      );
    }
  });
});

// =============================================================================
// Data shape — counts, ordering, snapshot identity, privacy
// =============================================================================

describe("getAttendanceFinalSummaryForCurrentTeacher — happy path DTO", () => {
  it("20/21/22/23/24/25. presentCount + absentCount + rosterCount, snapshot identity, no internal IDs", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const closedSession = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "A-001",
      },
      {
        studentUserId: "u-snap-2",
        fullNameSnapshot: "Bravo",
        identificationCodeSnapshot: "B-001",
      },
      {
        studentUserId: "u-snap-3",
        fullNameSnapshot: "Charlie",
        identificationCodeSnapshot: "C-001",
      },
    ]);
    setupSessionFindOneChain({ closedDoc: closedSession });
    setupListAllMarks([
      {
        studentUserId: "u-snap-1",
        status: "present",
        recognizedAt: "2026-09-16T10:05:00.000Z",
      },
      {
        studentUserId: "u-snap-2",
        status: "absent",
        recognizedAt: "2026-09-16T10:42:00.000Z",
      },
      {
        studentUserId: "u-snap-3",
        status: "present",
        recognizedAt: "2026-09-16T10:10:00.000Z",
      },
    ]);

    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // 20. presentCount correct
    expect(result.result.presentCount).toBe(2);
    // 21. absentCount correct
    expect(result.result.absentCount).toBe(1);
    // 22. rosterCount correct
    expect(result.result.session.rosterCount).toBe(3);

    // Session metadata
    expect(result.result.session.id).toBe(SESSION_ID);
    expect(result.result.session.startedAt).toBe(
      "2026-09-16T10:00:00.000Z",
    );
    expect(result.result.session.endedAt).toBe(
      "2026-09-16T10:42:00.000Z",
    );

    // Students in rosterSnapshot order
    expect(result.result.students).toEqual([
      {
        fullName: "Alpha",
        identificationCode: "A-001",
        status: "present",
        recognizedAt: "2026-09-16T10:05:00.000Z",
      },
      {
        fullName: "Bravo",
        identificationCode: "B-001",
        status: "absent",
        recognizedAt: "2026-09-16T10:42:00.000Z",
      },
      {
        fullName: "Charlie",
        identificationCode: "C-001",
        status: "present",
        recognizedAt: "2026-09-16T10:10:00.000Z",
      },
    ]);

    // 23. historical snapshot name used — current Profile.name
    // is NOT in the result.
    const serialized = JSON.stringify(result.result);
    expect(serialized).not.toContain("Test Teacher");
    expect(serialized).not.toContain("teacher@example.com");
    // 24. historical identificationCode used — never the
    // current Profile.identificationCode.
    expect(serialized).not.toContain("T-001");
    // 25. no internal IDs returned.
    expect(serialized).not.toContain("u-snap-1");
    expect(serialized).not.toContain("u-snap-2");
    expect(serialized).not.toContain("u-snap-3");
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("teacherUserId");
    expect(serialized).not.toContain("studentUserId");
    expect(serialized).not.toContain("startedByUserId");
    expect(serialized).not.toContain("classId");
    expect(serialized).not.toContain("source");
    expect(serialized).not.toContain("face_recognition");
    expect(serialized).not.toContain("session_finalization");
  });

  it("31. zero roster summary works (Present = 0, Absent = 0, Total = 0)", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const emptySession = makeClosedSessionDoc([]);
    setupSessionFindOneChain({ closedDoc: emptySession });
    setupListAllMarks([]);

    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.session.rosterCount).toBe(0);
    expect(result.result.presentCount).toBe(0);
    expect(result.result.absentCount).toBe(0);
    expect(result.result.students).toEqual([]);
  });

  it("all-present roster: presentCount = rosterCount, absentCount = 0", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "A-001",
      },
      {
        studentUserId: "u-snap-2",
        fullNameSnapshot: "Bravo",
        identificationCodeSnapshot: "B-001",
      },
    ]);
    setupSessionFindOneChain({ closedDoc: session });
    setupListAllMarks([
      {
        studentUserId: "u-snap-1",
        status: "present",
        recognizedAt: "2026-09-16T10:00:00Z",
      },
      {
        studentUserId: "u-snap-2",
        status: "present",
        recognizedAt: "2026-09-16T10:01:00Z",
      },
    ]);

    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    if (result.ok) {
      expect(result.result.presentCount).toBe(2);
      expect(result.result.absentCount).toBe(0);
    } else {
      throw new Error("expected success");
    }
  });

  it("all-absent roster: absentCount = rosterCount, presentCount = 0", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "A-001",
      },
      {
        studentUserId: "u-snap-2",
        fullNameSnapshot: "Bravo",
        identificationCodeSnapshot: "B-001",
      },
    ]);
    setupSessionFindOneChain({ closedDoc: session });
    setupListAllMarks([
      {
        studentUserId: "u-snap-1",
        status: "absent",
        recognizedAt: "2026-09-16T10:42:00Z",
      },
      {
        studentUserId: "u-snap-2",
        status: "absent",
        recognizedAt: "2026-09-16T10:42:00Z",
      },
    ]);

    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    if (result.ok) {
      expect(result.result.absentCount).toBe(2);
      expect(result.result.presentCount).toBe(0);
    } else {
      throw new Error("expected success");
    }
  });

  it("absent row has recognizedAt = finalization time (not face-recognition time)", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "A-001",
      },
    ]);
    setupSessionFindOneChain({ closedDoc: session });
    setupListAllMarks([
      {
        studentUserId: "u-snap-1",
        status: "absent",
        recognizedAt: "2026-09-16T10:42:00.000Z",
      },
    ]);

    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    if (!result.ok) throw new Error("expected success");
    const absent = result.result.students[0];
    expect(absent?.status).toBe("absent");
    expect(absent?.recognizedAt).toBe("2026-09-16T10:42:00.000Z");
    // Anti-fake: recognizedAt is the actual finalization
    // timestamp from the database — not a synthesized value.
  });

  it("ordering is by rosterSnapshot order (deterministic)", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "A-001",
      },
      {
        studentUserId: "u-snap-2",
        fullNameSnapshot: "Bravo",
        identificationCodeSnapshot: "B-001",
      },
      {
        studentUserId: "u-snap-3",
        fullNameSnapshot: "Charlie",
        identificationCodeSnapshot: "C-001",
      },
    ]);
    setupSessionFindOneChain({ closedDoc: session });
    // Provide marks in REVERSE order — ordering should be by
    // rosterSnapshot position, not by mark order.
    setupListAllMarks([
      {
        studentUserId: "u-snap-3",
        status: "present",
        recognizedAt: "2026-09-16T10:02:00Z",
      },
      {
        studentUserId: "u-snap-2",
        status: "absent",
        recognizedAt: "2026-09-16T10:42:00Z",
      },
      {
        studentUserId: "u-snap-1",
        status: "present",
        recognizedAt: "2026-09-16T10:01:00Z",
      },
    ]);

    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    if (!result.ok) throw new Error("expected success");
    expect(
      result.result.students.map((s) => s.identificationCode),
    ).toEqual(["A-001", "B-001", "C-001"]);
  });

  it("does NOT include source / face_recognition / session_finalization in output", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "A-001",
      },
    ]);
    setupSessionFindOneChain({ closedDoc: session });
    setupListAllMarks([
      {
        studentUserId: "u-snap-1",
        status: "present",
        recognizedAt: "2026-09-16T10:00:00Z",
      },
    ]);

    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    if (!result.ok) throw new Error("expected success");
    const serialized = JSON.stringify(result.result);
    expect(serialized).not.toContain("source");
    expect(serialized).not.toContain("face_recognition");
    expect(serialized).not.toContain("session_finalization");
    expect(serialized).not.toContain("FaceProfile");
    expect(serialized).not.toContain("embedding");
    expect(serialized).not.toContain("centroid");
    expect(serialized).not.toContain("biometric");
    expect(serialized).not.toContain("rawImage");
  });

  it("does NOT consult Profile.fullName / Profile.identificationCode for display", async () => {
    // Even if the teacher has updated their own profile in the
    // meantime, the summary should be from snapshot. We assert
    // this by checking the snapshot values appear and Profile
    // values don't.
    setupClassFindOneChain(makeOwnedClassDoc());
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Original Alpha",
        identificationCodeSnapshot: "ORIG-001",
      },
    ]);
    setupSessionFindOneChain({ closedDoc: session });
    setupListAllMarks([
      {
        studentUserId: "u-snap-1",
        status: "present",
        recognizedAt: "2026-09-16T10:00:00Z",
      },
    ]);

    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    if (!result.ok) throw new Error("expected success");
    // Snapshot value used:
    expect(result.result.students[0]?.fullName).toBe("Original Alpha");
    expect(result.result.students[0]?.identificationCode).toBe("ORIG-001");
  });

  it("does NOT expose startedByUserId / teacherUserId / classId", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "A-001",
      },
    ]);
    setupSessionFindOneChain({ closedDoc: session });
    setupListAllMarks([
      {
        studentUserId: "u-snap-1",
        status: "present",
        recognizedAt: "2026-09-16T10:00:00Z",
      },
    ]);

    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    if (!result.ok) throw new Error("expected success");
    const serialized = JSON.stringify(result.result);
    expect(serialized).not.toContain("startedByUserId");
    expect(serialized).not.toContain("teacherUserId");
    // classId is NOT surfaced in the DTO. The session.id IS
    // the only session-scoped id.
    expect(serialized).not.toMatch(/"classId"/);
  });
});

// =============================================================================
// Failure modes
// =============================================================================

describe("getAttendanceFinalSummaryForCurrentTeacher — failure modes", () => {
  it("unknown profile role → ATTENDANCE_SUMMARY_READ_FAILED", async () => {
    mockGetProfileByUserId.mockResolvedValueOnce({
      ...makeTeacherProfile(),
      role: "admin" as unknown as "teacher",
    });
    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SUMMARY_READ_FAILED,
      );
    }
  });

  it("profile service throws → ATTENDANCE_SUMMARY_READ_FAILED", async () => {
    mockGetProfileByUserId.mockRejectedValueOnce(new Error("db down"));
    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SUMMARY_READ_FAILED,
      );
    }
  });

  it("class lookup throws → ATTENDANCE_SUMMARY_READ_FAILED", async () => {
    mockClassFindOne.mockImplementationOnce(() => {
      throw new Error("db down");
    });
    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SUMMARY_READ_FAILED,
      );
    }
  });

  it("marks service throws → ATTENDANCE_SUMMARY_READ_FAILED", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "A-001",
      },
    ]);
    setupSessionFindOneChain({ closedDoc: session });
    mockListAllAttendanceMarksForSession.mockRejectedValueOnce(
      new Error("db down"),
    );

    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_FINAL_SUMMARY_ERROR_CODES.ATTENDANCE_SUMMARY_READ_FAILED,
      );
    }
  });
});

// =============================================================================
// Privacy — never expose internal IDs
// =============================================================================

describe("getAttendanceFinalSummaryForCurrentTeacher — privacy", () => {
  it("error result NEVER contains raw stack / Mongo internals / passwords", async () => {
    // Profile service throws an Error whose message contains a
    // leaked mongo URL. The read-service MUST fold this into the
    // safe code ATTENDANCE_SUMMARY_READ_FAILED without leaking
    // the raw message.
    mockGetProfileByUserId.mockRejectedValueOnce(
      new Error("DB: mongodb://localhost:27017 leaked"),
    );
    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("mongodb://");
    expect(serialized).not.toContain("stack");
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("CastError");
  });
});

// =============================================================================
// Defensive: zero roster
// =============================================================================

describe("getAttendanceFinalSummaryForCurrentTeacher — defensive edge", () => {
  it("empty roster + empty marks → zero counts, valid summary", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    setupSessionFindOneChain({ closedDoc: makeClosedSessionDoc([]) });
    setupListAllMarks([]);
    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.session.rosterCount).toBe(0);
      expect(result.result.presentCount).toBe(0);
      expect(result.result.absentCount).toBe(0);
      expect(result.result.students).toEqual([]);
    }
  });

  it("roster student without mark → silently omitted from students", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "A-001",
      },
      {
        studentUserId: "u-snap-2",
        fullNameSnapshot: "Bravo",
        identificationCodeSnapshot: "B-001",
      },
    ]);
    setupSessionFindOneChain({ closedDoc: session });
    // Only Alpha has a mark.
    setupListAllMarks([
      {
        studentUserId: "u-snap-1",
        status: "present",
        recognizedAt: "2026-09-16T10:00:00Z",
      },
    ]);

    const result = await getAttendanceFinalSummaryForCurrentTeacher(
      OWNED_CLASS_ID,
      SESSION_ID,
    );
    if (!result.ok) throw new Error("expected success");
    // The roster says 2, but only 1 mark exists.
    expect(result.result.session.rosterCount).toBe(2);
    // The defensive path omits the missing mark to avoid fake
    // "present" or "absent" with null identity.
    expect(result.result.students.length).toBe(1);
    expect(result.result.students[0]?.fullName).toBe("Alpha");
  });
});
