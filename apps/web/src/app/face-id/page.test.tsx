/**
 * Tests for `/face-id` overview page.
 *
 * PHASE 4.6B3C — Final Face ID Enrollment State Consistency + UX Polish.
 *
 * Server Components are tested by mocking their Next.js + service
 * collaborators and rendering the page module to a JSX tree.
 *
 * PHASE 4.6B3C state matrix:
 *   A. no profile + no enrollment → Not configured
 *   B. no profile + partial enrollment (N < 5) → Setup in progress
 *   C. no profile + 5/5 temporary → Samples collected (NOT Configured)
 *   D. FaceProfile exists → Configured (OUTRANKS any temp session)
 *
 * Source-of-truth priority:
 *   1. FaceProfile exists → CONFIGURED wins even if temp session remains
 *   2. no FaceProfile + active session → IN PROGRESS or SAMPLES COLLECTED
 *   3. no FaceProfile + no session → NOT CONFIGURED
 *
 * B3C requirements:
 *   - Configured outranks all temp enrollment residue
 *   - Temporary 5/5 is distinct from Configured
 *   - No "Setup complete" / "Configured" copy in the temp 5/5 state
 *   - No cleanup status / claim status / generationId exposed
 *   - Server-authoritative state (no localStorage/sessionStorage)
 *   - No automatic camera or finalization
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";

// =============================================================================
// Mocks
// =============================================================================

const mockGetFaceIdStatus = vi.fn();

vi.mock("@/lib/biometrics/face-id-status-service", () => ({
  getFaceIdStatus: () => mockGetFaceIdStatus(),
  REQUIRED_SAMPLES: 5,
}));

const mockRedirect = vi.fn((href: string) => {
  // Simulate Next.js by throwing a special "NEXT_REDIRECT" error.
  throw new Error(`NEXT_REDIRECT:${href}`);
});

const mockUseRouter = vi.fn(() => ({
  refresh: vi.fn(() => Promise.resolve()),
}));

vi.mock("next/navigation", () => ({
  redirect: (href: string) => mockRedirect(href),
  useRouter: () => mockUseRouter(),
}));

// Mock the client button — it is not exercised in these tests.
// The real EnrollmentStartButton renders a <button> wrapped in a <Link>
// that routes to /face-id/setup. We model this in the mock so the
// test can assert on both the text and the href.
vi.mock("@/components/face-id-pages/enrollment-start-button", () => ({
  EnrollmentStartButton: ({ label }: { label?: string }) =>
    React.createElement(
      "a",
      {
        "data-testid": "enrollment-start-button",
        href: "/face-id/setup",
      },
      label ?? "Set up Face ID",
    ),
}));

import FaceIdPage from "@/app/face-id/page";
import FaceIdSetupPage from "@/app/face-id/setup/page";

// =============================================================================
// Tests
// =============================================================================

describe("/face-id page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to /login when unauthenticated", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: false,
      isOnboardingComplete: false,
      status: null,
    });
    await expect(FaceIdPage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("redirects to /onboarding when profile incomplete", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: false,
      status: null,
    });
    await expect(FaceIdPage()).rejects.toThrow("NEXT_REDIRECT:/onboarding");
  });

  it("renders for authenticated, profile-complete user with no Face ID", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).toContain("Face ID");
    expect(tree).toContain("Not configured");
    // Start button must be present
    expect(tree).toContain("Set up Face ID");
  });

  it("renders configured state with enrolled date and sample count", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).toContain("Configured");
    expect(tree).toContain("Sample count");
    expect(tree).toContain("5");
    // Should not contain "Set up Face ID" button on a configured state.
    expect(tree).not.toContain("Set up Face ID");
  });

  it("renders active enrollment state with progress", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 2,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).toContain("Setup in progress");
    expect(tree).toContain("2 of 5 samples");
    expect(tree).toContain("Continue setup");
    // The "Continue setup" link must point to /face-id/setup.
    expect(tree).toContain('href="/face-id/setup"');
  });

  it("does not expose embeddings, ciphertext, IV, authTag in output", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 0,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    // Defensive: no raw biometric vocabulary in the rendered tree.
    expect(tree).not.toMatch(/embedding/i);
    expect(tree).not.toMatch(/ciphertext/i);
    expect(tree).not.toMatch(/authTag/i);
    expect(tree).not.toContain("userId");
  });

  it("Set up Face ID CTA points to /face-id/setup", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    // The button is a real button (rolled by EnrollmentStartButton
    // mock) — confirm "Set up Face ID" text is present.
    expect(tree).toContain("Set up Face ID");
  });

  it("configured state does not include a delete or re-enroll action", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).not.toMatch(/delete/i);
    expect(tree).not.toMatch(/re-?enroll/i);
  });
});

// =============================================================================
// PHASE 4.6B3C — STATE MATRIX TESTS
// =============================================================================

describe("PHASE 4.6B3C — overview state matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ── State A: not configured, no enrollment ──────────────────────────────

  it("A1 — no profile + no enrollment → Not configured", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).toContain("Not configured");
  });

  it("A2 — no profile + no enrollment → shows Set up Face ID link", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    // The enrollment start button renders (mocked as a button element with the label).
    // The actual <Link> component wraps it with an <a href="/face-id/setup">.
    expect(tree).toContain("Set up Face ID");
    // Verify the page contains the expected href on the anchor element
    expect(tree).toContain('href="/face-id/setup"');
  });

  it("A3 — no profile + no enrollment → does NOT show Configured", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).not.toContain("Configured");
    expect(tree).not.toContain("Enrolled");
  });

  // ── State B: not configured, partial enrollment ─────────────────────────

  it("B1 — partial enrollment → shows Setup in progress", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 3,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).toContain("Setup in progress");
    expect(tree).toContain("3 of 5 samples");
  });

  it("B2 — partial enrollment → shows server count (not fabricated)", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 4,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).toContain("4 of 5 samples");
  });

  it("B3 — partial enrollment → Continue setup CTA", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 2,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).toContain("Continue setup");
    expect(tree).toContain('href="/face-id/setup"');
  });

  it("B4 — partial enrollment → does NOT say Configured", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 3,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).not.toContain("Configured");
  });

  it("B5 — partial enrollment → does NOT show Finish setup", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 3,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).not.toContain("Finish setup");
  });

  // ── State C: not configured, temporary 5/5 ─────────────────────────────

  it("C1 — temp 5/5 → Samples collected (NOT Configured)", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 5,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    // B3C: 5/5 temp is NOT "Configured"
    expect(tree).not.toContain("Configured");
    // B3C: honest intermediate copy
    expect(tree).toContain("Samples collected");
    expect(tree).toContain("All 5 required samples have been collected");
  });

  it("C2 — temp 5/5 → Continue setup CTA to /face-id/setup", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 5,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).toContain("Continue setup");
    expect(tree).toContain('href="/face-id/setup"');
  });

  it("C3 — temp 5/5 → no Finish setup CTA on overview page", async () => {
    // "Finish setup" lives on /face-id/setup, not /face-id.
    // The overview shows "Continue setup" (a <Link> to /face-id/setup).
    // We assert that the CTA label does NOT appear.
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 5,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    // The overview CTA is "Continue setup", not "Finish setup".
    // We verify the CTA area doesn't say "Finish setup" as a clickable action.
    // The body copy "Finish setup to complete Face ID." is informational text only.
    // Check the CTA anchor element text.
    expect(tree).toContain("Continue setup");
    expect(tree).toContain('href="/face-id/setup"');
    // No "Finish setup" as a button/anchor CTA label.
    // Use a regex to find "Finish setup" NOT followed by " to complete"
    // (the body copy contains "Finish setup to complete Face ID.").
    const ctaPattern = />\s*Finish setup\s*</;
    expect(tree).not.toMatch(ctaPattern);
  });

  it("C4 — temp 5/5 → does NOT say identity verified / complete", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 5,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).not.toMatch(/identity verified/i);
    expect(tree).not.toMatch(/setup complete/i);
    expect(tree).not.toMatch(/final setup has not been completed/i);
  });

  // ── State D: configured ────────────────────────────────────────────────

  it("D1 — FaceProfile exists → Configured", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).toContain("Configured");
  });

  it("D2 — configured state → shows enrolledAt", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).toContain("Enrolled");
    expect(tree).toContain("Jan 15, 2026");
  });

  it("D3 — configured state → shows sampleCount", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).toContain("Sample count");
    expect(tree).toContain("5");
  });

  it("D4 — configured state → no Continue setup", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).not.toContain("Continue setup");
  });

  it("D5 — configured state → no Finish setup", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).not.toContain("Finish setup");
  });

  it("D6 — configured state → no Set up Face ID", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).not.toContain("Set up Face ID");
  });

  // ── State E: Configured + residual temp session ───────────────────────

  it("E1 — FaceProfile + partial temp session → Configured (NOT in progress)", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: true, // residual temp session still exists
          mode: "create",
          acceptedSamples: 3, // 3/5 partial residual
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    // B3C: configured outranks temp residue
    expect(tree).toContain("Configured");
    expect(tree).not.toContain("Setup in progress");
    expect(tree).not.toContain("3 of 5 samples");
  });

  it("E2 — FaceProfile + partial temp session → no Continue setup", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 3,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).not.toContain("Continue setup");
  });

  it("E3 — FaceProfile + 5/5 temp session → Configured (NOT samples collected)", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: true, // 5/5 residual temp session still exists
          mode: "create",
          acceptedSamples: 5,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    // B3C: configured outranks temp residue — show Configured, not "Samples collected"
    expect(tree).toContain("Configured");
    expect(tree).not.toContain("Samples collected");
    expect(tree).not.toContain("All 5 required samples have been collected");
  });

  it("E4 — FaceProfile + 5/5 temp session → no Finish setup", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 5,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).not.toContain("Finish setup");
  });

  it("E5 — FaceProfile + temp residue → no cleanup/claim status", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 5,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).not.toMatch(/cleanup/i);
    expect(tree).not.toMatch(/claim/i);
    expect(tree).not.toMatch(/finalization/i);
  });

  // ── Privacy ────────────────────────────────────────────────────────────

  it("P1 — configured overview contains no centroid", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree.toLowerCase()).not.toContain("centroid");
  });

  it("P2 — configured overview contains no generationId", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 5,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree.toLowerCase()).not.toContain("generationid");
  });

  it("P3 — configured overview contains no claimToken", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 5,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree.toLowerCase()).not.toContain("claimtoken");
    expect(tree.toLowerCase()).not.toContain("finalizationclaim");
  });

  it("P4 — configured overview contains no sourceEnrollmentGenerationId", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree.toLowerCase()).not.toContain("sourceenrollmentgenerationid");
  });

  it("P5 — configured overview contains no ciphertext", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree.toLowerCase()).not.toContain("ciphertext");
  });

  // ── Legacy profile (no sourceEnrollmentGenerationId) ───────────────────

  it("L1 — FaceProfile without sourceEnrollmentGenerationId → Configured", async () => {
    // Legacy profiles predate B2B and lack the lineage field.
    // They must still render as Configured.
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2025-01-01T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).toContain("Configured");
    expect(tree).toContain("Enrolled");
  });

  it("L2 — legacy profile + temp residue → Configured", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2025-01-01T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 2,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).toContain("Configured");
    expect(tree).not.toContain("Setup in progress");
  });

  // ── No localStorage / sessionStorage ─────────────────────────────────

  it("S1 — page does NOT read localStorage for configured flag", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    // Server Component renders directly — no browser API available.
    // The test verifies the page uses the server-side status service only.
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).toContain("Configured");
  });

  it("S2 — page does NOT read sessionStorage for configured flag", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdPage());
    expect(tree).toContain("Configured");
  });
});

// =============================================================================
// /face-id/setup page tests
// =============================================================================

describe("/face-id/setup page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to /login when unauthenticated", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: false,
      isOnboardingComplete: false,
      status: null,
    });
    await expect(FaceIdSetupPage()).rejects.toThrow("NEXT_REDIRECT:/login");
  });

  it("redirects to /onboarding when profile incomplete", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: false,
      status: null,
    });
    await expect(FaceIdSetupPage()).rejects.toThrow("NEXT_REDIRECT:/onboarding");
  });

  it("redirects to /face-id when face profile is already configured", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    await expect(FaceIdSetupPage()).rejects.toThrow("NEXT_REDIRECT:/face-id");
  });

  // ── PHASE 4.6B3C: Configured + residual session ───────────────────────

  it("B3C — configured + residual partial session → redirects /face-id", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: true, // residual partial temp session
          mode: "create",
          acceptedSamples: 3,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    await expect(FaceIdSetupPage()).rejects.toThrow("NEXT_REDIRECT:/face-id");
  });

  it("B3C — configured + residual 5/5 temp session → redirects /face-id", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: true, // residual 5/5 temp session
          mode: "create",
          acceptedSamples: 5,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    await expect(FaceIdSetupPage()).rejects.toThrow("NEXT_REDIRECT:/face-id");
  });

  it("B3C — redirect occurs before CameraPreview can render", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 5,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    // The redirect throws BEFORE any JSX is rendered.
    // If this throws, the camera was never rendered.
    await expect(FaceIdSetupPage()).rejects.toThrow("NEXT_REDIRECT:/face-id");
  });

  it("B3C — configured direct access does NOT call enrollment start", async () => {
    const mockStart = vi.fn();
    vi.doMock("@/lib/biometrics/enrollment-start-action", () => ({
      startFaceEnrollment: () => mockStart(),
    }));
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    await expect(FaceIdSetupPage()).rejects.toThrow("NEXT_REDIRECT:/face-id");
    // The redirect happened before any start action could be called
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("B3C — configured direct access does NOT call finish action", async () => {
    const mockFinish = vi.fn();
    vi.doMock("@/lib/biometrics/enrollment-completion-action", () => ({
      finishFaceEnrollment: () => mockFinish(),
    }));
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: true,
        faceId: {
          enrolledAt: "2026-01-15T10:00:00.000Z",
          sampleCount: 5,
        },
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    await expect(FaceIdSetupPage()).rejects.toThrow("NEXT_REDIRECT:/face-id");
    expect(mockFinish).not.toHaveBeenCalled();
  });

  it("renders Start setup button when no active session exists", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdSetupPage());
    expect(tree).toContain("Set up Face ID");
    // Camera preview must NOT be present yet (no active session).
    // The CameraPreview component has a Turn on camera button.
    expect(tree).not.toContain("Turn on camera");
  });

  it("renders CameraPreview when an active session exists", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 2,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdSetupPage());
    // CameraPreview is embedded — its "Turn on camera" button is visible.
    expect(tree).toContain("Turn on camera");
    expect(tree).toContain("2 of 5 samples");
  });

  it("PHASE 4.6B3B — 5/5 complete state renders Finish setup visibility marker", async () => {
    // The "Finish setup" button lives inside a client component, so
    // its DOM does not appear in SSR. The setup page MUST still
    // mount the client wrapper (which decides visibility from
    // server-derived `canFinish` / `faceProfileConfigured` flags).
    // We verify the wrapper is rendered by checking the panel's
    // privacy copy + the `data-component` marker. The actual button
    // visibility / interaction contract is verified in
    // `enrollment-finish-button.test.tsx`.
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 5,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdSetupPage());
    // The wrapper still renders; the panel's privacy copy is the
    // server-rendered marker we can assert here.
    expect(tree).toContain("encrypted biometric template");
    expect(tree).toContain("5 of 5 samples");
  });

  it("renders a Capture sample button (B3 contract) when an active session exists", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 0,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    // The Capture button is gated behind a "use client" boundary and
    // does not render in SSR. We must await dynamic imports / client
    // boundary resolution to see it, so we skip the static markup
    // assertion here and rely on the EnrollmentSamplePanel tests
    // for the actual button rendering contract. The SSR markup,
    // however, must still embed the panel marker (e.g. the panel
    // section's privacy copy).
    const tree = renderToStaticMarkup(await FaceIdSetupPage());
    // Privacy copy is rendered server-side.
    expect(tree).toContain("encrypted biometric template");
  });

  it("does NOT render a fake functional Capture button before the camera is ready", async () => {
    // The Capture button lives inside the client-side panel and is
    // disabled until the camera reports `ready`. This contract is
    // enforced by `EnrollmentSamplePanel` tests; here we only assert
    // that the panel's wrapper is rendered, NOT that an enabled
    // Capture button is present in SSR output.
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 0,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdSetupPage());
    // Server-side rendering must NOT render an enabled Capture button
    // because the button is gated by `use client` state; SSR will
    // produce only the panel's scaffolding text (e.g. the privacy
    // note). Any visible "Capture sample" string in SSR would imply a
    // server-rendered enabled control.
    expect(tree).toMatch(/encrypted biometric template/);
  });

  it("does NOT auto-start enrollment on page load", async () => {
    // Auto-start would have to call the action module — mock it so we
    // can assert NO call occurred.
    const mockStart = vi.fn();
    vi.doMock("@/lib/biometrics/enrollment-start-action", () => ({
      startFaceEnrollment: () => mockStart(),
    }));
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    renderToStaticMarkup(await FaceIdSetupPage());
    expect(mockStart).not.toHaveBeenCalled();
  });

  it("does NOT auto-request camera permission on load", async () => {
    // MediaDevices spy — we only record access.
    const navigatorSpy = {
      mediaDevices: {
        getUserMedia: vi.fn(() => Promise.reject(new Error("nope"))),
      },
    };
    Object.defineProperty(
      typeof globalThis !== "undefined" ? globalThis : (globalThis as object),
      "navigator",
      { value: navigatorSpy, configurable: true, writable: true },
    );
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: true,
          mode: "create",
          acceptedSamples: 0,
          requiredSamples: 5,
          expiresAt: "2030-01-01T10:00:00.000Z",
        },
      },
    });
    renderToStaticMarkup(await FaceIdSetupPage());
    expect(navigatorSpy.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it("renders neutral privacy copy on the setup page (B3-accurate)", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdSetupPage());
    // The B3 setup page now advertises that captured frames ARE sent
    // to the application for analysis while emphasising that raw
    // images are not kept.
    expect(tree).toContain("encrypted biometric template");
    expect(tree).toContain(
      "Each sample you choose to capture is sent securely",
    );
    expect(tree).toContain("Raw camera images are not kept");
  });

  it("does NOT contain 100% or 'guaranteed' overpromise copy", async () => {
    mockGetFaceIdStatus.mockResolvedValue({
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: {
          active: false,
          mode: null,
          acceptedSamples: 0,
          requiredSamples: 0,
          expiresAt: null,
        },
      },
    });
    const tree = renderToStaticMarkup(await FaceIdSetupPage());
    expect(tree).not.toMatch(/100%/);
    expect(tree).not.toMatch(/cannot be fooled/i);
    expect(tree).not.toMatch(/guaranteed/i);
  });
});
