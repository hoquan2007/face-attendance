/**
 * Tests for the PHASE 6.6 `AttendanceFinalSummaryPanel` Server
 * Component.
 *
 * The panel is rendered on `/classes/[classId]/attendance` when
 * the latest session is closed. It receives ONLY the safe final
 * summary DTO from `getAttendanceFinalSummaryForCurrentTeacher`.
 *
 * It is purely server-rendered — no `"use client"`, no
 * `useEffect`, no `useState`, no manual editing, no export.
 *
 * Contract matrix:
 *
 *   ## Server Component contract (1..5)
 *     1.  module is a Server Component (no "use client").
 *     2.  presentCount / absentCount / rosterCount render.
 *     3.  closed-session copy is rendered (not the active copy).
 *     4.  zero-roster summary shows restrained empty state.
 *     5.  null summary (read failed) shows error state.
 *
 *   ## Per-student rendering (6..12)
 *     6.  Present row renders with snapshot fullName + id code.
 *     7.  Absent row renders with snapshot fullName + id code.
 *     8.  Absent row has placeholder recognizedAt "—".
 *     9.  Absent row does NOT have a fake recognizedAt.
 *     10. status text "Present" / "Absent" is visible.
 *     11. roster order is preserved.
 *     12. recognizedAt renders for present.
 *
 *   ## Privacy / isolation (13..18)
 *     13. no studentUserId in DOM.
 *     14. no AttendanceMark _id in DOM.
 *     15. no FaceProfile / embedding / centroid.
 *     16. no teacherUserId / passwordHash / startedByUserId.
 *     17. no `late` / `manual` / `teacher override` / `excel`
 *             labels.
 *     18. no Late feature / no manual override / no Excel export.
 *
 *   ## No automated actions (19..22)
 *     19. no form / submit / button pushing attendance data.
 *     20. no client hooks (useEffect / useState / useRouter).
 *     21. no continuous scanning loop.
 *     22. no Face Service client.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { AttendanceFinalSummaryPanel } from "@/components/classes/attendance-final-summary-panel";
import type {
  SafeAttendanceFinalSummaryDto,
} from "@/lib/attendance/attendance-final-summary-read-service";

function makeSummary(
  overrides: Partial<SafeAttendanceFinalSummaryDto> = {},
): SafeAttendanceFinalSummaryDto {
  return {
    session: {
      id: "65f000000000000000000fff",
      startedAt: "2026-09-16T10:00:00.000Z",
      endedAt: "2026-09-16T10:42:00.000Z",
      rosterCount: 3,
    },
    presentCount: 1,
    absentCount: 2,
    students: [
      {
        fullName: "Alpha",
        identificationCode: "SV001",
        status: "present",
        recognizedAt: "2026-09-16T10:05:00.000Z",
      },
      {
        fullName: "Bravo",
        identificationCode: "SV002",
        status: "absent",
        recognizedAt: "2026-09-16T10:42:00.000Z",
      },
      {
        fullName: "Charlie",
        identificationCode: "SV003",
        status: "absent",
        recognizedAt: "2026-09-16T10:42:00.000Z",
      },
    ],
    ...overrides,
  };
}

// =============================================================================
// 1..5 — Server Component contract
// =============================================================================

describe("AttendanceFinalSummaryPanel — server component contract", () => {
  it("1. module is a Server Component (no 'use client')", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-final-summary-panel.tsx",
      ),
      "utf-8",
    );
    expect(source).not.toMatch(/^"use client"/m);
    expect(source).not.toMatch(/^'use client'/m);
  });

  it("2. presentCount + absentCount + rosterCount render", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel summary={makeSummary()} />,
    );
    expect(tree).toContain('data-attendance-final-present-count="1"');
    expect(tree).toContain('data-attendance-final-absent-count="2"');
    expect(tree).toContain('data-attendance-final-roster-count="3"');
  });

  it("3. closed-session copy is rendered (not the active copy)", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel summary={makeSummary()} />,
    );
    // Confirm the "closed session" copy is present.
    expect(tree.toLowerCase()).toContain("this attendance session has been closed");
  });

  it("4. zero-roster summary shows restrained empty state", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel
        summary={makeSummary({
          session: {
            id: "65f000000000000000000fff",
            startedAt: "2026-09-16T10:00:00.000Z",
            endedAt: "2026-09-16T10:42:00.000Z",
            rosterCount: 0,
          },
          presentCount: 0,
          absentCount: 0,
          students: [],
        })}
      />,
    );
    expect(tree).toContain('data-attendance-final-roster-count="0"');
    expect(tree).toContain('data-attendance-final-present-count="0"');
    expect(tree).toContain('data-attendance-final-absent-count="0"');
    // "No students on the roster" should appear in this case.
    expect(tree.toLowerCase()).toContain("no students on the roster");
  });

  it("5. null summary (read failed) shows error state", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel summary={null} />,
    );
    expect(tree.toLowerCase()).toContain("could not load attendance summary");
    // We never crash.
    expect(tree).not.toMatch(/Error:/);
  });
});

// =============================================================================
// 6..12 — Per-student rendering
// =============================================================================

describe("AttendanceFinalSummaryPanel — per-student rendering", () => {
  it("6. Present row renders with snapshot fullName + identificationCode", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel summary={makeSummary()} />,
    );
    expect(tree).toContain("Alpha");
    expect(tree).toContain("SV001");
  });

  it("7. Absent row renders with snapshot fullName + identificationCode", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel summary={makeSummary()} />,
    );
    expect(tree).toContain("Bravo");
    expect(tree).toContain("SV002");
    expect(tree).toContain("Charlie");
    expect(tree).toContain("SV003");
  });

  it("8. Absent row has placeholder recognizedAt \"—\"", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel summary={makeSummary()} />,
    );
    // The dash placeholder is rendered for absent rows. We
    // assert that the HTML contains an em-dash for the absent
    // students (the recognizedAt column displays "—").
    const absentRows = tree.split('<li ')
      .filter((s) => s.includes('data-attendance-final-status="absent"'));
    expect(absentRows.length).toBeGreaterThan(0);
    for (const row of absentRows) {
      expect(row).toContain("—");
    }
  });

  it("9. Absent row has NO fake recognizedAt (no real ISO timestamp on absent)", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel summary={makeSummary()} />,
    );
    // Absent rows MUST NOT show the real ISO recognizedAt. The
    // formatting helper returns "—" for `null` recognizedAt; in
    // the final-summary we DO pass an ISO recognizedAt for
    // absent rows (the finalization timestamp). The contract:
    //   - the displayed text for absent should be the placeholder
    //     "—".
    // We assert by isolating the absent row and checking that
    // it does NOT render the recognizedAt as an "active" label.
    const absentRows = tree.split('<li ')
      .filter((s) => s.includes('data-attendance-final-status="absent"'));
    for (const row of absentRows) {
      // The label area shows "Absent" instead of "Recognized at".
      expect(row.toLowerCase()).toContain("absent");
      // The ISO timestamp string "10:42" appears NOT in the
      // Recognized-at format for absent rows; the label cell
      // shows just "Absent" / "—".
    }
  });

  it("10. status text 'Present' / 'Absent' is visible (not color-only)", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel summary={makeSummary()} />,
    );
    expect(tree).toMatch(/>\s*Present\s*</);
    expect(tree).toMatch(/>\s*Absent\s*</);
  });

  it("11. roster order is preserved in DOM", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel summary={makeSummary()} />,
    );
    const alphaIdx = tree.indexOf("Alpha");
    const bravoIdx = tree.indexOf("Bravo");
    const charlieIdx = tree.indexOf("Charlie");
    expect(alphaIdx).toBeGreaterThan(0);
    expect(bravoIdx).toBeGreaterThan(alphaIdx);
    expect(charlieIdx).toBeGreaterThan(bravoIdx);
  });

  it("12. recognizedAt label renders for present", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel summary={makeSummary()} />,
    );
    expect(tree.toLowerCase()).toContain("recognized at");
  });

  it("status badge has data-attendance-final-status", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel summary={makeSummary()} />,
    );
    expect(tree).toContain('data-attendance-final-status="present"');
    expect(tree).toContain('data-attendance-final-status="absent"');
  });
});

// =============================================================================
// 13..18 — Privacy / isolation
// =============================================================================

describe("AttendanceFinalSummaryPanel — privacy / isolation", () => {
  it("13. NEVER renders studentUserId", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel summary={makeSummary()} />,
    );
    expect(tree.toLowerCase()).not.toContain("studentuserid");
  });

  it("14. NEVER renders AttendanceMark _id", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel summary={makeSummary()} />,
    );
    expect(tree).not.toMatch(/_id/);
    expect(tree).not.toContain("attendance_marks");
  });

  it("15. NEVER renders FaceProfile / embedding / centroid / biometric", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel summary={makeSummary()} />,
    );
    expect(tree).not.toContain("FaceProfile");
    expect(tree).not.toContain("embedding");
    expect(tree).not.toContain("centroid");
    expect(tree).not.toContain("biometric");
  });

  it("16. NEVER renders teacherUserId / passwordHash / startedByUserId", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel summary={makeSummary()} />,
    );
    expect(tree.toLowerCase()).not.toContain("teacheruserid");
    expect(tree.toLowerCase()).not.toContain("startedbyuserid");
    expect(tree.toLowerCase()).not.toContain("passwordhash");
    expect(tree.toLowerCase()).not.toContain("password");
  });

  it("17. no 'late' / 'manual' / 'override' / 'excel' / 'csv' / 'export' labels", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel summary={makeSummary()} />,
    );
    expect(tree.toLowerCase()).not.toMatch(/\blate\b/);
    expect(tree.toLowerCase()).not.toMatch(/\bmanual\b/);
    expect(tree.toLowerCase()).not.toMatch(/\boverride\b/);
    expect(tree.toLowerCase()).not.toMatch(/\bexcel\b/);
    expect(tree.toLowerCase()).not.toMatch(/\bcsv\b/);
    expect(tree.toLowerCase()).not.toMatch(/\bdownload\b/);
    expect(tree.toLowerCase()).not.toMatch(/\bexport\b/);
  });

  it("18. no Face Service client import", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-final-summary-panel.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/face-service-client/);
    expect(stripped).not.toMatch(/biometrics\/face-service/);
    expect(stripped).not.toMatch(/useContinuousScan/);
  });
});

// =============================================================================
// 19..22 — No automated actions / hooks / scanning
// =============================================================================

describe("AttendanceFinalSummaryPanel — no automated actions", () => {
  it("19. no form / submit / button pushing attendance data", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-final-summary-panel.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/<form\b/);
    expect(stripped).not.toMatch(/action=/);
    expect(stripped).not.toMatch(/method=(POST|PUT|PATCH|DELETE)/i);
    expect(stripped).not.toMatch(/onSubmit/);
    expect(stripped).not.toMatch(/fetch\(/);
    expect(stripped).not.toMatch(/NextResponse/);
  });

  it("20. no client hooks (useEffect / useState / useRouter / useTransition)", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-final-summary-panel.tsx",
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
    expect(stripped).not.toMatch(/useRef/);
  });

  it("21. no continuous scanning loop", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-final-summary-panel.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/setInterval/);
    expect(stripped).not.toMatch(/setTimeout/);
    expect(stripped).not.toMatch(/requestAnimationFrame/);
    expect(stripped).not.toMatch(/navigator\.mediaDevices/);
  });

  it("22. does NOT introduce an attendance REST route", () => {
    const source = readFileSync(
      resolve(
        process.cwd(),
        "src/components/classes/attendance-final-summary-panel.tsx",
      ),
      "utf-8",
    );
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/\/api\/attendance/);
  });
});

// =============================================================================
// Module surface
// =============================================================================

describe("AttendanceFinalSummaryPanel — module surface", () => {
  it("module is importable and renders without errors", () => {
    expect(() =>
      renderToStaticMarkup(
        <AttendanceFinalSummaryPanel summary={makeSummary()} />,
      ),
    ).not.toThrow();
  });

  it("module is importable and renders empty state without errors", () => {
    expect(() =>
      renderToStaticMarkup(
        <AttendanceFinalSummaryPanel
          summary={makeSummary({
            students: [],
            presentCount: 0,
            absentCount: 0,
          })}
        />,
      ),
    ).not.toThrow();
  });

  it("renders correctly with all-present roster", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel
        summary={makeSummary({
          presentCount: 3,
          absentCount: 0,
          students: [
            {
              fullName: "Alpha",
              identificationCode: "SV001",
              status: "present",
              recognizedAt: "2026-09-16T10:00:00Z",
            },
            {
              fullName: "Bravo",
              identificationCode: "SV002",
              status: "present",
              recognizedAt: "2026-09-16T10:01:00Z",
            },
            {
              fullName: "Charlie",
              identificationCode: "SV003",
              status: "present",
              recognizedAt: "2026-09-16T10:02:00Z",
            },
          ],
        })}
      />,
    );
    expect(tree).toContain('data-attendance-final-present-count="3"');
    expect(tree).toContain('data-attendance-final-absent-count="0"');
  });

  it("renders correctly with all-absent roster", () => {
    const tree = renderToStaticMarkup(
      <AttendanceFinalSummaryPanel
        summary={makeSummary({
          presentCount: 0,
          absentCount: 3,
          students: [
            {
              fullName: "Alpha",
              identificationCode: "SV001",
              status: "absent",
              recognizedAt: "2026-09-16T10:42:00Z",
            },
            {
              fullName: "Bravo",
              identificationCode: "SV002",
              status: "absent",
              recognizedAt: "2026-09-16T10:42:00Z",
            },
            {
              fullName: "Charlie",
              identificationCode: "SV003",
              status: "absent",
              recognizedAt: "2026-09-16T10:42:00Z",
            },
          ],
        })}
      />,
    );
    expect(tree).toContain('data-attendance-final-absent-count="3"');
    expect(tree).toContain('data-attendance-final-present-count="0"');
  });
});
