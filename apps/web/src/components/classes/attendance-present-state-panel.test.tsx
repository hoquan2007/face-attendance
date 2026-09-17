/**
 * Tests for the PHASE 6.4 `AttendancePresentStatePanel` Server
 * Component.
 *
 * The panel is rendered on `/classes/[classId]/attendance` and
 * receives ONLY the safe present-state DTO. It is purely
 * server-rendered — no `"use client"`, no `useEffect`, no
 * `useState`, no `fetch`, no `localStorage`.
 *
 * Contract matrix:
 *
 *   ## Server Component contract (1..3)
 *     1.  module is a Server Component (no `"use client"`).
 *     2.  presentCount / rosterCount renders.
 *     3.  empty state shows restrained copy.
 *
 *   ## Privacy / isolation (4..10)
 *     4.  no studentUserId in DOM.
 *     5.  no AttendanceMark _id in DOM.
 *     6.  no FaceProfile / embedding / centroid.
 *     7.  no teacherUserId / password / startedByUserId.
 *     8.  no `absent` / `late` labels.
 *     9.  no Face Service client import.
 *     10. no continuous scanning loop (component has no
 *         "use client" anyway).
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AttendancePresentStatePanel } from "@/components/classes/attendance-present-state-panel";
import type {
  SafeAttendancePresentStudentDto,
} from "@/lib/attendance/attendance-present-state-read-service";

function makeStudents(): SafeAttendancePresentStudentDto[] {
  return [
    {
      fullName: "Alice",
      identificationCode: "SV001",
      recognizedAt: "2026-09-16T10:00:00.000Z",
    },
    {
      fullName: "Bob",
      identificationCode: "SV002",
      recognizedAt: "2026-09-16T10:01:00.000Z",
    },
  ];
}

describe("AttendancePresentStatePanel — server component contract", () => {
  it("1. module is a Server Component (no 'use client')", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-present-state-panel.tsx",
      ),
      "utf-8",
    );
    expect(source).not.toMatch(/^"use client"/m);
    expect(source).not.toMatch(/^'use client'/m);
  });

  it("34. renders presentCount / rosterCount", () => {
    const tree = renderToStaticMarkup(
      <AttendancePresentStatePanel
        sessionId="session-1"
        rosterCount={25}
        presentCount={3}
        students={makeStudents()}
      />,
    );
    // presentCount / rosterCount is rendered as "3 / 25".
    expect(tree).toContain("data-attendance-present-count=\"3\"");
    expect(tree).toContain("data-attendance-roster-count=\"25\"");
    expect(tree).toMatch(/3\s*\/\s*25/);
  });

  it("35. present student name renders", () => {
    const tree = renderToStaticMarkup(
      <AttendancePresentStatePanel
        sessionId="session-1"
        rosterCount={25}
        presentCount={2}
        students={makeStudents()}
      />,
    );
    expect(tree).toContain("Alice");
    expect(tree).toContain("Bob");
  });

  it("36. identificationCode renders", () => {
    const tree = renderToStaticMarkup(
      <AttendancePresentStatePanel
        sessionId="session-1"
        rosterCount={25}
        presentCount={2}
        students={makeStudents()}
      />,
    );
    expect(tree).toContain("SV001");
    expect(tree).toContain("SV002");
  });

  it("37. recognizedAt renders", () => {
    const tree = renderToStaticMarkup(
      <AttendancePresentStatePanel
        sessionId="session-1"
        rosterCount={25}
        presentCount={2}
        students={makeStudents()}
      />,
    );
    // The formatRecognizedAt helper renders a localized string.
    // We assert the row carries the recognizedAt label.
    expect(tree.toLowerCase()).toContain("recognized at");
  });

  it("38. zero marks shows restrained empty state (no Absent / Late label)", () => {
    const tree = renderToStaticMarkup(
      <AttendancePresentStatePanel
        sessionId="session-1"
        rosterCount={25}
        presentCount={0}
        students={[]}
      />,
    );
    expect(tree).toContain("data-attendance-present-empty=\"true\"");
    expect(tree.toLowerCase()).not.toMatch(/\babsent\b/);
    expect(tree.toLowerCase()).not.toMatch(/\blate\b/);
    expect(tree).toMatch(/no students recorded yet/i);
  });

  it("sessionId is propagated as a data-attribute for reconciliation", () => {
    const tree = renderToStaticMarkup(
      <AttendancePresentStatePanel
        sessionId="session-1"
        rosterCount={25}
        presentCount={0}
        students={[]}
      />,
    );
    expect(tree).toContain('data-attendance-present-session="session-1"');
  });
});

describe("AttendancePresentStatePanel — privacy / isolation", () => {
  it("4. NEVER renders studentUserId", () => {
    const tree = renderToStaticMarkup(
      <AttendancePresentStatePanel
        sessionId="session-1"
        rosterCount={2}
        presentCount={1}
        students={[
          {
            fullName: "Alice",
            identificationCode: "SV001",
            recognizedAt: "2026-09-16T10:00:00.000Z",
          },
        ]}
      />,
    );
    expect(tree.toLowerCase()).not.toContain("studentuserid");
  });

  it("5. NEVER renders AttendanceMark _id", () => {
    const tree = renderToStaticMarkup(
      <AttendancePresentStatePanel
        sessionId="session-1"
        rosterCount={2}
        presentCount={1}
        students={[
          {
            fullName: "Alice",
            identificationCode: "SV001",
            recognizedAt: "2026-09-16T10:00:00.000Z",
          },
        ]}
      />,
    );
    expect(tree).not.toMatch(/_id/);
    expect(tree).not.toContain("attendance_marks");
  });

  it("6. NEVER renders FaceProfile / embedding / centroid / biometric", () => {
    const tree = renderToStaticMarkup(
      <AttendancePresentStatePanel
        sessionId="session-1"
        rosterCount={2}
        presentCount={1}
        students={[
          {
            fullName: "Alice",
            identificationCode: "SV001",
            recognizedAt: "2026-09-16T10:00:00.000Z",
          },
        ]}
      />,
    );
    expect(tree).not.toContain("FaceProfile");
    expect(tree).not.toContain("embedding");
    expect(tree).not.toContain("centroid");
    expect(tree).not.toContain("biometric");
  });

  it("7. NEVER renders teacherUserId / passwordHash / startedByUserId", () => {
    const tree = renderToStaticMarkup(
      <AttendancePresentStatePanel
        sessionId="session-1"
        rosterCount={2}
        presentCount={1}
        students={[
          {
            fullName: "Alice",
            identificationCode: "SV001",
            recognizedAt: "2026-09-16T10:00:00.000Z",
          },
        ]}
      />,
    );
    expect(tree.toLowerCase()).not.toContain("teacheruserid");
    expect(tree.toLowerCase()).not.toContain("startedbyuserid");
    expect(tree.toLowerCase()).not.toContain("password");
    expect(tree).not.toContain("passwordHash");
  });

  it("41 / 42. no Absent / Late label", () => {
    const tree = renderToStaticMarkup(
      <AttendancePresentStatePanel
        sessionId="session-1"
        rosterCount={2}
        presentCount={0}
        students={[]}
      />,
    );
    // The exact tokens are NOT rendered as attendance labels.
    expect(tree).not.toMatch(/Absent\s*:/);
    expect(tree).not.toMatch(/Late\s*:/);
  });

  it("9. NEVER imports the Face Service client", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-present-state-panel.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/face-service-client/);
    expect(stripped).not.toMatch(/biometrics\/face-service/);
  });

  it("does NOT introduce a /api/attendance route", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-present-state-panel.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/\/api\/attendance/);
    expect(stripped).not.toMatch(/NextResponse/);
  });

  it("does NOT use client hooks (useEffect, useState, useRouter)", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-present-state-panel.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/useEffect/);
    expect(stripped).not.toMatch(/useState/);
    expect(stripped).not.toMatch(/useRouter/);
    expect(stripped).not.toMatch(/useTransition/);
  });
});

describe("AttendancePresentStatePanel — module surface", () => {
  it("module is importable and renders without errors", () => {
    expect(() =>
      renderToStaticMarkup(
        <AttendancePresentStatePanel
          sessionId="session-1"
          rosterCount={0}
          presentCount={0}
          students={[]}
        />,
      ),
    ).not.toThrow();
  });
});
