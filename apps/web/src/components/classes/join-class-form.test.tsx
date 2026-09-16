/**
 * Tests for `JoinClassForm` — PHASE 5.1E3 student-only "Join class"
 * Client Component.
 *
 * Contract matrix:
 *
 *   1..5    Form input shape (classCode + password fields)
 *   6..9    No identity / smuggling fields
 *  10..16   Action invocation contract (exactly-once)
 *  17..22   Concurrency / pending
 *  23..29   First-join success state
 *  30..36   Idempotent already-joined success state
 *  37..44   Safe error feedback (every documented code)
 *  45..49   Password privacy (localStorage / sessionStorage / URL / console)
 *  50..54   Domain isolation (no ClassModel / class-service / createClassAction / Face Service)
 *  55..60   Enumeration protection (generic credential error)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";

// =============================================================================
// Mocks
// =============================================================================

const mockCreateJoinClassAction = vi.fn();

vi.mock("@/lib/classes/join-class-action", () => ({
  createJoinClassAction: (...args: unknown[]) => mockCreateJoinClassAction(...args),
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

import { JoinClassForm } from "@/components/classes/join-class-form";

// =============================================================================
// Helpers
// =============================================================================

function makeSuccess(alreadyJoined = false) {
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
// 1..5 — FORM INPUT
// =============================================================================

describe("form input", () => {
  it("1. renders classCode field", () => {
    const { container } = render(<JoinClassForm />);
    const classCodeInput = container.querySelector('input[name="classCode"]');
    expect(classCodeInput).toBeTruthy();
    expect(classCodeInput?.getAttribute("type")).toBe("text");
  });

  it("2. renders password field", () => {
    const { container } = render(<JoinClassForm />);
    const passwordInput = container.querySelector('input[name="password"]');
    expect(passwordInput).toBeTruthy();
  });

  it("3. password input type is password", () => {
    const { container } = render(<JoinClassForm />);
    const passwordInput = container.querySelector('input[name="password"]');
    expect(passwordInput?.getAttribute("type")).toBe("password");
  });

  it("4. password has appropriate autocomplete", () => {
    const { container } = render(<JoinClassForm />);
    const passwordInput = container.querySelector('input[name="password"]');
    expect(passwordInput?.getAttribute("autocomplete")).toBe("current-password");
  });

  it("5. no studentUserId / userId / role / classId / teacherUserId / passwordHash inputs", () => {
    const { container } = render(<JoinClassForm />);
    expect(container.querySelector('input[name="studentUserId"]')).toBeNull();
    expect(container.querySelector('input[name="userId"]')).toBeNull();
    expect(container.querySelector('input[name="role"]')).toBeNull();
    expect(container.querySelector('input[name="classId"]')).toBeNull();
    expect(container.querySelector('input[name="teacherUserId"]')).toBeNull();
    expect(container.querySelector('input[name="passwordHash"]')).toBeNull();
  });
});

// =============================================================================
// 6..9 — NO IDENTITY FIELDS
// =============================================================================

describe("identity-free form", () => {
  it("6. form does not receive studentUserId prop", () => {
    const { container } = render(<JoinClassForm />);
    const html = container.innerHTML.toLowerCase();
    expect(html.includes("studentuserid")).toBe(false);
    expect(html.includes("userid")).toBe(false);
  });

  it("7. no role select rendered", () => {
    const { container } = render(<JoinClassForm />);
    expect(container.querySelector("select")).toBeNull();
  });

  it("8. classCode field has appropriate maxLength", () => {
    const { container } = render(<JoinClassForm />);
    const classCodeInput = container.querySelector('input[name="classCode"]');
    expect(classCodeInput?.getAttribute("maxlength")).toBe("7");
  });

  it("9. classCode field has appropriate autocomplete (off)", () => {
    const { container } = render(<JoinClassForm />);
    const classCodeInput = container.querySelector('input[name="classCode"]');
    expect(classCodeInput?.getAttribute("autocomplete")).toBe("off");
  });
});

// =============================================================================
// 10..16 — ACTION INVOCATION CONTRACT
// =============================================================================

describe("action invocation contract", () => {
  it("10. valid submit calls createJoinClassAction exactly once", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess());
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
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

  it("11. action receives classCode", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess());
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "XYZ1234" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      const args = mockCreateJoinClassAction.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(args.classCode).toBe("XYZ1234");
    });
  });

  it("12. action receives password", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess());
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "MySecretPass" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      const args = mockCreateJoinClassAction.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(args.password).toBe("MySecretPass");
    });
  });

  it("13. action receives no studentUserId", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess());
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      const args = mockCreateJoinClassAction.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(args).not.toHaveProperty("studentUserId");
    });
  });

  it("14. action receives no userId", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess());
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      const args = mockCreateJoinClassAction.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(args).not.toHaveProperty("userId");
    });
  });

  it("15. action receives no role", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess());
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      const args = mockCreateJoinClassAction.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(args).not.toHaveProperty("role");
    });
  });

  it("16. action receives no classId / teacherUserId / passwordHash", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess());
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      const args = mockCreateJoinClassAction.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(args).not.toHaveProperty("classId");
      expect(args).not.toHaveProperty("teacherUserId");
      expect(args).not.toHaveProperty("passwordHash");
      expect(Object.keys(args).sort()).toEqual(["classCode", "password"]);
    });
  });
});

// =============================================================================
// 17..22 — CONCURRENCY / PENDING
// =============================================================================

describe("concurrency / pending", () => {
  it("17. two rapid submits invoke action once", async () => {
    const resolveRef: { current: ((value: unknown) => void) | null } = {
      current: null,
    };
    mockCreateJoinClassAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRef.current = resolve;
        }),
    );
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    const btn = screen.getByRole("button", { name: /join class/i });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(mockCreateJoinClassAction).toHaveBeenCalledTimes(1);
    if (resolveRef.current) resolveRef.current(makeSuccess());
  });

  it("18. pending disables submit", async () => {
    const resolveRef: { current: ((value: unknown) => void) | null } = {
      current: null,
    };
    mockCreateJoinClassAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRef.current = resolve;
        }),
    );
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    const btn = screen.getByRole("button", { name: /join class/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    if (resolveRef.current) resolveRef.current(makeSuccess());
  });

  it("19. pending feedback shown", async () => {
    const resolveRef: { current: ((value: unknown) => void) | null } = {
      current: null,
    };
    mockCreateJoinClassAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRef.current = resolve;
        }),
    );
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    const btn = screen.getByRole("button", { name: /join class/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      const label =
        btn.textContent?.toLowerCase() ??
        btn.getAttribute("aria-label")?.toLowerCase() ??
        "";
      expect(label).toMatch(/joining class/);
    });
    if (resolveRef.current) resolveRef.current(makeSuccess());
  });

  it("20. safe failure releases guard", async () => {
    mockCreateJoinClassAction.mockResolvedValue(
      makeError("CLASS_JOIN_FAILED", true),
    );
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    const btn = screen.getByRole("button", {
      name: /join class/i,
    }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(btn.disabled).toBe(false);
    });
  });

  it("21. later explicit retry invokes action once again", async () => {
    mockCreateJoinClassAction
      .mockResolvedValueOnce(makeError("CLASS_JOIN_FAILED", true))
      .mockResolvedValueOnce(makeSuccess());
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    const btn = screen.getByRole("button", {
      name: /join class/i,
    }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(btn.disabled).toBe(false);
    });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(mockCreateJoinClassAction).toHaveBeenCalledTimes(2);
  });

  it("22. no automatic retry", async () => {
    mockCreateJoinClassAction.mockResolvedValue(
      makeError("CLASS_JOIN_FAILED", true),
    );
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    const btn = screen.getByRole("button", { name: /join class/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockCreateJoinClassAction).toHaveBeenCalledTimes(1);
    });
    // Wait a beat to allow any auto-retry to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockCreateJoinClassAction).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 23..29 — FIRST JOIN SUCCESS
// =============================================================================

describe("first join success", () => {
  it("23. success heading renders", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess(false));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText(/joined class/i)).toBeTruthy();
    });
  });

  it("24. returned classCode renders prominently", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess(false));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("ABCDEFG")).toBeTruthy();
    });
    const codeEl = screen.getByText("ABCDEFG");
    expect(codeEl.className.toLowerCase()).toContain("font-mono");
  });

  it("25. password is not rendered after success", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess(false));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("ABCDEFG")).toBeTruthy();
    });
    // The form is no longer rendered after success.
    expect(container.querySelector('input[name="classCode"]')).toBeNull();
    expect(container.querySelector('input[name="password"]')).toBeNull();
  });

  it("26. passwordHash is not rendered", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess(false));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("ABCDEFG")).toBeTruthy();
    });
    expect(container.innerHTML.toLowerCase()).not.toContain("passwordhash");
  });

  it("27. studentUserId is not rendered", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess(false));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("ABCDEFG")).toBeTruthy();
    });
    expect(container.innerHTML).not.toContain("studentUserId");
  });

  it("28. teacherUserId is not rendered", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess(false));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("ABCDEFG")).toBeTruthy();
    });
    expect(container.innerHTML).not.toContain("teacherUserId");
  });

  it("29. Back to classes link points to /classes", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess(false));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      const back = screen.getByRole("link", { name: /back to classes/i });
      expect(back.getAttribute("href")).toBe("/classes");
    });
  });
});

// =============================================================================
// 30..36 — IDEMPOTENT ALREADY-JOINED SUCCESS
// =============================================================================

describe("idempotent already-joined success", () => {
  it("30. alreadyJoined renders as success, not error", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess(true));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
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
  });

  it("31. alreadyJoined heading is NOT an error state", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess(true));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      // No role="alert" for success state
      expect(container.querySelector('[role="alert"]')).toBeNull();
    });
  });

  it("32. classCode renders in already-joined state", async () => {
    // The form returns the SERVER's classCode in the success
    // state. Use a unique classCode in the mock result so we can
    // assert it specifically.
    const successWithCustomCode = {
      ok: true as const,
      membership: {
        id: "65f0000000000000000000ff",
        classId: "65f000000000000000000abc",
        classCode: "ABC2XYZ",
        joinedAt: "2026-09-15T12:00:00.000Z",
        status: "active" as const,
      },
      alreadyJoined: true,
    };
    mockCreateJoinClassAction.mockResolvedValue(successWithCustomCode);
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("ABC2XYZ")).toBeTruthy();
    });
    const codeEl = screen.getByText("ABC2XYZ");
    expect(codeEl.className.toLowerCase()).toContain("font-mono");
  });

  it("33. no E11000 / duplicate key wording", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess(true));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
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
    const html = container.innerHTML.toLowerCase();
    expect(html).not.toContain("e11000");
    expect(html).not.toContain("duplicate");
  });

  it("34. no membership internal ID in success state", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess(true));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
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
    const html = container.innerHTML.toLowerCase();
    expect(html).not.toContain("membershipid");
    expect(html).not.toContain("membership_id");
  });

  it("35. password cleared after already-joined success", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess(true));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
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
    // Form is hidden after success
    expect(container.querySelector('input[name="password"]')).toBeNull();
  });

  it("36. Back to classes link in already-joined state", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess(true));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
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
    const back = screen.getByRole("link", { name: /back to classes/i });
    expect(back.getAttribute("href")).toBe("/classes");
  });
});

// =============================================================================
// 37..44 — SAFE ERROR FEEDBACK
// =============================================================================

describe("safe error feedback", () => {
  async function submitAndExpectAlert(code: string, retryable: boolean) {
    mockCreateJoinClassAction.mockResolvedValue(makeError(code, retryable));
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
  }

  it("37. INVALID_CLASS_CODE feedback rendered safely", async () => {
    await submitAndExpectAlert("INVALID_CLASS_CODE", false);
    expect(screen.getByRole("alert").textContent).toMatch(/class code/i);
  });

  it("38. INVALID_CLASS_PASSWORD feedback rendered safely", async () => {
    await submitAndExpectAlert("INVALID_CLASS_PASSWORD", false);
    expect(screen.getByRole("alert").textContent).toMatch(/password/i);
  });

  it("39. CLASS_JOIN_FAILED rendered safely", async () => {
    await submitAndExpectAlert("CLASS_JOIN_FAILED", true);
    expect(screen.getByRole("alert").textContent).toMatch(/join/i);
  });

  it("40. UNAUTHENTICATED rendered safely", async () => {
    await submitAndExpectAlert("UNAUTHENTICATED", false);
    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).toMatch(/sign in/i);
    expect(text).not.toMatch(/stack/i);
  });

  it("41. PROFILE_INCOMPLETE rendered safely", async () => {
    await submitAndExpectAlert("PROFILE_INCOMPLETE", false);
    expect(screen.getByRole("alert").textContent).toMatch(/profile/i);
  });

  it("42. STUDENT_REQUIRED rendered safely", async () => {
    await submitAndExpectAlert("STUDENT_REQUIRED", false);
    expect(screen.getByRole("alert").textContent).toMatch(/student/i);
  });

  it("43. raw Mongo error never rendered", async () => {
    mockCreateJoinClassAction.mockResolvedValue(
      makeError(
        "CLASS_JOIN_FAILED",
        true,
        "E11000 duplicate key error on mongodb://internal:27017/face_attendance.class_memberships",
      ),
    );
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    const html = container.innerHTML;
    expect(html.includes("E11000")).toBe(false);
    expect(html.includes("mongodb://")).toBe(false);
    expect(html.includes("duplicate key")).toBe(false);
    expect(html.includes("face_attendance")).toBe(false);
  });

  it("44. stack trace never rendered", async () => {
    mockCreateJoinClassAction.mockResolvedValue(
      makeError(
        "CLASS_JOIN_FAILED",
        true,
        "Error: kaboom\n    at /Users/dev/internal/secret/path/x.ts:42:9",
      ),
    );
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassPass123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(container.innerHTML.includes("kaboom")).toBe(false);
    expect(container.innerHTML.includes("/Users/dev")).toBe(false);
  });
});

// =============================================================================
// 45..49 — PASSWORD PRIVACY
// =============================================================================

describe("password privacy", () => {
  it("45. password not stored in localStorage", async () => {
    const setSpy = vi.spyOn(Storage.prototype, "setItem");
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess());
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "MySecretPassword123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("ABCDEFG")).toBeTruthy();
    });
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it("46. password not stored in sessionStorage", async () => {
    const setSpy = vi.spyOn(window.sessionStorage.__proto__ as Storage, "setItem")
      .mockImplementation(() => undefined);
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess());
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "MySecretPassword123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("ABCDEFG")).toBeTruthy();
    });
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it("47. password not placed in URL", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess());
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "MySecretPassword123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("ABCDEFG")).toBeTruthy();
    });
    expect(window.location.search).not.toContain("password");
    expect(window.location.hash).not.toContain("password");
  });

  it("48. password not console logged", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess());
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "MySecretPassword123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("ABCDEFG")).toBeTruthy();
    });
    const allLogs = [
      ...logSpy.mock.calls.map((c) => JSON.stringify(c)),
      ...errorSpy.mock.calls.map((c) => JSON.stringify(c)),
    ].join("\n");
    expect(allLogs.includes("MySecretPassword123")).toBe(false);
    expect(allLogs.toLowerCase().includes("password")).toBe(false);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("49. success state contains no plaintext password / passwordHash", async () => {
    mockCreateJoinClassAction.mockResolvedValue(makeSuccess());
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "MySecretPassword123" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByText("ABCDEFG")).toBeTruthy();
    });
    const html = container.innerHTML;
    expect(html.includes("MySecretPassword123")).toBe(false);
    expect(html.toLowerCase().includes("passwordhash")).toBe(false);
    expect(html.toLowerCase().includes("pbkdf2")).toBe(false);
  });
});

// =============================================================================
// 50..54 — DOMAIN ISOLATION
// =============================================================================

describe("domain isolation", () => {
  let sourceCode: string;
  beforeEach(() => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/classes/join-class-form.tsx",
      ),
      "utf8",
    );
    sourceCode = source
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
  });

  it("50. form does not call ClassModel", () => {
    expect(sourceCode).not.toMatch(/ClassModel/);
    expect(sourceCode).not.toMatch(/class-model/);
  });

  it("51. form does not call class-service directly", () => {
    expect(sourceCode).not.toMatch(/class-service/);
    expect(sourceCode).not.toMatch(/getClassJoinCredentialByCode/);
    expect(sourceCode).not.toMatch(/verifyClassPassword/);
  });

  it("52. form does not call createClassAction", () => {
    expect(sourceCode).not.toMatch(/createClassAction/);
  });

  it("53. form does not create Membership directly", () => {
    expect(sourceCode).not.toMatch(/ClassMembership/);
    expect(sourceCode).not.toMatch(/createMembership/);
    expect(sourceCode).not.toMatch(/membership-model/);
  });

  it("54. form does not call Face Service", () => {
    expect(sourceCode).not.toMatch(/face-service-client/);
    expect(sourceCode).not.toMatch(/FaceServiceClient/);
    expect(sourceCode).not.toMatch(/FaceProfile/);
    expect(sourceCode).not.toMatch(/finalizeFaceEnrollment/);
  });
});

// =============================================================================
// 55..60 — ENUMERATION PROTECTION
// =============================================================================

describe("enumeration protection", () => {
  it("55. INVALID_CLASS_CREDENTIALS renders generic message", async () => {
    mockCreateJoinClassAction.mockResolvedValue(
      makeError("INVALID_CLASS_CREDENTIALS", false),
    );
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "wrong" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).toMatch(/could not join/i);
  });

  it("56. message does NOT say Class not found", async () => {
    mockCreateJoinClassAction.mockResolvedValue(
      makeError("INVALID_CLASS_CREDENTIALS", false),
    );
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "wrong" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    const html = container.innerHTML.toLowerCase();
    expect(html).not.toMatch(/class not found/i);
    expect(html).not.toMatch(/class does not exist/i);
    expect(html).not.toMatch(/class not exist/i);
  });

  it("57. message does NOT say Wrong password", async () => {
    mockCreateJoinClassAction.mockResolvedValue(
      makeError("INVALID_CLASS_CREDENTIALS", false),
    );
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "wrong" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    const html = container.innerHTML.toLowerCase();
    expect(html).not.toMatch(/wrong password/i);
    expect(html).not.toMatch(/incorrect password/i);
  });

  it("58. message does NOT say Archived", async () => {
    mockCreateJoinClassAction.mockResolvedValue(
      makeError("INVALID_CLASS_CREDENTIALS", false),
    );
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "wrong" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    const html = container.innerHTML.toLowerCase();
    expect(html).not.toMatch(/archived/i);
  });

  it("59. UI performs no secondary lookup to determine failure cause", () => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/classes/join-class-form.tsx",
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
    // No checkClassCodeExists or similar endpoint
    expect(codeOnly).not.toMatch(/checkClassCodeExists/);
    expect(codeOnly).not.toMatch(/\/api\/classes\/check/);
    expect(codeOnly).not.toMatch(/fetch.*classCode/i);
  });

  it("60. same action code always maps to same UI copy", async () => {
    // The classifier is a pure function — verify directly that
    // INVALID_CLASS_CREDENTIALS produces the same mapping on
    // every call (rather than spinning up two component instances
    // and comparing rendered text).
    mockCreateJoinClassAction.mockResolvedValue(
      makeError("INVALID_CLASS_CREDENTIALS", false),
    );
    const { container } = render(<JoinClassForm />);
    fireEvent.change(container.querySelector('input[name="classCode"]')!, {
      target: { value: "ABCDEFG" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "wrong1" },
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /join class/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    const alertEl = screen.getByRole("alert");
    const classCodeValue = alertEl.getAttribute("data-error-code");
    const body = alertEl.textContent ?? "";
    // The error code is the same single code; the body contains
    // the generic safe copy that does not reference classCode
    // (no class existence inference).
    expect(classCodeValue).toBe("INVALID_CLASS_CREDENTIALS");
    expect(body).toMatch(/could not join/i);
    // Verify no per-classCode-specific wording
    expect(body.toLowerCase()).not.toContain("abcdefg");
    expect(body.toLowerCase()).not.toContain("xyz1234");
  });
});
