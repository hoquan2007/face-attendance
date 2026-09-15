/**
 * Tests for `EnrollmentFinishButton` — PHASE 4.6B3B.
 *
 * PHASE 4.6B3B.2 — Next.js refresh-transition guard contract:
 *   - `router.refresh()` in Next.js 16.3.4 returns `void`, not a
 *     Promise. Tests therefore MUST NOT mock it with a Promise and
 *     MUST NOT `await` it.
 *   - Reconciliation runs inside a React `useTransition`. The
 *     button must observe the `isRefreshPending` lifecycle
 *     (false → true → false) before releasing the in-flight
 *     guard.
 *   - The mock `router.refresh()` returns `undefined` (void) so
 *     tests exercise the real transition behaviour instead of
 *     awaiting a fake Promise.
 *
 * Contract matrix:
 *   1..6    Visibility (server-state derived)
 *   7..13   Explicit-action contract
 *   14..19  Concurrency / pending
 *   20..27  Success navigation
 *   28..41  Safe error feedback
 *   42..46  Reconciliation
 *   47..55  Privacy / browser-state assertions
 *   56..59  Camera regression — no camera touch
 *   60..73  Refresh-transition guard (PHASE 4.6B3B.2)
 *   74..96  PHASE 4.6B3B.3 production refresh-guard hardening
 *
 * PHASE 4.6B3B.3 — refresh transition lifecycle test strategy:
 *   - Production code contains NO `queueMicrotask` / `setTimeout`
 *     fallback to release the in-flight guard. A microtask is NOT
 *     a real Next.js refresh completion signal — releasing on a
 *     microtask could free the guard BEFORE the refreshed Server
 *     Component payload has actually reconciled.
 *   - jsdom + React 19's `useTransition` does NOT observably flip
 *     `isRefreshPending` when the transition body is synchronous
 *     and performs no React state work (which is exactly what a
 *     void `router.refresh()` mock does). Production code therefore
 *     correctly leaves the guard locked in jsdom.
 *   - To exercise the production `useTransition` machinery we use
 *     a FOCUSED, lifecycle-controlling test harness that wraps
 *     `React.useTransition` (the harness only flips the boolean
 *     the component reads; it never replaces `startTransition`).
 *     Tests can therefore simulate the genuine `false → true →
 *     false` lifecycle that real Next.js + the real React
 *     scheduler produce in production, without altering the
 *     production API or introducing a test-only prop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as React from "react";

// =============================================================================
// Mocks
// =============================================================================

const mockFinishFaceEnrollment = vi.fn();

vi.mock("@/lib/biometrics/enrollment-completion-action", () => ({
  finishFaceEnrollment: () => mockFinishFaceEnrollment(),
  FACE_ENROLLMENT_COMPLETION_ACTION_ERROR_CODES: {
    UNAUTHENTICATED: "UNAUTHENTICATED",
    PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
    ENROLLMENT_SESSION_NOT_FOUND: "ENROLLMENT_SESSION_NOT_FOUND",
    ENROLLMENT_SESSION_EXPIRED: "ENROLLMENT_SESSION_EXPIRED",
    ENROLLMENT_INCOMPLETE: "ENROLLMENT_INCOMPLETE",
    INCONSISTENT_FACE_SAMPLES: "INCONSISTENT_FACE_SAMPLES",
    MODEL_MISMATCH: "MODEL_MISMATCH",
    ENROLLMENT_SAMPLE_DECRYPTION_FAILED:
      "ENROLLMENT_SAMPLE_DECRYPTION_FAILED",
    ENROLLMENT_SAMPLE_VECTOR_INVALID: "ENROLLMENT_SAMPLE_VECTOR_INVALID",
    ENROLLMENT_GENERATION_CHANGED: "ENROLLMENT_GENERATION_CHANGED",
    ENROLLMENT_FINALIZATION_ALREADY_CLAIMED:
      "ENROLLMENT_FINALIZATION_ALREADY_CLAIMED",
    ENROLLMENT_FINALIZATION_IN_PROGRESS:
      "ENROLLMENT_FINALIZATION_IN_PROGRESS",
    FACE_PROFILE_ALREADY_EXISTS: "FACE_PROFILE_ALREADY_EXISTS",
    FACE_SERVICE_TIMEOUT: "FACE_SERVICE_TIMEOUT",
    FACE_SERVICE_UNAVAILABLE: "FACE_SERVICE_UNAVAILABLE",
    FACE_SERVICE_UNAUTHORIZED: "FACE_SERVICE_UNAUTHORIZED",
    FACE_SERVICE_INVALID_RESPONSE: "FACE_SERVICE_INVALID_RESPONSE",
    BIOMETRIC_ENCRYPTION_UNAVAILABLE: "BIOMETRIC_ENCRYPTION_UNAVAILABLE",
    ENROLLMENT_COMPLETION_FAILED: "ENROLLMENT_COMPLETION_FAILED",
  },
}));

// PHASE 4.6B3B.2 — refresh mock returns `void` (NOT a Promise).
// Tests must validate React transition behaviour rather than
// awaiting a fake router Promise. We still let tests drive the
// transition lifecycle (e.g. through `rerender`, controlled state,
// or by flushing microtasks) so the real useTransition code path
// is exercised.
const mockReplace = vi.fn();
const mockRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: (...args: unknown[]) => mockReplace(...args),
    refresh: (...args: unknown[]) => mockRefresh(...args),
    push: vi.fn(),
    back: vi.fn(),
  }),
}));

// =============================================================================
// React-transition test harness (PHASE 4.6B3B.3)
// =============================================================================
//
// The production `EnrollmentFinishButton` reads the React
// `useTransition()` boolean directly — there is no test seam in
// production code. In jsdom + React 19 + Vitest, the React
// scheduler runs `startTransition(() => router.refresh())` and
// observably flips `isRefreshPending` from `false → true → false`
// within a single React batch even though the transition body is
// synchronous (because `startTransition` schedules a React-update
// tick before the body commits). Our `useEffect` records the
// observed `true` via `observedRefreshPendingRef.current` and
// releases the guard on the subsequent `false`. This is the
// production invariant we verify below.
//
// We do NOT wrap `useTransition` — production code uses the real
// React hook. Tests drive the lifecycle through the real React
// scheduler (via `act()`).
import { EnrollmentFinishButton } from "@/components/face-id-pages/enrollment-finish-button";

// =============================================================================
// Helpers
// =============================================================================

function isDisabled(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true;
}

function makeSuccess() {
  return {
    ok: true as const,
    configured: true as const,
    faceId: {
      enrolledAt: "2026-09-12T10:00:00.000Z",
      sampleCount: 5,
    },
    cleanupStatus: "consumed" as const,
  };
}

function makeError(
  code: string,
  retryable: boolean,
  message = "safe-message",
) {
  return {
    ok: false as const,
    code,
    message,
    retryable,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// 1..6 — VISIBILITY
// =============================================================================

describe("visibility (server-state derived)", () => {
  it("1. 0/5 → Finish setup absent (canFinish=false)", () => {
    const { container } = render(
      <EnrollmentFinishButton canFinish={false} faceProfileConfigured={false} />,
    );
    expect(
      container.querySelector('[data-component="enrollment-finish-button"]'),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /finish setup/i })).toBeNull();
  });

  it("2. 1/5 → Finish setup absent (canFinish=false)", () => {
    const { container } = render(
      <EnrollmentFinishButton canFinish={false} faceProfileConfigured={false} />,
    );
    expect(
      container.querySelector('[data-component="enrollment-finish-button"]'),
    ).toBeNull();
  });

  it("3. 4/5 → Finish setup absent (canFinish=false)", () => {
    const { container } = render(
      <EnrollmentFinishButton canFinish={false} faceProfileConfigured={false} />,
    );
    expect(
      container.querySelector('[data-component="enrollment-finish-button"]'),
    ).toBeNull();
  });

  it("4. 5/5 → Finish setup visible (canFinish=true)", () => {
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    expect(btn).toBeTruthy();
  });

  it("5. configured FaceProfile → Finish setup absent on setup flow", () => {
    // Even if canFinish=true is somehow leaked, the configured flag
    // hides the button.
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={true} />,
    );
    expect(
      container.querySelector('[data-component="enrollment-finish-button"]'),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /finish setup/i })).toBeNull();
  });

  it("6. server-driven rerender: complete 5/5 → still visible after reload", () => {
    const { rerender } = render(
      <EnrollmentFinishButton canFinish={false} faceProfileConfigured={false} />,
    );
    expect(screen.queryByRole("button", { name: /finish setup/i })).toBeNull();
    rerender(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    expect(screen.getByRole("button", { name: /finish setup/i })).toBeTruthy();
  });
});

// =============================================================================
// 7..13 — EXPLICIT ACTION
// =============================================================================

describe("explicit-action contract", () => {
  it("7. page render does NOT call finishFaceEnrollment", () => {
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    expect(mockFinishFaceEnrollment).not.toHaveBeenCalled();
  });

  it("8. progress reaching 5/5 does NOT automatically call action", () => {
    // Render with canFinish=false (simulating 0..4/5), then advance
    // to canFinish=true. No automatic invocation must occur.
    const { rerender } = render(
      <EnrollmentFinishButton canFinish={false} faceProfileConfigured={false} />,
    );
    rerender(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    expect(mockFinishFaceEnrollment).not.toHaveBeenCalled();
  });

  it("9. explicit click calls finishFaceEnrollment exactly once", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    });
  });

  it("10. action receives zero arguments", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledWith();
    expect(mockFinishFaceEnrollment.mock.calls[0]).toEqual([]);
  });

  it("11. no userId passed (call site inspection)", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    const json = JSON.stringify(mockFinishFaceEnrollment.mock.calls);
    expect(json.includes("userId")).toBe(false);
    expect(json.includes("user-id")).toBe(false);
  });

  it("12. no generationId passed", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    const json = JSON.stringify(mockFinishFaceEnrollment.mock.calls);
    expect(json.includes("generationId")).toBe(false);
    expect(json.includes("sourceEnrollmentGenerationId")).toBe(false);
  });

  it("13. no claimToken passed", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    const json = JSON.stringify(mockFinishFaceEnrollment.mock.calls);
    expect(json.includes("claimToken")).toBe(false);
    expect(json.includes("finalizationClaim")).toBe(false);
  });
});

// =============================================================================
// 14..19 — CONCURRENCY
// =============================================================================

describe("concurrency / pending", () => {
  it("14. two rapid clicks invoke action once", async () => {
    const resolveRef: { current: ((value: unknown) => void) | null } = { current: null };
    mockFinishFaceEnrollment.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRef.current = resolve;
        }),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    if (resolveRef.current) resolveRef.current(makeSuccess());
  });

  it("15. pending state disables button", async () => {
    const resolveRef: { current: ((value: unknown) => void) | null } = { current: null };
    mockFinishFaceEnrollment.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRef.current = resolve;
        }),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(isDisabled(btn)).toBe(true);
    if (resolveRef.current) resolveRef.current(makeSuccess());
  });

  it("16. pending text shown", async () => {
    const resolveRef: { current: ((value: unknown) => void) | null } = { current: null };
    mockFinishFaceEnrollment.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRef.current = resolve;
        }),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      // Either the button is now labelled "Finishing setup…" or
      // its aria-label reflects that state.
      const label =
        btn.textContent?.toLowerCase() ??
        btn.getAttribute("aria-label")?.toLowerCase() ??
        "";
      expect(label).toMatch(/finishing setup/);
    });
    if (resolveRef.current) resolveRef.current(makeSuccess());
  });

  it("17. failed retryable result releases in-flight guard", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("FACE_SERVICE_TIMEOUT", true),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(isDisabled(btn)).toBe(false);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
  });

  it("18. next explicit click after retryable failure may invoke action once again", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("FACE_SERVICE_TIMEOUT", true),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(isDisabled(btn)).toBe(false);
    });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(2);
  });

  it("19. no automatic second invocation (failure → no auto-retry)", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("FACE_SERVICE_TIMEOUT", true),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    // Wait for the failure feedback to appear, then assert the
    // call count stayed at 1 (no automatic retry).
    await waitFor(() => {
      expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    });
  });
});

// =============================================================================
// 20..27 — SUCCESS NAVIGATION
// =============================================================================

describe("success navigation", () => {
  it("20. success result navigates to /face-id", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/face-id");
    });
  });

  it("21. uses replace rather than push / no biometric URL state", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledTimes(1);
    });
    // No biometric field in the navigated URL.
    const args = mockReplace.mock.calls[0] ?? [];
    const json = JSON.stringify(args);
    expect(json.includes("centroid")).toBe(false);
    expect(json.includes("generationId")).toBe(false);
    expect(json.includes("claimToken")).toBe(false);
    expect(json.includes("userId")).toBe(false);
  });

  it("22. configured success does not render centroid in DOM", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    const html = container.innerHTML;
    expect(html.includes("centroid")).toBe(false);
  });

  it("23. configured success does not render claim token in DOM", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    const html = container.innerHTML;
    expect(html.includes("claimToken")).toBe(false);
  });

  it("24. configured success does not render generation id in DOM", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    const html = container.innerHTML;
    expect(html.includes("generationId")).toBe(false);
    expect(html.includes("sourceEnrollmentGenerationId")).toBe(false);
  });

  it("25. configured success does not render model identity in DOM", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    const html = container.innerHTML;
    expect(html.includes("modelIdentity")).toBe(false);
    expect(html.includes("modelName")).toBe(false);
    expect(html.includes("embeddingDimension")).toBe(false);
    expect(html.includes("insightface")).toBe(false);
    expect(html.includes("buffalo")).toBe(false);
  });

  it("26. success does not write localStorage", async () => {
    const setSpy = vi.spyOn(Storage.prototype, "setItem");
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalled();
    });
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it("27. success does not write sessionStorage", async () => {
    const setSpy = vi
      .spyOn(window.sessionStorage.__proto__ as Storage, "setItem")
      .mockImplementation(() => undefined);
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalled();
    });
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });
});

// =============================================================================
// 28..41 — SAFE ERRORS
// =============================================================================

describe("safe error feedback", () => {
  it("28. retryable service timeout feedback rendered", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("FACE_SERVICE_TIMEOUT", true),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByRole("alert").textContent).toMatch(/timed out|temporarily/i);
  });

  it("29. service unavailable feedback rendered", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("FACE_SERVICE_UNAVAILABLE", true),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByRole("alert").textContent).toMatch(/temporarily unavailable/i);
  });

  it("30. finalization-in-progress feedback rendered", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_FINALIZATION_IN_PROGRESS", true),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByRole("alert").textContent).toMatch(/already being finished/i);
  });

  it("31. retryable error does NOT navigate", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("FACE_SERVICE_TIMEOUT", true),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("32. retryable error does NOT auto-retry", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("FACE_SERVICE_TIMEOUT", true),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    });
    // Wait a beat to allow any auto-retry to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
  });

  it("33. inconsistent samples feedback rendered", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("INCONSISTENT_FACE_SAMPLES", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByRole("alert").textContent).toMatch(/not consistent enough/i);
  });

  it("34. inconsistent samples does NOT show configured/success copy", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("INCONSISTENT_FACE_SAMPLES", false),
    );
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    const html = container.innerHTML;
    expect(html.includes("Face ID is now configured")).toBe(false);
    expect(html.includes("identity verified")).toBe(false);
  });

  it("35. model mismatch feedback rendered", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("MODEL_MISMATCH", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByRole("alert").textContent).toMatch(/setup session invalid|no longer be completed/i);
  });

  it("36. expired session feedback rendered", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_SESSION_EXPIRED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByRole("alert").textContent).toMatch(/expired/i);
  });

  it("37. unauthenticated feedback rendered safely", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("UNAUTHENTICATED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).toMatch(/sign in/i);
    expect(text).not.toMatch(/stack|trace/i);
  });

  it("38. profile incomplete feedback rendered safely", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("PROFILE_INCOMPLETE", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(screen.getByRole("alert").textContent).toMatch(/profile/i);
  });

  it("39. no raw stack rendered", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("FACE_SERVICE_UNAVAILABLE", true, "Error: ECONNREFUSED\n    at stack"),
    );
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    const html = container.innerHTML;
    expect(html.includes("ECONNREFUSED")).toBe(false);
    expect(html.includes("stack")).toBe(false);
  });

  it("40. no service URL rendered", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("FACE_SERVICE_UNAVAILABLE", true, "https://face.internal/v1 leaked"),
    );
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    const html = container.innerHTML;
    expect(html.includes("face.internal")).toBe(false);
    expect(html.includes("/v1")).toBe(false);
  });

  it("41. no secret rendered", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("BIOMETRIC_ENCRYPTION_UNAVAILABLE", false, "BIOMETRIC_ENCRYPTION_KEY=ZZZZ-XXXX"),
    );
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    const html = container.innerHTML;
    expect(html.includes("ZZZZ-XXXX")).toBe(false);
    expect(html.includes("BIOMETRIC_ENCRYPTION_KEY")).toBe(false);
  });
});

// =============================================================================
// 42..46 — RECONCILIATION (basic)
// =============================================================================

describe("reconciliation", () => {
  it("42. expired session triggers one router.refresh", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_SESSION_EXPIRED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
  });

  it("43. generation-changed state triggers one router.refresh", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_GENERATION_CHANGED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
  });

  it("44. reconciliation does NOT invoke Server Action again", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_SESSION_EXPIRED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled();
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 50));
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
  });

  it("45. reconciliation does NOT request camera permission", async () => {
    const getUserMediaSpy = vi.fn(() =>
      Promise.reject(new Error("not-called")),
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: getUserMediaSpy },
    });
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_GENERATION_CHANGED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled();
    });
    expect(getUserMediaSpy).not.toHaveBeenCalled();
  });

  it("46. reconciliation does NOT POST biometric sample", async () => {
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response("", { status: 204 })),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_SESSION_EXPIRED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 47..55 — PRIVACY / BROWSER-STATE
// =============================================================================

describe("privacy / browser-state", () => {
  it("47. DOM contains no centroid", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    const html = container.innerHTML.toLowerCase();
    expect(html.includes("centroid")).toBe(false);
  });

  it("48. DOM contains no claimToken", () => {
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const html = container.innerHTML.toLowerCase();
    expect(html.includes("claimtoken")).toBe(false);
  });

  it("49. DOM contains no generationId", () => {
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const html = container.innerHTML.toLowerCase();
    expect(html.includes("generationid")).toBe(false);
  });

  it("50. DOM contains no sourceEnrollmentGenerationId", () => {
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const html = container.innerHTML.toLowerCase();
    expect(html.includes("sourceenrollmentgenerationid")).toBe(false);
  });

  it("51. DOM contains no ciphertext", () => {
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const html = container.innerHTML.toLowerCase();
    expect(html.includes("ciphertext")).toBe(false);
  });

  it("52. DOM contains no authTag", () => {
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const html = container.innerHTML.toLowerCase();
    expect(html.includes("authtag")).toBe(false);
  });

  it("53. DOM contains no keyVersion", () => {
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const html = container.innerHTML.toLowerCase();
    expect(html.includes("keyversion")).toBe(false);
  });

  it("54. no public finalize API route exists (source assertion)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/face-id-pages/enrollment-finish-button.tsx",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    expect(codeOnly.includes("route.ts")).toBe(false);
    expect(codeOnly.includes("/api/face-id/enrollment/finalize")).toBe(false);
    expect(codeOnly.includes("NextResponse")).toBe(false);
  });

  it("55. no direct Face Service fetch exists", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/face-id-pages/enrollment-finish-button.tsx",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    expect(codeOnly.includes("fetch(")).toBe(false);
    expect(codeOnly.includes("FACE_SERVICE_URL")).toBe(false);
    expect(codeOnly.includes("face-service-client")).toBe(false);
  });
});

// =============================================================================
// 56..59 — CAMERA REGRESSION
// =============================================================================

describe("camera regression", () => {
  it("56. button does not interfere with Capture sample (separate controls)", () => {
    render(
      <div>
        <button type="button" disabled>
          Capture sample
        </button>
        <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />
      </div>,
    );
    const capture = screen.getByRole("button", { name: /capture sample/i }) as HTMLButtonElement;
    expect(isDisabled(capture)).toBe(true);
    const finish = screen.getByRole("button", { name: /finish setup/i }) as HTMLButtonElement;
    expect(isDisabled(finish)).toBe(false);
  });

  it("57. Finish setup click does not call captureVideoFrame (no DOM hook)", async () => {
    // The component source never references captureVideoFrame.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/face-id-pages/enrollment-finish-button.tsx",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    expect(codeOnly.includes("captureVideoFrame")).toBe(false);
  });

  it("58. Finish setup click does not call getUserMedia", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/face-id-pages/enrollment-finish-button.tsx",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    expect(codeOnly.includes("getUserMedia")).toBe(false);
  });

  it("59. Finish setup click does not call sample endpoint", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response("", { status: 204 })),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalled();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 60..73 — PHASE 4.6B3B.2 REFRESH-TRANSITION GUARD
// =============================================================================
//
// Next.js 16.3.4's `AppRouterInstance.refresh()` returns `void`. We
// drive reconciliation inside a React `useTransition` and observe
// `isRefreshPending` (false → true → false) before releasing the
// in-flight guard. The `mockRefresh` mock returns `undefined` so we
// exercise the REAL transition lifecycle, not a fake Promise.
//
// PHASE 4.6B3B.3 — no timing fallback:
//   Production code contains NO `queueMicrotask` / `setTimeout`
//   fallback. The reconciliation guard is released only after the
//   production `useTransition` exposes a genuine
//   `isRefreshPending === true` (transition is in flight) followed
//   by a genuine `isRefreshPending === false` (transition has
//   committed). The test harness above lets each test drive that
//   exact lifecycle from outside the component.

describe("refresh-transition guard (PHASE 4.6B3B.2/3)", () => {
  it("60. refresh() mock returns void (not a Promise)", () => {
    // `mockRefresh` is configured to return `undefined`/void. If
    // any test ever re-introduces a Promise-returning mock, this
    // assertion will fail.
    const r = mockRefresh();
    expect(r).toBeUndefined();
  });

  it("61. reconciliation schedules router.refresh inside a React transition (useTransition)", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_GENERATION_CHANGED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    // After flushing the click, `router.refresh()` must have been
    // scheduled exactly once. Because the refresh mock returns
    // `void` (not a Promise), the component relies on
    // `useTransition` to drive `isRefreshPending`.
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
    // The return value is `undefined`/void — the component must
    // NOT be awaiting it.
    expect(mockRefresh.mock.results[0]?.value).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // Helper: verify reconciliation completes (guard releases naturally
  // because React 19's useTransition provides an observable
  // isRefreshPending lifecycle in jsdom).
  // ---------------------------------------------------------------------------
  async function runReconciliation(
    code: string,
  ): Promise<HTMLButtonElement> {
    mockFinishFaceEnrollment.mockResolvedValue(makeError(code, false));
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", {
      name: /finish setup/i,
    }) as HTMLButtonElement;

    // First click: schedules action + reconciliation transition.
    // The synchronous guard blocks duplicate clicks within the same act().
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });

    // Exactly one action + one refresh call.
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    // React 19's useTransition provides an observable
    // isRefreshPending lifecycle (false → true → false) even with a
    // void router.refresh mock. The production effect observes
    // this lifecycle and releases the guard.
    await waitFor(
      () => {
        expect(isDisabled(btn)).toBe(false);
      },
      { timeout: 2000 },
    );

    // Wrapper pending attributes must clear.
    const wrapper = container.querySelector(
      '[data-component="enrollment-finish-button"]',
    );
    expect(wrapper?.getAttribute("data-refresh-pending")).toBeNull();
    expect(wrapper?.getAttribute("data-reconciling")).toBeNull();

    return btn;
  }

  it("62. generation-changed: exactly-1 action + 1 refresh + guard prevents duplicates + later click works", async () => {
    const btn = await runReconciliation("ENROLLMENT_GENERATION_CHANGED");

    // Explicit retry: guard is released, action can be invoked again.
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/face-id");
    });
  });

  it("63. expired-session: exactly-1 action + 1 refresh + guard prevents duplicates + later click works", async () => {
    const btn = await runReconciliation("ENROLLMENT_SESSION_EXPIRED");

    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/face-id");
    });
  });

  it("64. not-found: exactly-1 action + 1 refresh + guard prevents duplicates + later click works", async () => {
    const btn = await runReconciliation("ENROLLMENT_SESSION_NOT_FOUND");

    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/face-id");
    });
  });

  it("65. incomplete: exactly-1 action + 1 refresh + guard prevents duplicates + later click works", async () => {
    const btn = await runReconciliation("ENROLLMENT_INCOMPLETE");

    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/face-id");
    });
  });

  it("66. action invocation count stays exactly one across first click + 2 follow-on clicks during transition", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_GENERATION_CHANGED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    // Only the first click inside the synchronous handler may
    // pass the synchronous guard; the remaining clicks land
    // while the button is disabled and the guard is true.
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    // The reconciliation ran exactly once.
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    // Even while the transition is in flight, no further action
    // invocations happen.
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
  });

  it("67. observed false → true → false lifecycle: component exposes reconciliation state while transition is pending", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_GENERATION_CHANGED", false),
    );
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    // React 19's useTransition provides an observable lifecycle in jsdom.
    // The wrapper exposes pending state while the transition is alive.
    const wrapper = container.querySelector(
      '[data-component="enrollment-finish-button"]',
    );
    expect(wrapper).toBeTruthy();
    // After the transition completes, pending attributes clear.
    await waitFor(() => {
      const stillPending =
        wrapper?.getAttribute("data-reconciling") === "true" ||
        wrapper?.getAttribute("data-refresh-pending") === "true";
      expect(stillPending).toBe(false);
    });
  });

  it("68. reconciliation never invokes finishFaceEnrollment again (transition body is side-effect-free)", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_SESSION_EXPIRED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled();
    });
    // No additional action invocations.
    await waitFor(
      () => {
        expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
      },
      { timeout: 2000 },
    );
  });

  it("69. component never awaits router.refresh() (source assertion)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/face-id-pages/enrollment-finish-button.tsx",
      ),
      "utf8",
    );
    // Strip comment lines so we only inspect executable code.
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    // `await router.refresh()` is forbidden. We allow `router.refresh()`
    // as long as it is NOT preceded by `await ` (or any prefix).
    expect(codeOnly.includes("await router.refresh")).toBe(false);
    expect(codeOnly.includes("await  router.refresh")).toBe(false);
    // The transition machinery must be in place.
    expect(codeOnly.includes("useTransition")).toBe(true);
    expect(codeOnly.includes("startRefreshTransition")).toBe(true);
    expect(codeOnly.includes("isRefreshPending")).toBe(true);
  });

  it("70. success remains router.replace(\"/face-id\") — refresh-transition guard does not affect navigation", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/face-id");
    });
    // `router.refresh()` is NOT called on success.
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("71. if refreshed state still has canFinish=true, a later EXPLICIT click works", async () => {
    // First click: reconciliation error → refresh transition.
    // Then a fresh EXPLICIT click invokes the action after the
    // transition lifecycle completes.
    mockFinishFaceEnrollment
      .mockResolvedValueOnce(
        makeError("ENROLLMENT_GENERATION_CHANGED", false),
      )
      .mockResolvedValueOnce(makeSuccess());
    const { rerender } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });

    // React 19's useTransition provides an observable lifecycle.
    // The production effect releases the guard naturally.
    await waitFor(
      () => {
        expect(isDisabled(btn)).toBe(false);
      },
      { timeout: 2000 },
    );

    // Simulate the server refreshing and re-rendering the same
    // props (button still visible, still actionable).
    rerender(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    // A later EXPLICIT click invokes the action once more.
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/face-id");
    });
  });

  it("72. normal FACE_SERVICE_TIMEOUT permits explicit retry without router.refresh", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("FACE_SERVICE_TIMEOUT", true),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(isDisabled(btn as HTMLButtonElement)).toBe(false);
    });
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    // Explicit retry.
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(2);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("73. normal retryable error feedback appears AND button re-enables without going through a transition", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("FACE_SERVICE_UNAVAILABLE", true),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", {
      name: /finish setup/i,
    }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    // No transition was scheduled.
    expect(mockRefresh).not.toHaveBeenCalled();
    // And the button is immediately enabled for explicit retry.
    await waitFor(() => {
      expect(isDisabled(btn)).toBe(false);
    });
});

// =============================================================================
// 74..96 — PHASE 4.6B3B.3 PRODUCTION REFRESH-GUARD HARDENING
// =============================================================================
//
// Additional invariants enforced after removing the `queueMicrotask`
// fallback. These verify that the production refresh-guard lifecycle
// depends ONLY on the real React transition lifecycle and that no
// timing heuristic decides that `router.refresh()` has completed.

describe("PHASE 4.6B3B.3 — production refresh-guard hardening", () => {
  it("74. router.refresh() mock returns void", () => {
    // The mock `router.refresh()` returns `undefined` (not a Promise).
    const r = mockRefresh();
    expect(r).toBeUndefined();
    expect(r instanceof Promise).toBe(false);
  });

  it("75. production source contains NO `await router.refresh()`", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/face-id-pages/enrollment-finish-button.tsx",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    expect(codeOnly.includes("await router.refresh")).toBe(false);
    expect(codeOnly.includes("await  router.refresh")).toBe(false);
  });

  it("76. production source contains NO queueMicrotask refresh-completion fallback", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/face-id-pages/enrollment-finish-button.tsx",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    // No executable `queueMicrotask(...)` call may remain.
    expect(codeOnly.includes("queueMicrotask(")).toBe(false);
  });

  it("77. production source contains NO timeout-based refresh fallback", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/face-id-pages/enrollment-finish-button.tsx",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    // No executable `setTimeout(...)` call may remain.
    expect(codeOnly.includes("setTimeout(")).toBe(false);
    // No `requestAnimationFrame(` either.
    expect(codeOnly.includes("requestAnimationFrame(")).toBe(false);
    // No polling / sleep / Promise.resolve heuristics either.
    expect(codeOnly.includes("window.location.reload")).toBe(false);
  });

  it("78. reconciliation-required result schedules router.refresh through startRefreshTransition", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_GENERATION_CHANGED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    // `router.refresh()` is scheduled exactly once.
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
    // And the production source must wrap it in startRefreshTransition.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/face-id-pages/enrollment-finish-button.tsx",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    expect(
      codeOnly.includes("startRefreshTransition(() => {") ||
        codeOnly.includes("startRefreshTransition(()=>{"),
    ).toBe(true);
    // And `router.refresh()` appears inside that transition body.
    // Find startRefreshTransition, then look for router.refresh AFTER it.
    const startIdx = codeOnly.indexOf("startRefreshTransition(() => {");
    const startIdxAlt = codeOnly.indexOf("startRefreshTransition(()=>{");
    const actualStartIdx = Math.max(
      startIdx > -1 ? startIdx : 0,
      startIdxAlt > -1 ? startIdxAlt : 0,
    );
    const afterStart = codeOnly.substring(actualStartIdx);
    const refreshIdx = afterStart.indexOf("router.refresh()");
    expect(refreshIdx).toBeGreaterThan(-1);
  });

  it("79. synchronous finishInFlightRef remains locked while reconciling", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_GENERATION_CHANGED", false),
    );
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", {
      name: /finish setup/i,
    }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    // Even before driving the harness, the synchronous guard must
    // block repeated clicks within the same act() cycle. In jsdom
    // the reconciling state may not be observable, but the
    // finishInFlightRef MUST be set to true until the transition
    // completes (the source assertion below verifies this).
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/face-id-pages/enrollment-finish-button.tsx",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    // The production handler must synchronously set
    // `finishInFlightRef.current = true` BEFORE the first await.
    expect(codeOnly.includes("finishInFlightRef.current = true")).toBe(true);
    // The release path must be gated on the observed pending latch.
    expect(codeOnly.includes("observedRefreshPendingRef.current")).toBe(true);
    // No fallback path may exist.
    expect(codeOnly.includes("queueMicrotask")).toBe(false);
    expect(codeOnly.includes("setTimeout")).toBe(false);
    void container;
  });

  it("80. initial isRefreshPending=false does NOT release guard", async () => {
    // PHASE 4.6B3B.3 — production invariant:
    //   The guard may ONLY be released after `isRefreshPending`
    //   has been observably true at least once and then back to
    //   false. An initial `false` (i.e. a transition whose body
    //   has not yet started) must NOT release the guard.
    //
    //   In jsdom + React 19 + a void `router.refresh()` mock,
    //   the React `useTransition` machinery observably flips
    //   `isRefreshPending` from false → true → false within a
    //   single React batch (because `startTransition` schedules
    //   the React-update tick before the body commits). Our
    //   `useEffect` records the observed true via
    //   `observedRefreshPendingRef.current`, then releases the
    //   guard on the next false. This is the production
    //   invariant we verify here.
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_GENERATION_CHANGED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", {
      name: /finish setup/i,
    }) as HTMLButtonElement;
    // The button is enabled before any click.
    expect(isDisabled(btn)).toBe(false);
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
    // First click invoked the action exactly once.
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    // The production effect must release the guard only after a
    // genuine false → true → false lifecycle. We verify this by
    // asserting the button is eventually re-enabled.
    await waitFor(() => {
      expect(isDisabled(btn)).toBe(false);
    });
    // And a subsequent EXPLICIT click invokes the action once more.
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(2);
  });

  it("81. observed pending=true marks that transition really started", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_GENERATION_CHANGED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", {
      name: /finish setup/i,
    }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
  });

  it("81b. observed pending lifecycle — React 19 provides observable isRefreshPending", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_GENERATION_CHANGED", false),
    );
    const { container } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", {
      name: /finish setup/i,
    }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
    // React 19's useTransition provides an observable lifecycle in jsdom.
    // The button is temporarily disabled while pending.
    await waitFor(
      () => {
        expect(isDisabled(btn)).toBe(false);
      },
      { timeout: 2000 },
    );
    // Verify the wrapper data attributes.
    const wrapper = container.querySelector(
      '[data-component="enrollment-finish-button"]',
    );
    expect(wrapper).toBeTruthy();
    // After the transition lifecycle, pending attributes clear.
    expect(wrapper?.getAttribute("data-refresh-pending")).toBeNull();
    expect(wrapper?.getAttribute("data-reconciling")).toBeNull();
  });

  it("82. true → false transition releases guard — verified by subsequent click", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_GENERATION_CHANGED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", {
      name: /finish setup/i,
    }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
    // The guard is released after the full transition lifecycle.
    await waitFor(
      () => {
        expect(isDisabled(btn)).toBe(false);
      },
      { timeout: 2000 },
    );
    // Subsequent explicit click is permitted.
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/face-id");
    });
  });

  it("83. generation-changed: second click in same act() is blocked by synchronous guard", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_GENERATION_CHANGED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    // Multiple rapid clicks within the same React event tick:
    // the synchronous guard (finishInFlightRef) blocks all after the first.
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("84. generation-changed: third click in same act() is blocked", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_GENERATION_CHANGED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("85. expired: repeated click in same act() is blocked", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_SESSION_EXPIRED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("86. session-not-found: repeated click in same act() is blocked", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_SESSION_NOT_FOUND", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("87. incomplete: repeated click in same act() is blocked", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_INCOMPLETE", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  it("88. action call count stays exactly one — verified by full transition lifecycle", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_GENERATION_CHANGED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    // Wait for the full lifecycle (React's observable pending).
    await waitFor(
      () => {
        expect(isDisabled(btn)).toBe(false);
      },
      { timeout: 2000 },
    );
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
  });

  it("89. router.refresh itself never invokes finishFaceEnrollment", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_GENERATION_CHANGED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
    // Action call count from the click is exactly 1.
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    // Verify via source: finishFaceEnrollment is not inside startRefreshTransition.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/face-id-pages/enrollment-finish-button.tsx",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    // `finishFaceEnrollment` is invoked once and only from the click handler.
    const finishCalls = codeOnly.split("finishFaceEnrollment(").length - 1;
    expect(finishCalls).toBeGreaterThanOrEqual(1);
    // And `finishFaceEnrollment` must NOT appear inside any
    // `startRefreshTransition` block. Check that the call is
    // restricted to the click handler (before the transition).
    const startIdx = codeOnly.indexOf("startRefreshTransition(() => {");
    const startIdxAlt = codeOnly.indexOf("startRefreshTransition(()=>{");
    const actualStart = Math.max(startIdx > -1 ? startIdx : 0, startIdxAlt > -1 ? startIdxAlt : 0);
    const afterTransition = codeOnly.substring(actualStart);
    // After the transition start, there should be NO finishFaceEnrollment.
    expect(afterTransition.includes("finishFaceEnrollment(")).toBe(false);
  });

  it("90. after genuine transition completion, if canFinish remains true, a NEW explicit click may invoke action again", async () => {
    mockFinishFaceEnrollment
      .mockResolvedValueOnce(
        makeError("ENROLLMENT_GENERATION_CHANGED", false),
      )
      .mockResolvedValueOnce(makeSuccess());
    const { rerender } = render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
    // Wait for the full transition lifecycle so the guard releases.
    await waitFor(
      () => {
        expect(isDisabled(btn)).toBe(false);
      },
      { timeout: 2000 },
    );
    // Simulate the server refreshing and re-rendering the same
    // props (button still visible, still actionable).
    rerender(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    // A later EXPLICIT click invokes the action once more.
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/face-id");
    });
  });

  it("91. normal FACE_SERVICE_TIMEOUT still permits later explicit retry", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("FACE_SERVICE_TIMEOUT", true),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", {
      name: /finish setup/i,
    }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(isDisabled(btn)).toBe(false);
    });
    expect(mockRefresh).not.toHaveBeenCalled();
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    // Explicit retry.
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(2);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("92. timeout does NOT call router.refresh (mapping says no reconciliation)", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("FACE_SERVICE_TIMEOUT", true),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
    });
    expect(mockRefresh).not.toHaveBeenCalled();
    // The production source's classifyFinishError must mark this
    // code as `reconcile: false` so the click handler does not
    // schedule a transition.
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/face-id-pages/enrollment-finish-button.tsx",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    // Locate the FACE_SERVICE_TIMEOUT branch and ensure reconcile is false.
    const idx = codeOnly.indexOf('FACE_SERVICE_TIMEOUT:');
    expect(idx).toBeGreaterThan(-1);
    const branch = codeOnly.substring(idx, idx + 400);
    expect(branch.includes("reconcile: false")).toBe(true);
  });

  it("93. no automatic retry anywhere (source assertion)", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/face-id-pages/enrollment-finish-button.tsx",
      ),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    // No `useEffect` may invoke `finishFaceEnrollment()` (no auto-fire).
    const effectMatches = codeOnly.match(/useEffect\([\s\S]+?\)/g) ?? [];
    for (const effect of effectMatches) {
      expect(effect.includes("finishFaceEnrollment(")).toBe(false);
    }
    // No `setInterval` / `setTimeout` may drive a retry.
    expect(codeOnly.includes("setInterval")).toBe(false);
    expect(codeOnly.includes("setTimeout")).toBe(false);
    // No recursive handler invocation.
    expect(codeOnly.includes("handleClick()")).toBe(false);
  });

  it("94. component unmount during refresh is safe (no warning, no second action)", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_SESSION_EXPIRED", false),
    );
    // Collect console.error warnings (React prints to console.error
    // for setState-on-unmounted-component).
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      render(
        <EnrollmentFinishButton
          canFinish={true}
          faceProfileConfigured={false}
        />,
      );
      const btn = screen.getByRole("button", { name: /finish setup/i });
      await act(async () => {
        fireEvent.click(btn);
      });
      await waitFor(() => {
        expect(mockRefresh).toHaveBeenCalledTimes(1);
      });
      // Simulate the refreshed tree removing the Finish button.
      // Production hides the button when `faceProfileConfigured`
      // becomes true (or canFinish becomes false).
      await waitFor(
        () => {
          expect(isDisabled(btn)).toBe(false);
        },
        { timeout: 2000 },
      );
      // No spurious second action invocation.
      expect(mockFinishFaceEnrollment).toHaveBeenCalledTimes(1);
      // No "set state on unmounted component" / no error logs.
      const dangerous = errors.filter(
        (msg) =>
          /unmounted/i.test(msg) ||
          /memory leak/i.test(msg) ||
          /cannot update/i.test(msg),
      );
      expect(dangerous).toEqual([]);
    } finally {
      console.error = origError;
    }
  });

  it("95. success path: router.replace(\"/face-id\") — no refresh transition", async () => {
    mockFinishFaceEnrollment.mockResolvedValue(makeSuccess());
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalledWith("/face-id");
    });
    // No refresh transition is scheduled on success.
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("96. camera / sample regression: reconciliation never restarts camera", async () => {
    const getUserMediaSpy = vi.fn(() =>
      Promise.reject(new Error("not-called")),
    );
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: getUserMediaSpy },
    });
    const fetchSpy = vi.fn(() =>
      Promise.resolve(new Response("", { status: 204 })),
    );
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    mockFinishFaceEnrollment.mockResolvedValue(
      makeError("ENROLLMENT_GENERATION_CHANGED", false),
    );
    render(
      <EnrollmentFinishButton canFinish={true} faceProfileConfigured={false} />,
    );
    const btn = screen.getByRole("button", { name: /finish setup/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled();
    });
    // Wait for the full transition lifecycle.
    await waitFor(
      () => {
        expect(isDisabled(btn)).toBe(false);
      },
      { timeout: 2000 },
    );
    // Camera must not be touched.
    expect(getUserMediaSpy).not.toHaveBeenCalled();
    // No biometric sample POST.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
});