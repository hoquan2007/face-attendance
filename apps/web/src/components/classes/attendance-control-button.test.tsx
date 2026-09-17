/**
 * Tests for the PHASE 6.2 `AttendanceControlButton` Client
 * Component.
 *
 * The component is the teacher-only browser-side trigger for
 * `startAttendanceSessionAction` and `stopAttendanceSessionAction`.
 *
 * Contract matrix:
 *
 *   ## Privacy / input shape (1..7)
 *     1..7   — Sends ONLY `classId` to the action. No
 *               `teacherUserId`, `userId`, `role`,
 *               `rosterSnapshot`, `status`, `startedAt`,
 *               `endedAt`, or `startedByUserId` smuggled.
 *
 *   ## Action invocation (8..9)
 *     8.   Start mode invokes `startAttendanceSessionAction`
 *          exactly once.
 *     9.   Stop mode invokes `stopAttendanceSessionAction`
 *          exactly once.
 *
 *   ## Concurrency / double-submit (10..14)
 *     10.  Two rapid clicks on Start invoke the action once.
 *     11.  Two rapid clicks on Stop invoke the action once.
 *     12.  Pending disables Start button.
 *     13.  Pending disables Stop button.
 *     14.  No automatic retry after failure.
 *
 *   ## Success / idempotency (15..20)
 *     15.  Start success calls `router.refresh()`.
 *     16.  Stop success calls `router.refresh()`.
 *     17.  `alreadyActive: true` is treated as success (no
 *          "Attendance already exists" copy).
 *     18.  `alreadyStopped: true` is treated as success.
 *     19.  After success, the safe local failure block is NOT
 *          rendered.
 *     20.  After success, the button label returns to the
 *          parent-supplied label (no stale "Starting…").
 *
 *   ## Error mapping (21..25)
 *     21.  Failure maps to restrained heading + body (no raw
 *          Mongo / stack / internal field name).
 *     22.  `CLASS_NOT_ACCESSIBLE` uses the "Class is not
 *          available" copy.
 *     23.  `PROFILE_INCOMPLETE` uses the onboarding copy.
 *     24.  `TEACHER_REQUIRED` uses the teachers-only copy.
 *     25.  After a failure, the user may retry explicitly
 *          (guard released) — and the second click performs a
 *          fresh action invocation (no automatic retry).
 *
 *   ## Domain isolation (26..30)
 *     26.  No Face Service call.
 *     27.  No FaceProfile / embedding / centroid.
 *     28.  No camera / MediaStream code.
 *     29.  No attendance marks (present / absent / late /
 *          confidence / recognizedAt).
 *     30.  No public REST attendance API call.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import * as React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Mocks
// =============================================================================

const mockStartAction = vi.fn();
const mockStopAction = vi.fn();
const mockRouterRefresh = vi.fn();

vi.mock(
  "@/lib/attendance/start-attendance-session-action",
  () => ({
    startAttendanceSessionAction: (...args: unknown[]) =>
      mockStartAction(...args),
  }),
);

vi.mock("@/lib/attendance/stop-attendance-session-action", () => ({
  stopAttendanceSessionAction: (...args: unknown[]) =>
    mockStopAction(...args),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: () => mockRouterRefresh(),
  }),
}));

vi.mock("@/lib/attendance/attendance-session-action-types", () => ({
  ATTENDANCE_SESSION_ACTION_ERROR_CODES: {
    UNAUTHENTICATED: "UNAUTHENTICATED",
    PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
    TEACHER_REQUIRED: "TEACHER_REQUIRED",
    CLASS_NOT_ACTIVE: "CLASS_NOT_ACTIVE",
    CLASS_NOT_ACCESSIBLE: "CLASS_NOT_ACCESSIBLE",
    ATTENDANCE_ROSTER_INVALID: "ATTENDANCE_ROSTER_INVALID",
    ATTENDANCE_SESSION_CREATE_FAILED:
      "ATTENDANCE_SESSION_CREATE_FAILED",
    ATTENDANCE_SESSION_STOP_FAILED:
      "ATTENDANCE_SESSION_STOP_FAILED",
  },
}));

// =============================================================================
// Imports under test
// =============================================================================

import { AttendanceControlButton } from "@/components/classes/attendance-control-button";

// =============================================================================
// Helpers
// =============================================================================

const OWNED_CLASS_ID = "65f000000000000000000abc";

function makeStartSuccess(alreadyActive = false) {
  return {
    ok: true as const,
    alreadyActive,
    session: {
      id: "65f000000000000000000fff",
      status: "active" as const,
      startedAt: "2026-09-16T10:00:00.000Z",
      endedAt: null,
      rosterCount: 3,
    },
  };
}

function makeStopSuccess(alreadyStopped = false) {
  return {
    ok: true as const,
    alreadyStopped,
    session: {
      id: "65f000000000000000000fff",
      status: "closed" as const,
      startedAt: "2026-09-16T10:00:00.000Z",
      endedAt: "2026-09-16T11:00:00.000Z",
      rosterCount: 3,
    },
  };
}

function makeError(code: string, retryable = false) {
  return {
    ok: false as const,
    code,
    message: "safe-message",
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
// 1..7 — Privacy / input shape
// =============================================================================

describe("AttendanceControlButton — privacy / input shape", () => {
  it("1. Start sends ONLY classId to startAttendanceSessionAction", async () => {
    mockStartAction.mockResolvedValue(makeStartSuccess());
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="start"
        label="Start attendance"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /start attendance/i }),
      );
    });
    await waitFor(() => {
      expect(mockStartAction).toHaveBeenCalledTimes(1);
    });
    const args = mockStartAction.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args).toEqual({ classId: OWNED_CLASS_ID });
    expect(args).not.toHaveProperty("teacherUserId");
    expect(args).not.toHaveProperty("userId");
    expect(args).not.toHaveProperty("role");
    expect(args).not.toHaveProperty("rosterSnapshot");
    expect(args).not.toHaveProperty("status");
    expect(args).not.toHaveProperty("startedAt");
    expect(args).not.toHaveProperty("endedAt");
    expect(args).not.toHaveProperty("startedByUserId");
  });

  it("2. Stop sends ONLY classId to stopAttendanceSessionAction", async () => {
    mockStopAction.mockResolvedValue(makeStopSuccess());
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="stop"
        label="Stop attendance"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /stop attendance/i }),
      );
    });
    await waitFor(() => {
      expect(mockStopAction).toHaveBeenCalledTimes(1);
    });
    const args = mockStopAction.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(args).toEqual({ classId: OWNED_CLASS_ID });
    expect(args).not.toHaveProperty("teacherUserId");
    expect(args).not.toHaveProperty("userId");
    expect(args).not.toHaveProperty("role");
    expect(args).not.toHaveProperty("rosterSnapshot");
    expect(args).not.toHaveProperty("status");
    expect(args).not.toHaveProperty("startedAt");
    expect(args).not.toHaveProperty("endedAt");
    expect(args).not.toHaveProperty("startedByUserId");
  });

  it("3. Start does not accept class roster / student / teacher ids via props", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-control-button.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    // The component must not declare a `teacherUserId`,
    // `studentUserId`, `userId`, `role`, `rosterSnapshot`,
    // `status`, `startedAt`, `endedAt`, `startedByUserId` prop.
    expect(stripped).not.toMatch(/teacherUserId\??:\s*string/);
    expect(stripped).not.toMatch(/studentUserId\??:\s*string/);
    expect(stripped).not.toMatch(/\brole\??:\s*"student"\s*\|\s*"teacher"/);
    expect(stripped).not.toMatch(/rosterSnapshot\??:/);
    expect(stripped).not.toMatch(/startedByUserId\??:\s*string/);
  });

  it("4. component does not write to localStorage / sessionStorage / IndexedDB", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-control-button.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/localStorage/);
    expect(stripped).not.toMatch(/sessionStorage/);
    expect(stripped).not.toMatch(/indexedDB/);
  });

  it("5. component does not issue fetch() to any attendance REST API", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-control-button.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/fetch\s*\(/);
    expect(stripped).not.toMatch(/axios/);
    expect(stripped).not.toMatch(/\/api\/attendance/);
  });

  it("6. component does not import Face Service / FaceProfile / biometric", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-control-button.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/face-service/);
    expect(stripped).not.toMatch(/FaceService/);
    expect(stripped).not.toMatch(/FaceProfile/);
    expect(stripped).not.toMatch(/embedding/);
    expect(stripped).not.toMatch(/centroid/);
    expect(stripped).not.toMatch(/getUserMedia/);
    expect(stripped).not.toMatch(/MediaStream/);
  });

  it("7. component does NOT render attendance marks (present / absent / late / confidence / recognizedAt)", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-control-button.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/present/);
    expect(stripped).not.toMatch(/absent/);
    expect(stripped).not.toMatch(/late/);
    expect(stripped).not.toMatch(/recognizedAt/);
    expect(stripped).not.toMatch(/confidence/);
  });
});

// =============================================================================
// 8..9 — Action invocation
// =============================================================================

describe("AttendanceControlButton — action invocation", () => {
  it("8. Start mode invokes startAttendanceSessionAction exactly once", async () => {
    mockStartAction.mockResolvedValue(makeStartSuccess());
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="start"
        label="Start attendance"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /start attendance/i }),
      );
    });
    await waitFor(() => {
      expect(mockStartAction).toHaveBeenCalledTimes(1);
    });
    // Stop must NOT have been called.
    expect(mockStopAction).not.toHaveBeenCalled();
  });

  it("9. Stop mode invokes stopAttendanceSessionAction exactly once", async () => {
    mockStopAction.mockResolvedValue(makeStopSuccess());
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="stop"
        label="Stop attendance"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /stop attendance/i }),
      );
    });
    await waitFor(() => {
      expect(mockStopAction).toHaveBeenCalledTimes(1);
    });
    expect(mockStartAction).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 10..14 — Concurrency / double-submit
// =============================================================================

describe("AttendanceControlButton — concurrency / double-submit", () => {
  it("10. two rapid clicks on Start invoke action ONCE", async () => {
    const resolveRef: { current: ((value: unknown) => void) | null } = {
      current: null,
    };
    mockStartAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRef.current = resolve;
        }),
    );
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="start"
        label="Start attendance"
      />,
    );
    const btn = screen.getByRole("button", { name: /start attendance/i });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(mockStartAction).toHaveBeenCalledTimes(1);
    if (resolveRef.current) resolveRef.current(makeStartSuccess());
  });

  it("11. two rapid clicks on Stop invoke action ONCE", async () => {
    const resolveRef: { current: ((value: unknown) => void) | null } = {
      current: null,
    };
    mockStopAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRef.current = resolve;
        }),
    );
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="stop"
        label="Stop attendance"
      />,
    );
    const btn = screen.getByRole("button", { name: /stop attendance/i });
    await act(async () => {
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
    });
    expect(mockStopAction).toHaveBeenCalledTimes(1);
    if (resolveRef.current) resolveRef.current(makeStopSuccess());
  });

  it("12. pending disables Start button", async () => {
    const resolveRef: { current: ((value: unknown) => void) | null } = {
      current: null,
    };
    mockStartAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRef.current = resolve;
        }),
    );
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="start"
        label="Start attendance"
      />,
    );
    const btn = screen.getByRole("button", { name: /start attendance/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    if (resolveRef.current) resolveRef.current(makeStartSuccess());
  });

  it("13. pending disables Stop button", async () => {
    const resolveRef: { current: ((value: unknown) => void) | null } = {
      current: null,
    };
    mockStopAction.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRef.current = resolve;
        }),
    );
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="stop"
        label="Stop attendance"
      />,
    );
    const btn = screen.getByRole("button", { name: /stop attendance/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    if (resolveRef.current) resolveRef.current(makeStopSuccess());
  });

  it("14. no automatic retry after failure", async () => {
    mockStartAction.mockResolvedValue(makeError("CLASS_NOT_ACCESSIBLE"));
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="start"
        label="Start attendance"
      />,
    );
    const btn = screen.getByRole("button", { name: /start attendance/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockStartAction).toHaveBeenCalledTimes(1);
    });
    // Wait a beat to ensure no auto-retry timer is firing.
    await new Promise((r) => setTimeout(r, 50));
    expect(mockStartAction).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 15..20 — Success / idempotency
// =============================================================================

describe("AttendanceControlButton — success / idempotency", () => {
  it("15. Start success triggers router.refresh()", async () => {
    mockStartAction.mockResolvedValue(makeStartSuccess());
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="start"
        label="Start attendance"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /start attendance/i }),
      );
    });
    await waitFor(() => {
      expect(mockStartAction).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
    });
  });

  it("16. Stop success triggers router.refresh()", async () => {
    mockStopAction.mockResolvedValue(makeStopSuccess());
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="stop"
        label="Stop attendance"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /stop attendance/i }),
      );
    });
    await waitFor(() => {
      expect(mockStopAction).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
    });
  });

  it("17. alreadyActive: true treated as success (no error rendered)", async () => {
    mockStartAction.mockResolvedValue(makeStartSuccess(true));
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="start"
        label="Start attendance"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /start attendance/i }),
      );
    });
    await waitFor(() => {
      expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
    });
    // The safe local failure block must NOT appear.
    expect(
      screen.queryByRole("alert"),
    ).toBeNull();
    // The button label must NOT contain an "already exists"
    // copy.
    expect(document.body.textContent ?? "").not.toMatch(/already exists/i);
  });

  it("18. alreadyStopped: true treated as success (no error rendered)", async () => {
    mockStopAction.mockResolvedValue(makeStopSuccess(true));
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="stop"
        label="Stop attendance"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /stop attendance/i }),
      );
    });
    await waitFor(() => {
      expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
    });
    expect(
      screen.queryByRole("alert"),
    ).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/already stopped/i);
  });

  it("19. safe local failure block NOT rendered after success", async () => {
    mockStartAction.mockResolvedValue(makeStartSuccess());
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="start"
        label="Start attendance"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /start attendance/i }),
      );
    });
    await waitFor(() => {
      expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("20. button label returns to parent-supplied label after success", async () => {
    mockStartAction.mockResolvedValue(makeStartSuccess());
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="start"
        label="Start attendance"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /start attendance/i }),
      );
    });
    await waitFor(() => {
      expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
    });
    // After the refresh completes the button label returns to
    // the parent-supplied "Start attendance" — there must be
    // no stale "Starting…" copy.
    await waitFor(() => {
      const label =
        screen
          .getByRole("button", { name: /start attendance/i })
          .textContent?.trim() ?? "";
      expect(label.toLowerCase()).not.toContain("starting");
    });
  });
});

// =============================================================================
// 21..25 — Error mapping
// =============================================================================

describe("AttendanceControlButton — error mapping", () => {
  it("21. failure maps to restrained copy (no Mongo / stack / internal field)", async () => {
    mockStartAction.mockResolvedValue(
      makeError(
        "ATTENDANCE_SESSION_CREATE_FAILED",
      ),
    );
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="start"
        label="Start attendance"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /start attendance/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    const body = document.body.textContent ?? "";
    expect(body).not.toContain("E11000");
    expect(body).not.toContain("mongodb://");
    expect(body).not.toContain("stack");
    expect(body).not.toContain("ECONNREFUSED");
    expect(body).not.toContain("rosterSnapshot");
    expect(body).not.toContain("studentUserId");
  });

  it("22. CLASS_NOT_ACCESSIBLE → 'Class is not available'", async () => {
    mockStartAction.mockResolvedValue(
      makeError("CLASS_NOT_ACCESSIBLE"),
    );
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="start"
        label="Start attendance"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /start attendance/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(document.body.textContent ?? "").toMatch(/class is not available/i);
  });

  it("23. PROFILE_INCOMPLETE → onboarding copy", async () => {
    mockStartAction.mockResolvedValue(
      makeError("PROFILE_INCOMPLETE"),
    );
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="start"
        label="Start attendance"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /start attendance/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(document.body.textContent ?? "").toMatch(/complete your profile/i);
  });

  it("24. TEACHER_REQUIRED → teachers-only copy", async () => {
    mockStartAction.mockResolvedValue(makeError("TEACHER_REQUIRED"));
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="start"
        label="Start attendance"
      />,
    );
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /start attendance/i }),
      );
    });
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(document.body.textContent ?? "").toMatch(/teachers only/i);
  });

  it("25. after failure, user may retry explicitly (guard released)", async () => {
    mockStartAction
      .mockResolvedValueOnce(makeError("CLASS_NOT_ACCESSIBLE"))
      .mockResolvedValueOnce(makeStartSuccess());
    render(
      <AttendanceControlButton
        classId={OWNED_CLASS_ID}
        mode="start"
        label="Start attendance"
      />,
    );
    const btn = screen.getByRole("button", { name: /start attendance/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockStartAction).toHaveBeenCalledTimes(1);
    });
    // After failure the guard is released — explicit retry
    // should issue a fresh action invocation.
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      expect(mockStartAction).toHaveBeenCalledTimes(2);
    });
  });
});

// =============================================================================
// 26..30 — Domain isolation
// =============================================================================

describe("AttendanceControlButton — domain isolation", () => {
  it("26. no Face Service client import", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-control-button.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/face-service-client/);
    expect(stripped).not.toMatch(/FaceServiceClient/);
    expect(stripped).not.toMatch(/biometrics\/face-service/);
  });

  it("27. no FaceProfile / embedding / centroid import", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-control-button.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/FaceProfile/);
    expect(stripped).not.toMatch(/face_profiles/);
    expect(stripped).not.toMatch(/embedding/);
    expect(stripped).not.toMatch(/centroid/);
  });

  it("28. no camera / MediaStream code", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-control-button.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/getUserMedia/);
    expect(stripped).not.toMatch(/MediaStream/);
    expect(stripped).not.toMatch(/capture/i);
  });

  it("29. no attendance marks (present / absent / late / confidence / recognizedAt)", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-control-button.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/present/);
    expect(stripped).not.toMatch(/absent/);
    expect(stripped).not.toMatch(/late/);
    expect(stripped).not.toMatch(/recognizedAt/);
    expect(stripped).not.toMatch(/confidence/);
  });

  it("30. no public REST attendance API call", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-control-button.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/fetch\s*\(/);
    expect(stripped).not.toMatch(/\/api\/attendance/);
    expect(stripped).not.toMatch(/NextResponse/);
  });
});
