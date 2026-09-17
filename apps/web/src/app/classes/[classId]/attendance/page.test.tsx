/**
 * Tests for `/classes/[classId]/attendance` — PHASE 6.3 live face
 * recognition preview.
 *
 * Tests call the async Server Component function directly to bypass
 * React 19's Suspense boundary constraints in renderToStaticMarkup.
 * Error-throwing pages (redirect/notFound) are caught via try/catch.
 *
 * Covers:
 *   40. Teacher active session may open live attendance page
 *   41. student cannot render page
 *   42. no-active-session redirects safely
 */

import { describe as _describe, expect, it, vi } from "vitest";
void _describe;

// =============================================================================
// Mocks
// =============================================================================

const mockGetSession = vi.fn();
const mockGetProfileByUserId = vi.fn();
const mockGetClassDetailForCurrentUser = vi.fn();
const mockGetAttendanceSessionStatusForCurrentTeacher = vi.fn();

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

// Mock the camera client to keep this test focused on the page shell.
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

// Test 42b: closed session redirects safely

it("42b. closed session redirects safely", async () => {
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

  const params = Promise.resolve({ classId: "class-1" });

  await expect(Page({ params })).rejects.toThrow(
    "NEXT_REDIRECT:/classes/class-1",
  );
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
