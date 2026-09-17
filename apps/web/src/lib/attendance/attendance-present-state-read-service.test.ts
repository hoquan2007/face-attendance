/**
 * Tests for the PHASE 6.4 server-only
 * `getAttendancePresentStateForCurrentTeacher` read boundary.
 *
 * The boundary composes the active AttendanceSession roster
 * snapshot with the persisted AttendanceMark collection to
 * produce a safe, browser-facing "present students" DTO.
 *
 * Contract matrix:
 *
 *   ## Auth + profile (24..26)
 *     24. teacher owner may read present state
 *     25. student rejected (TEACHER_REQUIRED)
 *     26. non-owner teacher rejected (CLASS_NOT_ACCESSIBLE)
 *
 *   ## Snapshot authority (27..30)
 *     27. rosterCount comes from session snapshot
 *     28. presentCount comes from marks
 *     29. display identity comes from rosterSnapshot
 *     30. current Profile name change does NOT change historical display
 *
 *   ## Sort + privacy (31..33)
 *     31. students sorted recognizedAt ASC
 *     32. no studentUserId returned
 *     33. no AttendanceMark id returned
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// Mocks
// =============================================================================

const mockGetSession = vi.fn();
const mockGetProfileByUserId = vi.fn();
const mockClassFindOne = vi.fn();
const mockActiveSessionFindOne = vi.fn();
const mockListPresentAttendanceMarksForSession = vi.fn();

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
    listPresentAttendanceMarksForSession: (...args: unknown[]) =>
      mockListPresentAttendanceMarksForSession(...args),
  };
});

// =============================================================================
// Imports under test
// =============================================================================

import { getAttendancePresentStateForCurrentTeacher } from "./attendance-present-state-read-service";
import { ATTENDANCE_PRESENT_READ_ERROR_CODES } from "./attendance-present-state-read-service";

// =============================================================================
// Fixtures
// =============================================================================

const TEACHER_USER_ID = "teacher-better-auth-id-001";
const OWNED_CLASS_ID = "65f000000000000000000abc";
const ACTIVE_SESSION_ID = "65f000000000000000000aaa";
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

function makeProfile(role: "student" | "teacher") {
  return {
    userId: TEACHER_USER_ID,
    emailSnapshot: "teacher@example.com",
    role,
    fullName: "Teacher",
    identificationCode: "T-001",
    phone: undefined,
    onboardingCompleted: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function setupOwnedClassLookup() {
  mockClassFindOne.mockImplementationOnce(() => ({
    select: () => ({
      lean: () => ({
        exec: async () => ({
          _id: { toString: () => OWNED_CLASS_ID },
          teacherUserId: TEACHER_USER_ID,
        }),
      }),
    }),
  }));
}

function setupNonOwnedClassLookup() {
  mockClassFindOne.mockImplementationOnce(() => ({
    select: () => ({
      lean: () => ({ exec: async () => null }),
    }),
  }));
}

function setupActiveSessionLookup(
  rosterSnapshot: Array<{
    studentUserId: string;
    fullNameSnapshot: string;
    identificationCodeSnapshot: string;
  }>,
) {
  mockActiveSessionFindOne.mockImplementationOnce(() => ({
    select: () => ({
      lean: () => ({
        exec: async () => ({
          _id: { toString: () => ACTIVE_SESSION_ID },
          rosterSnapshot,
        }),
      }),
    }),
  }));
}

function setupMissingSessionLookup() {
  mockActiveSessionFindOne.mockImplementationOnce(() => ({
    select: () => ({
      lean: () => ({ exec: async () => null }),
    }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSession.mockResolvedValue(makeSession(TEACHER_USER_ID));
  mockGetProfileByUserId.mockResolvedValue(makeProfile("teacher"));
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// 24 — Teacher owner may read present state
// =============================================================================

it("24. Teacher owner may read present state (active session with marks)", async () => {
  setupOwnedClassLookup();
  setupActiveSessionLookup([
    {
      studentUserId: "u-1",
      fullNameSnapshot: "Alice (snapshot)",
      identificationCodeSnapshot: "SV001",
    },
    {
      studentUserId: "u-2",
      fullNameSnapshot: "Bob (snapshot)",
      identificationCodeSnapshot: "SV002",
    },
  ]);
  mockListPresentAttendanceMarksForSession.mockResolvedValueOnce([
    {
      studentUserId: "u-1",
      recognizedAt: new Date("2026-09-16T10:00:00Z"),
    },
    {
      studentUserId: "u-2",
      recognizedAt: new Date("2026-09-16T10:01:00Z"),
    },
  ]);

  const result = await getAttendancePresentStateForCurrentTeacher(
    OWNED_CLASS_ID,
  );

  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.result.sessionId).toBe(ACTIVE_SESSION_ID);
  expect(result.result.rosterCount).toBe(2);
  expect(result.result.presentCount).toBe(2);
  expect(result.result.students).toHaveLength(2);
});

// =============================================================================
// 25 — Student rejected
// =============================================================================

it("25. Student rejected with TEACHER_REQUIRED (no session/mark query)", async () => {
  mockGetProfileByUserId.mockResolvedValueOnce(makeProfile("student"));

  const result = await getAttendancePresentStateForCurrentTeacher(
    OWNED_CLASS_ID,
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(ATTENDANCE_PRESENT_READ_ERROR_CODES.TEACHER_REQUIRED);
  // Student MUST NOT trigger class lookup or session/mark queries.
  expect(mockClassFindOne).not.toHaveBeenCalled();
  expect(mockActiveSessionFindOne).not.toHaveBeenCalled();
  expect(mockListPresentAttendanceMarksForSession).not.toHaveBeenCalled();
});

// =============================================================================
// 26 — Non-owner teacher rejected
// =============================================================================

it("26. Non-owner teacher rejected with CLASS_NOT_ACCESSIBLE", async () => {
  setupNonOwnedClassLookup();

  const result = await getAttendancePresentStateForCurrentTeacher(
    OWNED_CLASS_ID,
  );

  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(ATTENDANCE_PRESENT_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE);
});

// =============================================================================
// Malformed classId collapses to CLASS_NOT_ACCESSIBLE
// =============================================================================

it("malformed classId rejected with CLASS_NOT_ACCESSIBLE (no DB call)", async () => {
  const result = await getAttendancePresentStateForCurrentTeacher(NON_HEX_ID);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(ATTENDANCE_PRESENT_READ_ERROR_CODES.CLASS_NOT_ACCESSIBLE);
  expect(mockClassFindOne).not.toHaveBeenCalled();
});

// =============================================================================
// 27 — rosterCount comes from session snapshot
// =============================================================================

it("27. rosterCount comes from session snapshot (not from current ClassMembership)", async () => {
  setupOwnedClassLookup();
  // The session snapshot carries 5 students, even though only 2
  // currently have marks. The function MUST report 5.
  setupActiveSessionLookup(
    Array.from({ length: 5 }, (_, i) => ({
      studentUserId: `u-${i + 1}`,
      fullNameSnapshot: `Student ${i + 1}`,
      identificationCodeSnapshot: `SV${String(i + 1).padStart(3, "0")}`,
    })),
  );
  mockListPresentAttendanceMarksForSession.mockResolvedValueOnce([
    {
      studentUserId: "u-1",
      recognizedAt: new Date("2026-09-16T10:00:00Z"),
    },
  ]);

  const result = await getAttendancePresentStateForCurrentTeacher(
    OWNED_CLASS_ID,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.result.rosterCount).toBe(5);
  expect(result.result.presentCount).toBe(1);
});

// =============================================================================
// 28 — presentCount comes from marks
// =============================================================================

it("28. presentCount equals the number of present marks", async () => {
  setupOwnedClassLookup();
  setupActiveSessionLookup([
    {
      studentUserId: "u-1",
      fullNameSnapshot: "Alice",
      identificationCodeSnapshot: "SV001",
    },
    {
      studentUserId: "u-2",
      fullNameSnapshot: "Bob",
      identificationCodeSnapshot: "SV002",
    },
    {
      studentUserId: "u-3",
      fullNameSnapshot: "Carol",
      identificationCodeSnapshot: "SV003",
    },
  ]);
  mockListPresentAttendanceMarksForSession.mockResolvedValueOnce([
    {
      studentUserId: "u-1",
      recognizedAt: new Date("2026-09-16T10:00:00Z"),
    },
    {
      studentUserId: "u-2",
      recognizedAt: new Date("2026-09-16T10:01:00Z"),
    },
    {
      studentUserId: "u-3",
      recognizedAt: new Date("2026-09-16T10:02:00Z"),
    },
  ]);

  const result = await getAttendancePresentStateForCurrentTeacher(
    OWNED_CLASS_ID,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.result.presentCount).toBe(3);
  expect(result.result.students).toHaveLength(3);
});

// =============================================================================
// 29 — display identity comes from rosterSnapshot
// =============================================================================

it("29. display identity comes from rosterSnapshot (not from current Profile)", async () => {
  setupOwnedClassLookup();
  setupActiveSessionLookup([
    {
      studentUserId: "u-1",
      fullNameSnapshot: "Alice (historical)",
      identificationCodeSnapshot: "SV001-OLD",
    },
  ]);
  mockListPresentAttendanceMarksForSession.mockResolvedValueOnce([
    {
      studentUserId: "u-1",
      recognizedAt: new Date("2026-09-16T10:00:00Z"),
    },
  ]);

  const result = await getAttendancePresentStateForCurrentTeacher(
    OWNED_CLASS_ID,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.result.students[0]).toMatchObject({
    fullName: "Alice (historical)",
    identificationCode: "SV001-OLD",
  });
});

// =============================================================================
// 30 — current Profile name change does NOT change historical display
// =============================================================================

it("30. current Profile name change does NOT change historical display", async () => {
  setupOwnedClassLookup();
  setupActiveSessionLookup([
    {
      studentUserId: "u-1",
      fullNameSnapshot: "Alice (at session start)",
      identificationCodeSnapshot: "SV001",
    },
  ]);
  // The Profile read would have updated to "Alice (new)" but we
  // never read Profile.fullName — the snapshot wins.
  mockListPresentAttendanceMarksForSession.mockResolvedValueOnce([
    {
      studentUserId: "u-1",
      recognizedAt: new Date("2026-09-16T10:00:00Z"),
    },
  ]);

  const result = await getAttendancePresentStateForCurrentTeacher(
    OWNED_CLASS_ID,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.result.students[0]?.fullName).toBe("Alice (at session start)");
  // The function NEVER queries Profile for the per-student row.
});

// =============================================================================
// 31 — students sorted recognizedAt ASC
// =============================================================================

it("31. students sorted recognizedAt ASC", async () => {
  setupOwnedClassLookup();
  setupActiveSessionLookup([
    {
      studentUserId: "u-1",
      fullNameSnapshot: "Alice",
      identificationCodeSnapshot: "SV001",
    },
    {
      studentUserId: "u-2",
      fullNameSnapshot: "Bob",
      identificationCodeSnapshot: "SV002",
    },
  ]);
  // Note: input order is intentionally NOT sorted; the read
  // service must apply the ASC order.
  mockListPresentAttendanceMarksForSession.mockResolvedValueOnce([
    {
      studentUserId: "u-2",
      recognizedAt: new Date("2026-09-16T10:01:00Z"),
    },
    {
      studentUserId: "u-1",
      recognizedAt: new Date("2026-09-16T10:00:00Z"),
    },
  ]);

  const result = await getAttendancePresentStateForCurrentTeacher(
    OWNED_CLASS_ID,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.result.students[0]?.fullName).toBe("Alice");
  expect(result.result.students[1]?.fullName).toBe("Bob");
  // recognizedAt on the rows is preserved from the marks.
  expect(result.result.students[0]?.recognizedAt).toBe(
    "2026-09-16T10:00:00.000Z",
  );
});

// =============================================================================
// 32 — no studentUserId returned
// =============================================================================

it("32. no studentUserId returned", async () => {
  setupOwnedClassLookup();
  setupActiveSessionLookup([
    {
      studentUserId: "u-1",
      fullNameSnapshot: "Alice",
      identificationCodeSnapshot: "SV001",
    },
  ]);
  mockListPresentAttendanceMarksForSession.mockResolvedValueOnce([
    {
      studentUserId: "u-1",
      recognizedAt: new Date("2026-09-16T10:00:00Z"),
    },
  ]);

  const result = await getAttendancePresentStateForCurrentTeacher(
    OWNED_CLASS_ID,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const serialized = JSON.stringify(result);
  expect(serialized.toLowerCase()).not.toContain("studentuserid");
});

// =============================================================================
// 33 — no AttendanceMark id returned
// =============================================================================

it("33. no AttendanceMark id returned", async () => {
  setupOwnedClassLookup();
  setupActiveSessionLookup([
    {
      studentUserId: "u-1",
      fullNameSnapshot: "Alice",
      identificationCodeSnapshot: "SV001",
    },
  ]);
  mockListPresentAttendanceMarksForSession.mockResolvedValueOnce([
    {
      studentUserId: "u-1",
      recognizedAt: new Date("2026-09-16T10:00:00Z"),
    },
  ]);

  const result = await getAttendancePresentStateForCurrentTeacher(
    OWNED_CLASS_ID,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  const serialized = JSON.stringify(result);
  // The Mongo `_id` is never projected.
  expect(serialized).not.toMatch(/_id/);
  // The collection name is never projected.
  expect(serialized).not.toMatch(/attendance_marks/);
  // The mark-internal fields are never projected.
  expect(serialized).not.toMatch(/classId/);
  expect(serialized).not.toMatch(/status/);
  expect(serialized).not.toMatch(/source/);
  expect(serialized).not.toMatch(/face_recognition/);
});

// =============================================================================
// Zero marks — empty list
// =============================================================================

it("zero marks returns presentCount=0 and empty students array", async () => {
  setupOwnedClassLookup();
  setupActiveSessionLookup([
    {
      studentUserId: "u-1",
      fullNameSnapshot: "Alice",
      identificationCodeSnapshot: "SV001",
    },
  ]);
  mockListPresentAttendanceMarksForSession.mockResolvedValueOnce([]);

  const result = await getAttendancePresentStateForCurrentTeacher(
    OWNED_CLASS_ID,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.result.presentCount).toBe(0);
  expect(result.result.students).toEqual([]);
  expect(result.result.rosterCount).toBe(1);
});

// =============================================================================
// Orphaned mark (studentUserId not in snapshot) is silently skipped
// =============================================================================

it("orphaned mark (studentUserId not in snapshot) is silently skipped", async () => {
  setupOwnedClassLookup();
  setupActiveSessionLookup([
    {
      studentUserId: "u-1",
      fullNameSnapshot: "Alice",
      identificationCodeSnapshot: "SV001",
    },
  ]);
  mockListPresentAttendanceMarksForSession.mockResolvedValueOnce([
    {
      studentUserId: "u-1",
      recognizedAt: new Date("2026-09-16T10:00:00Z"),
    },
    {
      // This studentUserId is NOT in the snapshot — orphan.
      studentUserId: "u-orphan",
      recognizedAt: new Date("2026-09-16T10:01:00Z"),
    },
  ]);

  const result = await getAttendancePresentStateForCurrentTeacher(
    OWNED_CLASS_ID,
  );
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.result.students).toHaveLength(1);
  expect(result.result.presentCount).toBe(1);
  // The orphan id MUST NEVER appear in the projection.
  const serialized = JSON.stringify(result);
  expect(serialized).not.toContain("u-orphan");
});

// =============================================================================
// No active session → ATTENDANCE_SESSION_NOT_ACTIVE
// =============================================================================

it("no active session returns ATTENDANCE_SESSION_NOT_ACTIVE", async () => {
  setupOwnedClassLookup();
  setupMissingSessionLookup();

  const result = await getAttendancePresentStateForCurrentTeacher(
    OWNED_CLASS_ID,
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(
    ATTENDANCE_PRESENT_READ_ERROR_CODES.ATTENDANCE_SESSION_NOT_ACTIVE,
  );
});

// =============================================================================
// Unauthenticated
// =============================================================================

it("no session returns UNAUTHENTICATED", async () => {
  mockGetSession.mockResolvedValueOnce(null);

  const result = await getAttendancePresentStateForCurrentTeacher(
    OWNED_CLASS_ID,
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(ATTENDANCE_PRESENT_READ_ERROR_CODES.UNAUTHENTICATED);
});

// =============================================================================
// Incomplete profile
// =============================================================================

it("incomplete profile returns PROFILE_INCOMPLETE", async () => {
  mockGetProfileByUserId.mockResolvedValueOnce({
    ...makeProfile("teacher"),
    onboardingCompleted: false,
  });

  const result = await getAttendancePresentStateForCurrentTeacher(
    OWNED_CLASS_ID,
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.code).toBe(ATTENDANCE_PRESENT_READ_ERROR_CODES.PROFILE_INCOMPLETE);
});
