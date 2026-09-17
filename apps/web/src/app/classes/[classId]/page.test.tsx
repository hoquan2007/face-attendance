/**
 * Tests for `/classes/[classId]` — PHASE 5.1E4A authorized class
 * detail page.
 *
 * Server Component tests render the page module to a JSX tree
 * with `renderToStaticMarkup` so the assertions cover both the
 * rendered HTML and the call-shape invariants.
 *
 * The tests mock:
 *   - `next/navigation` redirect / notFound
 *   - `@/lib/session` getSession
 *   - `@/lib/profile-service` getProfileByUserId
 *   - `@/lib/classes/class-read-service` getClassDetailForCurrentUser
 *
 * No Mongoose / Mongo / Face Service is touched.
 *
 * The contract covers:
 *   - 1..6   — server page contract (D2A reuse, no direct models,
 *              no client fetch, no browser userId/role)
 *   - 7..12  — auth / profile gating
 *   - 13..18 — generic inaccessible boundary (malformed /
 *              missing / unauthorized)
 *   - 19..24 — safe detail UI (class name, code, status, dates,
 *              back link)
 *   - 25..27 — archived authorized access
 *   - 28..34 — privacy (no password, ids, biometric data)
 *   - 35..38 — no roster / no attendance / no Face Service / no
 *              mutation
 *   - 39..42 — no public API / no client state
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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Mocks
// =============================================================================

const mockGetSession = vi.fn();
const mockGetProfileByUserId = vi.fn();
const mockGetClassDetailForCurrentUser = vi.fn();
const mockGetClassRosterForCurrentTeacher = vi.fn();
const mockGetAttendanceSessionStatusForCurrentTeacher = vi.fn();
// `notFound()` throws to halt the route segment — mirror the
// existing redirect-mock pattern so tests can observe the call.
const mockNotFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
const mockRedirect = vi.fn((href: string) => {
  throw new Error(`NEXT_REDIRECT:${href}`);
});

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
  getClassDetailForCurrentUser: (...args: unknown[]) =>
    mockGetClassDetailForCurrentUser(...args),
  getClassRosterForCurrentTeacher: (...args: unknown[]) =>
    mockGetClassRosterForCurrentTeacher(...args),
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

vi.mock("next/navigation", () => ({
  redirect: (href: string) => mockRedirect(href),
  notFound: () => mockNotFound(),
  useRouter: () => ({
    refresh: () => undefined,
  }),
}));

import ClassDetailPage from "@/app/classes/[classId]/page";

// =============================================================================
// Helpers
// =============================================================================

interface ProfileFixture {
  userId: string;
  emailSnapshot: string;
  role: "teacher" | "student";
  fullName: string;
  identificationCode: string;
  onboardingCompleted: boolean;
}

function makeProfile(overrides: Partial<ProfileFixture> = {}): ProfileFixture {
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

interface ClassDetailFixture {
  id: string;
  name: string;
  classCode: string;
  status: "active" | "archived";
  createdAt: string;
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

// =============================================================================
// Setup / teardown
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  // Default safe roster result for tests that exercise the
  // teacher viewer path. Tests that assert specific roster
  // behavior override this mock locally. The student viewer
  // path does NOT call this function at all, so student-path
  // tests are unaffected even with this default.
  mockGetClassRosterForCurrentTeacher.mockResolvedValue({
    ok: true,
    result: { class: makeClassDetail(), students: [] },
  });
  // Default safe attendance status result for the teacher
  // viewer path. Tests that assert specific attendance
  // behavior override this mock locally. The student viewer
  // path does NOT call this function at all, so student-path
  // tests are unaffected even with this default.
  mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue({
    ok: true,
    result: { state: "none", session: null },
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// Strip JSDoc + line comments so static-source checks do not pick
// up matches from documentation.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// =============================================================================
// 7..12 — Server page contract
// =============================================================================

describe("/classes/[classId] page — server page contract", () => {
  it("7. dynamic detail page exists", () => {
    // The detail page module must be importable from the
    // dynamic route path; the route file lives at
    // `apps/web/src/app/classes/[classId]/page.tsx`.
    expect(ClassDetailPage).toBeDefined();
    expect(typeof ClassDetailPage).toBe("function");
  });

  it("8. page is server-rendered (no useEffect, no use client)", () => {
    const source = readFileSync(
      resolve(
        __dirname,
        "..",
        "..",
        "..",
        "app",
        "classes",
        "[classId]",
        "page.tsx",
      ),
      "utf-8",
    );
    const body = stripComments(source);
    expect(body).not.toMatch(/useEffect/);
    expect(body).not.toMatch(/"use client"/);
  });

  it("9. page calls getClassDetailForCurrentUser with route classId", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail({ id: "650000000000000000000099" }),
      },
    });
    await ClassDetailPage({
      params: Promise.resolve({ classId: "650000000000000000000099" }),
    });
    expect(mockGetClassDetailForCurrentUser).toHaveBeenCalledTimes(1);
    expect(mockGetClassDetailForCurrentUser).toHaveBeenCalledWith(
      "650000000000000000000099",
    );
  });

  it("10. page does not query ClassModel directly", () => {
    const source = readFileSync(
      resolve(
        __dirname,
        "..",
        "..",
        "..",
        "app",
        "classes",
        "[classId]",
        "page.tsx",
      ),
      "utf-8",
    );
    const body = stripComments(source);
    expect(body).not.toMatch(/class-model/);
    expect(body).not.toMatch(/ClassModel/);
  });

  it("11. page does not query MembershipModel directly", () => {
    const source = readFileSync(
      resolve(
        __dirname,
        "..",
        "..",
        "..",
        "app",
        "classes",
        "[classId]",
        "page.tsx",
      ),
      "utf-8",
    );
    const body = stripComments(source);
    expect(body).not.toMatch(/class-membership-model/);
    expect(body).not.toMatch(/ClassMembershipModel/);
  });

  it("12. page performs no client fetch", () => {
    const source = readFileSync(
      resolve(
        __dirname,
        "..",
        "..",
        "..",
        "app",
        "classes",
        "[classId]",
        "page.tsx",
      ),
      "utf-8",
    );
    const body = stripComments(source);
    expect(body).not.toMatch(/fetch\s*\(/);
    expect(body).not.toMatch(/\/api\/classes/);
    expect(body).not.toMatch(/react-query/);
    expect(body).not.toMatch(/useQuery/);
    expect(body).not.toMatch(/useSWR/);
  });
});

// =============================================================================
// 13..16 — Auth / profile gating
// =============================================================================

describe("/classes/[classId] page — auth / profile gating", () => {
  it("13. UNAUTHENTICATED follows existing auth behavior (redirect /login)", async () => {
    mockGetSession.mockResolvedValue(null);
    mockGetProfileByUserId.mockResolvedValue(null);
    mockGetClassDetailForCurrentUser.mockResolvedValue(null);
    await expect(
      ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(mockGetClassDetailForCurrentUser).not.toHaveBeenCalled();
  });

  it("14. PROFILE_INCOMPLETE follows onboarding behavior (redirect /onboarding)", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(null);
    mockGetClassDetailForCurrentUser.mockResolvedValue(null);
    await expect(
      ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    ).rejects.toThrow("NEXT_REDIRECT:/onboarding");
    expect(mockGetClassDetailForCurrentUser).not.toHaveBeenCalled();
  });

  it("15. page accepts no browser userId", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail(),
      },
    });
    // Defensive call with extra positional arguments must NOT
    // influence identity handling.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (ClassDetailPage as any)(
      { params: Promise.resolve({ classId: "650000000000000000000099" }) },
      "attacker-supplied-user-id",
    );
    const sessionCall = mockGetSession.mock.calls[0];
    expect(sessionCall).toBeDefined();
    // The session mock itself was NOT given any argument.
    expect(sessionCall?.length ?? 0).toBe(0);
  });

  it("16. page accepts no browser role", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail(),
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    // The page must NOT render any visible role select / input
    // that the browser could manipulate to change the viewer
    // role.
    expect(tree).not.toMatch(/<select\b/);
    expect(tree.toLowerCase()).not.toMatch(/name="role"/);
    // The page must NOT echo the browser-supplied classId; it
    // should use the route-supplied classId.
    expect(mockGetClassDetailForCurrentUser).toHaveBeenCalledWith(
      "650000000000000000000099",
    );
  });
});

// =============================================================================
// 17..22 — Generic inaccessible boundary
// =============================================================================

describe("/classes/[classId] page — generic inaccessible boundary", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
  });

  it("17. CLASS_NOT_ACCESSIBLE uses generic inaccessible/notFound behavior", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: false,
      code: "CLASS_NOT_ACCESSIBLE",
      message: "This class is not available.",
    });
    await expect(
      ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    ).rejects.toThrow();
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it("18. malformed id receives same UI behavior", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: false,
      code: "CLASS_NOT_ACCESSIBLE",
      message: "This class is not available.",
    });
    await expect(
      ClassDetailPage({
        params: Promise.resolve({ classId: "not-a-real-id" }),
      }),
    ).rejects.toThrow();
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it("19. missing class receives same UI behavior", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: false,
      code: "CLASS_NOT_ACCESSIBLE",
      message: "This class is not available.",
    });
    await expect(
      ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    ).rejects.toThrow();
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it("20. non-owner teacher receives same UI behavior", async () => {
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: false,
      code: "CLASS_NOT_ACCESSIBLE",
      message: "This class is not available.",
    });
    await expect(
      ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    ).rejects.toThrow();
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it("21. non-member student receives same UI behavior", async () => {
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: false,
      code: "CLASS_NOT_ACCESSIBLE",
      message: "This class is not available.",
    });
    await expect(
      ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    ).rejects.toThrow();
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });

  it("22. no failure-specific ownership/member copy leaks", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: false,
      code: "CLASS_NOT_ACCESSIBLE",
      message: "This class is not available.",
    });
    // The notFound() mock throws via the page's branch — no
    // tree is produced. We assert by source that no
    // distinguishable copy is rendered.
    const source = readFileSync(
      resolve(
        __dirname,
        "..",
        "..",
        "..",
        "app",
        "classes",
        "[classId]",
        "page.tsx",
      ),
      "utf-8",
    );
    const body = stripComments(source).toLowerCase();
    expect(body).not.toMatch(/class does not exist/);
    expect(body).not.toMatch(/you do not own this class/);
    expect(body).not.toMatch(/you are not a member/);
    expect(body).not.toMatch(/invalid class id/);
  });
});

// =============================================================================
// 23..29 — Safe detail UI
// =============================================================================

describe("/classes/[classId] page — safe detail UI", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
  });

  it("23. class name renders", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail({ name: "Discrete Math" }),
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain("Discrete Math");
  });

  it("24. classCode renders (monospace)", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail({ classCode: "WXYZ123" }),
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain("WXYZ123");
    // Monospace class is applied so the code is visually distinct.
    expect(tree.toLowerCase()).toMatch(/font-mono/);
  });

  it("25. active status renders", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail({ status: "active" }),
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain("Active");
  });

  it("26. archived status renders", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail({ status: "archived" }),
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain("Archived");
  });

  it("27. created date renders", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail({ createdAt: "2026-02-15T10:00:00.000Z" }),
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain("Feb 15, 2026");
  });

  it("28. updated date renders", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail({ updatedAt: "2026-03-20T10:00:00.000Z" }),
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain("Mar 20, 2026");
  });

  it("29. Back to classes link points to /classes", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail(),
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toMatch(/href="\/classes"/);
    expect(tree.toLowerCase()).toMatch(/back to classes/);
    // The back link carries no class data in the URL.
    // Note: /classes/<id>/attendance/history is the NEW history link, not the back link.
    expect(tree).not.toMatch(/href="\/classes\?/);
    // The back link should point to /classes (not /classes/650000000000000000000099).
    // We verify the back link specifically by checking for the "Back to classes" text link.
    // The history link is /classes/<id>/attendance/history (with /attendance/history suffix).
    expect(tree).toMatch(/href="\/classes"\s*>/); // Plain /classes link
  });
});

// =============================================================================
// 30..32 — Archived authorized access
// =============================================================================

describe("/classes/[classId] page — archived authorized access", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
  });

  it("30. authorized archived teacher detail renders", async () => {
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail({
          status: "archived",
          classCode: "ARCHIV1",
        }),
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain("Archived");
    expect(tree).toContain("ARCHIV1");
    // The page does NOT call notFound / redirect for archived
    // authorized classes.
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("31. authorized archived student detail renders", async () => {
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "student",
        class: makeClassDetail({
          status: "archived",
          classCode: "ARCHIV2",
        }),
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain("Archived");
    expect(tree).toContain("ARCHIV2");
    expect(mockNotFound).not.toHaveBeenCalled();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("32. archived detail is not treated as inaccessible merely due to status", () => {
    const source = readFileSync(
      resolve(
        __dirname,
        "..",
        "..",
        "..",
        "app",
        "classes",
        "[classId]",
        "page.tsx",
      ),
      "utf-8",
    );
    const body = stripComments(source).toLowerCase();
    // The page must NOT contain a status === "archived" branch
    // that collapses archived → notFound.
    expect(body).not.toMatch(/status\s*===\s*["']archived["']\s*\?\s*notfound/);
    expect(body).not.toMatch(/archived.*notfound/);
  });
});

// =============================================================================
// 33..40 — Privacy
// =============================================================================

describe("/classes/[classId] page — privacy", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
  });

  it("33. DOM contains no password", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).not.toMatch(/passwordHash/i);
    expect(tree).not.toMatch(/pbkdf2/i);
    expect(tree).not.toMatch(/"password"/);
  });

  it("34. DOM contains no passwordHash", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree.toLowerCase()).not.toContain("passwordhash");
  });

  it("35. DOM contains no teacherUserId", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).not.toContain("teacherUserId");
  });

  it("36. DOM contains no studentUserId", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "student", class: makeClassDetail() },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).not.toContain("studentUserId");
  });

  it("37. DOM contains no membershipId", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "student", class: makeClassDetail() },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree.toLowerCase()).not.toContain("membershipid");
    expect(tree.toLowerCase()).not.toContain("membership_id");
  });

  it("38. DOM contains no email", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).not.toContain("emailSnapshot");
    expect(tree).not.toContain("u@example.com");
  });

  it("39. DOM contains no phone", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree.toLowerCase()).not.toContain("phone");
  });

  it("40. DOM contains no biometric value", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree.toLowerCase()).not.toContain("embedding");
    expect(tree.toLowerCase()).not.toContain("centroid");
    expect(tree.toLowerCase()).not.toContain("faceprofile");
  });
});

// =============================================================================
// 41..45 — No roster, no attendance, no Face Service, no mutation
// =============================================================================

describe("/classes/[classId] page — domain isolation", () => {
  let sourceBody: string;
  beforeEach(() => {
    const source = readFileSync(
      resolve(
        __dirname,
        "..",
        "..",
        "..",
        "app",
        "classes",
        "[classId]",
        "page.tsx",
      ),
      "utf-8",
    );
    sourceBody = stripComments(source);
  });

  it("41. page does not call getClassRosterForCurrentTeacher on student viewer path", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "student", class: makeClassDetail() },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue({
      ok: true,
      result: {
        class: makeClassDetail(),
        students: [
          {
            fullName: "Should Not Appear",
            identificationCode: "SHOULDNOT",
            joinedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    });
    await ClassDetailPage({
      params: Promise.resolve({ classId: "650000000000000000000099" }),
    });
    expect(mockGetClassRosterForCurrentTeacher).not.toHaveBeenCalled();
  });

  it("41b. teacher viewer path calls getClassRosterForCurrentTeacher", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue({
      ok: true,
      result: {
        class: makeClassDetail(),
        students: [],
      },
    });
    await ClassDetailPage({
      params: Promise.resolve({ classId: "650000000000000000000099" }),
    });
    expect(mockGetClassRosterForCurrentTeacher).toHaveBeenCalledTimes(1);
    expect(mockGetClassRosterForCurrentTeacher).toHaveBeenCalledWith(
      "650000000000000000000099",
    );
  });

  it("42. page does not render Students section on student viewer path", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "student", class: makeClassDetail() },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue({
      ok: true,
      result: { class: makeClassDetail(), students: [] },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    // The "Students" heading appears ONLY on the teacher viewer
    // path. The student viewer path MUST NOT render it.
    expect(tree).not.toMatch(/Students<\/h2/);
  });

  it("43. no Members section", () => {
    expect(sourceBody.toLowerCase()).not.toMatch(/members/);
  });

  it("44. studentUserId is NEVER projected in source", () => {
    // The page may mention the field name in safe comments /
    // projections, but it MUST NOT build a roster row from
    // `studentUserId`. The field is identity-bearing and must
    // never be rendered into the DOM.
    expect(sourceBody.toLowerCase()).not.toContain("studentuserid");
  });

  it("45. teacherUserId is NEVER projected in source", () => {
    expect(sourceBody.toLowerCase()).not.toContain("teacheruserid");
  });

  it("46. no createClassAction", () => {
    expect(sourceBody).not.toMatch(/createClassAction/);
  });

  it("47. no createJoinClassAction", () => {
    expect(sourceBody).not.toMatch(/createJoinClassAction/);
  });

  it("48. no class password verification primitive", () => {
    expect(sourceBody).not.toMatch(/verifyClassPassword/);
    expect(sourceBody).not.toMatch(/hashClassPassword/);
  });

  it("49. no Face Service call", () => {
    expect(sourceBody).not.toMatch(/face-service-client/);
    expect(sourceBody).not.toMatch(/FaceServiceClient/);
    expect(sourceBody).not.toMatch(/finalizeFaceEnrollment/);
    expect(sourceBody).not.toMatch(/analyzeEnrollmentSample/);
  });

  it("50. no FaceProfile lookup", () => {
    expect(sourceBody).not.toMatch(/FaceProfile/);
    expect(sourceBody).not.toMatch(/face-profile-service/);
  });

  it("51. no attendance OPERATION (only the read-only attendance status read is allowed)", () => {
    // PHASE 6.2 introduces the Attendance READ on the teacher
    // viewer path — it is intentionally a server-only read
    // boundary. The page MUST NOT mutate / create / start /
    // stop attendance. The control surfaces live in the
    // dedicated `AttendanceControlButton` Client Component.
    expect(sourceBody.toLowerCase()).not.toMatch(/startattendance/);
    expect(sourceBody.toLowerCase()).not.toMatch(/stopattendance/);
    expect(sourceBody.toLowerCase()).not.toMatch(/attendance_records/);
    expect(sourceBody.toLowerCase()).not.toMatch(/attendance-marks/);
  });

  it("52. no class mutation", () => {
    expect(sourceBody).not.toMatch(/updateClass/);
    expect(sourceBody).not.toMatch(/deleteClass/);
    expect(sourceBody).not.toMatch(/archiveClass/);
  });

  it("53. no membership mutation", () => {
    expect(sourceBody).not.toMatch(/createMembership/);
    expect(sourceBody).not.toMatch(/updateMembership/);
    expect(sourceBody).not.toMatch(/deleteMembership/);
  });
});

// =============================================================================
// 54..57 — No public API / no client state
// =============================================================================

describe("/classes/[classId] page — no public API / no client state", () => {
  let sourceBody: string;
  beforeEach(() => {
    const source = readFileSync(
      resolve(
        __dirname,
        "..",
        "..",
        "..",
        "app",
        "classes",
        "[classId]",
        "page.tsx",
      ),
      "utf-8",
    );
    sourceBody = stripComments(source);
  });

  it("54. no class-detail REST route introduced", () => {
    expect(sourceBody).not.toMatch(/\/api\/classes\/\[/);
    expect(sourceBody).not.toMatch(/route\.ts/);
  });

  it("55. no localStorage", () => {
    expect(sourceBody).not.toMatch(/localStorage/);
  });

  it("56. no sessionStorage", () => {
    expect(sourceBody).not.toMatch(/sessionStorage/);
  });

  it("57. no client-side class cache", () => {
    expect(sourceBody).not.toMatch(/useQuery/);
    expect(sourceBody).not.toMatch(/useSWR/);
    expect(sourceBody).not.toMatch(/react-query/);
    expect(sourceBody).not.toMatch(/swr/);
  });
});

// =============================================================================
// 58..62 — Accessibility / structure
// =============================================================================

describe("/classes/[classId] page — accessibility / structure", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
  });

  it("58. page has an h1 (class name)", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail({ name: "Discrete Math" }),
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    const headingMatches = tree.match(/<h1[^>]*>/g) ?? [];
    expect(headingMatches.length).toBeGreaterThanOrEqual(1);
    expect(tree).toContain("Discrete Math");
  });

  it("59. detail uses semantic dl/dt/dd structure", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toMatch(/<dl\b/);
    expect(tree).toMatch(/<dt\b/);
    expect(tree).toMatch(/<dd\b/);
  });

  it("60. status badge has visible textual status", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail({ status: "archived" }),
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    // Status is conveyed by both visible text and color.
    expect(tree).toContain("Archived");
  });

  it("61. classCode uses select-all so it is readable/selectable", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail({ classCode: "SELECT1" }),
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toMatch(/select-all/);
    expect(tree).toContain("SELECT1");
  });

  it("62. CLASS_READ_FAILED renders a calm error block, no raw text", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: false,
      code: "CLASS_READ_FAILED",
      message: "Could not load the class. Please try again.",
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain("Could not load the class");
    expect(tree).not.toMatch(/ECONNREFUSED/);
    expect(tree).not.toMatch(/stack/i);
    expect(tree).not.toMatch(/mongo/i);
    expect(tree).not.toMatch(/E11000/);
  });
});

// =============================================================================
// 63..78 — PHASE 5.1E4B — TEACHER ROSTER UI
// =============================================================================

/**
 * PHASE 5.1E4B — teacher roster UI contract. The page calls
 * `getClassRosterForCurrentTeacher(classId)` only on the teacher
 * viewer path and renders a Students section using ONLY the safe
 * roster DTO fields. The student viewer path performs ZERO roster
 * lookups.
 *
 * The contract covers:
 *   - roster read invocation (teacher path only)
 *   - rendering fullName / identificationCode / joinedAt
 *   - empty roster state
 *   - archived teacher class still renders roster
 *   - student path performs no roster lookup
 *   - roster failure keeps class detail visible
 *   - privacy (no email / phone / user IDs / membership / Face /
 *     attendance in the rendered DOM)
 *   - no public roster REST API
 */

// Shared helpers for the E4B roster contract tests.
interface RosterItemFixture {
  fullName: string;
  identificationCode: string;
  joinedAt: string;
}

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

function makeRosterSuccess(students: RosterItemFixture[]) {
  return {
    ok: true as const,
    result: {
      class: makeClassDetail(),
      students,
    },
  };
}

function makeRosterFailure(
  code: string,
  message: string,
): {
  ok: false;
  code: string;
  message: string;
} {
  // The `message` field is preserved here so we can verify
  // it is NEVER surfaced in the rendered DOM by the page
  // (the panel renders a hardcoded safe copy regardless).
  return { ok: false, code, message };
}

describe("/classes/[classId] page — PHASE 5.1E4B teacher roster UI", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
  });

  it("63. teacher detail calls roster read with route classId", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue(
      makeRosterSuccess([]),
    );
    await ClassDetailPage({
      params: Promise.resolve({ classId: "650000000000000000000099" }),
    });
    expect(mockGetClassRosterForCurrentTeacher).toHaveBeenCalledTimes(1);
    expect(mockGetClassRosterForCurrentTeacher).toHaveBeenCalledWith(
      "650000000000000000000099",
    );
  });

  it("64. teacher roster renders fullName", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue(
      makeRosterSuccess([
        makeRosterItem({
          fullName: "Alice Adams",
          identificationCode: "S-001",
        }),
      ]),
    );
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain("Alice Adams");
  });

  it("65. teacher roster renders identificationCode", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue(
      makeRosterSuccess([
        makeRosterItem({
          fullName: "Alice Adams",
          identificationCode: "S-001ABC",
        }),
      ]),
    );
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain("S-001ABC");
  });

  it("66. teacher roster renders joinedAt as a formatted date", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue(
      makeRosterSuccess([
        makeRosterItem({
          joinedAt: "2026-02-15T10:00:00.000Z",
        }),
      ]),
    );
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain("Feb 15, 2026");
  });

  it("67. empty roster state renders the calm placeholder", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue(
      makeRosterSuccess([]),
    );
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain("No students have joined this class yet.");
  });

  it("67b. empty roster state never renders a fake count", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue(
      makeRosterSuccess([]),
    );
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    // No fake numeric count, no fake student rows.
    expect(tree).not.toMatch(/\b0 students\b/i);
    expect(tree).not.toMatch(/\b1 student\b/i);
  });

  it("68. archived teacher class still renders roster", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail({ status: "archived" }),
      },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue(
      makeRosterSuccess([
        makeRosterItem({
          fullName: "Alice Adams",
          identificationCode: "S-001",
        }),
      ]),
    );
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain("Archived");
    expect(tree).toContain("Alice Adams");
    // The roster read still runs on the archived teacher path.
    expect(mockGetClassRosterForCurrentTeacher).toHaveBeenCalledTimes(1);
  });

  it("69. student detail does NOT call roster read", async () => {
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "student", class: makeClassDetail() },
    });
    // The roster mock is configured to reject if called — but
    // it MUST NOT be called at all.
    mockGetClassRosterForCurrentTeacher.mockImplementation(() => {
      throw new Error("ROSTER_SHOULD_NOT_BE_CALLED");
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(mockGetClassRosterForCurrentTeacher).not.toHaveBeenCalled();
    // No "Students" heading on the student viewer path.
    expect(tree).not.toMatch(/Students<\/h2/);
  });

  it("70. student viewer path renders no roster identity fields", async () => {
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "student", class: makeClassDetail() },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue(
      makeRosterSuccess([
        makeRosterItem({
          fullName: "Should Not Appear",
          identificationCode: "SHOULDNOT",
        }),
      ]),
    );
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    // The page MUST NOT have rendered any roster identity
    // fields, because the roster read was never invoked.
    expect(tree).not.toContain("Should Not Appear");
    expect(tree).not.toContain("SHOULDNOT");
    expect(mockGetClassRosterForCurrentTeacher).not.toHaveBeenCalled();
  });

  it("71. roster read failure keeps class detail visible", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue(
      makeRosterFailure(
        "CLASS_READ_FAILED",
        "Could not load the roster. Please try again.",
      ),
    );
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    // The class detail card is still rendered.
    expect(tree).toContain("ABCDEFG");
    expect(tree).toContain("Back to classes");
    // The calm roster-local failure block is rendered.
    expect(tree).toContain("Student list could not be loaded.");
  });

  it("72. roster failure exposes no raw internal error", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    // Simulate a malformed driver-internal message arriving in
    // the message field. The page MUST NOT echo it.
    mockGetClassRosterForCurrentTeacher.mockResolvedValue(
      makeRosterFailure(
        "CLASS_READ_FAILED",
        "E11000 duplicate key on mongodb://internal:27017/face_attendance.class_memberships",
      ),
    );
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    // The panel renders a constant safe copy and the backend
    // message MUST NEVER leak into the DOM.
    expect(tree).not.toMatch(/E11000/);
    expect(tree).not.toMatch(/mongodb:\/\//);
    expect(tree).not.toMatch(/duplicate key/);
    expect(tree).not.toMatch(/face_attendance/);
    expect(tree).not.toMatch(/stack/i);
    // The calm safe copy IS rendered.
    expect(tree).toContain("Student list could not be loaded.");
  });

  it("73. roster DOM contains no email / emailSnapshot", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue(
      makeRosterSuccess([
        makeRosterItem({
          fullName: "Alice Adams",
          identificationCode: "S-001",
        }),
      ]),
    );
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).not.toContain("emailSnapshot");
    expect(tree).not.toContain("u@example.com");
    expect(tree).not.toContain("EMAIL_SNAPSHOT");
  });

  it("74. roster DOM contains no phone", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue(
      makeRosterSuccess([
        makeRosterItem({
          fullName: "Alice Adams",
          identificationCode: "S-001",
        }),
      ]),
    );
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree.toLowerCase()).not.toContain("phone");
  });

  it("75. roster DOM contains no user IDs", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue(
      makeRosterSuccess([
        makeRosterItem({
          fullName: "Alice Adams",
          identificationCode: "S-001",
        }),
      ]),
    );
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).not.toContain("studentUserId");
    expect(tree).not.toContain("teacherUserId");
    expect(tree.toLowerCase()).not.toContain("membershipid");
    expect(tree.toLowerCase()).not.toContain("membership_id");
  });

  it("76. roster DOM contains no biometric data", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue(
      makeRosterSuccess([
        makeRosterItem({
          fullName: "Alice Adams",
          identificationCode: "S-001",
        }),
      ]),
    );
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree.toLowerCase()).not.toContain("embedding");
    expect(tree.toLowerCase()).not.toContain("centroid");
    expect(tree.toLowerCase()).not.toContain("faceprofile");
  });

  it("77. roster DOM contains no attendance marker copy", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    mockGetClassRosterForCurrentTeacher.mockResolvedValue(
      makeRosterSuccess([
        makeRosterItem({
          fullName: "Alice Adams",
          identificationCode: "S-001",
        }),
      ]),
    );
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    // The roster panel must NOT advertise attendance marks.
    // Copy such as "Present: 5" / "Absent: 2" / "Late" /
    // "Confidence" must NOT leak — those do not exist in
    // this phase. The word "present" alone is too broad
    // (it appears in section copy); the assertion below
    // checks for the marker label shape instead.
    expect(tree).not.toMatch(/present\s*:/i);
    expect(tree).not.toMatch(/absent\s*:/i);
    expect(tree).not.toMatch(/\blate\b/i);
    expect(tree.toLowerCase()).not.toContain("recognition");
    expect(tree.toLowerCase()).not.toContain("camera");
    expect(tree.toLowerCase()).not.toContain("confidence");
  });

  it("78. no public roster REST route introduced", async () => {
    const source = readFileSync(
      resolve(
        __dirname,
        "..",
        "..",
        "..",
        "app",
        "classes",
        "[classId]",
        "page.tsx",
      ),
      "utf-8",
    );
    const body = stripComments(source);
    expect(body).not.toMatch(/\/api\/classes\/.+\/roster/);
    expect(body).not.toMatch(/\/api\/roster/);
    expect(body).not.toMatch(/route\.ts/);
  });

  it("78b. roster read preserves server-supplied joinedAt ASC ordering", async () => {
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", class: makeClassDetail() },
    });
    // Server returns joinedAt ASC: oldest first.
    mockGetClassRosterForCurrentTeacher.mockResolvedValue(
      makeRosterSuccess([
        makeRosterItem({
          fullName: "Oldest First",
          identificationCode: "OLD-001",
          joinedAt: "2026-01-01T10:00:00.000Z",
        }),
        makeRosterItem({
          fullName: "Middle Second",
          identificationCode: "MID-001",
          joinedAt: "2026-02-01T10:00:00.000Z",
        }),
        makeRosterItem({
          fullName: "Newest Third",
          identificationCode: "NEW-001",
          joinedAt: "2026-03-01T10:00:00.000Z",
        }),
      ]),
    );
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    // The page must NOT resort. Verify the server-supplied
    // order is preserved in the rendered output.
    const idxOldest = tree.indexOf("Oldest First");
    const idxMiddle = tree.indexOf("Middle Second");
    const idxNewest = tree.indexOf("Newest Third");
    expect(idxOldest).toBeGreaterThan(-1);
    expect(idxMiddle).toBeGreaterThan(idxOldest);
    expect(idxNewest).toBeGreaterThan(idxMiddle);
  });
});

// =============================================================================
// PHASE 6.2 — TEACHER ATTENDANCE CONTROL UI
// =============================================================================

describe("/classes/[classId] page — PHASE 6.2 teacher attendance status read", () => {
  it("A1. teacher viewer calls getAttendanceSessionStatusForCurrentTeacher with route classId", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail({ id: "650000000000000000000099" }),
      },
    });
    mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue({
      ok: true,
      result: { state: "none", session: null },
    });
    await ClassDetailPage({
      params: Promise.resolve({ classId: "650000000000000000000099" }),
    });
    expect(
      mockGetAttendanceSessionStatusForCurrentTeacher,
    ).toHaveBeenCalledTimes(1);
    expect(
      mockGetAttendanceSessionStatusForCurrentTeacher,
    ).toHaveBeenCalledWith("650000000000000000000099");
  });

  it("A2. student viewer NEVER calls getAttendanceSessionStatusForCurrentTeacher", async () => {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({
        role: "student",
        userId: "STUDENT-1",
      }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "student",
        class: makeClassDetail(),
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    // The student path performs ZERO attendance reads —
    // neither to call-then-hide nor to call-then-discard.
    expect(
      mockGetAttendanceSessionStatusForCurrentTeacher,
    ).not.toHaveBeenCalled();
    // The student detail DOM must NOT contain the Attendance
    // panel.
    expect(tree.toLowerCase()).not.toContain('data-component="attendance-panel"');
    expect(tree).not.toMatch(/start attendance/i);
    expect(tree).not.toMatch(/stop attendance/i);
  });

  it("A3. teacher detail renders the Attendance panel (NONE state)", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail(),
      },
    });
    mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue({
      ok: true,
      result: { state: "none", session: null },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain('data-component="attendance-panel"');
    expect(tree).toContain('data-attendance-state="none"');
    expect(tree).toMatch(/start attendance/i);
  });

  it("A4. teacher detail renders the Attendance panel (ACTIVE state)", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail(),
      },
    });
    mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue({
      ok: true,
      result: {
        state: "active",
        session: {
          id: "65f000000000000000000fff",
          status: "active",
          startedAt: "2026-09-16T10:00:00.000Z",
          endedAt: null,
          rosterCount: 4,
        },
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain('data-attendance-state="active"');
    expect(tree).toMatch(/stop attendance/i);
    // The rosterCount from the read is rendered verbatim.
    expect(tree).toContain('data-attendance-roster-count="4"');
  });

  it("A5. teacher detail renders the Attendance panel (CLOSED state)", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail(),
      },
    });
    mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue({
      ok: true,
      result: {
        state: "closed",
        session: {
          id: "65f000000000000000000fff",
          status: "closed",
          startedAt: "2026-09-16T10:00:00.000Z",
          endedAt: "2026-09-16T11:00:00.000Z",
          rosterCount: 9,
        },
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain('data-attendance-state="closed"');
    expect(tree).toMatch(/start new attendance/i);
    expect(tree).toContain('data-attendance-roster-count="9"');
  });

  it("A6. attendance read failure renders the safe failure block (no raw error)", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail(),
      },
    });
    mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue({
      ok: false,
      code: "ATTENDANCE_READ_FAILED",
      message:
        "MongoServerSelectionError: ECONNREFUSED 10.0.0.1:27017 stack-trace",
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    // The detail card is preserved; the attendance panel
    // surfaces a calm local safe failure block.
    expect(tree).toMatch(/attendance status could not be loaded/i);
    // The raw backend message MUST NOT leak into the DOM.
    expect(tree).not.toContain("ECONNREFUSED");
    expect(tree).not.toContain("10.0.0.1");
    expect(tree).not.toContain("27017");
    expect(tree).not.toContain("MongoServerSelectionError");
    expect(tree).not.toContain("stack-trace");
    // The Start / Stop buttons are NOT rendered when the
    // read fails — there is no session to interact with.
    expect(tree).not.toMatch(/<button[^>]*data-mode="start"/);
    expect(tree).not.toMatch(/<button[^>]*data-mode="stop"/);
  });

  it("A7. archived class renders the archived notice and NO Start button", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail({ status: "archived" }),
      },
    });
    mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue({
      ok: true,
      result: { state: "none", session: null },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).toContain('data-attendance-archived-notice="true"');
    expect(tree).toMatch(
      /attendance cannot be started for an archived class/i,
    );
    // No interactive Start button is rendered for archived
    // classes. The closed session metadata (when present) is
    // still rendered.
    expect(tree).not.toMatch(/<button[^>]*data-mode="start"/);
    expect(tree).not.toMatch(/<button[^>]*data-mode="stop"/);
  });

  it("A8. archived class with a historical closed session still renders the metadata", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail({ status: "archived" }),
      },
    });
    mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue({
      ok: true,
      result: {
        state: "closed",
        session: {
          id: "65f000000000000000000fff",
          status: "closed",
          startedAt: "2026-09-16T10:00:00.000Z",
          endedAt: "2026-09-16T11:00:00.000Z",
          rosterCount: 12,
        },
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    // The closed session metadata is still rendered.
    expect(tree).toContain('data-attendance-roster-count="12"');
    // The Start button is still NOT rendered for archived
    // classes.
    expect(tree).not.toMatch(/<button[^>]*data-mode="start"/);
  });

  it("A9. attendance panel NEVER renders rosterSnapshot / studentUserId / teacherUserId / startedByUserId", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail(),
      },
    });
    mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue({
      ok: true,
      result: {
        state: "active",
        session: {
          id: "65f000000000000000000fff",
          status: "active",
          startedAt: "2026-09-16T10:00:00.000Z",
          endedAt: null,
          rosterCount: 3,
        },
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).not.toContain("rosterSnapshot");
    expect(tree).not.toContain("fullNameSnapshot");
    expect(tree).not.toContain("identificationCodeSnapshot");
    expect(tree.toLowerCase()).not.toContain("studentuserid");
    expect(tree.toLowerCase()).not.toContain("teacheruserid");
    expect(tree.toLowerCase()).not.toContain("startedbyuserid");
  });

  it("A10. attendance panel NEVER renders FaceProfile / embedding / centroid / biometric", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail(),
      },
    });
    mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue({
      ok: true,
      result: {
        state: "active",
        session: {
          id: "65f000000000000000000fff",
          status: "active",
          startedAt: "2026-09-16T10:00:00.000Z",
          endedAt: null,
          rosterCount: 3,
        },
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).not.toContain("FaceProfile");
    expect(tree.toLowerCase()).not.toContain("embedding");
    expect(tree.toLowerCase()).not.toContain("centroid");
    expect(tree.toLowerCase()).not.toContain("biometric");
  });

  it("A11. attendance panel NEVER creates / displays attendance marks", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail(),
      },
    });
    mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue({
      ok: true,
      result: {
        state: "active",
        session: {
          id: "65f000000000000000000fff",
          status: "active",
          startedAt: "2026-09-16T10:00:00.000Z",
          endedAt: null,
          rosterCount: 3,
        },
      },
    });
    const tree = renderToStaticMarkup(
      await ClassDetailPage({
        params: Promise.resolve({ classId: "650000000000000000000099" }),
      }),
    );
    expect(tree).not.toMatch(/present\s*:/i);
    expect(tree).not.toMatch(/absent\s*:/i);
    expect(tree).not.toMatch(/\blate\b/i);
    expect(tree).not.toContain("recognizedAt");
    expect(tree).not.toContain("confidence");
  });

  it("A12. attendance panel NEVER introduces a /api/attendance REST route", async () => {
    const source = readFileSync(
      resolve(
        __dirname,
        "..",
        "..",
        "..",
        "app",
        "classes",
        "[classId]",
        "page.tsx",
      ),
      "utf-8",
    );
    const body = stripComments(source);
    expect(body).not.toMatch(/\/api\/attendance/);
    expect(body).not.toMatch(/NextResponse/);
    expect(body).not.toMatch(/route\.ts/);
  });

  it("A13. page calls getAttendanceSessionStatusForCurrentTeacher with classId ONLY", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetClassDetailForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        class: makeClassDetail(),
      },
    });
    mockGetAttendanceSessionStatusForCurrentTeacher.mockResolvedValue({
      ok: true,
      result: { state: "none", session: null },
    });
    await ClassDetailPage({
      params: Promise.resolve({ classId: "650000000000000000000099" }),
    });
    const args =
      mockGetAttendanceSessionStatusForCurrentTeacher.mock
        .calls[0] ?? [];
    expect(args.length).toBe(1);
    expect(typeof args[0]).toBe("string");
    expect(args[0]).toBe("650000000000000000000099");
  });
});
