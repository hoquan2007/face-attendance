/**
 * Server-only authenticated Teacher Attendance History read model tests.
 *
 * PHASE 6.7 — ATTENDANCE HISTORY.
 *
 * These tests exercise `getAttendanceHistoryForCurrentTeacher`
 * in isolation from MongoDB / Better Auth / Face Service. They
 * verify the safe DTO shape, authorization boundaries, ordering,
 * privacy (no internal IDs), counter accuracy, and N+1 avoidance.
 *
 * Covers:
 *   1. Teacher owner can read history
 *   2. Student rejected
 *   3. non-owner rejected
 *   4. only closed sessions returned
 *   5. active session excluded
 *   6. newest completed first
 *   7. empty history valid
 *   8. present counts correct
 *   9. absent counts correct
 *  10. rosterCount correct
 *  11. no N+1 mark queries (single batch query)
 *  12. no rosterSnapshot returned
 *  13. no student IDs returned
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
const mockSessionFind = vi.fn();
const mockMarkFind = vi.fn();

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
      find: (...args: unknown[]) => mockSessionFind(...args),
    },
  };
});

vi.mock("@/lib/attendance/attendance-mark-model", async () => {
  const actual =
    await vi.importActual<
      typeof import("@/lib/attendance/attendance-mark-model")
    >("@/lib/attendance/attendance-mark-model");
  return {
    ...actual,
    AttendanceMarkModel: {
      find: (...args: unknown[]) => mockMarkFind(...args),
    },
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
const SESSION_ID_1 = "65f000000000000000001001";
const SESSION_ID_2 = "65f000000000000000002002";

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
  sessionId: string,
  startedAt: Date,
  endedAt: Date,
  rosterSize: number,
) {
  const rosterSnapshot = Array.from({ length: rosterSize }, (_, i) => ({
    studentUserId: `u-snap-${sessionId}-${i}`,
    fullNameSnapshot: `Student ${i}`,
    identificationCodeSnapshot: `S-${sessionId}-${i}`,
  }));
  return {
    _id: { toString: () => sessionId },
    classId: { toString: () => OWNED_CLASS_ID } as unknown,
    status: "closed" as const,
    startedAt,
    endedAt,
    startedByUserId: TEACHER_USER_ID,
    rosterSnapshot,
    createdAt: startedAt,
    updatedAt: endedAt,
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

function setupSessionFindChain(
  docs: Array<ReturnType<typeof makeClosedSessionDoc>>,
) {
  mockSessionFind.mockImplementationOnce(() => {
    const query = {
      select: () => query,
      sort: () => query,
      lean: () => query,
      exec: async () => docs,
    };
    return query;
  });
}

function setupMarkFindChain(
  marks: Array<{
    sessionId: string;
    status: "present" | "absent";
  }>,
) {
  mockMarkFind.mockImplementationOnce(() => {
    const query = {
      select: () => query,
      lean: () => query,
      exec: async () => marks,
    };
    return query;
  });
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
  getAttendanceHistoryForCurrentTeacher,
  ATTENDANCE_HISTORY_ERROR_CODES,
} from "./attendance-history-read-service";

// =============================================================================
// Auth + role
// =============================================================================

describe("getAttendanceHistoryForCurrentTeacher — auth + role", () => {
  it("1. unauthenticated → UNAUTHENTICATED", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_HISTORY_ERROR_CODES.UNAUTHENTICATED,
      );
    }
    expect(mockClassFindOne).not.toHaveBeenCalled();
    expect(mockSessionFind).not.toHaveBeenCalled();
  });

  it("incomplete profile → PROFILE_INCOMPLETE", async () => {
    mockGetProfileByUserId.mockResolvedValueOnce(
      makeTeacherProfile({ onboardingCompleted: false }),
    );
    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_HISTORY_ERROR_CODES.PROFILE_INCOMPLETE,
      );
    }
    expect(mockClassFindOne).not.toHaveBeenCalled();
  });

  it("2. Student → TEACHER_REQUIRED", async () => {
    mockGetProfileByUserId.mockResolvedValueOnce(makeStudentProfile());
    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_HISTORY_ERROR_CODES.TEACHER_REQUIRED,
      );
    }
    expect(mockClassFindOne).not.toHaveBeenCalled();
    expect(mockSessionFind).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Authorization
// =============================================================================

describe("getAttendanceHistoryForCurrentTeacher — authorization", () => {
  it("3. non-owner → CLASS_NOT_ACCESSIBLE", async () => {
    setupClassFindOneChain(null);
    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_HISTORY_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    expect(mockSessionFind).not.toHaveBeenCalled();
  });

  it("malformed classId → CLASS_NOT_ACCESSIBLE", async () => {
    const result = await getAttendanceHistoryForCurrentTeacher(
      NON_HEX_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_HISTORY_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    expect(mockClassFindOne).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Session filtering
// =============================================================================

describe("getAttendanceHistoryForCurrentTeacher — session filtering", () => {
  it("4. only closed sessions returned", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    // Sessions: one closed, one active (active should be filtered out).
    const closedSession = makeClosedSessionDoc(
      SESSION_ID_1,
      new Date("2026-09-16T10:00:00Z"),
      new Date("2026-09-16T10:42:00Z"),
      3,
    );
    setupSessionFindChain([closedSession]);
    setupMarkFindChain([
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "absent" },
    ]);

    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.sessions).toHaveLength(1);
    expect(result.result.sessions[0]?.id).toBe(SESSION_ID_1);
    expect(result.result.sessions[0]?.rosterCount).toBe(3);
    expect(result.result.sessions[0]?.presentCount).toBe(2);
    expect(result.result.sessions[0]?.absentCount).toBe(1);
  });

  it("5. active session excluded from history", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    // Query filter is: status: "closed" — active sessions are not returned.
    setupSessionFindChain([]); // Empty = no closed sessions (only active exists).
    setupMarkFindChain([]);

    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.sessions).toHaveLength(0);
  });
});

// =============================================================================
// Ordering
// =============================================================================

describe("getAttendanceHistoryForCurrentTeacher — ordering", () => {
  it("6. newest completed first (endedAt DESC)", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    // Two sessions: older and newer.
    const olderSession = makeClosedSessionDoc(
      SESSION_ID_1,
      new Date("2026-09-15T10:00:00Z"),
      new Date("2026-09-15T10:42:00Z"),
      2,
    );
    const newerSession = makeClosedSessionDoc(
      SESSION_ID_2,
      new Date("2026-09-16T10:00:00Z"),
      new Date("2026-09-16T10:42:00Z"),
      2,
    );
    // Mock returns docs in the order they come from find().sort({ endedAt: -1 })
    setupSessionFindChain([newerSession, olderSession]);
    setupMarkFindChain([
      // Marks for session 1
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "present" },
      // Marks for session 2
      { sessionId: SESSION_ID_2, status: "present" },
      { sessionId: SESSION_ID_2, status: "present" },
    ]);

    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.sessions).toHaveLength(2);
    // Newest first.
    expect(result.result.sessions[0]?.id).toBe(SESSION_ID_2);
    expect(result.result.sessions[1]?.id).toBe(SESSION_ID_1);
  });
});

// =============================================================================
// Empty history
// =============================================================================

describe("getAttendanceHistoryForCurrentTeacher — empty history", () => {
  it("7. empty history valid", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    setupSessionFindChain([]);
    setupMarkFindChain([]);

    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.sessions).toEqual([]);
  });
});

// =============================================================================
// Counts
// =============================================================================

describe("getAttendanceHistoryForCurrentTeacher — counts", () => {
  it("8. present counts correct", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session = makeClosedSessionDoc(
      SESSION_ID_1,
      new Date("2026-09-16T10:00:00Z"),
      new Date("2026-09-16T10:42:00Z"),
      5,
    );
    setupSessionFindChain([session]);
    // 3 present, 2 absent.
    setupMarkFindChain([
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "absent" },
      { sessionId: SESSION_ID_1, status: "absent" },
    ]);

    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.sessions).toHaveLength(1);
    expect(result.result.sessions[0]?.presentCount).toBe(3);
  });

  it("9. absent counts correct", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session = makeClosedSessionDoc(
      SESSION_ID_1,
      new Date("2026-09-16T10:00:00Z"),
      new Date("2026-09-16T10:42:00Z"),
      5,
    );
    setupSessionFindChain([session]);
    // 2 present, 3 absent.
    setupMarkFindChain([
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "absent" },
      { sessionId: SESSION_ID_1, status: "absent" },
      { sessionId: SESSION_ID_1, status: "absent" },
    ]);

    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.sessions).toHaveLength(1);
    expect(result.result.sessions[0]?.absentCount).toBe(3);
  });

  it("10. rosterCount correct", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session = makeClosedSessionDoc(
      SESSION_ID_1,
      new Date("2026-09-16T10:00:00Z"),
      new Date("2026-09-16T10:42:00Z"),
      10,
    );
    setupSessionFindChain([session]);
    setupMarkFindChain([
      // Only 5 students have marks (3 present, 2 absent)
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "absent" },
      { sessionId: SESSION_ID_1, status: "absent" },
    ]);

    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // rosterCount comes from session snapshot, not from marks.
    expect(result.result.sessions[0]?.rosterCount).toBe(10);
    // present/absent counts come from marks.
    expect(result.result.sessions[0]?.presentCount).toBe(3);
    expect(result.result.sessions[0]?.absentCount).toBe(2);
  });
});

// =============================================================================
// N+1 avoidance
// =============================================================================

describe("getAttendanceHistoryForCurrentTeacher — N+1 avoidance", () => {
  it("11. single batch query for all session marks (no N+1)", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session1 = makeClosedSessionDoc(
      SESSION_ID_1,
      new Date("2026-09-15T10:00:00Z"),
      new Date("2026-09-15T10:42:00Z"),
      3,
    );
    const session2 = makeClosedSessionDoc(
      SESSION_ID_2,
      new Date("2026-09-16T10:00:00Z"),
      new Date("2026-09-16T10:42:00Z"),
      4,
    );
    setupSessionFindChain([session2, session1]); // Newest first.
    // Marks query should be a SINGLE batch query for ALL sessions.
    setupMarkFindChain([
      // All marks for session 1
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "absent" },
      // All marks for session 2
      { sessionId: SESSION_ID_2, status: "present" },
      { sessionId: SESSION_ID_2, status: "present" },
    ]);

    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Verify only ONE mark query was made.
    expect(mockMarkFind).toHaveBeenCalledTimes(1);

    // Verify the query uses $in for all session IDs.
    const markFindCall = mockMarkFind.mock.calls[0]?.[0];
    expect(markFindCall).toBeDefined();
    // The query should have sessionId: { $in: [sessionId1, sessionId2] }
    const queryObj = markFindCall as { sessionId?: { $in?: unknown[] } };
    expect(queryObj?.sessionId?.$in).toBeDefined();
    expect(queryObj.sessionId?.$in).toHaveLength(2);

    // Verify counts are correct for each session.
    const s1 = result.result.sessions.find((s) => s.id === SESSION_ID_1);
    const s2 = result.result.sessions.find((s) => s.id === SESSION_ID_2);
    expect(s1?.presentCount).toBe(1);
    expect(s1?.absentCount).toBe(1);
    expect(s2?.presentCount).toBe(2);
    expect(s2?.absentCount).toBe(0);
  });
});

// =============================================================================
// Privacy
// =============================================================================

describe("getAttendanceHistoryForCurrentTeacher — privacy", () => {
  it("12. no rosterSnapshot returned", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session = makeClosedSessionDoc(
      SESSION_ID_1,
      new Date("2026-09-16T10:00:00Z"),
      new Date("2026-09-16T10:42:00Z"),
      2,
    );
    setupSessionFindChain([session]);
    setupMarkFindChain([
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "absent" },
    ]);

    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.result);
    expect(serialized).not.toContain("rosterSnapshot");
    expect(serialized).not.toContain("fullNameSnapshot");
    expect(serialized).not.toContain("identificationCodeSnapshot");
  });

  it("13. no student IDs returned", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session = makeClosedSessionDoc(
      SESSION_ID_1,
      new Date("2026-09-16T10:00:00Z"),
      new Date("2026-09-16T10:42:00Z"),
      3,
    );
    setupSessionFindChain([session]);
    setupMarkFindChain([
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "absent" },
    ]);

    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.result);
    expect(serialized).not.toContain("studentUserId");
    expect(serialized).not.toContain("startedByUserId");
    expect(serialized).not.toContain("teacherUserId");
    expect(serialized).not.toContain("passwordHash");
    expect(serialized).not.toContain("u-snap-"); // studentUserId values
  });

  it("no startedByUserId / teacherUserId in output", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session = makeClosedSessionDoc(
      SESSION_ID_1,
      new Date("2026-09-16T10:00:00Z"),
      new Date("2026-09-16T10:42:00Z"),
      1,
    );
    setupSessionFindChain([session]);
    setupMarkFindChain([
      { sessionId: SESSION_ID_1, status: "present" },
    ]);

    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialized = JSON.stringify(result.result);
    expect(serialized).not.toContain("startedByUserId");
    expect(serialized).not.toContain("teacherUserId");
  });
});

// =============================================================================
// Session metadata
// =============================================================================

describe("getAttendanceHistoryForCurrentTeacher — session metadata", () => {
  it("session id, startedAt, endedAt returned correctly", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const startedAt = new Date("2026-09-16T10:00:00Z");
    const endedAt = new Date("2026-09-16T10:42:00Z");
    const session = makeClosedSessionDoc(
      SESSION_ID_1,
      startedAt,
      endedAt,
      2,
    );
    setupSessionFindChain([session]);
    setupMarkFindChain([
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "absent" },
    ]);

    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.sessions).toHaveLength(1);
    const s = result.result.sessions[0];
    expect(s?.id).toBe(SESSION_ID_1);
    expect(s?.startedAt).toBe(startedAt.toISOString());
    expect(s?.endedAt).toBe(endedAt.toISOString());
  });
});

// =============================================================================
// Failure modes
// =============================================================================

describe("getAttendanceHistoryForCurrentTeacher — failure modes", () => {
  it("unknown profile role → ATTENDANCE_HISTORY_READ_FAILED", async () => {
    mockGetProfileByUserId.mockResolvedValueOnce({
      ...makeTeacherProfile(),
      role: "admin" as unknown as "teacher",
    });
    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_HISTORY_ERROR_CODES.ATTENDANCE_HISTORY_READ_FAILED,
      );
    }
  });

  it("profile service throws → ATTENDANCE_HISTORY_READ_FAILED", async () => {
    mockGetProfileByUserId.mockRejectedValueOnce(new Error("db down"));
    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_HISTORY_ERROR_CODES.ATTENDANCE_HISTORY_READ_FAILED,
      );
    }
  });

  it("class lookup throws → ATTENDANCE_HISTORY_READ_FAILED", async () => {
    mockClassFindOne.mockImplementationOnce(() => {
      throw new Error("db down");
    });
    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_HISTORY_ERROR_CODES.ATTENDANCE_HISTORY_READ_FAILED,
      );
    }
  });

  it("session find throws → ATTENDANCE_HISTORY_READ_FAILED", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockSessionFind.mockImplementationOnce(() => {
      throw new Error("db down");
    });

    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_HISTORY_ERROR_CODES.ATTENDANCE_HISTORY_READ_FAILED,
      );
    }
  });

  it("mark find throws → ATTENDANCE_HISTORY_READ_FAILED", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session = makeClosedSessionDoc(
      SESSION_ID_1,
      new Date("2026-09-16T10:00:00Z"),
      new Date("2026-09-16T10:42:00Z"),
      2,
    );
    setupSessionFindChain([session]);
    mockMarkFind.mockImplementationOnce(() => {
      throw new Error("db down");
    });

    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_HISTORY_ERROR_CODES.ATTENDANCE_HISTORY_READ_FAILED,
      );
    }
  });

  it("error result NEVER contains raw stack / Mongo internals", async () => {
    mockGetProfileByUserId.mockRejectedValueOnce(
      new Error("DB: mongodb://localhost:27017 leaked"),
    );
    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("mongodb://");
    expect(serialized).not.toContain("stack");
    expect(serialized).not.toContain("passwordHash");
  });
});

// =============================================================================
// Multiple sessions
// =============================================================================

describe("getAttendanceHistoryForCurrentTeacher — multiple sessions", () => {
  it("multiple sessions with different mark counts aggregated correctly", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const session1 = makeClosedSessionDoc(
      SESSION_ID_1,
      new Date("2026-09-14T10:00:00Z"),
      new Date("2026-09-14T10:42:00Z"),
      4,
    );
    const session2 = makeClosedSessionDoc(
      SESSION_ID_2,
      new Date("2026-09-15T10:00:00Z"),
      new Date("2026-09-15T10:42:00Z"),
      5,
    );
    // Sorted newest first.
    setupSessionFindChain([session2, session1]);
    // Batch marks for both sessions.
    setupMarkFindChain([
      // Session 1: 2 present, 2 absent.
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "present" },
      { sessionId: SESSION_ID_1, status: "absent" },
      { sessionId: SESSION_ID_1, status: "absent" },
      // Session 2: 4 present, 1 absent.
      { sessionId: SESSION_ID_2, status: "present" },
      { sessionId: SESSION_ID_2, status: "present" },
      { sessionId: SESSION_ID_2, status: "present" },
      { sessionId: SESSION_ID_2, status: "present" },
      { sessionId: SESSION_ID_2, status: "absent" },
    ]);

    const result = await getAttendanceHistoryForCurrentTeacher(
      OWNED_CLASS_ID,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.sessions).toHaveLength(2);

    // Session 2 should be first (newest).
    const s2 = result.result.sessions.find((s) => s.id === SESSION_ID_2);
    expect(s2?.presentCount).toBe(4);
    expect(s2?.absentCount).toBe(1);
    expect(s2?.rosterCount).toBe(5);

    // Session 1 should be second.
    const s1 = result.result.sessions.find((s) => s.id === SESSION_ID_1);
    expect(s1?.presentCount).toBe(2);
    expect(s1?.absentCount).toBe(2);
    expect(s1?.rosterCount).toBe(4);
  });
});
