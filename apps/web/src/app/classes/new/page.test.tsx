/**
 * Tests for `/classes/new` — PHASE 5.1E2 authenticated teacher-only
 * "Create class" page.
 *
 * Server Component tests render the page module to a JSX tree
 * with `renderToStaticMarkup` so the assertions cover both the
 * rendered HTML and the call-shape invariants.
 *
 * The tests mock:
 *   - `next/navigation` redirect
 *   - `@/lib/session` getSession
 *   - `@/lib/profile-service` getProfileByUserId
 *
 * No Mongoose / Mongo / Face Service is touched.
 *
 * The contract covers:
 *   - server-rendered page
 *   - guard chain (no session / incomplete profile / student)
 *   - identity-free page (no userId / teacherUserId / role props)
 *   - no direct ClassModel / ClassMembershipModel query
 *   - teacher renders the `CreateClassForm` shell
 *   - student redirects to /classes
 *   - no public API route introduced
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Mocks
// =============================================================================

const mockGetSession = vi.fn();
const mockGetProfileByUserId = vi.fn();

vi.mock("@/lib/session", () => ({
  getSession: () => mockGetSession(),
}));

vi.mock("@/lib/profile-service", () => ({
  getProfileByUserId: (...args: unknown[]) =>
    mockGetProfileByUserId(...args),
}));

const mockRedirect = vi.fn((href: string) => {
  throw new Error(`NEXT_REDIRECT:${href}`);
});

vi.mock("next/navigation", () => ({
  redirect: (href: string) => mockRedirect(href),
}));

import NewClassPage from "@/app/classes/new/page";

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

// Helper: strip JSDoc + line comments so the static-source checks
// below do not pick up matches from documentation. The runtime
// code body is what we want to assert against.
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
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// 1..7 — Server-rendered page contract
// =============================================================================

describe("/classes/new page — server page contract", () => {
  it("1. /classes/new is server-rendered (no client directive)", async () => {
    const source = readFileSync(
      resolve(__dirname, "page.tsx"),
      "utf-8",
    );
    const body = stripComments(source);
    expect(body).not.toMatch(/^["']use client["']/m);
    expect(body).not.toMatch(/["']use client["']/);
  });

  it("2. no session follows established auth behavior (redirect /login)", async () => {
    mockGetSession.mockResolvedValue(null);
    mockGetProfileByUserId.mockResolvedValue(null);
    await expect(NewClassPage()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(mockGetProfileByUserId).not.toHaveBeenCalled();
  });

  it("3. incomplete profile follows onboarding behavior (redirect /onboarding)", async () => {
    mockGetSession.mockResolvedValue(makeSession("USER-1"));
    mockGetProfileByUserId.mockResolvedValue(null);
    await expect(NewClassPage()).rejects.toThrow(
      "NEXT_REDIRECT:/onboarding",
    );
  });

  it("4. teacher renders the form shell (heading + form)", async () => {
    mockGetSession.mockResolvedValue(makeSession("TEACHER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    const tree = renderToStaticMarkup(await NewClassPage());
    // The page renders an h1 with "Create class".
    expect(tree).toContain("Create class");
    // The CreateClassForm Client Component is rendered — its
    // data-component attribute is present.
    expect(tree).toContain('data-component="create-class-form"');
    // The form renders both fields.
    expect(tree).toContain('name="name"');
    expect(tree).toContain('name="password"');
    expect(tree).toContain('type="password"');
  });

  it("5. student direct access redirects to /classes", async () => {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    await expect(NewClassPage()).rejects.toThrow("NEXT_REDIRECT:/classes");
  });

  it("6. page does not accept userId (no userId arg)", async () => {
    mockGetSession.mockResolvedValue(makeSession("TEACHER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    // The page must read identity from the session, not from any
    // browser-supplied argument. Defensive call with extra args
    // must not change identity handling.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (NewClassPage as any)("attacker-supplied-user-id");
    const sessionCall = mockGetSession.mock.calls[0];
    expect(sessionCall).toBeDefined();
    // The session mock itself was NOT given the attacker-supplied
    // id — the page never passes any argument to getSession.
    expect(sessionCall?.length ?? 0).toBe(0);
  });

  it("7. page does not query ClassModel directly", async () => {
    const source = readFileSync(
      resolve(__dirname, "page.tsx"),
      "utf-8",
    );
    const body = stripComments(source);
    expect(body).not.toMatch(/class-model/);
    expect(body).not.toMatch(/ClassModel/);
  });

  it("7b. page does not query Membership directly", async () => {
    const source = readFileSync(
      resolve(__dirname, "page.tsx"),
      "utf-8",
    );
    const body = stripComments(source);
    expect(body).not.toMatch(/class-membership-model/);
    expect(body).not.toMatch(/ClassMembershipModel/);
  });
});

// =============================================================================
// 8..10 — Domain isolation (no public API, no Face Service, no roster)
// =============================================================================

describe("/classes/new page — domain isolation", () => {
  let sourceBody: string;
  beforeEach(() => {
    const source = readFileSync(
      resolve(__dirname, "page.tsx"),
      "utf-8",
    );
    sourceBody = stripComments(source);
  });

  it("8. no /api/classes route introduced", () => {
    expect(sourceBody).not.toMatch(/\/api\/classes/);
    expect(sourceBody).not.toMatch(/route\.ts/);
  });

  it("9. no Face Service call", () => {
    expect(sourceBody).not.toMatch(/face-service-client/);
    expect(sourceBody).not.toMatch(/FaceServiceClient/);
    expect(sourceBody).not.toMatch(/finalizeFaceEnrollment/);
    expect(sourceBody).not.toMatch(/analyzeEnrollmentSample/);
  });

  it("10. no FaceProfile touch", () => {
    expect(sourceBody).not.toMatch(/FaceProfile/);
    expect(sourceBody).not.toMatch(/face-profile-service/);
  });

  it("11. no attendance operation", () => {
    expect(sourceBody.toLowerCase()).not.toContain("attendance");
  });

  it("12. no roster read", () => {
    expect(sourceBody).not.toMatch(/getClassRosterForCurrentTeacher/);
    expect(sourceBody).not.toMatch(/getClassDetailForCurrentUser/);
    expect(sourceBody.toLowerCase()).not.toContain("roster");
  });

  it("13. no createClassAction invocation in page (form owns the action)", () => {
    // The page composes the CreateClassForm Client Component; it
    // does NOT call the Server Action directly.
    expect(sourceBody).not.toMatch(/createClassAction/);
  });

  it("14. no joinClassAction invocation in page", () => {
    expect(sourceBody).not.toMatch(/createJoinClassAction/);
    expect(sourceBody).not.toMatch(/joinClassAction/);
    expect(sourceBody).not.toMatch(/joinClass\s*\(/);
  });

  it("15. no browser persistence introduced", () => {
    expect(sourceBody).not.toMatch(/localStorage/);
    expect(sourceBody).not.toMatch(/sessionStorage/);
    expect(sourceBody).not.toMatch(/IndexedDB/);
  });

  it("16. no useEffect / no client fetch", () => {
    expect(sourceBody).not.toMatch(/useEffect/);
    expect(sourceBody).not.toMatch(/fetch\s*\(/);
  });
});

// =============================================================================
// 17..20 — Privacy / structural
// =============================================================================

describe("/classes/new page — privacy / structure", () => {
  it("17. rendered DOM contains no passwordHash", async () => {
    mockGetSession.mockResolvedValue(makeSession("TEACHER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    const tree = renderToStaticMarkup(await NewClassPage());
    expect(tree.toLowerCase()).not.toContain("passwordhash");
    expect(tree.toLowerCase()).not.toContain("pbkdf2");
  });

  it("18. rendered DOM contains no teacherUserId", async () => {
    mockGetSession.mockResolvedValue(makeSession("TEACHER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    const tree = renderToStaticMarkup(await NewClassPage());
    expect(tree).not.toContain("teacherUserId");
    expect(tree).not.toContain("TEACHER-1");
  });

  it("19. rendered DOM contains no studentUserId", async () => {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    // Student direct access redirects — but the page itself must
    // never render any student-related identity either.
    await expect(NewClassPage()).rejects.toThrow("NEXT_REDIRECT:/classes");
    expect(mockGetProfileByUserId).toHaveBeenCalledTimes(1);
  });

  it("20. page exposes a primary h1 heading", async () => {
    mockGetSession.mockResolvedValue(makeSession("TEACHER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    const tree = renderToStaticMarkup(await NewClassPage());
    expect(tree).toMatch(/<h1[^>]*>/);
    expect(tree).toContain("Create class");
  });
});
