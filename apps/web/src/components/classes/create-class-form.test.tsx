/**
 * Tests for `CreateClassForm` — PHASE 5.1E2 teacher-only "Create
 * class" Client Component.
 *
 * Contract matrix:
 *
 *   1..6    Form input shape (name + password fields)
 *   7..12   No identity / smuggling fields
 *  13..18   Action invocation contract (exactly-once)
 *  19..24   Concurrency / pending
 *  25..32   Success state (classCode prominent, password never echoed)
 *  33..40   Safe error feedback (every documented code)
 *  41..45   Password privacy (localStorage / sessionStorage / URL /
 *           console / success state)
 *  46..52   Domain isolation (no ClassModel / class-service /
 *           joinClassAction / Face Service / FaceProfile /
 *           attendance)
 *  53..55   Routes / no public API
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";

// =============================================================================
// Mocks
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

import { CreateClassForm } from "@/components/classes/create-class-form";

// =============================================================================
// Helpers
// =============================================================================

function makeSuccess() {
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
// 1..6 — FORM INPUT
// =============================================================================

describe("form input", () => {
  it("1. renders name field", () => {
    const { container } = render(<CreateClassForm />);
    const nameInput = container.querySelector('input[name="name"]');
    expect(nameInput).toBeTruthy();
    expect(nameInput?.getAttribute("type")).toBe("text");
  });

  it("2. renders password field", () => {
    const { container } = render(<CreateClassForm />);
    const passwordInput = container.querySelector('input[name="password"]');
    expect(passwordInput).toBeTruthy();
  });

  it("3. password input type is password", () => {
    const { container } = render(<CreateClassForm />);
    const passwordInput = container.querySelector('input[name="password"]');
    expect(passwordInput?.getAttribute("type")).toBe("password");
  });

  it("4. password has appropriate autocomplete", () => {
    const { container } = render(<CreateClassForm />);
    const passwordInput = container.querySelector('input[name="password"]');
    expect(passwordInput?.getAttribute("autocomplete")).toBe("new-password");
  });

  it("5. no teacherUserId field rendered", () => {
    const { container } = render(<CreateClassForm />);
    expect(
      container.querySelector('input[name="teacherUserId"]'),
    ).toBeNull();
    expect(
      container.querySelector('input[name="teacher_user_id"]'),
    ).toBeNull();
    expect(container.innerHTML.toLowerCase()).not.toContain(
      "teacheruserid",
    );
  });

  it("6. no userId / classCode / passwordHash / role inputs", () => {
    const { container } = render(<CreateClassForm />);
    expect(container.querySelector('input[name="userId"]')).toBeNull();
    expect(container.querySelector('input[name="classCode"]')).toBeNull();
    expect(container.querySelector('input[name="passwordHash"]')).toBeNull();
    expect(container.querySelector('input[name="role"]')).toBeNull();
    expect(container.querySelector('select[name="role"]')).toBeNull();
  });
});

// =============================================================================
// 7..12 — NO IDENTITY FIELDS, NO SMUGGLING
// =============================================================================

describe("identity-free form", () => {
  it("7. form does not receive teacherUserId prop", () => {
    // The component's TS interface intentionally excludes any
    // identity prop. The runtime check below confirms the
    // rendered HTML does not leak any viewer identity.
    const { container } = render(<CreateClassForm />);
    const html = container.innerHTML.toLowerCase();
    expect(html.includes("teacheruserid")).toBe(false);
    expect(html.includes("userid")).toBe(false);
  });

  it("8. no role select rendered", () => {
    const { container } = render(<CreateClassForm />);
    expect(container.querySelector("select")).toBeNull();
  });
});

// =============================================================================
// 13..18 — ACTION INVOCATION CONTRACT
// =============================================================================

describe("action invocation contract", () => {
  it("13. valid submit calls createClassAction exactly once", async () => {
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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

  it("14. action receives name", async () => {
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
    const args = mockCreateClassAction.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args.name).toBe("Intro to CS");
  });

  it("15. action receives password", async () => {
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
    const args = mockCreateClassAction.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args.password).toBe("ClassP@ssw0rd-2026");
  });

  it("16. action receives no userId / teacherUserId / classCode / passwordHash / role", async () => {
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
    const args = mockCreateClassAction.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args).not.toHaveProperty("userId");
    expect(args).not.toHaveProperty("teacherUserId");
    expect(args).not.toHaveProperty("classCode");
    expect(args).not.toHaveProperty("passwordHash");
    expect(args).not.toHaveProperty("role");
    expect(args).not.toHaveProperty("status");
    expect(Object.keys(args).sort()).toEqual(["name", "password"]);
  });
});

// =============================================================================
// 19..24 — CONCURRENCY / PENDING
// =============================================================================

describe("concurrency / pending", () => {
  it("19. two rapid submits invoke action once", async () => {
    const resolveRef: { current: ((value: unknown) => void) | null } = {
      current: null,
    };
    mockCreateClassAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRef.current = resolve;
        }),
    );
    const { container } = render(<CreateClassForm />);
    fireEvent.change(container.querySelector('input[name="name"]')!, {
      target: { value: "Intro to CS" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassP@ssw0rd-2026" },
    });
    const btn = screen.getByRole("button", { name: /create class/i });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(mockCreateClassAction).toHaveBeenCalledTimes(1);
    if (resolveRef.current) resolveRef.current(makeSuccess());
  });

  it("20. pending disables submit", async () => {
    const resolveRef: { current: ((value: unknown) => void) | null } = {
      current: null,
    };
    mockCreateClassAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRef.current = resolve;
        }),
    );
    const { container } = render(<CreateClassForm />);
    fireEvent.change(container.querySelector('input[name="name"]')!, {
      target: { value: "Intro to CS" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassP@ssw0rd-2026" },
    });
    const btn = screen.getByRole("button", { name: /create class/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    if (resolveRef.current) resolveRef.current(makeSuccess());
  });

  it("21. pending feedback shown", async () => {
    const resolveRef: { current: ((value: unknown) => void) | null } = {
      current: null,
    };
    mockCreateClassAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRef.current = resolve;
        }),
    );
    const { container } = render(<CreateClassForm />);
    fireEvent.change(container.querySelector('input[name="name"]')!, {
      target: { value: "Intro to CS" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassP@ssw0rd-2026" },
    });
    const btn = screen.getByRole("button", { name: /create class/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      const label =
        btn.textContent?.toLowerCase() ??
        btn.getAttribute("aria-label")?.toLowerCase() ??
        "";
      expect(label).toMatch(/creating class/);
    });
    if (resolveRef.current) resolveRef.current(makeSuccess());
  });

  it("22. safe failure releases guard", async () => {
    mockCreateClassAction.mockResolvedValue(
      makeError("CLASS_CREATION_FAILED", true),
    );
    const { container } = render(<CreateClassForm />);
    fireEvent.change(container.querySelector('input[name="name"]')!, {
      target: { value: "Intro to CS" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassP@ssw0rd-2026" },
    });
    const btn = screen.getByRole("button", {
      name: /create class/i,
    }) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(btn.disabled).toBe(false);
    });
  });

  it("23. later explicit retry invokes action once again", async () => {
    mockCreateClassAction
      .mockResolvedValueOnce(makeError("CLASS_CREATION_FAILED", true))
      .mockResolvedValueOnce(makeSuccess());
    const { container } = render(<CreateClassForm />);
    fireEvent.change(container.querySelector('input[name="name"]')!, {
      target: { value: "Intro to CS" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassP@ssw0rd-2026" },
    });
    const btn = screen.getByRole("button", {
      name: /create class/i,
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
    expect(mockCreateClassAction).toHaveBeenCalledTimes(2);
  });

  it("24. no automatic retry", async () => {
    mockCreateClassAction.mockResolvedValue(
      makeError("CLASS_CREATION_FAILED", true),
    );
    const { container } = render(<CreateClassForm />);
    fireEvent.change(container.querySelector('input[name="name"]')!, {
      target: { value: "Intro to CS" },
    });
    fireEvent.change(container.querySelector('input[name="password"]')!, {
      target: { value: "ClassP@ssw0rd-2026" },
    });
    const btn = screen.getByRole("button", { name: /create class/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockCreateClassAction).toHaveBeenCalledTimes(1);
    });
    // Wait a beat to allow any auto-retry to fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockCreateClassAction).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 25..32 — SUCCESS STATE
// =============================================================================

describe("success state", () => {
  it("25. success heading renders", async () => {
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
      expect(screen.getByText(/class created/i)).toBeTruthy();
    });
  });

  it("26. returned class name renders", async () => {
    mockCreateClassAction.mockResolvedValue(
      makeSuccess() /* name: "Intro to CS" */,
    );
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
      expect(screen.getByText("Intro to CS")).toBeTruthy();
    });
  });

  it("27. returned classCode renders prominently", async () => {
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
    // The classCode is rendered in monospace.
    const codeEl = screen.getByText("ABC2XYZ");
    expect(codeEl.className.toLowerCase()).toContain("font-mono");
  });

  it("28. classCode uses visible selectable text", async () => {
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
    // `select-all` is a project pattern that lets the user
    // select the text without DOM gymnastics.
    expect(
      container.querySelector(".select-all") ||
        screen.getByText("ABC2XYZ").className.toLowerCase().includes("select-all") ||
        screen.getByText("ABC2XYZ").className.toLowerCase().includes("select-text"),
    ).toBeTruthy();
  });

  it("29. password is not rendered after success", async () => {
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
    // The form is no longer rendered after success.
    expect(container.querySelector('input[name="name"]')).toBeNull();
    expect(container.querySelector('input[name="password"]')).toBeNull();
  });

  it("30. password form value is cleared after success", async () => {
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
    // The form is unmounted; a re-render with the success state
    // does not re-introduce any password input.
    expect(container.querySelector('input[name="password"]')).toBeNull();
  });

  it("31. passwordHash is not rendered", async () => {
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
    expect(container.innerHTML.toLowerCase()).not.toContain("passwordhash");
  });

  it("31b. teacherUserId is not rendered", async () => {
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
    expect(container.innerHTML).not.toContain("teacherUserId");
  });

  it("32. Back to classes link points to /classes", async () => {
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
      const back = screen.getByRole("link", { name: /back to classes/i });
      expect(back.getAttribute("href")).toBe("/classes");
    });
  });

  it("32b. success does not immediately redirect before code can be read", async () => {
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
    // No router.replace / router.push call exists in this form
    // (no navigation hook). Verify via source.
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/classes/create-class-form.tsx",
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
    expect(codeOnly.includes("useRouter")).toBe(false);
    expect(codeOnly.includes("router.replace")).toBe(false);
    expect(codeOnly.includes("router.push")).toBe(false);
  });
});

// =============================================================================
// 33..40 — SAFE ERROR FEEDBACK
// =============================================================================

describe("safe error feedback", () => {
  async function submitAndExpectAlert(code: string, retryable: boolean) {
    mockCreateClassAction.mockResolvedValue(makeError(code, retryable));
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
  }

  it("33. INVALID_CLASS_NAME feedback rendered safely", async () => {
    await submitAndExpectAlert("INVALID_CLASS_NAME", false);
    expect(screen.getByRole("alert").textContent).toMatch(/name/i);
  });

  it("34. INVALID_CLASS_PASSWORD feedback rendered safely", async () => {
    await submitAndExpectAlert("INVALID_CLASS_PASSWORD", false);
    expect(screen.getByRole("alert").textContent).toMatch(/password/i);
  });

  it("35. CLASS_CODE_GENERATION_FAILED rendered safely", async () => {
    await submitAndExpectAlert("CLASS_CODE_GENERATION_FAILED", true);
    expect(screen.getByRole("alert").textContent).toMatch(/class code/i);
  });

  it("36. CLASS_CREATION_FAILED rendered safely", async () => {
    await submitAndExpectAlert("CLASS_CREATION_FAILED", true);
    expect(screen.getByRole("alert").textContent).toMatch(/create/i);
  });

  it("37. UNAUTHENTICATED rendered safely", async () => {
    await submitAndExpectAlert("UNAUTHENTICATED", false);
    const text = screen.getByRole("alert").textContent ?? "";
    expect(text).toMatch(/sign in/i);
    expect(text).not.toMatch(/stack/i);
  });

  it("38. PROFILE_INCOMPLETE rendered safely", async () => {
    await submitAndExpectAlert("PROFILE_INCOMPLETE", false);
    expect(screen.getByRole("alert").textContent).toMatch(/profile/i);
  });

  it("39. TEACHER_REQUIRED rendered safely", async () => {
    await submitAndExpectAlert("TEACHER_REQUIRED", false);
    expect(screen.getByRole("alert").textContent).toMatch(/teacher/i);
  });

  it("40. raw Mongo error never rendered", async () => {
    mockCreateClassAction.mockResolvedValue(
      makeError(
        "CLASS_CREATION_FAILED",
        true,
        "E11000 duplicate key error on mongodb://internal:27017/face_attendance.classes",
      ),
    );
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
    const html = container.innerHTML;
    expect(html.includes("E11000")).toBe(false);
    expect(html.includes("mongodb://")).toBe(false);
    expect(html.includes("duplicate key")).toBe(false);
    expect(html.includes("face_attendance")).toBe(false);
  });

  it("40b. raw E11000 never rendered", async () => {
    mockCreateClassAction.mockResolvedValue(
      makeError(
        "CLASS_CREATION_FAILED",
        true,
        "E11000 duplicate key error collection",
      ),
    );
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
    expect(container.innerHTML.includes("E11000")).toBe(false);
  });

  it("40c. stack trace never rendered", async () => {
    mockCreateClassAction.mockResolvedValue(
      makeError(
        "CLASS_CREATION_FAILED",
        true,
        "Error: kaboom\n    at /Users/dev/internal/secret/path/x.ts:42:9",
      ),
    );
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
    expect(container.innerHTML.includes("kaboom")).toBe(false);
    expect(container.innerHTML.includes("at ")).toBe(false);
    expect(container.innerHTML.includes("/Users/dev")).toBe(false);
  });
});

// =============================================================================
// 41..45 — PASSWORD PRIVACY
// =============================================================================

describe("password privacy", () => {
  it("41. password not stored in localStorage", async () => {
    const setSpy = vi.spyOn(Storage.prototype, "setItem");
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it("42. password not stored in sessionStorage", async () => {
    const setSpy = vi.spyOn(window.sessionStorage.__proto__ as Storage, "setItem")
      .mockImplementation(() => undefined);
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
  });

  it("43. password not placed in URL", async () => {
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
    expect(window.location.search).not.toContain("password");
    expect(window.location.hash).not.toContain("password");
  });

  it("44. password not console logged", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
    const allLogs = [
      ...logSpy.mock.calls.map((c) => JSON.stringify(c)),
      ...errorSpy.mock.calls.map((c) => JSON.stringify(c)),
    ].join("\n");
    expect(allLogs.includes("ClassP@ssw0rd-2026")).toBe(false);
    expect(allLogs.toLowerCase().includes("password")).toBe(false);
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("45. success state contains no plaintext password / passwordHash", async () => {
    mockCreateClassAction.mockResolvedValue(makeSuccess());
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
    const html = container.innerHTML;
    expect(html.includes("ClassP@ssw0rd-2026")).toBe(false);
    expect(html.toLowerCase().includes("passwordhash")).toBe(false);
    expect(html.toLowerCase().includes("pbkdf2")).toBe(false);
  });
});

// =============================================================================
// 46..52 — DOMAIN ISOLATION
// =============================================================================

describe("domain isolation", () => {
  let sourceCode: string;
  beforeEach(() => {
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/classes/create-class-form.tsx",
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

  it("46. form does not call ClassModel", () => {
    expect(sourceCode).not.toMatch(/ClassModel/);
    expect(sourceCode).not.toMatch(/class-model/);
  });

  it("47. form does not call class-service directly", () => {
    expect(sourceCode).not.toMatch(/class-service/);
    expect(sourceCode).not.toMatch(/createClass\s*\(/);
  });

  it("48. form does not call joinClassAction", () => {
    expect(sourceCode).not.toMatch(/joinClassAction/);
    expect(sourceCode).not.toMatch(/createJoinClassAction/);
    expect(sourceCode).not.toMatch(/joinClass\s*\(/);
  });

  it("49. form does not create Membership", () => {
    expect(sourceCode).not.toMatch(/ClassMembership/);
    expect(sourceCode).not.toMatch(/createMembership/);
    expect(sourceCode).not.toMatch(/membership-model/);
  });

  it("50. form does not call Face Service", () => {
    expect(sourceCode).not.toMatch(/face-service-client/);
    expect(sourceCode).not.toMatch(/FaceServiceClient/);
    expect(sourceCode).not.toMatch(/finalizeFaceEnrollment/);
    expect(sourceCode).not.toMatch(/analyzeEnrollmentSample/);
    expect(sourceCode).not.toMatch(/FACE_SERVICE_URL/);
  });

  it("51. form does not touch FaceProfile", () => {
    expect(sourceCode).not.toMatch(/FaceProfile/);
    expect(sourceCode).not.toMatch(/face-profile-service/);
    expect(sourceCode).not.toMatch(/face-id-status-service/);
  });

  it("52. form does not touch attendance", () => {
    expect(sourceCode.toLowerCase()).not.toContain("attendance");
  });
});

// =============================================================================
// 53..55 — ROUTES
// =============================================================================

describe("routes / no public API", () => {
  it("53. /classes/new route exists", () => {
    // The page is mounted at apps/web/src/app/classes/new/page.tsx.
    expect(
      existsSync(
        join(
          process.cwd(),
          "src/app/classes/new/page.tsx",
        ),
      ),
    ).toBe(true);
  });

  it("54. /classes/join route exists (PHASE 5.1E3)", () => {
    // PHASE 5.1E3 added the /classes/join route. The E2 form
    // is NOT a create-class route so this assertion is the
    // document that the E2 surface area was NOT expanded.
    expect(
      existsSync(join(process.cwd(), "src/app/classes/join/page.tsx")),
    ).toBe(true);
  });

  it("55. no class detail route touched by E2 form (PHASE 5.1E4A detail page is a different surface)", () => {
    // PHASE 5.1E4A adds the `/classes/[classId]` Server Component
    // detail page, but the create-class form is a Server Action
    // submission surface only — it does NOT navigate to the detail
    // route, does NOT know about the route id, and does NOT
    // touch the detail read model.
    const source = readFileSync(
      join(
        process.cwd(),
        "src/components/classes/create-class-form.tsx",
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
    expect(codeOnly).not.toMatch(/\/classes\/\[classId\]/);
    expect(codeOnly).not.toMatch(/getClassDetailForCurrentUser/);
    expect(codeOnly).not.toMatch(/getClassRosterForCurrentTeacher/);
  });

  it("55b. no create-class REST endpoint added", () => {
    expect(
      existsSync(join(process.cwd(), "src/app/api/classes/route.ts")),
    ).toBe(false);
    expect(
      existsSync(join(process.cwd(), "src/app/api/classes")),
    ).toBe(false);
  });
});
