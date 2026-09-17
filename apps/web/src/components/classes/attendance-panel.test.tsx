/**
 * Tests for the PHASE 6.2 `AttendancePanel` Server Component.
 *
 * The panel is rendered on the teacher viewer path of the
 * `/classes/[classId]` class detail page. The component
 * receives the safe attendance read DTO and renders ONLY the
 * safe fields.
 *
 * Contract matrix:
 *
 *   ## Server Component contract (1..5)
 *     1.   Panel module is importable as a Server Component
 *          (no `"use client"` directive).
 *     2.   The component returns `null` when the caller passes
 *          `state.status === "absent"` — used by the student
 *          viewer path to opt out of the entire panel.
 *     3.   The component renders a calm failure block when
 *          `state.status === "failure"`.
 *     4.   The component renders the NONE state copy and the
 *          "Start attendance" button when `state === "none"`.
 *     5.   The component renders the ACTIVE state copy with
 *          startedAt and rosterCount, plus the "Stop
 *          attendance" button when `state === "active"`.
 *     5b.  The component renders the CLOSED state copy with
 *          startedAt and endedAt and rosterCount, plus the
 *          "Start new attendance" button when `state ===
 *          "closed"`.
 *     5c.  The component renders the archived-class notice
 *          and does NOT render the Start button when
 *          `classStatus === "archived"`.
 *
 *   ## Privacy / isolation (6..12)
 *     6.   Renders NEVER include `rosterSnapshot`.
 *     7.   Renders NEVER include `studentUserId`.
 *     8.   Renders NEVER include `teacherUserId`.
 *     9.   Renders NEVER include `startedByUserId`.
 *     10.  Renders NEVER include `passwordHash` / `password`.
 *     11.  Renders NEVER include `FaceProfile` / `embedding` /
 *          `centroid`.
 *     12.  Renders NEVER include attendance marks
 *          (`present` / `absent` / `late` / `confidence` /
 *          `recognizedAt`).
 *
 *   ## Module surface / static (13..16)
 *     13.  The component does NOT import the Face Service
 *          client.
 *     14.  The component does NOT introduce a `/api/attendance`
 *          route.
 *     15.  The component does NOT use `useEffect`, `useState`,
 *          or any client-side hook.
 *     16.  The component does NOT call any Server Action
 *          directly (Start / Stop is delegated to
 *          `AttendanceControlButton`).
 */

import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// =============================================================================
// Mocks
// =============================================================================

// Mock the AttendanceControlButton so we don't pull in
// `next/navigation`, Server Actions, or any client-only runtime
// during these Server-Component tests. The mock renders a
// `<button>` whose visible label is the parent-supplied
// `label` prop and tags the DOM with `data-mode` for assertion.
vi.mock("@/components/classes/attendance-control-button", () => ({
  AttendanceControlButton: ({
    classId,
    mode,
    label,
  }: {
    classId: string;
    mode: "start" | "stop";
    label: string;
  }) => (
    <button
      type="button"
      data-component="attendance-control-button"
      data-mode={mode}
      data-class-id={classId}
    >
      {label}
    </button>
  ),
}));

// =============================================================================
// Imports under test
// =============================================================================

import { AttendancePanel } from "@/components/classes/attendance-panel";
import type {
  AttendanceSessionStatusDto,
  AttendanceSessionStatusSessionDto,
} from "@/lib/attendance/attendance-session-status-types";

// =============================================================================
// Helpers
// =============================================================================

function makeActiveSession(
  overrides: Partial<AttendanceSessionStatusSessionDto> = {},
): AttendanceSessionStatusSessionDto {
  return {
    id: "65f000000000000000000fff",
    status: "active",
    startedAt: "2026-09-16T10:00:00.000Z",
    endedAt: null,
    rosterCount: 5,
    ...overrides,
  };
}

function makeClosedSession(
  overrides: Partial<AttendanceSessionStatusSessionDto> = {},
): AttendanceSessionStatusSessionDto {
  return {
    id: "65f000000000000000000fff",
    status: "closed",
    startedAt: "2026-09-16T10:00:00.000Z",
    endedAt: "2026-09-16T11:00:00.000Z",
    rosterCount: 7,
    ...overrides,
  };
}

function makeSuccessState(
  state: AttendanceSessionStatusDto["state"],
  session: AttendanceSessionStatusSessionDto | null,
): AttendanceSessionStatusDto {
  return { state, session };
}

const CLASS_ID = "65f000000000000000000abc";

// =============================================================================
// 1..5 — Server Component contract
// =============================================================================

describe("AttendancePanel — server component contract", () => {
  it("1. module is a Server Component (no 'use client' directive)", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-panel.tsx",
      ),
      "utf-8",
    );
    expect(source).not.toMatch(/^"use client"/m);
    expect(source).not.toMatch(/^'use client'/m);
  });

  it("2. absent status returns null (student viewer path)", () => {
    const tree = renderToStaticMarkup(
      <AttendancePanel
        state={{ status: "absent" }}
        classId=""
        classStatus="active"
      />,
    );
    expect(tree).toBe("");
  });

  it("3. failure status renders a calm safe failure block (no raw error)", () => {
    const tree = renderToStaticMarkup(
      <AttendancePanel
        state={{ status: "failure" }}
        classId={CLASS_ID}
        classStatus="active"
      />,
    );
    expect(tree).toMatch(/could not be loaded/i);
    expect(tree).not.toContain("E11000");
    expect(tree).not.toContain("stack");
    expect(tree).not.toContain("mongodb://");
  });

  it("4. none state renders 'Start attendance' control", () => {
    const tree = renderToStaticMarkup(
      <AttendancePanel
        state={{
          status: "success",
          payload: makeSuccessState("none", null),
        }}
        classId={CLASS_ID}
        classStatus="active"
      />,
    );
    expect(tree).toMatch(/start attendance/i);
    const button = extractFirst(tree, /<button[^>]*>/);
    expect(button).toMatch(/data-mode="start"/);
  });

  it("5. active state renders Stop attendance with startedAt and rosterCount", () => {
    const tree = renderToStaticMarkup(
      <AttendancePanel
        state={{
          status: "success",
          payload: makeSuccessState(
            "active",
            makeActiveSession({ rosterCount: 4 }),
          ),
        }}
        classId={CLASS_ID}
        classStatus="active"
      />,
    );
    expect(tree).toMatch(/stop attendance/i);
    expect(tree).toMatch(/in progress/i);
    expect(tree).toContain("data-attendance-roster-count=\"4\"");
    const button = extractFirst(tree, /<button[^>]*>/);
    expect(button).toMatch(/data-mode="stop"/);
  });

  it("5b. closed state renders Start new attendance with startedAt, endedAt, rosterCount", () => {
    const tree = renderToStaticMarkup(
      <AttendancePanel
        state={{
          status: "success",
          payload: makeSuccessState(
            "closed",
            makeClosedSession({ rosterCount: 9 }),
          ),
        }}
        classId={CLASS_ID}
        classStatus="active"
      />,
    );
    expect(tree).toMatch(/start new attendance/i);
    expect(tree).toMatch(/ended/i);
    expect(tree).toContain("data-attendance-roster-count=\"9\"");
    const button = extractFirst(tree, /<button[^>]*>/);
    expect(button).toMatch(/data-mode="start"/);
  });

  it("5c. archived class renders the archive notice and NO Start button", () => {
    const tree = renderToStaticMarkup(
      <AttendancePanel
        state={{
          status: "success",
          payload: makeSuccessState(
            "closed",
            makeClosedSession({ rosterCount: 2 }),
          ),
        }}
        classId={CLASS_ID}
        classStatus="archived"
      />,
    );
    expect(tree).toMatch(/cannot be started for an archived class/i);
    // The Start button must NOT be rendered for an archived
    // class — even though the latest closed session is
    // rendered below the notice.
    const buttons = tree.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBe(0);
    // The closed-session metadata is still rendered.
    expect(tree).toContain("data-attendance-roster-count=\"2\"");
  });

  it("5d. archived class with NONE state renders the archive notice + no Start button", () => {
    const tree = renderToStaticMarkup(
      <AttendancePanel
        state={{
          status: "success",
          payload: makeSuccessState("none", null),
        }}
        classId={CLASS_ID}
        classStatus="archived"
      />,
    );
    expect(tree).toMatch(/cannot be started for an archived class/i);
    const buttons = tree.match(/<button[^>]*>/g) ?? [];
    expect(buttons.length).toBe(0);
  });
});

// =============================================================================
// 6..12 — Privacy / isolation
// =============================================================================

describe("AttendancePanel — privacy / isolation", () => {
  it("6. NEVER renders rosterSnapshot", () => {
    const tree = renderToStaticMarkup(
      <AttendancePanel
        state={{
          status: "success",
          payload: makeSuccessState(
            "active",
            makeActiveSession({ rosterCount: 3 }),
          ),
        }}
        classId={CLASS_ID}
        classStatus="active"
      />,
    );
    expect(tree).not.toContain("rosterSnapshot");
    expect(tree).not.toContain("fullNameSnapshot");
    expect(tree).not.toContain("identificationCodeSnapshot");
  });

  it("7. NEVER renders studentUserId", () => {
    const tree = renderToStaticMarkup(
      <AttendancePanel
        state={{
          status: "success",
          payload: makeSuccessState(
            "active",
            makeActiveSession(),
          ),
        }}
        classId={CLASS_ID}
        classStatus="active"
      />,
    );
    expect(tree.toLowerCase()).not.toContain("studentuserid");
  });

  it("8. NEVER renders teacherUserId", () => {
    const tree = renderToStaticMarkup(
      <AttendancePanel
        state={{
          status: "success",
          payload: makeSuccessState(
            "active",
            makeActiveSession(),
          ),
        }}
        classId={CLASS_ID}
        classStatus="active"
      />,
    );
    expect(tree.toLowerCase()).not.toContain("teacheruserid");
  });

  it("9. NEVER renders startedByUserId", () => {
    const tree = renderToStaticMarkup(
      <AttendancePanel
        state={{
          status: "success",
          payload: makeSuccessState(
            "active",
            makeActiveSession(),
          ),
        }}
        classId={CLASS_ID}
        classStatus="active"
      />,
    );
    expect(tree.toLowerCase()).not.toContain("startedbyuserid");
  });

  it("10. NEVER renders password / passwordHash / pbkdf2", () => {
    const tree = renderToStaticMarkup(
      <AttendancePanel
        state={{
          status: "success",
          payload: makeSuccessState(
            "active",
            makeActiveSession(),
          ),
        }}
        classId={CLASS_ID}
        classStatus="active"
      />,
    );
    expect(tree.toLowerCase()).not.toContain("password");
    expect(tree).not.toContain("passwordHash");
    expect(tree).not.toContain("pbkdf2");
  });

  it("11. NEVER renders FaceProfile / embedding / centroid / biometric", () => {
    const tree = renderToStaticMarkup(
      <AttendancePanel
        state={{
          status: "success",
          payload: makeSuccessState(
            "active",
            makeActiveSession(),
          ),
        }}
        classId={CLASS_ID}
        classStatus="active"
      />,
    );
    expect(tree).not.toContain("FaceProfile");
    expect(tree).not.toContain("embedding");
    expect(tree).not.toContain("centroid");
    expect(tree).not.toContain("biometric");
  });

  it("12. NEVER renders attendance marks (present / absent / late / confidence / recognizedAt)", () => {
    const tree = renderToStaticMarkup(
      <AttendancePanel
        state={{
          status: "success",
          payload: makeSuccessState(
            "active",
            makeActiveSession(),
          ),
        }}
        classId={CLASS_ID}
        classStatus="active"
      />,
    );
    // The words "present" / "absent" are common — check
    // specifically for attendance-marker rendering rather
    // than the raw word.
    expect(tree).not.toMatch(/present\s*:/i);
    expect(tree).not.toMatch(/absent\s*:/i);
    expect(tree).not.toMatch(/\blate\b/i);
    expect(tree).not.toContain("recognizedAt");
    expect(tree).not.toContain("confidence");
  });
});

// =============================================================================
// 13..16 — Module surface / static
// =============================================================================

describe("AttendancePanel — module surface / static", () => {
  it("13. component does NOT import the Face Service client", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-panel.tsx",
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

  it("14. component does NOT introduce a /api/attendance route", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-panel.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/\/api\/attendance/);
    expect(stripped).not.toMatch(/NextResponse/);
    expect(stripped).not.toMatch(/route handler/i);
  });

  it("15. component does NOT use client hooks (useEffect, useState, useTransition)", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-panel.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/useEffect/);
    expect(stripped).not.toMatch(/useState/);
    expect(stripped).not.toMatch(/useTransition/);
    expect(stripped).not.toMatch(/useRouter/);
    expect(stripped).not.toMatch(/"use client"/);
  });

  it("16. component does NOT call a Server Action directly (delegates to AttendanceControlButton)", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-panel.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/startAttendanceSessionAction\s*\(/);
    expect(stripped).not.toMatch(/stopAttendanceSessionAction\s*\(/);
  });
});

// =============================================================================
// Helpers
// =============================================================================

function extractFirst(haystack: string, regex: RegExp): string {
  const match = haystack.match(regex);
  if (!match) return "";
  return match[0];
}
