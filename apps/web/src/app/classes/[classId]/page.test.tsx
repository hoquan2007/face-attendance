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
  CLASS_DETAIL_READ_ERROR_CODES: {
    UNAUTHENTICATED: "UNAUTHENTICATED",
    PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
    CLASS_NOT_ACCESSIBLE: "CLASS_NOT_ACCESSIBLE",
    CLASS_READ_FAILED: "CLASS_READ_FAILED",
  },
}));

vi.mock("next/navigation", () => ({
  redirect: (href: string) => mockRedirect(href),
  notFound: () => mockNotFound(),
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
    expect(tree).not.toMatch(/href="\/classes\?/);
    expect(tree).not.toMatch(/href="\/classes\/6500/);
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

  it("41. page does not call getClassRosterForCurrentTeacher", () => {
    expect(sourceBody).not.toMatch(/getClassRosterForCurrentTeacher/);
  });

  it("42. no Students section", () => {
    expect(sourceBody.toLowerCase()).not.toMatch(/students/);
  });

  it("43. no Members section", () => {
    expect(sourceBody.toLowerCase()).not.toMatch(/members/);
  });

  it("44. no identificationCode in source", () => {
    expect(sourceBody.toLowerCase()).not.toContain("identificationcode");
  });

  it("45. no joinedAt roster row", () => {
    expect(sourceBody.toLowerCase()).not.toContain("joinedat");
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

  it("51. no attendance operation", () => {
    expect(sourceBody.toLowerCase()).not.toContain("attendance");
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
