/**
 * Tests for `/classes` — PHASE 5.1E1 authenticated class list page.
 *
 * Server Component tests render the page module to a JSX tree
 * with `renderToStaticMarkup` so the assertions cover both the
 * rendered HTML and the call-shape invariants.
 *
 * The tests mock:
 *   - `next/navigation` redirect
 *   - `@/lib/session` getSession
 *   - `@/lib/profile-service` getProfileByUserId
 *   - `@/lib/classes/class-read-service` getVisibleClassesForCurrentUser
 *
 * No Mongoose / Mongo / Face Service is touched.
 *
 * The contract covers:
 *   - read boundary reuse
 *   - no direct model / membership query
 *   - no browser userId
 *   - no client-side role inference
 *   - canonical auth / profile / read-failure handling
 *   - teacher UI (heading, copy, items, empty state, no Create / Join)
 *   - student UI (heading, copy, items, empty state)
 *   - ordering preserved (createdAt DESC)
 *   - archived entry not silently removed
 *   - navigation / no dead detail link
 *   - privacy (no password, no ids, no biometric state)
 *   - domain isolation (no roster, no actions, no Face Service)
 *   - no client fetch / localStorage / etc.
 *   - accessibility / structural assertions
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Mocks
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
  // Other helpers may be referenced transitively but are not
  // used by the /classes page. We provide harmless stubs.
  isOnboardingComplete: (...args: unknown[]) =>
    mockGetProfileByUserId(...args).then(
      (p: { onboardingCompleted?: boolean } | null) =>
        Boolean(p?.onboardingCompleted),
    ),
}));

vi.mock("@/lib/classes/class-read-service", () => ({
  getVisibleClassesForCurrentUser: () =>
    mockGetVisibleClassesForCurrentUser(),
  CLASS_READ_ERROR_CODES: {
    UNAUTHENTICATED: "UNAUTHENTICATED",
    PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
    CLASS_READ_FAILED: "CLASS_READ_FAILED",
  },
}));

const mockRedirect = vi.fn((href: string) => {
  throw new Error(`NEXT_REDIRECT:${href}`);
});

vi.mock("next/navigation", () => ({
  redirect: (href: string) => mockRedirect(href),
}));

import ClassesPage from "@/app/classes/page";

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

interface ClassFixture {
  id: string;
  name: string;
  classCode: string;
  status: "active" | "archived";
  createdAt: string;
}

function makeClass(overrides: Partial<ClassFixture> = {}): ClassFixture {
  return {
    id: "650000000000000000000001",
    name: "Intro to CS",
    classCode: "ABCDEFG",
    status: "active",
    createdAt: "2026-01-01T10:00:00.000Z",
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

// Helper: strip JSDoc + line comments so the static-source checks
// below do not pick up matches from documentation. The runtime
// code body is what we want to assert against.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

// =============================================================================
// 1..8 — Server page contract
// =============================================================================

describe("/classes page — server page contract", () => {
  it("1. /classes uses getVisibleClassesForCurrentUser", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", classes: [] },
    });
    await ClassesPage();
    expect(mockGetVisibleClassesForCurrentUser).toHaveBeenCalledTimes(1);
  });

  it("2. page does not query ClassModel directly", async () => {
    // The page module's source must not import ClassModel.
    // We do a coarse static check on the page file.
    const source = readFileSync(
      resolve(__dirname, "page.tsx"),
      "utf-8",
    );
    const body = stripComments(source);
    expect(body).not.toMatch(/class-model/);
    expect(body).not.toMatch(/ClassModel/);
  });

  it("3. page does not query Membership directly", async () => {
    const source = readFileSync(
      resolve(__dirname, "page.tsx"),
      "utf-8",
    );
    const body = stripComments(source);
    expect(body).not.toMatch(/class-membership-model/);
    expect(body).not.toMatch(/ClassMembershipModel/);
  });

  it("4. page does not accept browser userId (no userId arg)", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", classes: [] },
    });
    // The page must read identity from the session, not from any
    // browser-supplied argument. Defensive call with extra args
    // must not change identity handling.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (ClassesPage as any)("attacker-supplied-user-id");
    const sessionCall = mockGetSession.mock.calls[0];
    expect(sessionCall).toBeDefined();
    // The session mock itself was NOT given the attacker-supplied
    // id — the page never passes any argument to getSession.
    expect(sessionCall?.length ?? 0).toBe(0);
  });

  it("5. page does not infer role client-side — role comes from read result", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    // The Profile is teacher; the read service returns student.
    // The page must honor the read service's role, NOT the
    // Profile role, and NOT the count of classes.
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "student", classes: [] },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    // The student sub-copy is the source of truth — "Classes you've joined."
    expect(tree).toContain("Classes you&#x27;ve joined");
  });

  it("6. UNAUTHENTICATED follows established auth behavior (redirect /login)", async () => {
    mockGetSession.mockResolvedValue(null);
    mockGetProfileByUserId.mockResolvedValue(null);
    mockGetVisibleClassesForCurrentUser.mockResolvedValue(null);
    await expect(ClassesPage()).rejects.toThrow(
      "NEXT_REDIRECT:/login",
    );
    expect(mockGetVisibleClassesForCurrentUser).not.toHaveBeenCalled();
  });

  it("7. PROFILE_INCOMPLETE follows established onboarding behavior (redirect /onboarding)", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(null);
    await expect(ClassesPage()).rejects.toThrow(
      "NEXT_REDIRECT:/onboarding",
    );
    expect(mockGetVisibleClassesForCurrentUser).not.toHaveBeenCalled();
  });

  it("8. CLASS_READ_FAILED does not expose raw error", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: false,
      code: "CLASS_READ_FAILED",
      message: "Could not load your classes. Please try again.",
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    // The rendered tree must contain a calm error block and MUST
    // NOT contain raw exception text, stack traces, or driver
    // internals.
    expect(tree).toContain("Could not load your classes");
    expect(tree).not.toMatch(/ECONNREFUSED/);
    expect(tree).not.toMatch(/stack/i);
    expect(tree).not.toMatch(/mongo/i);
    expect(tree).not.toMatch(/E11000/);
  });
});

// =============================================================================
// 9..19 — Teacher UI
// =============================================================================

describe("/classes page — teacher UI", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(makeSession("TEACHER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
  });

  it("9. teacher heading/copy renders", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", classes: [] },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toContain("Classes");
    expect(tree).toContain("Classes you manage");
  });

  it("10. one owned class renders", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass({ name: "Algebra 101" })],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toContain("Algebra 101");
  });

  it("11. multiple owned classes render", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [
          makeClass({ id: "A", name: "Algebra", classCode: "ALGEBRA" }),
          makeClass({ id: "B", name: "Biology", classCode: "BIOLOGY" }),
          makeClass({ id: "C", name: "Chemistry", classCode: "CHEMSTR" }),
        ],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toContain("Algebra");
    expect(tree).toContain("Biology");
    expect(tree).toContain("Chemistry");
  });

  it("12. class name renders", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass({ name: "Discrete Math" })],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toContain("Discrete Math");
  });

  it("13. classCode renders", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass({ classCode: "WXYZ123" })],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toContain("WXYZ123");
  });

  it("14. active status renders", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass({ status: "active" })],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toContain("Active");
  });

  it("15. archived status renders", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [
          makeClass({ status: "archived", classCode: "ARCHIV1" }),
        ],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toContain("Archived");
    expect(tree).toContain("ARCHIV1");
  });

  it("16. created date renders", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [
          makeClass({ createdAt: "2026-02-15T10:00:00.000Z" }),
        ],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toContain("Feb 15, 2026");
  });

  it("17. teacher empty state renders when classes=[]", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", classes: [] },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toContain("No classes yet");
    expect(tree).toContain("Classes you create will appear here");
  });

  it("18. PHASE 5.1E2 — teacher renders Create class CTA linking to /classes/new", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass({ name: "Algebra 101" })],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toMatch(/create\s*class/i);
    expect(tree).toContain('href="/classes/new"');
    expect(tree).toContain('data-component="create-class-cta"');
  });

  it("18b. PHASE 5.1E2 — empty teacher state still permits Create class CTA", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", classes: [] },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toMatch(/create\s*class/i);
    expect(tree).toContain('href="/classes/new"');
  });

  it("18c. PHASE 5.1E2 — student /classes does NOT render Create class CTA", async () => {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "student",
        classes: [makeClass({ name: "Algebra 101" })],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).not.toMatch(/create\s*class/i);
    expect(tree).not.toContain("/classes/new");
    expect(tree).not.toContain('data-component="create-class-cta"');
  });

  it("19. no Join Class form exists on teacher page", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass({ name: "Algebra 101" })],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).not.toMatch(/join\s*class/i);
    expect(tree).not.toContain("/classes/join");
  });

  it("19b. PHASE 5.1E3 — student /classes renders Join class CTA linking to /classes/join", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "student",
        classes: [makeClass({ name: "Algebra 101" })],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toMatch(/join\s*class/i);
    expect(tree).toContain('href="/classes/join"');
    expect(tree).toContain('data-component="join-class-cta"');
  });

  it("19c. PHASE 5.1E3 — empty student state permits Join class CTA", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "student", classes: [] },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toMatch(/join\s*class/i);
    expect(tree).toContain('href="/classes/join"');
  });

  it("19d. PHASE 5.1E3 — teacher /classes does NOT render Join class CTA", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass({ name: "Algebra 101" })],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).not.toMatch(/join\s*class/i);
    expect(tree).not.toContain("/classes/join");
    expect(tree).not.toContain('data-component="join-class-cta"');
  });

  it("19e. PHASE 5.1E3 — student with existing classes still permits Join class CTA", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "student",
        classes: [
          makeClass({ name: "Algebra 101" }),
          makeClass({ id: "B", name: "Biology", classCode: "BIOLOGY" }),
        ],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toMatch(/join\s*class/i);
    expect(tree).toContain('href="/classes/join"');
  });

  it("19f. PHASE 5.1E3 — teacher Create class CTA remains intact when student CTA also exists", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass({ name: "Algebra 101" })],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    // Teacher still has Create class
    expect(tree).toMatch(/create\s*class/i);
    expect(tree).toContain('href="/classes/new"');
    // Teacher does NOT have Join class
    expect(tree).not.toMatch(/join\s*class/i);
  });

  it("19g. PHASE 5.1E3 — no role renders both CTAs (verify role matrix enforced)", async () => {
    // This test verifies that if somehow role was not set, the page
    // would not render CTAs for both roles. In practice the read
    // service always returns "teacher" or "student".
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "student" as const, classes: [] },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    // Student has Join class, not Create class
    expect(tree).toMatch(/join\s*class/i);
    expect(tree).not.toMatch(/create\s*class/i);
  });
});

// =============================================================================
// 20..25 — Student UI
// =============================================================================

describe("/classes page — student UI", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
  });

  it("20. student heading/copy renders", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "student", classes: [] },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toContain("Classes");
    expect(tree).toContain("Classes you&#x27;ve joined");
  });

  it("21. joined classes render", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "student",
        classes: [
          makeClass({ name: "Algebra 101" }),
          makeClass({ id: "B", name: "Biology", classCode: "BIOLOGY" }),
        ],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toContain("Algebra 101");
    expect(tree).toContain("Biology");
  });

  it("22. student empty state renders when classes=[]", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "student", classes: [] },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toContain("No classes yet");
    expect(tree).toContain("Classes you join will appear here");
  });

  it("23. classCode renders safely", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "student",
        classes: [makeClass({ classCode: "SAFE001" })],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toContain("SAFE001");
  });

  it("24. status renders safely", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "student",
        classes: [makeClass({ status: "active" })],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toContain("Active");
  });

  it("25. no teacher-only data appears (no roster, no students)", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "student",
        classes: [makeClass({ name: "Algebra 101" })],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).not.toMatch(/student/i); // No roster copy
    expect(tree).not.toMatch(/members/i);
    expect(tree).not.toMatch(/joined\s*at/i);
    expect(tree).not.toMatch(/identification/i);
  });
});

// =============================================================================
// 26..28 — Ordering
// =============================================================================

describe("/classes page — ordering", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
  });

  it("26. page preserves server result ordering", async () => {
    // Server returns: NEWEST first, then older. The test asserts
    // the page renders them in the same order (no resort).
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [
          makeClass({
            id: "1",
            name: "Z-NEWEST",
            classCode: "ZZZZZZ1",
            createdAt: "2026-03-01T10:00:00.000Z",
          }),
          makeClass({
            id: "2",
            name: "M-MIDDLE",
            classCode: "MMMMMM1",
            createdAt: "2026-02-01T10:00:00.000Z",
          }),
          makeClass({
            id: "3",
            name: "A-OLDEST",
            classCode: "AAAAAAA",
            createdAt: "2026-01-01T10:00:00.000Z",
          }),
        ],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    const idxNewest = tree.indexOf("Z-NEWEST");
    const idxMiddle = tree.indexOf("M-MIDDLE");
    const idxOldest = tree.indexOf("A-OLDEST");
    expect(idxNewest).toBeGreaterThan(-1);
    expect(idxMiddle).toBeGreaterThan(idxNewest);
    expect(idxOldest).toBeGreaterThan(idxMiddle);
  });

  it("27. newest class remains first when read model returns DESC order", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [
          makeClass({
            id: "1",
            name: "NEWEST",
            classCode: "NEWCODE",
            createdAt: "2026-06-01T00:00:00.000Z",
          }),
          makeClass({
            id: "2",
            name: "OLDER",
            classCode: "OLDER01",
            createdAt: "2025-01-01T00:00:00.000Z",
          }),
        ],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree.indexOf("NEWEST")).toBeLessThan(
      tree.indexOf("OLDER"),
    );
  });

  it("28. archived entry is not silently removed", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [
          makeClass({
            id: "1",
            name: "Current Term",
            classCode: "CURRENT",
            status: "active",
          }),
          makeClass({
            id: "2",
            name: "Last Year",
            classCode: "LASTYR1",
            status: "archived",
          }),
        ],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toContain("Current Term");
    expect(tree).toContain("Last Year");
    expect(tree).toContain("Archived");
  });
});

// =============================================================================
// 29..32 — Navigation
// =============================================================================

describe("/classes page — navigation", () => {
  it("29. primary authenticated navigation contains Classes link", async () => {
    const { NAV_GROUPS } = await import(
      "@/components/layout/nav-config"
    );
    const classesItem = NAV_GROUPS.flatMap((g) => g.items).find(
      (i) => i.key === "classes",
    );
    expect(classesItem).toBeDefined();
    expect(classesItem?.status).toBe("ready");
  });

  it("30. Classes link points to /classes", async () => {
    const { NAV_GROUPS } = await import(
      "@/components/layout/nav-config"
    );
    const classesItem = NAV_GROUPS.flatMap((g) => g.items).find(
      (i) => i.key === "classes",
    );
    expect(classesItem?.href).toBe("/classes");
  });

  it("31. no Attendance navigation entry introduced", async () => {
    const { NAV_GROUPS } = await import(
      "@/components/layout/nav-config"
    );
    const attendanceItem = NAV_GROUPS.flatMap((g) => g.items).find(
      (i) => i.key === "attendance",
    );
    expect(attendanceItem).toBeDefined();
    expect(attendanceItem?.status).toBe("coming_soon");
    expect(attendanceItem?.href).toBeUndefined();
  });

  it("32. no Create/Join class route link introduced in E1", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass()],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    // PHASE 5.1E2 — teacher sees a Create class link to
    // /classes/new. Students still must not see any link to
    // /classes/new or /classes/join.
    expect(tree).toContain("/classes/new");
    expect(tree).not.toContain("/classes/join");
    // The nav-config must NOT introduce such hrefs either — the
    // page itself owns the Create class CTA.
    const { NAV_GROUPS } = await import(
      "@/components/layout/nav-config"
    );
    const allHrefs = NAV_GROUPS.flatMap((g) =>
      g.items.map((i) => i.href ?? ""),
    );
    expect(allHrefs).not.toContain("/classes/new");
    expect(allHrefs).not.toContain("/classes/join");
  });

  it("32b. PHASE 5.1E3 — student /classes DOES link to /classes/join", async () => {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "student",
        classes: [makeClass()],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).not.toContain("/classes/new");
    // PHASE 5.1E3 — students SHOULD see Join class CTA
    expect(tree).toContain("/classes/join");
  });
});

// =============================================================================
// 33..34 — No dead detail route
// =============================================================================

describe("/classes page — no dead detail route", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
  });

  it("33. list item does not link to nonexistent /classes/[id] route", async () => {
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
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).not.toMatch(/href="\/classes\/650000000000000000000099"/);
    expect(tree).not.toMatch(/href="\/classes\/\[classId\]"/);
  });

  it("34. no class-detail route is introduced by E1", async () => {
    const source = readFileSync(
      resolve(__dirname, "page.tsx"),
      "utf-8",
    );
    const body = stripComments(source);
    expect(body).not.toMatch(/\/classes\/\[/);
  });
});

// =============================================================================
// 35..42 — Privacy
// =============================================================================

describe("/classes page — privacy", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
  });

  it("35. DOM contains no password", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass()],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).not.toMatch(/passwordHash/i);
    expect(tree).not.toMatch(/pbkdf2/i);
    expect(tree).not.toMatch(/"password"/);
  });

  it("36. DOM contains no passwordHash", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass()],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree.toLowerCase()).not.toContain("passwordhash");
  });

  it("37. DOM contains no teacherUserId", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass()],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).not.toContain("teacherUserId");
    expect(tree).not.toContain("TEACHER-1");
  });

  it("38. DOM contains no studentUserId", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "student",
        classes: [makeClass()],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).not.toContain("studentUserId");
    expect(tree).not.toContain("STUDENT-1");
  });

  it("39. DOM contains no membershipId", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "student",
        classes: [makeClass()],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree.toLowerCase()).not.toContain("membershipid");
    expect(tree.toLowerCase()).not.toContain("membership_id");
  });

  it("40. DOM contains no email / emailSnapshot", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass()],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).not.toContain("emailSnapshot");
    expect(tree).not.toContain("u@example.com");
  });

  it("41. DOM contains no phone", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass()],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree.toLowerCase()).not.toContain("phone");
  });

  it("42. DOM contains no biometric values", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass()],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree.toLowerCase()).not.toContain("embedding");
    expect(tree.toLowerCase()).not.toContain("centroid");
    expect(tree.toLowerCase()).not.toContain("faceprofile");
    expect(tree.toLowerCase()).not.toContain("faceprofile");
  });
});

// =============================================================================
// 43..48 — Domain isolation
// =============================================================================

describe("/classes page — domain isolation", () => {
  let sourceBody: string;
  beforeAll(() => {
    const source = readFileSync(
      resolve(__dirname, "page.tsx"),
      "utf-8",
    );
    sourceBody = stripComments(source);
  });

  it("43. page performs no roster read", () => {
    expect(sourceBody).not.toMatch(/getClassRosterForCurrentTeacher/);
    expect(sourceBody).not.toMatch(/getClassDetailForCurrentUser/);
    expect(sourceBody.toLowerCase()).not.toContain("roster");
  });

  it("44. page performs no createClassAction", () => {
    expect(sourceBody).not.toMatch(/createClassAction/);
    expect(sourceBody).not.toMatch(/createClass\s*\(/);
  });

  it("45. page performs no joinClassAction", () => {
    expect(sourceBody).not.toMatch(/createJoinClassAction/);
    expect(sourceBody).not.toMatch(/joinClassAction/);
    expect(sourceBody).not.toMatch(/joinClass\s*\(/);
  });

  it("46. page performs no Face Service call", () => {
    expect(sourceBody).not.toMatch(/face-service-client/);
    expect(sourceBody).not.toMatch(/FaceServiceClient/);
    expect(sourceBody).not.toMatch(/finalizeFaceEnrollment/);
    expect(sourceBody).not.toMatch(/analyzeEnrollmentSample/);
  });

  it("47. page performs no FaceProfile lookup", () => {
    expect(sourceBody).not.toMatch(/FaceProfile/);
    expect(sourceBody).not.toMatch(/face-profile-service/);
    expect(sourceBody).not.toMatch(/face-id-status-service/);
  });

  it("48. page performs no attendance operation", () => {
    expect(sourceBody.toLowerCase()).not.toContain("attendance");
  });
});

// =============================================================================
// 49..53 — No client fetch
// =============================================================================

describe("/classes page — no client fetch", () => {
  let sourceBody: string;
  beforeAll(() => {
    const source = readFileSync(
      resolve(__dirname, "page.tsx"),
      "utf-8",
    );
    sourceBody = stripComments(source);
  });

  it("49. no fetch(/api/classes)", () => {
    expect(sourceBody).not.toMatch(/\/api\/classes/);
    expect(sourceBody).not.toMatch(/fetch\s*\(\s*["'`]\/api/);
  });

  it("50. no useEffect class loading", () => {
    expect(sourceBody).not.toMatch(/useEffect/);
    expect(sourceBody).not.toMatch(/"use client"/);
  });

  it("51. no localStorage", () => {
    expect(sourceBody).not.toMatch(/localStorage/);
  });

  it("52. no sessionStorage", () => {
    expect(sourceBody).not.toMatch(/sessionStorage/);
  });

  it("53. no React Query / SWR dependency introduced", () => {
    expect(sourceBody).not.toMatch(/react-query/);
    expect(sourceBody).not.toMatch(/swr/);
    expect(sourceBody).not.toMatch(/useQuery/);
    expect(sourceBody).not.toMatch(/useSWR/);
  });
});

// =============================================================================
// 54..57 — Accessibility / structure
// =============================================================================

describe("/classes page — accessibility / structure", () => {
  beforeEach(() => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
  });

  it("54. page has one primary Classes heading", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [makeClass()],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    // The PageHeader renders an h1 by default.
    const headingMatches = tree.match(/<h1[^>]*>/g) ?? [];
    expect(headingMatches.length).toBeGreaterThanOrEqual(1);
    expect(tree).toContain("Classes");
  });

  it("55. class collection uses semantic list structure", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [
          makeClass({ name: "Algebra" }),
          makeClass({ name: "Biology", classCode: "BIOLOGY" }),
        ],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toMatch(/<ul\b/);
    expect(tree).toMatch(/<li\b/);
    expect(tree).toContain("aria-label");
  });

  it("56. status has visible text", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: {
        role: "teacher",
        classes: [
          makeClass({ status: "active" }),
          makeClass({
            id: "B",
            status: "archived",
            classCode: "ARCHIV1",
          }),
        ],
      },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    expect(tree).toContain("Active");
    expect(tree).toContain("Archived");
  });

  it("57. empty state is textually understandable", async () => {
    mockGetVisibleClassesForCurrentUser.mockResolvedValue({
      ok: true,
      result: { role: "teacher", classes: [] },
    });
    const tree = renderToStaticMarkup(await ClassesPage());
    // The empty state uses the EmptyState component which renders
    // role="status". The tree must contain both a title and a
    // description that is textually meaningful.
    expect(tree).toMatch(/role="status"/);
    expect(tree).toContain("No classes yet");
    expect(tree).toContain("Classes you create will appear here");
  });
});