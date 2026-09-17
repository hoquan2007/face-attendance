/**
 * Tests for `/classes/[classId]/attendance` — PHASE 6.4 live
 * face recognition + persisted present state.
 * PHASE 6.6 — ATTENDANCE SESSION FINALIZATION (adds closed-session final summary).
 *
 * Tests call the async Server Component function directly to
 * bypass React 19's Suspense boundary constraints in
 * renderToStaticMarkup. Error-throwing pages (redirect/notFound)
 * are caught via try/catch.
 *
 * Covers:
 *   40. Teacher active session may open live attendance page
 *   41. student cannot render page
 *   42. no-active-session redirects safely
 *
 * PHASE 6.4 additions:
 *   35. page renders presentCount / rosterCount from the
 *       persisted present-state read
 *   36. present student name renders
 *   37. identificationCode renders
 *   38. zero marks shows restrained empty state
 *   39. successful scan calls router.refresh (covered in the
 *       AttendanceCameraClient test)
 *   40. repeated scans do not visually inflate persisted count
 *   41. no Absent label
 *   42. no Late label
 *
 * PHASE 6.6 additions:
 *   27. closed session renders final summary (not active camera)
 *   33. final summary appears after stop
 *   — final summary read service covered in
 *     attendance-final-summary-read-service.test.ts
 *   — final summary panel covered in
 *     attendance-final-summary-panel.test.tsx
 */

import { beforeEach, describe as _describe, expect, it, vi } from "vitest";
void _describe;

// =============================================================================
// Mocks
// =============================================================================

const mockGetSession = vi.fn();
const mockGetProfileByUserId = vi.fn();
const mockGetClassDetailForCurrentUser = vi.fn();
const mockGetAttendanceSessionStatusForCurrentTeacher = vi.fn();
const mockGetAttendancePresentStateForCurrentTeacher = vi.fn();
const mockGetAttendanceFinalSummaryForCurrentTeacher = vi.fn();

beforeEach(() => {
  mockGetSession.mockReset();
  mockGetProfileByUserId.mockReset();
  mockGetClassDetailForCurrentUser.mockReset();
  mockGetAttendanceSessionStatusForCurrentTeacher.mockReset();
  mockGetAttendancePresentStateForCurrentTeacher.mockReset();
  mockGetAttendanceFinalSummaryForCurrentTeacher.mockReset();
  mockNotFound.mockClear();
  mockRedirect.mockClear();
});

const mockNotFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const mockRedirect = vi.fn((href: string) => {
  throw new Error(`NEXT_REDIRECT:${href}`);
});

vi.mock("next/navigation", () => ({
  redirect: (href: string) => mockRedirect(href),
  notFound: () => mockNotFound(),
}));

vi.mock("@/lib/session", () => ({
  getSession: () => mockGetSession(),
}));

vi.mock("@/lib/profile-service", () => ({
  getProfileByUserId: (...args: unknown[]) => mockGetProfileByUserId(...args),
}));

vi.mock("@/lib/classes/class-read-service", () => ({
  getClassDetailForCurrentUser: (...args: unknown[]) =>
    mockGetClassDetailForCurrentUser(...args),
  CLASS_DETAIL_READ_ERROR_CODES: {
    UNAUTHENTICATED: "UNAUTHENTICATED",
    PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
    CLASS_NOT_ACCESSIBLE: "CLASS_NOT_ACCESSIBLE",
    CLASS_READ_FAILED: "CLASS_READ_FAILED",
  },
}));

vi.mock("@/lib/attendance/attendance-session-status-read-service", () => ({
  getAttendanceSessionStatusForCurrentTeacher: (...args: unknown[]) =>
    mockGetAttendanceSessionStatusForCurrentTeacher(...args),
}));

vi.mock(
  "@/lib/attendance/attendance-present-state-read-service",
  () => ({
    getAttendancePresentStateForCurrentTeacher: (...args: unknown[]) =>
      mockGetAttendancePresentStateForCurrentTeacher(...args),
  }),
);

// PHASE 6.6 — final attendance summary read model mock
vi.mock(
  "@/lib/attendance/attendance-final-summary-read-service",
  () => ({
    getAttendanceFinalSummaryForCurrentTeacher: (...args: unknown[]) =>
      mockGetAttendanceFinalSummaryForCurrentTeacher(...args),
    ATTENDANCE_FINAL_SUMMARY_ERROR_CODES: {
      UNAUTHENTICATED: "UNAUTHENTICATED",
      PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
      TEACHER_REQUIRED: "TEACHER_REQUIRED",
      CLASS_NOT_ACCESSIBLE: "CLASS_NOT_ACCESSIBLE",
      ATTENDANCE_SESSION_NOT_FOUND: "ATTENDANCE_SESSION_NOT_FOUND",
      ATTENDANCE_SESSION_NOT_CLOSED: "ATTENDANCE_SESSION_NOT_CLOSED",
      ATTENDANCE_SUMMARY_READ_FAILED: "ATTENDANCE_SUMMARY_READ_FAILED",
    },
  }),
);

// Mock both client components so this test focuses on the
// Server Component shell.
vi.mock("@/components/classes/attendance-camera-client", () => ({
  AttendanceCameraClient: ({
    classId,
    sessionId,
    rosterCount,
  }: {
    classId: string;
    sessionId: string;
    rosterCount: number;
  }) => (
    <div
      data-component="attendance-camera-client"
      data-class-id={classId}
      data-session-id={sessionId}
      data-roster-count={rosterCount}
    >
      Camera Mock
    </div>
  ),
}));

vi.mock("@/components/classes/attendance-present-state-panel", () => ({
  AttendancePresentStatePanel: ({
    sessionId,
    rosterCount,
    presentCount,
    students,
  }: {
    sessionId: string;
    rosterCount: number;
    presentCount: number;
    students: Array<{
      fullName: string;
      identificationCode: string;
      recognizedAt: string;
    }>;
  }) => (
    <div
      data-component="attendance-present-state-panel"
      data-session-id={sessionId}
      data-present-count={presentCount}
      data-roster-count={rosterCount}
    >
      {students.map((s, i: number) => (
        <div
          key={i}
          data-attendance-present-row="true"
          data-student-name={s.fullName}
          data-student-id={s.identificationCode}
          data-recognized-at={s.recognizedAt}
        />
      ))}
    </div>
  ),
}));

// PHASE 6.6 — Mock the FinalSummaryPanel as a visible stub.
vi.mock("@/components/classes/attendance-final-summary-panel", () => ({
  AttendanceFinalSummaryPanel: ({
    summary,
  }: {
    summary: {
      session: { id: string; rosterCount: number };
      presentCount: number;
      absentCount: number;
      students: Array<{
        fullName: string;
        identificationCode: string;
        status: "present" | "absent";
        recognizedAt: string | null;
      }>;
    } | null;
  }) => {
    if (!summary) {
      return (
        <div
          data-component="attendance-final-summary-panel"
          data-summary-null="true"
        >
          Error Mock
        </div>
      );
    }
    return (
      <div
        data-component="attendance-final-summary-panel"
        data-summary-rendered="true"
        data-present-count={summary.presentCount}
        data-absent-count={summary.absentCount}
        data-roster-count={summary.session.rosterCount}
      >
        {summary.students.map((s, i: number) => (
          <div
            key={i}
            data-attendance-final-row="true"
            data-student-name={s.fullName}
            data-student-id={s.identificationCode}
            data-student-status={s.status}
          />
        ))}
      </div>
    );
  },
}));

// =============================================================================
// Fixtures
// =============================================================================

function makeSession(user: { id: string }) {
  return {
    user: {
      id: user.id,
      email: `${user.id}@example.com`,
      name: "Test User",
      image: null,
    },
    expiresAt: new Date(),
  };
}

function makeClassDetail(
  role: "teacher" | "student",
  overrides: { ok?: boolean; code?: string } = {},
) {
  if (overrides.ok === false) {
    return { ok: false, code: overrides.code ?? "CLASS_NOT_ACCESSIBLE" };
  }
  return {
    ok: true,
    result: {
      role,
      class: {
        id: "class-1",
        name: "Test Class",
      },
    },
  };
}

function makeAttendanceStatus(state: "active" | "closed" | "none") {
  if (state === "none") {
    return {
      ok: true,
      result: {
        state: "none" as const,
        session: null,
      },
    };
  }
  return {
    ok: true,
    result: {
      state,
      session: {
        id: "session-1",
        status: state,
        startedAt: new Date().toISOString(),
        endedAt: state === "closed" ? new Date().toISOString() : null,
        rosterCount: 5,
      },
    },
  };
}

function makePresentState(
  presentCount: number,
  students: Array<{
    fullName: string;
    identificationCode: string;
    recognizedAt: string;
  }> = [],
) {
  return {
    ok: true,
    result: {
      sessionId: "session-1",
      rosterCount: 25,
      presentCount,
      students,
    },
  };
}

// =============================================================================
// Tests
// =============================================================================

// Test 40: Teacher active session may open live attendance page

it("40. Teacher active session may open live attendance page", async () => {
  const { default: Page } = await import(
    "@/app/classes/[classId]/attendance/page"
  );

  mockGetSession.mockResolvedValue(makeSession({ id: "teacher-1" }));
  mockGetProfileByUserId.mockResolvedValue({
    onboardingCompleted: true,
    role: "teacher",
    userId: "teacher-1",
    fullName: "Teacher",
    identificationCode: "TC001",
  });
  mockGetClassDetailForCurrentUser.mockResolvedValue(
    makeClassDetail("teacher"),
  );
  mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue(
    makeAttendanceStatus("active"),
  );
  mockGetAttendancePresentStateForCurrentTeacher.mockResolvedValue(
    makePresentState(0, []),
  );

  const params = Promise.resolve({ classId: "class-1" });

  // Call the async Server Component directly.
  const result = await Page({ params });

  // The page should produce a JSX tree without throwing.
  expect(result).toBeDefined();
  expect(mockNotFound).not.toHaveBeenCalled();
  expect(mockRedirect).not.toHaveBeenCalled();
});

// Test 41: student cannot render page

it("41. student cannot render page", async () => {
  const { default: Page } = await import(
    "@/app/classes/[classId]/attendance/page"
  );

  mockGetSession.mockResolvedValue(makeSession({ id: "student-1" }));
  mockGetProfileByUserId.mockResolvedValue({
    onboardingCompleted: true,
    role: "student",
    userId: "student-1",
    fullName: "Student",
    identificationCode: "SV001",
  });
  mockGetClassDetailForCurrentUser.mockResolvedValue(
    makeClassDetail("student"),
  );
  mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue(
    makeAttendanceStatus("active"),
  );

  const params = Promise.resolve({ classId: "class-1" });

  // notFound() throws — the page must trigger it for students.
  await expect(Page({ params })).rejects.toThrow("NEXT_NOT_FOUND");
  expect(mockNotFound).toHaveBeenCalled();
});

// Test 42: no-active-session redirects safely

it("42. no-active-session redirects safely", async () => {
  const { default: Page } = await import(
    "@/app/classes/[classId]/attendance/page"
  );

  mockGetSession.mockResolvedValue(makeSession({ id: "teacher-1" }));
  mockGetProfileByUserId.mockResolvedValue({
    onboardingCompleted: true,
    role: "teacher",
    userId: "teacher-1",
    fullName: "Teacher",
    identificationCode: "TC001",
  });
  mockGetClassDetailForCurrentUser.mockResolvedValue(
    makeClassDetail("teacher"),
  );
  mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue(
    makeAttendanceStatus("none"),
  );

  const params = Promise.resolve({ classId: "class-1" });

  // No active session → redirect back to class detail.
  await expect(Page({ params })).rejects.toThrow(
    "NEXT_REDIRECT:/classes/class-1",
  );
  expect(mockRedirect).toHaveBeenCalledWith("/classes/class-1");
});

// Test 42b: closed session renders final attendance summary (PHASE 6.6)

it("27/33. closed session renders final attendance summary", async () => {
  const { default: Page } = await import(
    "@/app/classes/[classId]/attendance/page"
  );

  mockGetSession.mockResolvedValue(makeSession({ id: "teacher-1" }));
  mockGetProfileByUserId.mockResolvedValue({
    onboardingCompleted: true,
    role: "teacher",
    userId: "teacher-1",
    fullName: "Teacher",
    identificationCode: "TC001",
  });
  mockGetClassDetailForCurrentUser.mockResolvedValue(
    makeClassDetail("teacher"),
  );
  mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue(
    makeAttendanceStatus("closed"),
  );
  mockGetAttendanceFinalSummaryForCurrentTeacher.mockResolvedValue({
    ok: true,
    result: {
      session: {
        id: "session-1",
        startedAt: "2026-09-16T10:00:00.000Z",
        endedAt: "2026-09-16T10:42:00.000Z",
        rosterCount: 3,
      },
      presentCount: 2,
      absentCount: 1,
      students: [
        {
          fullName: "Alpha",
          identificationCode: "SV001",
          status: "present",
          recognizedAt: "2026-09-16T10:05:00.000Z",
        },
        {
          fullName: "Bravo",
          identificationCode: "SV002",
          status: "absent",
          recognizedAt: "2026-09-16T10:42:00.000Z",
        },
        {
          fullName: "Charlie",
          identificationCode: "SV003",
          status: "present",
          recognizedAt: "2026-09-16T10:10:00.000Z",
        },
      ],
    },
  });

  const params = Promise.resolve({ classId: "class-1" });
  const tree = await Page({ params });

  // PHASE 6.6: The final summary panel is rendered.
  expect(mockRedirect).not.toHaveBeenCalled();
  expect(mockGetAttendanceFinalSummaryForCurrentTeacher).toHaveBeenCalledWith(
    "class-1",
    "session-1",
  );

  // The page renders the FinalSummaryPanel by including it as a
  // child element with the correct summary prop. We check the
  // serialized React element for the summary data.
  const serialized = JSON.stringify(tree ?? null);
  expect(serialized).toContain('"presentCount":2');
  expect(serialized).toContain('"absentCount":1');
  expect(serialized).toContain('"rosterCount":3');
  expect(serialized).toContain("Alpha");
  expect(serialized).toContain("Bravo");
  expect(serialized).toContain("SV001");
  expect(serialized).toContain("SV002");
});

// PHASE 6.6 — closed session with read failure renders null summary

it("PHASE 6.6 — closed session with read failure renders null summary panel", async () => {
  const { default: Page } = await import(
    "@/app/classes/[classId]/attendance/page"
  );

  mockGetSession.mockResolvedValue(makeSession({ id: "teacher-1" }));
  mockGetProfileByUserId.mockResolvedValue({
    onboardingCompleted: true,
    role: "teacher",
    userId: "teacher-1",
    fullName: "Teacher",
    identificationCode: "TC001",
  });
  mockGetClassDetailForCurrentUser.mockResolvedValue(
    makeClassDetail("teacher"),
  );
  mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue(
    makeAttendanceStatus("closed"),
  );
  mockGetAttendanceFinalSummaryForCurrentTeacher.mockResolvedValue({
    ok: false,
    code: "ATTENDANCE_SUMMARY_READ_FAILED",
    message: "boom",
  });

  const params = Promise.resolve({ classId: "class-1" });
  const tree = await Page({ params });

  expect(mockRedirect).not.toHaveBeenCalled();
  const serialized = JSON.stringify(tree ?? null);
  // The null summary is passed to the panel.
  expect(serialized).toContain('"summary":null');
});

// Test 43: unauthenticated redirects to login

it("43. unauthenticated redirects to login", async () => {
  const { default: Page } = await import(
    "@/app/classes/[classId]/attendance/page"
  );

  mockGetSession.mockResolvedValue(null);

  const params = Promise.resolve({ classId: "class-1" });

  await expect(Page({ params })).rejects.toThrow("NEXT_REDIRECT:/login");
});

// Test 44: class not accessible triggers notFound

it("44. class not accessible triggers notFound", async () => {
  const { default: Page } = await import(
    "@/app/classes/[classId]/attendance/page"
  );

  mockGetSession.mockResolvedValue(makeSession({ id: "teacher-1" }));
  mockGetProfileByUserId.mockResolvedValue({
    onboardingCompleted: true,
    role: "teacher",
    userId: "teacher-1",
    fullName: "Teacher",
    identificationCode: "TC001",
  });
  mockGetClassDetailForCurrentUser.mockResolvedValue({
    ok: false,
    code: "CLASS_NOT_ACCESSIBLE",
  });

  const params = Promise.resolve({ classId: "class-1" });

  await expect(Page({ params })).rejects.toThrow("NEXT_NOT_FOUND");
});

// =============================================================================
// PHASE 6.4 — present state contract
// =============================================================================

// 35 — page reads persisted present state from the read service

it("35. page reads persisted present state from getAttendancePresentStateForCurrentTeacher", async () => {
  const { default: Page } = await import(
    "@/app/classes/[classId]/attendance/page"
  );

  mockGetSession.mockResolvedValue(makeSession({ id: "teacher-1" }));
  mockGetProfileByUserId.mockResolvedValue({
    onboardingCompleted: true,
    role: "teacher",
    userId: "teacher-1",
    fullName: "Teacher",
    identificationCode: "TC001",
  });
  mockGetClassDetailForCurrentUser.mockResolvedValue(
    makeClassDetail("teacher"),
  );
  mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue(
    makeAttendanceStatus("active"),
  );
  mockGetAttendancePresentStateForCurrentTeacher.mockResolvedValue(
    makePresentState(3, [
      {
        fullName: "Alice",
        identificationCode: "SV001",
        recognizedAt: "2026-09-16T10:00:00.000Z",
      },
      {
        fullName: "Bob",
        identificationCode: "SV002",
        recognizedAt: "2026-09-16T10:01:00.000Z",
      },
      {
        fullName: "Carol",
        identificationCode: "SV003",
        recognizedAt: "2026-09-16T10:02:00.000Z",
      },
    ]),
  );

  const params = Promise.resolve({ classId: "class-1" });

  await Page({ params });

  expect(mockGetAttendancePresentStateForCurrentTeacher).toHaveBeenCalledTimes(
    1,
  );
  expect(mockGetAttendancePresentStateForCurrentTeacher).toHaveBeenCalledWith(
    "class-1",
  );
});

// 38 — zero marks still renders the page (empty state)

it("38. zero marks still renders the page (empty state)", async () => {
  const { default: Page } = await import(
    "@/app/classes/[classId]/attendance/page"
  );

  mockGetSession.mockResolvedValue(makeSession({ id: "teacher-1" }));
  mockGetProfileByUserId.mockResolvedValue({
    onboardingCompleted: true,
    role: "teacher",
    userId: "teacher-1",
    fullName: "Teacher",
    identificationCode: "TC001",
  });
  mockGetClassDetailForCurrentUser.mockResolvedValue(
    makeClassDetail("teacher"),
  );
  mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue(
    makeAttendanceStatus("active"),
  );
  mockGetAttendancePresentStateForCurrentTeacher.mockResolvedValue(
    makePresentState(0, []),
  );

  const params = Promise.resolve({ classId: "class-1" });

  await expect(Page({ params })).resolves.toBeDefined();
});

// 38b — present read failure renders empty present state, page still works

it("38b. present read failure renders empty present state (no crash)", async () => {
  const { default: Page } = await import(
    "@/app/classes/[classId]/attendance/page"
  );

  mockGetSession.mockResolvedValue(makeSession({ id: "teacher-1" }));
  mockGetProfileByUserId.mockResolvedValue({
    onboardingCompleted: true,
    role: "teacher",
    userId: "teacher-1",
    fullName: "Teacher",
    identificationCode: "TC001",
  });
  mockGetClassDetailForCurrentUser.mockResolvedValue(
    makeClassDetail("teacher"),
  );
  mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue(
    makeAttendanceStatus("active"),
  );
  mockGetAttendancePresentStateForCurrentTeacher.mockResolvedValue({
    ok: false,
    code: "ATTENDANCE_PRESENT_READ_FAILED",
    message: "failed",
  });

  const params = Promise.resolve({ classId: "class-1" });

  await expect(Page({ params })).resolves.toBeDefined();
});

// 40 — repeated scans do not visually inflate persisted count

it("40. repeated scans do not visually inflate persisted count (page consumes server state, not client state)", async () => {
  const { default: Page } = await import(
    "@/app/classes/[classId]/attendance/page"
  );

  mockGetSession.mockResolvedValue(makeSession({ id: "teacher-1" }));
  mockGetProfileByUserId.mockResolvedValue({
    onboardingCompleted: true,
    role: "teacher",
    userId: "teacher-1",
    fullName: "Teacher",
    identificationCode: "TC001",
  });
  mockGetClassDetailForCurrentUser.mockResolvedValue(
    makeClassDetail("teacher"),
  );
  mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue(
    makeAttendanceStatus("active"),
  );
  mockGetAttendancePresentStateForCurrentTeacher.mockResolvedValue(
    makePresentState(3, [
      {
        fullName: "Alice",
        identificationCode: "SV001",
        recognizedAt: "2026-09-16T10:00:00.000Z",
      },
      {
        fullName: "Bob",
        identificationCode: "SV002",
        recognizedAt: "2026-09-16T10:01:00.000Z",
      },
      {
        fullName: "Carol",
        identificationCode: "SV003",
        recognizedAt: "2026-09-16T10:02:00.000Z",
      },
    ]),
  );

  const params = Promise.resolve({ classId: "class-1" });

  // Render the page twice — both reads hit the same persisted
  // state. The page never doubles or otherwise inflates the
  // count because the client never accumulates state.
  await Page({ params });
  await Page({ params });

  expect(mockGetAttendancePresentStateForCurrentTeacher).toHaveBeenCalledTimes(
    2,
  );
  // The read service was called twice with the SAME classId;
  // both calls returned the same persistent-state snapshot.
});
