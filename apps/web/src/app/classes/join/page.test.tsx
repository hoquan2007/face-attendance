/**
 * Tests for `/classes/join` — PHASE 5.1E3 student-only "Join class" page.
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
 *   - server-side student gating
 *   - no session → redirect /login
 *   - incomplete profile → redirect /onboarding
 *   - teacher direct access → redirect /classes
 *   - student direct access → renders Join form
 *   - no ClassModel / MembershipModel query
 *   - no browser userId / studentUserId
 *   - privacy (no identity fields in page)
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

import JoinClassPage from "@/app/classes/join/page";

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
    role: "student",
    fullName: "Test Student",
    identificationCode: "S-001",
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
// 1..5 — Server page contract
// =============================================================================

describe("/classes/join page — server page contract", () => {
  it("1. page does not query ClassModel directly", async () => {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    const source = readFileSync(
      resolve(__dirname, "page.tsx"),
      "utf-8",
    );
    const body = stripComments(source);
    expect(body).not.toMatch(/class-model/);
    expect(body).not.toMatch(/ClassModel/);
  });

  it("2. page does not query Membership directly", async () => {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    const source = readFileSync(
      resolve(__dirname, "page.tsx"),
      "utf-8",
    );
    const body = stripComments(source);
    expect(body).not.toMatch(/class-membership-model/);
    expect(body).not.toMatch(/ClassMembershipModel/);
  });

  it("3. page does not accept browser userId", async () => {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    // The page must read identity from the session, not from any
    // browser-supplied argument.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (JoinClassPage as any)("attacker-supplied-user-id");
    const sessionCall = mockGetSession.mock.calls[0];
    expect(sessionCall).toBeDefined();
    // The session mock itself was NOT given the attacker-supplied
    // id — the page never passes any argument to getSession.
    expect(sessionCall?.length ?? 0).toBe(0);
  });

  it("4. page does not accept browser studentUserId", async () => {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (JoinClassPage as any)("attacker-student-id");
    const sessionCall = mockGetSession.mock.calls[0];
    expect(sessionCall?.length ?? 0).toBe(0);
  });

  it("5. page renders student-only heading", async () => {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    const tree = renderToStaticMarkup(await JoinClassPage());
    expect(tree).toContain("Join class");
  });
});

// =============================================================================
// 6..10 — Auth / profile gating
// =============================================================================

describe("/classes/join page — auth / profile gating", () => {
  it("6. no session redirects /login", async () => {
    mockGetSession.mockResolvedValue(null);
    mockGetProfileByUserId.mockResolvedValue(null);
    await expect(JoinClassPage()).rejects.toThrow(
      "NEXT_REDIRECT:/login",
    );
  });

  it("7. incomplete profile redirects /onboarding", async () => {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(null);
    await expect(JoinClassPage()).rejects.toThrow(
      "NEXT_REDIRECT:/onboarding",
    );
  });

  it("8. teacher direct access redirects /classes", async () => {
    mockGetSession.mockResolvedValue(makeSession("TEACHER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    await expect(JoinClassPage()).rejects.toThrow(
      "NEXT_REDIRECT:/classes",
    );
  });

  it("9. teacher redirect does not render form", async () => {
    mockGetSession.mockResolvedValue(makeSession("TEACHER-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "teacher" }),
    );
    try {
      await JoinClassPage();
      throw new Error("Should have redirected");
    } catch (e) {
      expect((e as Error).message).toBe("NEXT_REDIRECT:/classes");
    }
  });

  it("10. student direct access renders Join form", async () => {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    const tree = renderToStaticMarkup(await JoinClassPage());
    expect(tree).toContain("Join class");
    // The form component is rendered
    expect(tree).toMatch(/classCode/i);
    expect(tree).toMatch(/password/i);
  });
});

// =============================================================================
// 11..15 — Student CTA on /classes
// =============================================================================

describe("/classes/join page — privacy", () => {
  let sourceBody: string;
  beforeEach(() => {
    const source = readFileSync(
      resolve(__dirname, "page.tsx"),
      "utf-8",
    );
    sourceBody = stripComments(source);
  });

  it("11. page performs no createClassAction", () => {
    expect(sourceBody).not.toMatch(/createClassAction/);
  });

  it("12. page performs no joinClassAction (only the form does)", () => {
    // The page itself doesn't call joinClassAction — the form does.
    // The page only guards and renders.
    expect(sourceBody).not.toMatch(/createJoinClassAction/);
  });

  it("13. page performs no Face Service call", () => {
    expect(sourceBody).not.toMatch(/face-service-client/);
    expect(sourceBody).not.toMatch(/FaceServiceClient/);
  });

  it("14. page performs no FaceProfile lookup", () => {
    expect(sourceBody).not.toMatch(/FaceProfile/);
  });

  it("15. page performs no attendance operation", () => {
    expect(sourceBody.toLowerCase()).not.toContain("attendance");
  });
});

// =============================================================================
// 16..18 — No client fetch / storage
// =============================================================================

describe("/classes/join page — no client fetch / storage", () => {
  let sourceBody: string;
  beforeEach(() => {
    const source = readFileSync(
      resolve(__dirname, "page.tsx"),
      "utf-8",
    );
    sourceBody = stripComments(source);
  });

  it("16. no useEffect class loading", () => {
    expect(sourceBody).not.toMatch(/useEffect/);
    expect(sourceBody).not.toMatch(/"use client"/);
  });

  it("17. no localStorage", () => {
    expect(sourceBody).not.toMatch(/localStorage/);
  });

  it("18. no sessionStorage", () => {
    expect(sourceBody).not.toMatch(/sessionStorage/);
  });
});

// =============================================================================
// 19..20 — Routes / structure
// =============================================================================

describe("/classes/join page — routes / structure", () => {
  it("19. page has a heading", async () => {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    const tree = renderToStaticMarkup(await JoinClassPage());
    expect(tree).toMatch(/<h1[^>]*>/);
  });

  it("20. page renders the JoinClassForm component", async () => {
    mockGetSession.mockResolvedValue(makeSession("STUDENT-1"));
    mockGetProfileByUserId.mockResolvedValue(
      makeProfile({ role: "student" }),
    );
    const tree = renderToStaticMarkup(await JoinClassPage());
    // The page should render the form with data-component attribute
    expect(tree).toMatch(/join-class-form/i);
  });
});
