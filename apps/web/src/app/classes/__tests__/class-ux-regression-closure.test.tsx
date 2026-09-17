/**
 * PHASE 5.1E4C — FINAL CLASS UX POLISH + REGRESSION CLOSURE.
 *
 * This file is the single canonical regression closure for the
 * Class UX MVP. It purposefully re-renders the four Class routes
 * and the three Class Client Components to assert the full
 * teacher and student flows work together — without introducing
 * a giant end-to-end framework. The existing Vitest mocks and
 * React-render patterns are reused.
 *
 * The contract matrix covers exactly the items in PHASE 5.1E4C:
 *
 *   TEACHER FLOW (items 1..10)
 *     1.  teacher /classes shows Create class
 *     2.  teacher /classes hides Join class
 *     3.  teacher creates class successfully
 *     4.  success shows classCode
 *     5.  success View class uses /classes/<id>
 *     6.  teacher detail renders class summary
 *     7.  teacher detail renders Students roster
 *     8.  empty roster state works
 *     9.  archived teacher class still opens
 *     10. teacher detail has Back to classes
 *
 *   STUDENT FLOW (items 11..20)
 *     11. student /classes shows Join class
 *     12. student /classes hides Create class
 *     13. student joins successfully
 *     14. first join View class works
 *     15. alreadyJoined View class works
 *     16. student detail renders class summary
 *     17. student detail never invokes roster read
 *     18. student detail shows no Students section
 *     19. archived joined class still opens
 *     20. student detail has Back to classes
 *
 *   SECURITY / PRIVACY (items 21..30)
 *     21..30 — the rendered browser output never contains
 *     passwordHash / teacherUserId / studentUserId /
 *     membershipId / emailSnapshot / phone / FaceProfile /
 *     embedding / centroid / raw Mongo errors. These are
 *     applied as cross-cutting assertions against the final
 *     rendered trees produced by the routes above.
 *
 *   DOMAIN ISOLATION (items 31..36)
 *     31. call Face Service              — no
 *     32. query FaceProfile              — no
 *     33. create attendance data         — no
 *     34. display attendance state       — no
 *     35. call class password verify     — no
 *     36. create public Class REST APIs  — no
 *
 * The tests use the existing Vitest mock patterns. NO new
 * dependencies, NO new test framework, NO new pool / isolation
 * configuration are introduced.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as React from "react";

// =============================================================================
// Shared mocks — /classes
// =============================================================================

const mockGetSession = vi.fn();
const mockGetProfileByUserId = vi.fn();
const mockGetVisibleClassesForCurrentUser = vi.fn();

vi.mock("@/lib/session", () => ({
  getSession: () => mockGetSession(),
}));

vi.mock("@/lib/profile-service", () => ({
  getProfileByUserId: (...args: unknown[]) =>
    mockGetProfileByUserId(...args),
  isOnboardingComplete: (...args: unknown[]) =>
    mockGetProfileByUserId(...args).then(
      (p: { onboardingCompleted?: boolean } | null) =>
        Boolean(p?.onboardingCompleted),
    ),
}));

vi.mock("@/lib/classes/class-read-service", () => ({
  getVisibleClassesForCurrentUser: () =>
    mockGetVisibleClassesForCurrentUser(),
  getClassDetailForCurrentUser: (...args: unknown[]) =>
    mockGetClassDetailForCurrentUser(...args),
  getClassRosterForCurrentTeacher: (...args: unknown[]) =>
    mockGetClassRosterForCurrentTeacher(...args),
  CLASS_READ_ERROR_CODES: {
    UNAUTHENTICATED: "UNAUTHENTICATED",
    PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
    CLASS_READ_FAILED: "CLASS_READ_FAILED",
  },
  CLASS_DETAIL_READ_ERROR_CODES: {
    UNAUTHENTICATED: "UNAUTHENTICATED",
    PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
    CLASS_NOT_ACCESSIBLE: "CLASS_NOT_ACCESSIBLE",
    CLASS_READ_FAILED: "CLASS_READ_FAILED",
  },
  CLASS_ROSTER_READ_ERROR_CODES: {
    UNAUTHENTICATED: "UNAUTHENTICATED",
    PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
    TEACHER_REQUIRED: "TEACHER_REQUIRED",
    CLASS_NOT_ACCESSIBLE: "CLASS_NOT_ACCESSIBLE",
    CLASS_READ_FAILED: "CLASS_READ_FAILED",
  },
}));

// PHASE 6.2 — Attendance READ mock. The teacher class detail
// page now calls this server-only read primitive. The mock
// returns a SAFE default (`{ state: "none", session: null }`)
// so the regression closure test renders a tree whose
// Attendance panel does not advertise fake analytics. Tests
// that exercise a specific attendance behavior override
// this mock locally.
const mockGetAttendanceSessionStatusForCurrentTeacher = vi.fn();

vi.mock(
  "@/lib/attendance/attendance-session-status-read-service",
  () => ({
    getAttendanceSessionStatusForCurrentTeacher: (
      ...args: unknown[]
    ) => mockGetAttendanceSessionStatusForCurrentTeacher(...args),
    ATTENDANCE_SESSION_STATUS_READ_ERROR_CODES: {
      UNAUTHENTICATED: "UNAUTHENTICATED",
      PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
      TEACHER_REQUIRED: "TEACHER_REQUIRED",
      CLASS_NOT_ACCESSIBLE: "CLASS_NOT_ACCESSIBLE",
      ATTENDANCE_READ_FAILED: "ATTENDANCE_READ_FAILED",
    },
  }),
);

// =============================================================================
// Shared mocks — Server Action calls
// =============================================================================

const mockCreateClassAction = vi.fn();

vi.mock("@/lib/classes/create-class-action", () => ({
  createClassAction: (...args: unknown[]) => mockCreateClassAction(...args),
  CREATE_CLASS_ACTION_ERROR_CODES: {
    UNAUTHENTICATED: "UNAUTHENTICATED",
    PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
    TEACHER_REQUIRED: "TEACHER_REQUIRED",
    INVALID_CLASS_NAME: "INVALID_CLASS_NAME",
    INVALID_CLASS_PASSWORD: "INVALID_CLASS_PASSWORD",
    CLASS_CODE_GENERATION_FAILED: "CLASS_CODE_GENERATION_FAILED",
    CLASS_CREATION_FAILED: "CLASS_CREATION_FAILED",
  },
}));

const mockCreateJoinClassAction = vi.fn();

vi.mock("@/lib/classes/join-class-action", () => ({
  createJoinClassAction: (...args: unknown[]) =>
    mockCreateJoinClassAction(...args),
  JOIN_CLASS_ACTION_ERROR_CODES: {
    UNAUTHENTICATED: "UNAUTHENTICATED",
    PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
    STUDENT_REQUIRED: "STUDENT_REQUIRED",
    INVALID_CLASS_CODE: "INVALID_CLASS_CODE",
    INVALID_CLASS_PASSWORD: "INVALID_CLASS_PASSWORD",
    INVALID_CLASS_CREDENTIALS: "INVALID_CLASS_CREDENTIALS",
    CLASS_JOIN_FAILED: "CLASS_JOIN_FAILED",
  },
}));

// =============================================================================
// Shared mocks — navigation
// =============================================================================

const mockGetClassDetailForCurrentUser = vi.fn();
const mockGetClassRosterForCurrentTeacher = vi.fn();
const mockNotFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const mockRedirect = vi.fn((href: string) => {
  throw new Error(`NEXT_REDIRECT:${href}`);
});

vi.mock("next/navigation", () => ({
  redirect: (href: string) => mockRedirect(href),
  notFound: () => mockNotFound(),
  useRouter: () => ({
    refresh: () => undefined,
  }),
}));

// =============================================================================
// Imports under test
// =============================================================================

import ClassesPage from "@/app/classes/page";
import ClassDetailPage from "@/app/classes/[classId]/page";
import { CreateClassForm } from "@/components/classes/create-class-form";
import { JoinClassForm } from "@/components/classes/join-class-form";

// =============================================================================
// Test fixtures
// =============================================================================

interface ProfileFixture {
  userId: string;
  emailSnapshot: string;
  role: "teacher" | "student";
  fullName: string;
  identificationCode: string;
  onboardingCompleted: boolean;
}

function makeProfile(
  overrides: Partial<ProfileFixture> = {},
): ProfileFixture {
  return {
    userId: "USER-1",
    emailSnapshot: "u@example.com",
    role: "teacher",
    fullName: "Test User",
    identificationCode: "U-001",
    onboardingCompleted: true,
    ...overrides,
  };
}

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

interface ClassFixture {
  id: string;
  name: string;
  classCode: string;
  status: "active" | "archived";
  createdAt: string;
}

function makeClass(
  overrides: Partial<ClassFixture> = {},
): ClassFixture {
  return {
    id: "650000000000000000000099",
    name: "Intro to CS",
    classCode: "ABCDEFG",
    status: "active",
    createdAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

interface ClassDetailFixture extends ClassFixture {
  updatedAt: string;
}

function makeClassDetail(
  overrides: Partial<ClassDetailFixture> = {},
): ClassDetailFixture {
  return {
    id: "650000000000000000000099",
    name: "Intro to CS",
    classCode: "ABCDEFG",
    status: "active",
    createdAt: "2026-01-01T10:00:00.000Z",
    updatedAt: "2026-01-15T10:00:00.000Z",
    ...overrides,
  };
}

interface RosterItemFixture {
  fullName: string;
  identificationCode: string;
  joinedAt: string;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function makeRosterItem(
  overrides: Partial<RosterItemFixture> = {},
): RosterItemFixture {
  return {
    fullName: "Alice Adams",
    identificationCode: "S-001",
    joinedAt: "2026-01-01T10:00:00.000Z",
    ...overrides,
  };
}

function makeCreateSuccess() {
  return {
    ok: true as const,
    class: {
      id: "65f0000000000000000000a1",
      name: "Intro to CS",
      classCode: "ABC2XYZ",
      status: "active" as const,
      createdAt: "2026-09-15T10:00:00.000Z",
    },
  };
}

function makeJoinSuccess(alreadyJoined = false) {
  return {
    ok: true as const,
    membership: {
      id: "65f0000000000000000000ff",
      classId: "65f000000000000000000abc",
      classCode: "ABCDEFG",
      joinedAt: "2026-09-15T12:00:00.000Z",
      status: "active" as const,
    },
    alreadyJoined,
  };
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// =============================================================================
// Setup / teardown
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  // Default safe roster result so teacher-path tests do not need
  // to set this explicitly unless they want a specific roster.
  mockGetClassRosterForCurrentTeacher.mockResolvedValue({
    ok: true,
    result: {
      class: makeClassDetail(),
      students: [],
    },
  });
  // PHASE 6.2 — Default safe attendance status result so the
  // teacher class detail page renders a calm panel.
  mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue({
    ok: true,
    result: { state: "none", session: null },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// TEACHER FLOW — items 1..10
// =============================================================================

describe("PHASE 5.1E4C teacher flow — items 1..10", () => {
  // The same render outputs are computed once per case via local
  // helper functions. Each test below asserts exactly one item.

  async function renderTeacherList() {
    mockGetSession.mockResolvedValue(makeSession("TEACHER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [
          makeClass({
            id: "650000000000000000000099",
            name: "Algebra 101",
          }),
        ],
      },
    });
    return renderToStaticMarkup(await ClassesPage());
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function renderTeacherListEmpty() {
    mockGetSession.mockResolvedValue(makeSession("TEACHER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", classes: [] },
    });
    return renderToStaticMarkup(await ClassesPage());
  }

  async function renderTeacherDetail(
    status: "active" | "archived" = "active",
  ) {
    mockGetSession.mockResolvedValue(makeSession("TEACHER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail({ status }),
      },
    });
    return renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({
          classId: "650000000000000000000099",
        }),
      }),
    );
  }

  it("1. teacher /classes shows Create class", async () => {
    const tree = await renderTeacherList();
    expect(tree).toMatch(/create\s*class/i);
    expect(tree).toContain('href="/classes/new"');
    expect(tree).toContain('data-component="create-class-cta"');
  });

  it("2. teacher /classes hides Join class", async () => {
    const tree = await renderTeacherList();
    expect(tree).not.toMatch(/join\s*class/i);
    expect(tree).not.toContain('href="/classes/join"');
    expect(tree).not.toContain('data-component="join-class-cta"');
  });

  it("3. teacher creates class successfully", async () => {
    mockCreateClassAction.mockResolvedValue(makeCreateSuccess());
    const { container } = render(<CreateClassForm />);
    fireEvent.change(container.querySelector('input[name="name"]')!, {
      target: { value: "Intro to CS" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassP@ssw0rd-2026" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /create class/i }),
      );
    });
    await waitFor(() => {
      expect(mockCreateClassAction).toHaveBeenCalledTimes(1);
    });
  });

  it("4. success shows classCode", async () => {
    mockCreateClassAction.mockResolvedValue(makeCreateSuccess());
    const { container } = render(<CreateClassForm />);
    fireEvent.change(container.querySelector('input[name="name"]')!, {
      target: { value: "Intro to CS" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassP@ssw0rd-2026" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /create class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("ABC2XYZ")).toBeTruthy();
    });
  });

  it("5. success View class uses /classes/<id>", async () => {
    mockCreateClassAction.mockResolvedValue(makeCreateSuccess());
    const { container } = render(<CreateClassForm />);
    fireEvent.change(container.querySelector('input[name="name"]')!, {
      target: { value: "Intro to CS" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassP@ssw0rd-2026" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /create class/i }),
      );
    });
    await waitFor(() => {
      const viewLink = screen.getByRole("link", {
        name: /view class/i,
      });
      expect(viewLink.getAttribute("href")).toBe(
        "/classes/65f0000000000000000000a1",
      );
    });
  });

  it("6. teacher detail renders class summary", async () => {
    const tree = await renderTeacherDetail();
    expect(tree).toContain("Intro to CS");
    expect(tree).toContain("ABCDEFG");
    expect(tree).toContain("Active");
    expect(tree).toContain("Jan 1, 2026"); // createdAt
    expect(tree).toContain("Jan 15, 2026"); // updatedAt
  });

  it("7. teacher detail renders Students roster", async () => {
    const tree = await renderTeacherDetail();
    expect(tree).toMatch(/Students<\/h2/);
  });

  it("8. empty roster state works", async () => {
    // The beforeEach default returns an empty roster. The
    // teacher detail page MUST render the empty copy.
    const tree = await renderTeacherDetail();
    expect(tree).toContain("No students have joined this class yet");
  });

  it("9. archived teacher class still opens", async () => {
    const tree = await renderTeacherDetail("archived");
    expect(tree).toContain("Archive" + "d");
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("10. teacher detail has Back to classes", async () => {
    const tree = await renderTeacherDetail();
    expect(tree.toLowerCase()).toMatch(/back to classes/);
    expect(tree).toMatch(/href="\/classes"/);
    // Back link carries no class data in the URL.
    expect(tree).not.toMatch(/href="\/classes\?/);
    // The back link should point to /classes (not /classes/<id>).
    // We verify by looking for the exact pattern.
    expect(tree).toMatch(/href="\/classes"\s*>/);
  });
});

// =============================================================================
// STUDENT FLOW — items 11..20
// =============================================================================

describe("PHASE 5.1E4C student flow — items 11..20", () => {
  async function renderStudentList() {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "student",
        classes: [
          makeClass({
            id: "650000000000000000000077",
            name: "Algebra 101",
          }),
        ],
      },
    });
    return renderToStaticMarkup(await ClassesPage());
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async function renderStudentListEmpty() {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "student", classes: [] },
    });
    return renderToStaticMarkup(await ClassesPage());
  }

  async function renderStudentDetail(
    status: "active" | "archived" = "active",
  ) {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "student",
        class: makeClassDetail({
          id: "650000000000000000000077",
          name: "Algebra 101",
          status,
        }),
      },
    });
    return renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({
          classId: "650000000000000000000077",
        }),
      }),
    );
  }

  it("11. student /classes shows Join class", async () => {
    const tree = await renderStudentList();
    expect(tree).toMatch(/join\s*class/i);
    expect(tree).toContain('href="/classes/join"');
    expect(tree).toContain('data-component="join-class-cta"');
  });

  it("12. student /classes hides Create class", async () => {
    const tree = await renderStudentList();
    expect(tree).not.toMatch(/create\s*class/i);
    expect(tree).not.toContain('href="/classes/new"');
    expect(tree).not.toContain('data-component="create-class-cta"');
  });

  it("13. student joins successfully", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeJoinSuccess(false));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(
      container.querySelector('input[name="classCode"]')!,
      { target: { value: "ABCDEFG" } },
    );
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(mockCreateJoinClassAction).toHaveBeenCalledTimes(1);
    });
  });

  it("14. first join View class works", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeJoinSuccess(false));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(
      container.querySelector('input[name="classCode"]')!,
      { target: { value: "ABCDEFG" } },
    );
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      const viewLink = screen.getByRole("link", {
        name: /view class/i,
      });
      expect(viewLink.getAttribute("href")).toBe(
        "/classes/65f000000000000000000abc",
      );
    });
  });

  it("15. alreadyJoined View class works", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeJoinSuccess(true));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(
      container.querySelector('input[name="classCode"]')!,
      { target: { value: "ABCDEFG" } },
    );
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText(/already joined/i)).toBeTruthy();
    });
    const viewLink = screen.getByRole("link", {
      name: /view class/i,
    });
    expect(viewLink.getAttribute("href")).toBe(
      "/classes/65f000000000000000000abc",
    );
  });

  it("16. student detail renders class summary", async () => {
    const tree = await renderStudentDetail();
    expect(tree).toContain("Algebra 101");
    expect(tree).toContain("ABCDEFG");
    expect(tree).toContain("Active");
    expect(tree).toContain("Jan 1, 2026"); // createdAt
    expect(tree).toContain("Jan 15, 2026"); // updatedAt
  });

  it("17. student detail never invokes roster read", async () => {
    mockGetClassRosterForCurrentTeacher.mockImplementation(() => {
      throw new Error("ROSTER_SHOULD_NOT_BE_CALLED");
    });
    await renderStudentDetail();
    expect(mockGetClassRosterForCurrentTeacher).not.toHaveBeenCalled();
  });

  it("18. student detail shows no Students section", async () => {
    const tree = await renderStudentDetail();
    expect(tree).not.toMatch(/Students<\/h2/);
  });

  it("19. archived joined class still opens", async () => {
    const tree = await renderStudentDetail("archived");
    expect(tree).toContain("Archive" + "d");
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("20. student detail has Back to classes", async () => {
    const tree = await renderStudentDetail();
    expect(tree.toLowerCase()).toMatch(/back to classes/);
    expect(tree).toMatch(/href="\/classes"/);
  });
});

// =============================================================================
// SECURITY / PRIVACY — items 21..30 (cross-cutting runtime assertions)
// =============================================================================

describe("PHASE 5.1E4C security / privacy — items 21..30", () => {
  // Each forbidden value MUST NEVER appear in the rendered browser
  // output of any Class surface. The assertions below scan the
  // final trees produced by the four routes + the three client
  // components (the latter via the post-success DOM).

  async function teacherListTree(): Promise<string> {
    mockGetSession.mockResolvedValue(makeSession("TEACHER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass({ id: "650000000000000000000099" })],
      },
    });
    return renderToStaticMarkup(await ClassesPage());
  }

  async function studentListTree(): Promise<string> {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "student",
        classes: [makeClass({ id: "650000000000000000000077" })],
      },
    });
    return renderToStaticMarkup(await ClassesPage());
  }

  async function teacherDetailTree(): Promise<string> {
    mockGetSession.mockResolvedValue(makeSession("TEACHER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    return renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({
          classId: "650000000000000000000099",
        }),
      }),
    );
  }

  async function studentDetailTree(): Promise<string> {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "student",
        class: makeClassDetail({
          id: "650000000000000000000077",
        }),
      },
    });
    return renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({
          classId: "650000000000000000000077",
        }),
      }),
    );
  }

  async function createSuccessTree(): Promise<string> {
    mockCreateClassAction.mockResolvedValue(makeCreateSuccess());
    const { container } = render(<CreateClassForm />);
    fireEvent.change(container.querySelector('input[name="name"]')!, {
      target: { value: "Intro to CS" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassP@ssw0rd-2026" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /create class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("ABC2XYZ")).toBeTruthy();
    });
    return container.innerHTML;
  }

  async function joinSuccessTree(
    alreadyJoined: boolean,
  ): Promise<string> {
    mockCreateJoinClassAction.mockResolvedValue(
      makeJoinSuccess(alreadyJoined),
    );
    const { container } = render(<JoinClassForm />);
    fireEvent.change(
      container.querySelector('input[name="classCode"]')!,
      { target: { value: "ABCDEFG" } },
    );
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    // Wait for the form to fully unmount and the success state
    // to be the only ABCDEFG in the DOM. We assert on the form
    // input being absent (form is hidden) and the success
    // heading + classCode being present.
    await waitFor(() => {
      expect(container.querySelector('input[name="classCode"]')).toBeNull();
    });
    return container.innerHTML;
  }

  // Runtime helpers — scan every tree the same way.
  function assertNo(tree: string, pattern: RegExp) {
    expect(tree).not.toMatch(pattern);
  }
  function assertNoString(tree: string, value: string) {
    expect(tree.toLowerCase()).not.toContain(value.toLowerCase());
  }

  // 21..30 — privacy invariants. Each is asserted across every
  //   Class UX surface.

  const surfaces = async () => ({
    teacherList: await teacherListTree(),
    studentList: await studentListTree(),
    teacherDetail: await teacherDetailTree(),
    studentDetail: await studentDetailTree(),
  });

  it("21. passwordHash never appears in any Class surface", async () => {
    const s = await surfaces();
    for (const tree of Object.values(s)) {
      assertNoString(tree, "passwordhash");
    }
  });

  it("22. teacherUserId never appears in any Class surface", async () => {
    const s = await surfaces();
    for (const tree of Object.values(s)) {
      assertNoString(tree, "teacheruserid");
    }
  });

  it("23. studentUserId never appears in any Class surface", async () => {
    const s = await surfaces();
    for (const tree of Object.values(s)) {
      assertNoString(tree, "studentuserid");
    }
  });

  it("24. membershipId never appears in any Class surface", async () => {
    const s = await surfaces();
    for (const tree of Object.values(s)) {
      assertNoString(tree, "membershipid");
      assertNoString(tree, "membership_id");
    }
  });

  it("25. emailSnapshot never appears in any Class surface", async () => {
    const s = await surfaces();
    for (const tree of Object.values(s)) {
      assertNoString(tree, "emailsnapshot");
    }
  });

  it("26. phone never appears in any Class surface", async () => {
    const s = await surfaces();
    for (const tree of Object.values(s)) {
      assertNoString(tree, "phone");
    }
  });

  it("27. FaceProfile never appears in any Class surface", async () => {
    const s = await surfaces();
    for (const tree of Object.values(s)) {
      assertNoString(tree, "faceprofile");
    }
  });

  it("28. embedding never appears in any Class surface", async () => {
    const s = await surfaces();
    for (const tree of Object.values(s)) {
      assertNoString(tree, "embedding");
    }
  });

  it("29. centroid never appears in any Class surface", async () => {
    const s = await surfaces();
    for (const tree of Object.values(s)) {
      assertNoString(tree, "centroid");
    }
  });

  it("30. raw Mongo errors never appear in any Class surface", async () => {
    // Force a CLASS_READ_FAILED state and verify the calm copy
    // does NOT echo raw driver-internal strings.
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: false,
      code: "CLASS_READ_FAILED",
      message:
        "E11000 duplicate key error on mongodb://internal:27017/face_attendance.classes",
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).not.toMatch(/E11000/);
    expect(tree).not.toMatch(/mongodb:\/\//);
    expect(tree).not.toMatch(/duplicate key/);
    expect(tree).not.toMatch(/face_attendance/);
    expect(tree).not.toMatch(/stack/i);

    // And the same invariant on the detail page.
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: false,
      code: "CLASS_READ_FAILED",
      message:
        "E11000 duplicate key error on mongodb://internal:27017/face_attendance.classes",
    });
    const detailTree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({
          classId: "650000000000000000000099",
        }),
      }),
    );
    expect(detailTree).not.toMatch(/E11000/);
    expect(detailTree).not.toMatch(/mongodb:\/\//);
    expect(detailTree).not.toMatch(/duplicate key/);
    expect(detailTree).not.toMatch(/face_attendance/);

    // And the same invariant on the create-class failure form.
    mockCreateClassAction.mockResolvedValue({
      ok: false,
      code: "CLASS_CREATION_FAILED",
      retryable: true,
      message:
        "E11000 duplicate key error on mongodb://internal:27017/face_attendance.classes",
    });
    const { container } = render(<CreateClassForm />);
    fireEvent.change(container.querySelector('input[name="name"]')!, {
      target: { value: "Intro to CS" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassP@ssw0rd-2026" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /create class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(container.innerHTML).not.toContain("E11000");
    expect(container.innerHTML).not.toContain("mongodb://");
    expect(container.innerHTML).not.toContain("duplicate key");
    expect(container.innerHTML).not.toContain("face_attendance");
  });

  it("21b. privacy invariants hold in success-state Class UIs", async () => {
    const createTree = await createSuccessTree();
    const joinTree = await joinSuccessTree(false);
    const joinAlreadyTree = await joinSuccessTree(true);

    for (const tree of [createTree, joinTree, joinAlreadyTree]) {
      assertNoString(tree, "passwordhash");
      assertNoString(tree, "teacheruserid");
      assertNoString(tree, "studentuserid");
      assertNoString(tree, "membershipid");
      assertNoString(tree, "emailsnapshot");
      assertNoString(tree, "phone");
      assertNoString(tree, "faceprofile");
      assertNoString(tree, "embedding");
      assertNoString(tree, "centroid");
      assertNo(tree, /E11000/);
      assertNo(tree, /mongodb:\/\//);
      assertNo(tree, /duplicate key/i);
      assertNo(tree, /face_attendance/);
    }
  });
});

// =============================================================================
// DOMAIN ISOLATION — items 31..36
// =============================================================================

describe("PHASE 5.1E4C domain isolation — items 31..36", () => {
  // Items 31..36 are enforced by source-wide assertions. We do
  // NOT depend on brittle string assertions where a focused
  // symbol assertion is sufficient.

  function loadSource(relativeFromAppsWeb: string): string {
    return readFileSync(
      resolve(
        process.cwd(),
        "src",
        ...relativeFromAppsWeb.split("/"),
      ),
      "utf-8",
    );
  }

  function codeOnly(source: string): string {
    return stripComments(source);
  }

  it("31. no Class UI module calls the Face Service", () => {
    const files = [
      "app/classes/page.tsx",
      "app/classes/new/page.tsx",
      "app/classes/join/page.tsx",
      "app/classes/[classId]/page.tsx",
      "components/classes/create-class-form.tsx",
      "components/classes/join-class-form.tsx",
      "components/classes/roster-panel.tsx",
    ];
    for (const f of files) {
      const body = codeOnly(loadSource(f));
      expect(body, `${f} references Face Service`).not.toMatch(
        /face-service-client/,
      );
      expect(body).not.toMatch(/FaceServiceClient/);
      expect(body).not.toMatch(/finalizeFaceEnrollment/);
      expect(body).not.toMatch(/analyzeEnrollmentSample/);
    }
  });

  it("32. no Class UI module queries FaceProfile", () => {
    const files = [
      "app/classes/page.tsx",
      "app/classes/new/page.tsx",
      "app/classes/join/page.tsx",
      "app/classes/[classId]/page.tsx",
      "components/classes/create-class-form.tsx",
      "components/classes/join-class-form.tsx",
      "components/classes/roster-panel.tsx",
    ];
    for (const f of files) {
      const body = codeOnly(loadSource(f));
      expect(body, `${f} touches FaceProfile`).not.toMatch(/FaceProfile/);
      expect(body).not.toMatch(/face-profile-service/);
      expect(body).not.toMatch(/face-id-status-service/);
    }
  });

  it("33. no Class UI module creates attendance data (read-only attendance is now allowed)", () => {
    // PHASE 6.2 introduces the Attendance READ on the teacher
    // viewer path. The page calls
    // `getAttendanceSessionStatusForCurrentTeacher(...)`, a
    // server-only read primitive. The page itself MUST NOT
    // create / mutate attendance data, and the read MUST be
    // delegated to the dedicated read service. This test
    // asserts:
    //   - the dedicated attendance-panel / control-button /
    //     read-service modules exist outside the listed
    //     "core Class UI" files;
    //   - the listed Class UI files do NOT call any
    //     start / stop / mutation action directly;
    //   - the listed Class UI files do NOT touch the
    //     attendance_models / attendance_records persistence.
    const files = [
      "app/classes/page.tsx",
      "app/classes/new/page.tsx",
      "app/classes/join/page.tsx",
      "app/classes/[classId]/page.tsx",
      "components/classes/create-class-form.tsx",
      "components/classes/join-class-form.tsx",
      "components/classes/roster-panel.tsx",
    ];
    for (const f of files) {
      const body = codeOnly(loadSource(f));
      // No mutation / create / start / stop attendance
      // operation must be invoked directly from a Class UI
      // module.
      expect(body, `${f} imports startAttendanceSessionAction`).not.toMatch(
        /startAttendanceSessionAction/,
      );
      expect(body, `${f} imports stopAttendanceSessionAction`).not.toMatch(
        /stopAttendanceSessionAction/,
      );
      expect(body, `${f} imports createAttendanceSession`).not.toMatch(
        /createAttendanceSession/,
      );
      expect(body, `${f} imports closeActiveAttendanceSessionForClass`).not.toMatch(
        /closeActiveAttendanceSessionForClass/,
      );
      expect(body, `${f} imports AttendanceSessionModel`).not.toMatch(
        /AttendanceSessionModel/,
      );
      expect(body, `${f} writes attendance_records`).not.toMatch(
        /attendance_records/,
      );
    }
  });

  it("34. no Class UI module displays attendance state (read-only projection is now allowed)", () => {
    // The roster panel must NOT advertise attendance marks.
    // Attendance copy such as "Present / Absent / Late /
    // Recognition" must not surface as visible UI text. The
    // dedicated AttendancePanel module is the ONLY allowed
    // surface for the Attendance lifecycle copy. The
    // dedicated roster panel still MUST NOT display
    // attendance marks.
    //
    // NOTE: the RosterPanelState union uses the string
    // discriminator "absent" to mean "render nothing" — this
    // is a UI sentinel, NOT attendance copy. We therefore
    // assert on the user-visible copy ("Present" / "Absent"
    // as labels, "Late", "Recognition", "Camera") instead.
    const rosterFiles = [
      "components/classes/roster-panel.tsx",
    ];
    for (const f of rosterFiles) {
      const body = codeOnly(loadSource(f)).toLowerCase();
      expect(body, `${f} references present`).not.toMatch(/\bpresent\b/);
      expect(body).not.toMatch(/\blate\b/);
      expect(body).not.toContain("recognition");
      expect(body).not.toContain("camera");
      expect(body).not.toContain("attendance");
    }
    // The class detail page MAY mention "attendance" because
    // it hosts the AttendancePanel; the assertion below
    // checks that the page itself does NOT render explicit
    // attendance marks.
    const detailBody = codeOnly(
      loadSource("app/classes/[classId]/page.tsx"),
    ).toLowerCase();
    expect(detailBody).not.toMatch(/present\s*:/);
    expect(detailBody).not.toMatch(/\blate\b/);
    expect(detailBody).not.toContain("recognition");
    expect(detailBody).not.toContain("camera");
    expect(detailBody).not.toContain("confidence");
  });

  it("35. no Class UI module calls class password verification", () => {
    // The verification primitive lives in
    // apps/web/src/lib/classes/class-password.ts. None of the
    // UI files should import it.
    const files = [
      "app/classes/page.tsx",
      "app/classes/new/page.tsx",
      "app/classes/join/page.tsx",
      "app/classes/[classId]/page.tsx",
      "components/classes/create-class-form.tsx",
      "components/classes/join-class-form.tsx",
      "components/classes/roster-panel.tsx",
    ];
    for (const f of files) {
      const body = codeOnly(loadSource(f));
      expect(body, `${f} imports verifyClassPassword`).not.toMatch(
        /verifyClassPassword/,
      );
      expect(body).not.toMatch(/hashClassPassword/);
      expect(body).not.toMatch(/class-password/);
    }
  });

  it("36. no Class UI module introduces a public REST route", () => {
    // No `/api/classes` route is created by the Class UI. The
    // route directory MUST NOT exist.
    const apiClassesPath = resolve(
      process.cwd(),
      "src",
      "app",
      "api",
      "classes",
    );
    expect(
      existsSync(apiClassesPath),
      "Public Class REST directory was introduced",
    ).toBe(false);

    const files = [
      "app/classes/page.tsx",
      "app/classes/new/page.tsx",
      "app/classes/join/page.tsx",
      "app/classes/[classId]/page.tsx",
      "components/classes/create-class-form.tsx",
      "components/classes/join-class-form.tsx",
      "components/classes/roster-panel.tsx",
    ];
    for (const f of files) {
      const body = codeOnly(loadSource(f));
      expect(body, `${f} references /api/classes`).not.toMatch(
        /\/api\/classes/,
      );
      expect(body).not.toMatch(/route\.ts/);
      expect(body).not.toMatch(/\/api\/classes\/\[classId\]/);
      expect(body).not.toMatch(/\/api\/classes\/join/);
      expect(body).not.toMatch(/\/api\/classes\/.+\/roster/);
    }
  });
});

// =============================================================================
// ROUTE REGRESSION — items 31..36 mirrored as route-surfacing checks
// =============================================================================

describe("PHASE 5.1E4C route regression", () => {
  // The four Class routes MUST exist. No additional Class route
  // was introduced in E4C.

  function routeExists(relative: string) {
    return existsSync(
      resolve(process.cwd(), "src", "app", ...relative.split("/")),
    );
  }

  it("/classes route still exists", () => {
    expect(routeExists("classes/page.tsx")).toBe(true);
  });

  it("/classes/new route still exists", () => {
    expect(routeExists("classes/new/page.tsx")).toBe(true);
  });

  it("/classes/join route still exists", () => {
    expect(routeExists("classes/join/page.tsx")).toBe(true);
  });

  it("/classes/[classId] route still exists", () => {
    expect(routeExists("classes/[classId]/page.tsx")).toBe(true);
  });

  it("no new public Class REST route introduced", () => {
    expect(routeExists("api/classes")).toBe(false);
    expect(routeExists("api/classes/join")).toBe(false);
    expect(routeExists("api/classes/[classId]")).toBe(false);
    expect(routeExists("api/classes/[classId]/students")).toBe(false);
  });

  it("Vitest canonical config keeps forks + isolate", () => {
    const cfg = readFileSync(
      resolve(process.cwd(), "vitest.config.ts"),
      "utf-8",
    );
    expect(cfg).toMatch(/pool:\s*["']forks["']/);
    expect(cfg).toMatch(/isolate:\s*true/);
  });
});
