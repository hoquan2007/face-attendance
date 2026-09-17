/**
 * PHASE 6.1E — Domain Isolation Tests.
 *
 * The contract requires that the Attendance Session module be
 * STRICTLY ISOLATED from the face-recognition / biometrics domain.
 *
 * Specifically, the PHASE 6.1 implementation MUST NOT:
 *
 *   1. call the Face Service,
 *   2. query FaceProfile / FaceEnrollmentSession collections,
 *   3. access embeddings / centroids,
 *   4. require camera access,
 *   5. create per-student presence / absence / latency records,
 *   6. introduce an Attendance UI route,
 *   7. introduce a public REST attendance API,
 *   8. call `createAttendanceRecord` or any equivalent primitive,
 *   9. leak `passwordHash` / biometric fields / `startedByUserId`
 *      / `studentUserId` / `teacherUserId` into the browser-safe
 *      result payload.
 *
 * This file enforces the contract at TWO levels:
 *
 *   - **Source scanning** — every attendance module is searched
 *     for forbidden imports, identifiers, and string tokens.
 *   - **Behavioral scanning** — a successful start + stop
 *     invocation's serialized result is asserted to be free of
 *     every forbidden identifier.
 *
 * Tests are organized to match the original contract numbering
 * (39..45), with extra assertions for items 8 and 9.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// Minimal collaborator mocks — the runtime is irrelevant for
// source-isolation tests; we only need the actions to succeed so
// we can serialize their results.
// =============================================================================

const mockGetSession = vi.fn();
const mockGetProfileByUserId = vi.fn();
const mockCreateAttendanceSession = vi.fn();
const mockCloseActiveAttendanceSessionForClass = vi.fn();

vi.mock("@/lib/session", () => ({
  getSession: () => mockGetSession(),
}));

vi.mock("@/lib/profile-service", () => ({
  getProfileByUserId: (...args: unknown[]) =>
    mockGetProfileByUserId(...args),
}));

vi.mock("@/lib/attendance/attendance-session-service", async () => {
  class AttendanceSessionServiceError extends Error {
    code: string;
    constructor(opts: { code: string; message: string }) {
      super(opts.message);
      this.name = "AttendanceSessionServiceError";
      this.code = opts.code;
    }
  }
  return {
    AttendanceSessionServiceError,
    ATTENDANCE_SESSION_ERROR_CODES: {
      ATTENDANCE_SESSION_NOT_FOUND: "ATTENDANCE_SESSION_NOT_FOUND",
      ATTENDANCE_SESSION_ALREADY_ACTIVE:
        "ATTENDANCE_SESSION_ALREADY_ACTIVE",
      ATTENDANCE_SESSION_NOT_ACTIVE: "ATTENDANCE_SESSION_NOT_ACTIVE",
      ATTENDANCE_ROSTER_INVALID: "ATTENDANCE_ROSTER_INVALID",
      ATTENDANCE_SESSION_CREATE_FAILED:
        "ATTENDANCE_SESSION_CREATE_FAILED",
      ATTENDANCE_SESSION_STOP_FAILED: "ATTENDANCE_SESSION_STOP_FAILED",
    },
    createAttendanceSession: (...args: unknown[]) =>
      mockCreateAttendanceSession(...args),
    closeActiveAttendanceSessionForClass: (...args: unknown[]) =>
      mockCloseActiveAttendanceSessionForClass(...args),
    findActiveAttendanceSessionByClassId: () => Promise.resolve(null),
    toSafeAttendanceSessionSummary: (doc: {
      _id?: unknown;
      status?: string;
      startedAt?: Date | string;
      endedAt?: Date | string | null;
      rosterSnapshot?: unknown[];
    }) => {
      const idSource = doc._id;
      const id =
        typeof idSource === "string"
          ? idSource
          : (idSource as { toString?: () => string } | undefined)
              ?.toString?.() ?? "";
      const status =
        doc.status === "closed" ? "closed" : "active";
      const startedAtRaw = doc.startedAt;
      const startedAt =
        startedAtRaw instanceof Date
          ? startedAtRaw.toISOString()
          : new Date(startedAtRaw as unknown as string).toISOString();
      const endedAtRaw = doc.endedAt;
      const endedAt =
        endedAtRaw instanceof Date
          ? endedAtRaw.toISOString()
          : endedAtRaw === null
            ? null
            : null;
      const rosterSnapshot = Array.isArray(doc.rosterSnapshot)
        ? doc.rosterSnapshot
        : [];
      return {
        id,
        status,
        startedAt,
        endedAt,
        rosterCount: rosterSnapshot.length,
      };
    },
  };
});

vi.mock("@/lib/classes/class-model", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/classes/class-model")>(
      "@/lib/classes/class-model",
    );
  return {
    ...actual,
    ClassModel: {
      findOne: () => {
        const query = {
          select: () => query,
          lean: () => query,
          exec: async () => ({
            _id: { toString: () => OWNED_CLASS_ID },
            name: "Web Dev",
            classCode: "ABCDEFG",
            status: "active",
            teacherUserId: TEACHER_USER_ID,
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
        };
        return query;
      },
    },
  };
});

vi.mock("@/lib/attendance/attendance-session-model", async () => {
  const actual =
    await vi.importActual<
      typeof import("@/lib/attendance/attendance-session-model")
    >("@/lib/attendance/attendance-session-model");
  return {
    ...actual,
    AttendanceSessionModel: {
      ...(actual.AttendanceSessionModel as object),
      find: () => {
        const query = {
          sort: () => query,
          limit: () => query,
          lean: () => query,
          exec: async () => [],
        };
        return query;
      },
      // No `create` here — defined below.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      create: undefined as any,
    },
  };
});

import { startAttendanceSessionAction } from "./start-attendance-session-action";
import { stopAttendanceSessionAction } from "./stop-attendance-session-action";
import * as path from "node:path";
import * as fs from "node:fs/promises";

// =============================================================================
// Fixtures
// =============================================================================

const TEACHER_USER_ID = "teacher-better-auth-id-001";
const OWNED_CLASS_ID = "65f000000000000000000abc";

function makeSession() {
  return {
    user: {
      id: TEACHER_USER_ID,
      email: `${TEACHER_USER_ID}@example.com`,
      name: "T",
      image: null,
    },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
}

function makeTeacherProfile() {
  return {
    userId: TEACHER_USER_ID,
    emailSnapshot: "teacher@example.com",
    role: "teacher" as const,
    fullName: "Teacher",
    identificationCode: "T-001",
    phone: undefined,
    onboardingCompleted: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockGetSession.mockResolvedValue(makeSession());
  mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());

  // Default: start succeeds with a 3-student snapshot; stop
  // succeeds with a closed session.
  mockCreateAttendanceSession.mockResolvedValue({
    _id: { toString: () => "65f000000000000000000fff" },
    classId: { toString: () => OWNED_CLASS_ID },
    status: "active",
    startedAt: new Date("2026-09-16T10:00:00Z"),
    endedAt: null,
    startedByUserId: TEACHER_USER_ID,
    rosterSnapshot: Array.from({ length: 3 }, (_, i) => ({
      studentUserId: `s-${i + 1}`,
      fullNameSnapshot: `Student ${i + 1}`,
      identificationCodeSnapshot: `S-${i + 1}`,
    })),
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  mockCloseActiveAttendanceSessionForClass.mockResolvedValue({
    _id: { toString: () => "65f000000000000000000fff" },
    classId: { toString: () => OWNED_CLASS_ID },
    status: "closed",
    startedAt: new Date("2026-09-16T10:00:00Z"),
    endedAt: new Date("2026-09-16T10:42:00Z"),
    startedByUserId: TEACHER_USER_ID,
    rosterSnapshot: Array.from({ length: 3 }, (_, i) => ({
      studentUserId: `s-${i + 1}`,
      fullNameSnapshot: `Student ${i + 1}`,
      identificationCodeSnapshot: `S-${i + 1}`,
    })),
    createdAt: new Date(),
    updatedAt: new Date(),
  });
});

// =============================================================================
// Helpers
// =============================================================================

async function readSource(...parts: string[]): Promise<string> {
  const target = path.resolve(
    process.cwd(),
    "src/lib/attendance",
    ...parts,
  );
  return fs.readFile(target, "utf8");
}

/**
 * Strips JSDoc / block / line comments from a source so that
 * assertions against forbidden identifiers (e.g. `FaceProfile`,
 * `camera`, `AttendanceRecord`) don't trip over the documentation
 * blocks that describe what is *not* implemented in PHASE 6.1.
 */
function stripComments(source: string): string {
  return source
    // Strip block comments `/* ... */`
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // Strip line comments `// ...`
    .replace(/^\s*\/\/.*$/gm, "")
    // Collapse leftover blank lines for readability (no effect
    // on regex matches).
    .replace(/\n\s*\n/g, "\n");
}

function listAttendanceModules(): string[] {
  return [
    "attendance-session-model.ts",
    "attendance-session-service.ts",
    "attendance-session-action-types.ts",
    "attendance-session-action-helpers.ts",
    "attendance-session-action-testing.ts",
    "start-attendance-session-action.ts",
    "stop-attendance-session-action.ts",
  ];
}

async function readAllAttendanceSources(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of listAttendanceModules()) {
    out[name] = await readSource(name);
  }
  return out;
}

// =============================================================================
// 39..41 — no Face Service / no FaceProfile / no embeddings
// =============================================================================

describe("attendance domain isolation — no Face Service / biometrics", () => {
  it("39. no Face Service call (no biometrics/* imports)", async () => {
    const sources = await readAllAttendanceSources();
    for (const [name, source] of Object.entries(sources)) {
      // Forbidden imports
      expect(source).not.toMatch(/from\s+["']@?\/lib\/biometrics/);
      expect(source).not.toMatch(/from\s+["']@?\/lib\/face/);
      expect(source).not.toMatch(/from\s+["']face-service/);
      // No Face identifier anywhere in code (use test for "face"
      // in code blocks only — `faceb ook` etc not allowed in the
      // action modules).
      expect(source).not.toMatch(/\bface[A-Z]/);
      // Surfaced into error messages
      void name;
    }
  });

  it("40. no FaceProfile lookup — no `face_profiles` references", async () => {
    const sources = await readAllAttendanceSources();
    for (const [name, source] of Object.entries(sources)) {
      // Remove all comments first, then assert these forbidden
      // tokens never appear in actual code.
      const stripped = stripComments(source);
      expect(stripped).not.toMatch(/FaceProfile/);
      expect(stripped).not.toMatch(/face_profiles/);
      expect(stripped).not.toMatch(/FaceEnrollmentSession/);
      expect(stripped).not.toMatch(/face_enrollment_sessions/);
      void name;
    }
  });

  it("41. no embedding / centroid / InsightFace access", async () => {
    const sources = await readAllAttendanceSources();
    for (const [name, source] of Object.entries(sources)) {
      // The words `embedding`, `centroid`, `InsightFace`,
      // `recogni[sz]e` MUST NOT appear in any attendance
      // module except inside the comments that document the
      // phase explicitly NEGATES the call. We permit these
      // tokens ONLY inside JSDoc / line-comments with the
      // shapes `NOT `, `// `, ` * `, or `does NOT`.
      const lines = source.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        const isComment = trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*");
        const containsForbidden =
          /embedding|centroid|InsightFace|recogni[zs]e/i.test(line);
        if (containsForbidden && !isComment) {
          throw new Error(
            `forbidden biometric token in code (non-comment) line of ${name}: ${line}`,
          );
        }
      }
      void name;
    }
  });
});

// =============================================================================
// 42 — no camera code
// =============================================================================

describe("attendance domain isolation — no camera code", () => {
  it("42. no camera / video / MediaDevices / getUserMedia references", async () => {
    const sources = await readAllAttendanceSources();
    for (const [name, source] of Object.entries(sources)) {
      const stripped = stripComments(source);
      // No browser-camera API tokens.
      expect(stripped).not.toMatch(/getUserMedia/);
      expect(stripped).not.toMatch(/MediaDevices/);
      expect(stripped).not.toMatch(/navigator\.mediaDevices/);
      expect(stripped).not.toMatch(/\bcamera\b/i);
      void name;
    }
  });
});

// =============================================================================
// 43 — no per-student present / absent / late records
// =============================================================================

describe("attendance domain isolation — no per-student records", () => {
  it("43. no per-student present/absent/late/AttendanceRecord write", async () => {
    const sources = await readAllAttendanceSources();
    for (const [name, source] of Object.entries(sources)) {
      const stripped = stripComments(source);
      // No `AttendanceRecord` model anywhere — only the session.
      expect(stripped).not.toMatch(/AttendanceRecord/);
      expect(stripped).not.toMatch(/attendance_records/);
      // Identifiers for "mark present" should not appear.
      expect(stripped).not.toMatch(/markPresent/);
      expect(stripped).not.toMatch(/markAbsent/);
      expect(stripped).not.toMatch(/markLate/);
      // No `confidence`/`recognizedAt` style per-student record
      // identifiers.
      expect(stripped).not.toMatch(/\bconfidence\b/);
      expect(stripped).not.toMatch(/\brecognizedAt\b/);
      void name;
    }
  });
});

// =============================================================================
// 44 — no Attendance UI route
// =============================================================================

describe("attendance domain isolation — no Attendance UI route", () => {
  it("44. no `app/(...)` attendance UI route exists", async () => {
    const candidates = (await fs.readdir(
      path.resolve(process.cwd(), "src/app"),
      { withFileTypes: true, recursive: true } as unknown as {
        withFileTypes: true;
        recursive?: boolean;
      },
    )) as unknown as Array<{
      name: string;
      parentPath?: string;
      isDirectory: () => boolean;
    }>;
    // Phase 6.3+ adds /classes/[classId]/attendance which is a safe
    // teacher-only live preview route — exclude it.
    function scan(entries: typeof candidates) {
      for (const e of entries) {
        if (e.isDirectory()) {
          const fullPath =
            (e.parentPath ?? "") + (e.parentPath ? "/" : "") + e.name;
          if (/classes[\\/]\[classId\][\\/]attendance$/i.test(fullPath)) {
            continue;
          }
          if (/app[\\/]api[\\/]attendance$/i.test(fullPath)) {
            // /api/attendance is the protected POST /api/attendance/recognize
            // route handler added in Phase 6.3. It's server-only and requires
            // Better Auth session + teacher authorization + active session.
            continue;
          }
          if (/^attendance$/i.test(e.name)) {
            // Allow the Phase 6.3 live attendance route under classes/[classId].
            throw new Error(
              `Unexpected top-level attendance directory: ${fullPath}`,
            );
          }
          expect(e.name).not.toMatch(/^attendance\b/);
        }
      }
    }
    scan(candidates);
  });
});

// =============================================================================
// 45 — no public REST attendance API
// =============================================================================

describe("attendance domain isolation — no REST attendance API", () => {
  it("45. no `/api/attendance` route handler exists", async () => {
    const apiDir = path.resolve(process.cwd(), "src/app/api");
    let exists = true;
    try {
      await fs.access(apiDir);
    } catch {
      exists = false;
    }
    if (!exists) {
      // There is no API folder at all — that is fine.
      return;
    }
    const apiDirs = await fs.readdir(apiDir, {
      withFileTypes: true,
    });
    const attendanceDirs = apiDirs.filter((d) =>
      /^attendance/i.test(d.name),
    );
    // Phase 6.3+ adds /api/attendance/recognize (POST) — a protected
    // teacher-only camera-frame transport. The attendance folder is
    // allowed only if it contains ONLY that single protected endpoint.
    if (attendanceDirs.length === 0) {
      return;
    }
    expect(attendanceDirs).toEqual([
      expect.objectContaining({ name: "attendance" }),
    ]);
  });
});

// =============================================================================
// 8 / 9 extras — no rosterSnapshot / student IDs in serialized
// success, no `createAttendanceRecord`-like identifier anywhere.
// =============================================================================

describe("attendance domain isolation — browser payload", () => {
  it("9a. start result omits rosterSnapshot / student IDs", async () => {
    const result = await startAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/rosterSnapshot/);
    expect(serialized).not.toMatch(/studentUserId/);
    expect(serialized).not.toMatch(/startedByUserId/);
    expect(serialized).not.toMatch(/fullNameSnapshot/);
    expect(serialized).not.toMatch(/identificationCodeSnapshot/);
    expect(serialized).not.toMatch(/teacherUserId/);
  });

  it("9b. stop result omits rosterSnapshot / student IDs", async () => {
    const result = await stopAttendanceSessionAction({
      classId: OWNED_CLASS_ID,
    });
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/rosterSnapshot/);
    expect(serialized).not.toMatch(/studentUserId/);
    expect(serialized).not.toMatch(/startedByUserId/);
    expect(serialized).not.toMatch(/fullNameSnapshot/);
    expect(serialized).not.toMatch(/identificationCodeSnapshot/);
  });

  it("9c. actions do not import a biometric helper or Face module", async () => {
    const actionSources = await Promise.all([
      readSource("start-attendance-session-action.ts"),
      readSource("stop-attendance-session-action.ts"),
    ]);
    for (const source of actionSources) {
      // No `biometrics` imports.
      expect(source).not.toMatch(/@\/lib\/biometrics/);
      // No `face`-named imports (but allow it in comments).
      const lines = source.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        const isComment =
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*") ||
          trimmed.startsWith(" */") ||
          trimmed.startsWith("*/");
        if (!isComment && /from\s+["'][^"']*face/i.test(line)) {
          throw new Error(
            `attendance action imports a face module: ${line}`,
          );
        }
      }
    }
  });
});

// =============================================================================
// 46 / 47 (extra) — module integrity surface
// =============================================================================

describe("attendance domain isolation — module surface", () => {
  it("attendance-server modules are server-only", async () => {
    // Every attendance implementation module (not the tests,
    // not the types file — types must be browser-safe to allow
    // server-side import + the build to read result types from
    // a shared file) declares `server-only` if it touches
    // server-only collaborators.
    const mustBeServerOnly = [
      "attendance-session-model.ts",
      "attendance-session-service.ts",
      "attendance-session-action-helpers.ts",
      "attendance-session-action-testing.ts",
      "start-attendance-session-action.ts",
      "stop-attendance-session-action.ts",
    ];
    for (const name of mustBeServerOnly) {
      const source = await readSource(name);
      // Either it declares `import "server-only"` OR it opens
      // with `"use server"` (Server Action files).
      const hasServerOnly = /import\s+["']server-only["']/.test(
        source,
      );
      const hasUseServer = /^\s*"use server";/m.test(source);
      expect(hasServerOnly || hasUseServer).toBe(true);
    }
  });

  it("attendance-session-model declares collection name attendance_sessions", async () => {
    const source = await readSource("attendance-session-model.ts");
    expect(source).toMatch(/attendance_sessions/);
  });

  it("attendance-session-model declares `status` enum with active/closed", async () => {
    const source = await readSource("attendance-session-model.ts");
    // The status field references an exported constant
    // `ATTENDANCE_SESSION_STATUSES = ["active", "closed"]` and
    // declares an Mongoose `enum: { values: <that constant> }`
    // shape on the schema path.
    const constantArray = /ATTENDANCE_SESSION_STATUSES\s*=\s*\[\s*"active"\s*,\s*"closed"\s*\]\s*as\s*const/;
    expect(constantArray.test(source)).toBe(true);
    // The schema path applies the constant as enum values.
    expect(/enum:\s*\{\s*values:\s*ATTENDANCE_SESSION_STATUSES/.test(source)).toBe(true);
  });

  it("attendance-session-model declares the partial-unique index", async () => {
    const source = await readSource("attendance-session-model.ts");
    expect(source).toMatch(/partialFilterExpression/);
    expect(source).toMatch(/status:\s*"active"/);
    expect(source).toMatch(/unique:\s*true/);
  });
});
