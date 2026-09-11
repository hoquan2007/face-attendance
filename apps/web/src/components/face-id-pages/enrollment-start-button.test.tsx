/**
 * Tests for `EnrollmentStartButton`.
 *
 * PHASE 4.5B1 — Face ID Page Shell.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as React from "react";

// =============================================================================
// Mock the server action module
// =============================================================================

const mockStartFaceEnrollment = vi.fn();

vi.mock("@/lib/biometrics/enrollment-start-action", () => ({
  startFaceEnrollment: () => mockStartFaceEnrollment(),
}));

// Mock next/navigation
const mockRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mockRefresh,
    push: vi.fn(),
    back: vi.fn(),
  }),
}));

import { EnrollmentStartButton } from "@/components/face-id-pages/enrollment-start-button";

describe("EnrollmentStartButton", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the default label", () => {
    render(<EnrollmentStartButton />);
    const buttons = screen.getAllByRole("button", { name: /set up face id/i });
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("renders a custom label", () => {
    render(<EnrollmentStartButton label="Restart setup" />);
    const buttons = screen.getAllByRole("button", { name: /restart setup/i });
    expect(buttons.length).toBeGreaterThan(0);
  });

  it("triggers exactly one startFaceEnrollment call per click", async () => {
    mockStartFaceEnrollment.mockResolvedValue({
      ok: true,
      status: "started",
      mode: "create",
      acceptedSamples: 0,
      requiredSamples: 5,
      expiresAt: new Date().toISOString(),
    });
    render(<EnrollmentStartButton />);
    const button = screen.getByRole("button", { name: /set up face id/i });
    fireEvent.click(button);
    await waitFor(() => {
      expect(mockStartFaceEnrollment).toHaveBeenCalledTimes(1);
    });
  });

  it("calls router.refresh on success", async () => {
    mockStartFaceEnrollment.mockResolvedValue({
      ok: true,
      status: "started",
      mode: "create",
      acceptedSamples: 0,
      requiredSamples: 5,
      expiresAt: new Date().toISOString(),
    });
    render(<EnrollmentStartButton />);
    fireEvent.click(screen.getByRole("button", { name: /set up face id/i }));
    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalledTimes(1);
    });
  });

  it("does NOT send any userId via the request", async () => {
    mockStartFaceEnrollment.mockResolvedValue({
      ok: true,
      status: "started",
      mode: "create",
      acceptedSamples: 0,
      requiredSamples: 5,
      expiresAt: new Date().toISOString(),
    });
    render(<EnrollmentStartButton />);
    fireEvent.click(screen.getByRole("button", { name: /set up face id/i }));
    await waitFor(() => {
      const calls = mockStartFaceEnrollment.mock.calls;
      expect(calls.length).toBe(1);
      // Either no args, or an empty object (no userId).
      for (const callArgs of calls) {
        if (callArgs.length > 0) {
          const first = callArgs[0];
          expect(first).not.toHaveProperty("userId");
        }
      }
    });
  });

  it("disables button while pending and re-enables after success", async () => {
    let resolveFn: (value: unknown) => void = () => {};
    mockStartFaceEnrollment.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFn = resolve;
        }),
    );
    render(<EnrollmentStartButton />);
    const button = screen.getByRole(
      "button",
    ) as HTMLButtonElement;

    // First click triggers the pending state.
    fireEvent.click(button);

    // While pending the button should be disabled.
    await waitFor(() => {
      expect(button.disabled).toBe(true);
    });

    // Resolve the promise.
    resolveFn({
      ok: true,
      status: "started",
      mode: "create",
      acceptedSamples: 0,
      requiredSamples: 5,
      expiresAt: new Date().toISOString(),
    });

    await waitFor(() => {
      expect(button.disabled).toBe(false);
    });
  });

  it("shows friendly error message on failure", async () => {
    mockStartFaceEnrollment.mockResolvedValue({
      ok: false,
      error: {
        code: "FACE_PROFILE_ALREADY_EXISTS",
        message: "raw-safe-message",
      },
    });
    render(<EnrollmentStartButton />);
    fireEvent.click(screen.getByRole("button", { name: /set up face id/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/already configured/i);
    // Ensure raw error.message is NOT leaked.
    expect(alert.textContent).not.toContain("raw-safe-message");
  });

  it("shows enrollment-start-failed message on persistence error", async () => {
    mockStartFaceEnrollment.mockResolvedValue({
      ok: false,
      error: {
        code: "ENROLLMENT_START_FAILED",
        message: "raw-message",
      },
    });
    render(<EnrollmentStartButton />);
    fireEvent.click(screen.getByRole("button", { name: /set up face id/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/try again/i);
    expect(alert.textContent).not.toContain("raw-message");
  });

  it("does not call router.refresh on failure", async () => {
    mockStartFaceEnrollment.mockResolvedValue({
      ok: false,
      error: { code: "ENROLLMENT_START_FAILED", message: "msg" },
    });
    render(<EnrollmentStartButton />);
    fireEvent.click(screen.getByRole("button", { name: /set up face id/i }));
    const alert = await waitFor(() => screen.getByRole("alert"));
    expect(alert).toBeDefined();
    expect(mockRefresh).not.toHaveBeenCalled();
  });
});
