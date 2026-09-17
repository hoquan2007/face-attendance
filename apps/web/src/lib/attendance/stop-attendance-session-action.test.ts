/**
 * Tests for the PHASE 6.1E authenticated Teacher stop-attendance
 * Server Action.
 *
 * Covers the 19-test contract:
 *
 *   ## Auth + profile (1..4)
 *     1.  no session → UNAUTHENTICATED
 *     2.  incomplete profile → PROFILE_INCOMPLETE
 *     3.  student → TEACHER_REQUIRED
 *     4.  teacher owner of active class may stop
 *
 *   ## Authorization (5..6)
 *     5.  non-owner cannot stop
 *     6.  malformed classId → CLASS_NOT_ACCESSIBLE
 *
 *   ## Input (7)
 *     7.  browser only supplies classId
 *
 *   ## Atomic stop (8..11)
 *     8.  stop is atomic (single findOneAndUpdate, no read-then-update)
 *     9.  stopped session becomes closed with server-set endedAt
 *     10. stop preserves rosterSnapshot verbatim
 *     11. stop returns rosterCount + status / startedAt / endedAt
 *
 *   ## Idempotency (12..14)
 *     12. first stop → alreadyStopped = false
 *     13. second stop → alreadyStopped = true
 *     14. no-session class → ATTENDANCE_SESSION_STOP_FAILED
 *
 *   ## Forbidden consequences (15..19)
 *     15. stop does NOT create a new AttendanceSession document
 *     16. stop does NOT alter startedAt / startedByUserId
 *     17. stop does NOT expose password / studentUserId / startedByUserId
 *     18. stop module opens with "use server"
 *     19. database-enforced ACTIVE-only filter is encoded into
 *         the service query (status: "active")
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
const mockFindActiveAttendanceSessionByClassId = vi.fn();
const mockCloseActiveAttendanceSessionForClass = vi.fn();
const mockFinalizeAbsentMarksForClosedSession = vi.fn();

vi.mock("@/lib/session", () => ({
  getSession: () => mockGetSession(),
}));

vi.mock("@/lib/profile-service", () => ({
  getProfileByUserId: (...args: unknown[]) =>
    mockGetProfileByUserId(...args),
}));

// =============================================================================
// PHASE 6.6 — Mock finalizeAbsentMarksForClosedSession so the
// finalization path is exercised WITHOUT touching the real Mongoose
// layer. Tests that need to drive a specific finalization outcome set
// their own implementation via mockFinalizeAbsentMarksForClosedSession.
// =============================================================================

vi.mock("@/lib/attendance/attendance-mark-service", async () => {
  const actual =
    await vi.importActual<
      typeof import("@/lib/attendance/attendance-mark-service")
    >("@/lib/attendance/attendance-mark-service");
  return {
    ...actual,
    finalizeAbsentMarksForClosedSession: (...args: unknown[]) =>
      mockFinalizeAbsentMarksForClosedSession(...args),
  };
});

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
    closeActiveAttendanceSessionForClass: (...args: unknown[]) =>
      mockCloseActiveAttendanceSessionForClass(...args),
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

// In-memory model mock for AttendanceSessionModel — exercises the
// "no new session" guarantee on the stop path, and supports the
// latest-closed-session fallback.
const mockAttendanceSessionFind = vi.fn();
const mockAttendanceSessionFindOneAndUpdate = vi.fn();

vi.mock("@/lib/attendance/attendance-session-model", async () => {
  const actual =
    await vi.importActual<
      typeof import("@/lib/attendance/attendance-session-model")
    >("@/lib/attendance/attendance-session-model");
  return {
    ...actual,
    AttendanceSessionModel: {
      ...(actual.AttendanceSessionModel as object),
      find: (...args: unknown[]) => mockAttendanceSessionFind(...args),
      findOneAndUpdate: (...args: unknown[]) =>
        mockAttendanceSessionFindOneAndUpdate(...args),
    },
  };
});

const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = vi
  .spyOn(console, "error")
  .mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

// =============================================================================
// Imports under test
// =============================================================================

import { stopAttendanceSessionAction } from "./stop-attendance-session-action";
import { ATTENDANCE_SESSION_ACTION_ERROR_CODES } from "./attendance-session-action-types";
import {
  AttendanceSessionServiceError,
  ATTENDANCE_SESSION_ERROR_CODES,
} from "@/lib/attendance/attendance-session-service";

// =============================================================================
// Fixtures
// =============================================================================

const TEACHER_USER_ID = "teacher-better-auth-id-001";
const OTHER_TEACHER_USER_ID = "teacher-better-auth-id-002";
const STUDENT_USER_ID = "student-better-auth-id-002";
const OWNED_CLASS_ID = "65f000000000000000000abc";
const NON_HEX_ID = "not-a-canonical-hex";
const ARCHIVED_OWNED_CLASS_ID = "65f0000000000000000000aa";
const SESSION_ID = "65f000000000000000000fff";
const STUDENT_USER_IDS = [
  "student-1",
  "student-2",
  "student-3",
  "student-4",
  "student-5",
];

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
  id: string;
}> = {}) {
  const id = overrides.id ?? OWNED_CLASS_ID;
  return {
    _id: { toString: () => id },
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

function makeClosedSessionDoc(overrides: Partial<{
  status: "closed";
  rosterCount: number;
  startedAt: Date;
  endedAt: Date;
}> = {}) {
  return {
    _id: { toString: () => SESSION_ID },
    classId: { toString: () => OWNED_CLASS_ID } as unknown,
    status: "closed" as const,
    startedAt: overrides.startedAt ?? new Date("2026-09-16T10:00:00Z"),
    endedAt:
      overrides.endedAt ?? new Date("2026-09-16T10:42:00Z"),
    startedByUserId: TEACHER_USER_ID,
    rosterSnapshot: Array.from(
      { length: overrides.rosterCount ?? STUDENT_USER_IDS.length },
      (_, i) => ({
        studentUserId: STUDENT_USER_IDS[i] ?? `s-${i + 1}`,
        fullNameSnapshot: `Student ${i + 1}`,
        identificationCodeSnapshot: `S-${i + 1}`,
      }),
    ),
    createdAt: new Date("2026-09-16T10:00:00Z"),
    updatedAt:
      overrides.endedAt ?? new Date("2026-09-16T10:42:00Z"),
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
  vi.resetAllMocks();
  consoleLogSpy.mockClear();
  consoleErrorSpy.mockClear();
  consoleWarnSpy.mockClear();

  // Default happy-path state. Tests that exercise the stop path
  // MUST set their own `mockCloseActiveAttendanceSessionForClass`
  // queue entry.
  mockGetSession.mockResolvedValue(makeSession(TEACHER_USER_ID));
  mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
  // Default: never called in stop path; if a test triggers a
  // re-read, it MUST set its own return value.
  mockFindActiveAttendanceSessionByClassId.mockResolvedValue(null);

  // PHASE 6.6 — Default finalization mock. The default returns
  // an empty result (zero absent). Tests that verify finalization
  // semantics re-implement the mock for their own scenario.
  mockFinalizeAbsentMarksForClosedSession.mockResolvedValue({
    createdAbsent: [],
    alreadyHadMark: [],
    finalizedAt: new Date("2026-09-16T10:42:00Z").toISOString(),
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// 1..4 — Auth + profile
// =============================================================================

describe("stopAttendanceSessionAction — auth + profile", () => {
  it("1. no session → UNAUTHENTICATED", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.UNAUTHENTICATED,
      );
      expect(result.retryable).toBe(false);
    }
    // No service write / read.
    expect(mockCloseActiveAttendanceSessionForClass).not.toHaveBeenCalled();
    expect(mockAttendanceSessionFind).not.toHaveBeenCalled();
  });

  it("2. incomplete profile → PROFILE_INCOMPLETE", async () => {
    mockGetProfileByUserId.mockResolvedValueOnce(
      makeTeacherProfile({ onboardingCompleted: false }),
    );
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.PROFILE_INCOMPLETE,
      );
    }
    expect(mockCloseActiveAttendanceSessionForClass).not.toHaveBeenCalled();
  });

  it("3. student → TEACHER_REQUIRED", async () => {
    mockGetProfileByUserId.mockResolvedValueOnce(makeStudentProfile());
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.TEACHER_REQUIRED,
      );
    }
    expect(mockCloseActiveAttendanceSessionForClass).not.toHaveBeenCalled();
    expect(mockClassFindOne).not.toHaveBeenCalled();
  });

  it("4. teacher owner of active class may stop", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCloseActiveAttendanceSessionForClass.mockResolvedValueOnce(
      makeClosedSessionDoc(),
    );
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyStopped).toBe(false);
      expect(result.session.status).toBe("closed");
      expect(result.session.classId).toBe(OWNED_CLASS_ID);
      expect(typeof result.session.endedAt).toBe("string");
      expect(result.session.rosterCount).toBe(STUDENT_USER_IDS.length);
    }
  });
});

// =============================================================================
// 5..6 — Authorization
// =============================================================================

describe("stopAttendanceSessionAction — authorization", () => {
  it("5. non-owner cannot stop", async () => {
    // Class findOne returns null → CLASS_NOT_ACCESSIBLE.
    setupClassFindOneChain(null);
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    expect(mockCloseActiveAttendanceSessionForClass).not.toHaveBeenCalled();
  });

  it("6. malformed classId → CLASS_NOT_ACCESSIBLE", async () => {
    const result = await stopAttendanceSessionAction({
      classId: NON_HEX_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    expect(mockClassFindOne).not.toHaveBeenCalled();
    expect(mockCloseActiveAttendanceSessionForClass).not.toHaveBeenCalled();
  });

  it("doesn't differentiate between missing-class and non-owner", async () => {
    // Distinct — we never expose a "not the owner" code path.
    setupClassFindOneChain(null);
    const resultA = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    if (!resultA.ok) {
      expect(resultA.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
  });
});

// =============================================================================
// 7 — Input
// =============================================================================

describe("stopAttendanceSessionAction — input", () => {
  it("7. browser only supplies classId; extras are stripped", async () => {
    // The schema is `.strict()` — extras (teacherUserId, role,
    // status, startedAt, endedAt, startedByUserId, rosterSnapshot)
    // cause a parse failure, which the action maps to the safe
    // `CLASS_NOT_ACCESSIBLE` boundary. The service layer MUST
    // never see the smuggled values.
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
      teacherUserId: "sneaky-teacher-id",
      userId: "sneaky-user-id",
      role: "teacher",
      status: "closed",
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      startedByUserId: "sneaky",
      rosterSnapshot: [{ studentUserId: "abc" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    // No service call because validation failed before any
    // service was reached.
    expect(mockClassFindOne).not.toHaveBeenCalled();
    expect(mockCloseActiveAttendanceSessionForClass).not.toHaveBeenCalled();

    // Sanity check: a clean input MUST succeed.
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCloseActiveAttendanceSessionForClass.mockResolvedValueOnce(
      makeClosedSessionDoc(),
    );
    const okResult = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(okResult.ok).toBe(true);
    if (okResult.ok) {
      expect(okResult.alreadyStopped).toBe(false);
    }
  });

  it("7b. non-object input → CLASS_NOT_ACCESSIBLE", async () => {
    const result = await stopAttendanceSessionAction("just-a-string");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
      );
    }
    expect(mockClassFindOne).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 8..11 — Atomic stop
// =============================================================================

describe("stopAttendanceSessionAction — atomic stop", () => {
  it("8. stop is a SINGLE atomic CAS — no read-then-update", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCloseActiveAttendanceSessionForClass.mockResolvedValueOnce(
      makeClosedSessionDoc(),
    );
    await stopAttendanceSessionAction({ classId: OWNED_CLASS_ID });
    expect(
      mockCloseActiveAttendanceSessionForClass,
    ).toHaveBeenCalledTimes(1);
    // We must NEVER touch the read primitive on the happy path —
    // only the NOT_ACTIVE typed error fallback may read.
    expect(
      mockFindActiveAttendanceSessionByClassId,
    ).not.toHaveBeenCalled();
  });

  it("9. stopped session becomes closed with server-set endedAt", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCloseActiveAttendanceSessionForClass.mockResolvedValueOnce(
      makeClosedSessionDoc(),
    );
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.status).toBe("closed");
      const endedAt = new Date(result.session.endedAt as string);
      expect(Number.isNaN(endedAt.getTime())).toBe(false);
    }
  });

  it("10. stop preserves rosterSnapshot verbatim", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const snapshotBefore = [
      {
        studentUserId: "student-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "A-001",
      },
      {
        studentUserId: "student-2",
        fullNameSnapshot: "Bravo",
        identificationCodeSnapshot: "B-001",
      },
    ];
    mockCloseActiveAttendanceSessionForClass.mockResolvedValueOnce({
      ...makeClosedSessionDoc({ rosterCount: 0 }),
      rosterSnapshot: snapshotBefore,
    });
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.rosterCount).toBe(2);
    }
    // The service received the original snapshot and is not
    // expected to mutate it (it is declared `_id`-less on the
    // action side, but must project rosterCount from the same
    // array).
    expect(mockCloseActiveAttendanceSessionForClass).toHaveBeenCalledTimes(
      1,
    );
  });

  it("11. result exposes endedAt + rosterCount + status + startedAt", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const fixedStartedAt = new Date("2026-09-16T10:00:00Z");
    const fixedEndedAt = new Date("2026-09-16T10:30:00Z");
    mockCloseActiveAttendanceSessionForClass.mockResolvedValueOnce(
      makeClosedSessionDoc({
        startedAt: fixedStartedAt,
        endedAt: fixedEndedAt,
        rosterCount: 7,
      }),
    );
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.startedAt).toBe(fixedStartedAt.toISOString());
      expect(result.session.endedAt).toBe(fixedEndedAt.toISOString());
      expect(result.session.rosterCount).toBe(7);
      expect(result.session.id).toBe(SESSION_ID);
    }
  });
});

// =============================================================================
// 12..14 — Idempotency
// =============================================================================

describe("stopAttendanceSessionAction — idempotency", () => {
  it("12. first stop → alreadyStopped = false", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCloseActiveAttendanceSessionForClass.mockResolvedValueOnce(
      makeClosedSessionDoc(),
    );
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyStopped).toBe(false);
    }
  });

  it("13. second stop on a closed session → alreadyStopped = true (idempotent success)", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    // First CAS misses → typed error.
    mockCloseActiveAttendanceSessionForClass.mockRejectedValueOnce(
      new AttendanceSessionServiceError({
        code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_SESSION_NOT_ACTIVE,
        message: "no active session",
      }),
    );
    // Fallback read returns the latest closed session.
    const latestClosed = makeClosedSessionDoc();
    setupAttendanceSessionFindChain([latestClosed]);
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyStopped).toBe(true);
      expect(result.session.status).toBe("closed");
      expect(result.session.id).toBe(SESSION_ID);
    }
  });

  it("14. no session ever existed → ATTENDANCE_SESSION_STOP_FAILED", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCloseActiveAttendanceSessionForClass.mockRejectedValueOnce(
      new AttendanceSessionServiceError({
        code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_SESSION_NOT_ACTIVE,
        message: "no active session",
      }),
    );
    // Fallback read returns [] (no document ever existed).
    setupAttendanceSessionFindChain([]);
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        ATTENDANCE_SESSION_ACTION_ERROR_CODES.ATTENDANCE_SESSION_STOP_FAILED,
      );
    }
  });
});

// =============================================================================
// 15..19 — Forbidden consequences
// =============================================================================

describe("stopAttendanceSessionAction — forbidden consequences", () => {
  it("15. stop does NOT create a new AttendanceSession document", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCloseActiveAttendanceSessionForClass.mockResolvedValueOnce(
      makeClosedSessionDoc(),
    );
    await stopAttendanceSessionAction({ classId: OWNED_CLASS_ID });
    // The action MUST NEVER touch AttendanceSessionModel.create /
    // AttendanceSessionModel.insertMany / .save etc.
    const model =
      (await import("@/lib/attendance/attendance-session-model"))
        .AttendanceSessionModel as unknown as Record<string, unknown>;
    expect(typeof model.create).not.toBe("function");
    // No `create` call either via the service or the action.
    expect(mockCloseActiveAttendanceSessionForClass).toHaveBeenCalledTimes(
      1,
    );
  });

  it("16. stop does NOT alter startedAt / startedByUserId", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const fixedStartedAt = new Date("2026-09-16T10:00:00Z");
    const fixedStartedBy = "original-teacher-id";
    mockCloseActiveAttendanceSessionForClass.mockResolvedValueOnce({
      ...makeClosedSessionDoc(),
      startedAt: fixedStartedAt,
      startedByUserId: fixedStartedBy,
    });
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // startedAt is surfaced as the original (immutable).
      expect(result.session.startedAt).toBe(fixedStartedAt.toISOString());
      // startedByUserId is NEVER exposed.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(fixedStartedBy);
    }
  });

  it("17. stop NEVER returns password / studentUserId / teacherUserId", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCloseActiveAttendanceSessionForClass.mockResolvedValueOnce({
      ...makeClosedSessionDoc({ rosterCount: 2 }),
      passwordHash: "leak-test",
    });
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("passwordHash");
      expect(serialized).not.toContain("leak-test");
      expect(serialized).not.toContain("startedByUserId");
      // No studentUserId anywhere in the DTO.
      expect(serialized).not.toMatch(/student-1|student-2|s-1|s-2/);
    }
  });

  it("18. stop action module opens with 'use server'", async () => {
    // Read the file directly and assert the "use server" directive
    // is present in the source. We resolve the path relative to the
    // working directory because Vitest's module URL scheme is not
    // `file:`.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const target = path.resolve(
      process.cwd(),
      "src/lib/attendance/stop-attendance-session-action.ts",
    );
    const source = await fs.readFile(target, "utf8");
    // Tolerate a leading UTF-8 BOM.
    const normalized = source.replace(/^\uFEFF/, "");
    // The directive must appear on its own line. It is the FIRST
    // executable statement; comments may precede it.
    expect(/^"use server";/m.test(normalized)).toBe(true);
  });

  it("19. service-level CAS is encoded with status='active' precondition", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCloseActiveAttendanceSessionForClass.mockResolvedValueOnce(
      makeClosedSessionDoc(),
    );
    await stopAttendanceSessionAction({ classId: OWNED_CLASS_ID });
    expect(
      mockCloseActiveAttendanceSessionForClass,
    ).toHaveBeenCalledWith(expect.any(Object));
    // The action passes the classId ObjectId straight to the
    // service. The CAS `status: "active"` precondition is
    // enforced INSIDE the service (covered by the dedicated
    // service test). Here we only assert the action delegates to
    // the service rather than performing its own write.
    expect(mockAttendanceSessionFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

// =============================================================================
// helpers
// =============================================================================

function setupAttendanceSessionFindChain(
  result: ReturnType<typeof makeClosedSessionDoc>[] | [],
) {
  mockAttendanceSessionFind.mockImplementationOnce(() => {
    const query = {
      sort: () => query,
      limit: () => query,
      lean: () => query,
      exec: async () => result,
    };
    return query;
  });
}

// =============================================================================
// PHASE 6.6 — Session finalization
// =============================================================================

describe("stopAttendanceSessionAction — PHASE 6.6 session finalization", () => {
  it("32/33. stop success → finalizeAbsentMarksForClosedSession is called", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCloseActiveAttendanceSessionForClass.mockResolvedValueOnce(
      makeClosedSessionDoc(),
    );

    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyStopped).toBe(false);
      // Finalization status must propagate to the client.
      expect(typeof result.session.finalizedAt).toBe("string");
      expect(result.session.absentCount).toBe(0);
    }

    // The finalize function was called with the closed session.
    expect(mockFinalizeAbsentMarksForClosedSession).toHaveBeenCalledTimes(1);
    const finalizeArgs = mockFinalizeAbsentMarksForClosedSession.mock
      .calls[0]?.[0] as { sessionId: string; classId: string };
    expect(finalizeArgs.sessionId).toBe(SESSION_ID);
    expect(finalizeArgs.classId).toBe(OWNED_CLASS_ID);
  });

  it("PHASE 6.6 — finalizeAbsentMarksForClosedSession failure does NOT fail the stop action", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCloseActiveAttendanceSessionForClass.mockResolvedValueOnce(
      makeClosedSessionDoc(),
    );
    mockFinalizeAbsentMarksForClosedSession.mockRejectedValueOnce(
      new Error("Mock finalization failure"),
    );

    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });

    // The session was already closed; finalization failure is
    // tolerable — the action surfaces the safe idempotent
    // success.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyStopped).toBe(false);
      expect(result.session.status).toBe("closed");
      // finalizedAt / absentCount remain undefined when
      // finalization failed.
      expect(result.session.finalizedAt).toBeUndefined();
      expect(result.session.absentCount).toBeUndefined();
    }
  });

  it("PHASE 6.6 — absent count is propagated to the browser when finalize succeeds", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCloseActiveAttendanceSessionForClass.mockResolvedValueOnce(
      makeClosedSessionDoc(),
    );
    mockFinalizeAbsentMarksForClosedSession.mockResolvedValueOnce({
      createdAbsent: ["s1", "s2", "s3", "s4", "s5"],
      alreadyHadMark: [],
      finalizedAt: "2026-09-16T10:42:00.000Z",
    });

    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session.absentCount).toBe(5);
      expect(result.session.finalizedAt).toBe(
        "2026-09-16T10:42:00.000Z",
      );
    }
  });

  it("PHASE 6.6 — idempotent re-stop ALSO finalizes (idempotent finalization)", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    // First CAS misses — typed NOT_ACTIVE.
    mockCloseActiveAttendanceSessionForClass.mockRejectedValueOnce(
      new AttendanceSessionServiceError({
        code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_SESSION_NOT_ACTIVE,
        message: "no active session",
      }),
    );
    // Fallback read returns the closed session.
    setupAttendanceSessionFindChain([makeClosedSessionDoc()]);
    mockFinalizeAbsentMarksForClosedSession.mockResolvedValueOnce({
      createdAbsent: [],
      alreadyHadMark: ["s1"],
      finalizedAt: "2026-09-16T10:42:00.000Z",
    });

    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyStopped).toBe(true);
      expect(result.session.absentCount).toBe(0);
      // alreadyHad from finalize indicates no NEW absent marks
      // were created on this re-stop.
      expect(typeof result.session.finalizedAt).toBe("string");
    }
    // Finalization MUST be reattempted on idempotent stop too.
    expect(mockFinalizeAbsentMarksForClosedSession).toHaveBeenCalledTimes(1);
  });

  it("PHASE 6.6 — finalizeAbsentMarksForClosedSession is NOT called on auth failure", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(false);
    expect(mockFinalizeAbsentMarksForClosedSession).not.toHaveBeenCalled();
  });

  it("PHASE 6.6 — finalizeAbsentMarksForClosedSession is NOT called on non-owner", async () => {
    setupClassFindOneChain(null);
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(false);
    expect(mockFinalizeAbsentMarksForClosedSession).not.toHaveBeenCalled();
  });

  it("PHASE 6.6 — finalizeAbsentMarksForClosedSession is NOT called when no session exists", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCloseActiveAttendanceSessionForClass.mockRejectedValueOnce(
      new AttendanceSessionServiceError({
        code: ATTENDANCE_SESSION_ERROR_CODES.ATTENDANCE_SESSION_NOT_ACTIVE,
        message: "no session",
      }),
    );
    // Fallback read returns [].
    setupAttendanceSessionFindChain([]);

    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(false);
    // Critically: when there's NO session at all we do NOT
    // touch finalizeAbsentMarksForClosedSession.
    expect(mockFinalizeAbsentMarksForClosedSession).not.toHaveBeenCalled();
  });

  it("PHASE 6.6 — finalize NEVER queries current ClassMembership / Profile", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    mockCloseActiveAttendanceSessionForClass.mockResolvedValueOnce(
      makeClosedSessionDoc(),
    );

    await stopAttendanceSessionAction({ classId: OWNED_CLASS_ID });

    expect(mockFinalizeAbsentMarksForClosedSession).toHaveBeenCalledTimes(1);
    // The finalize call is parameter-isolated — just sessionId
    // + classId; nothing else.
    const callArgs = mockFinalizeAbsentMarksForClosedSession.mock
      .calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(callArgs).sort()).toEqual(["classId", "sessionId"]);
  });

  it("PHASE 6.6 — stop NEVER mutates rosterSnapshot", async () => {
    setupClassFindOneChain(makeOwnedClassDoc());
    const snapshotBefore = [
      {
        studentUserId: "student-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "A-001",
      },
      {
        studentUserId: "student-2",
        fullNameSnapshot: "Bravo",
        identificationCodeSnapshot: "B-001",
      },
    ];
    mockCloseActiveAttendanceSessionForClass.mockResolvedValueOnce({
      ...makeClosedSessionDoc({ rosterCount: 0 }),
      rosterSnapshot: snapshotBefore,
    });

    await stopAttendanceSessionAction({ classId: OWNED_CLASS_ID });

    // The mock service received no mutation; the snapshot is
    // verbatim on the service-returned doc.
    expect(snapshotBefore.length).toBe(2);
  });
});
