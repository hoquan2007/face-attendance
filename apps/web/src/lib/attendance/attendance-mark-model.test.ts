/**
 * Schema tests for the AttendanceMark Mongoose model.
 *
 * PHASE 6.4 — IDEMPOTENT PRESENT ATTENDANCE MARKS.
 * PHASE 6.6 — ATTENDANCE SESSION FINALIZATION (absent + session_finalization).
 *
 * These tests inspect the Mongoose schema (collection name,
 * required fields, status enum, source enum, unique compound
 * index) without connecting to MongoDB. They use the production
 * model so the configuration under test matches what runs in
 * the application.
 *
 * Covers:
 *   1. attendance_marks model is server-only
 *   2. required sessionId / classId / studentUserId fields
 *   3. (PHASE 6.4 + 6.6) status supports "present" AND "absent"
 *   4. recognizedAt stored
 *   5. (PHASE 6.4 + 6.6) source supports "face_recognition" AND "session_finalization"
 *   6. unique sessionId + studentUserId index
 *   7. (PHASE 6.6) "late" status NOT supported
 *   8. (PHASE 6.6) "manual" / "excused" sources NOT supported
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  AttendanceMarkModel,
  ATTENDANCE_MARK_STATUSES,
  ATTENDANCE_MARK_SOURCES,
} from "./attendance-mark-model";

// =============================================================================
// 1 — server-only
// =============================================================================

describe("AttendanceMark model / module boundary", () => {
  it("1. attendance_marks model is server-only (import 'server-only')", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/lib/attendance/attendance-mark-model.ts"),
      "utf-8",
    );
    expect(source).toMatch(/import\s+["']server-only["']/);
  });

  it("uses the expected collection name 'attendance_marks'", () => {
    expect(AttendanceMarkModel.collection.name).toBe("attendance_marks");
  });

  it("does NOT use Better Auth collection names", () => {
    const name = AttendanceMarkModel.collection.name;
    expect(name).not.toBe("user");
    expect(name).not.toBe("session");
    expect(name).not.toBe("account");
    expect(name).not.toBe("verification");
    expect(name).not.toBe("classes");
    expect(name).not.toBe("class_memberships");
    expect(name).not.toBe("profiles");
    expect(name).not.toBe("face_profiles");
    expect(name).not.toBe("face_enrollment_sessions");
    expect(name).not.toBe("attendance_sessions");
  });
});

// =============================================================================
// 2 — required fields
// =============================================================================

describe("AttendanceMark model / required fields", () => {
  it("2a. sessionId is required", () => {
    expect(AttendanceMarkModel.schema.path("sessionId").isRequired).toBe(
      true,
    );
  });

  it("2b. classId is required", () => {
    expect(AttendanceMarkModel.schema.path("classId").isRequired).toBe(
      true,
    );
  });

  it("2c. studentUserId is required", () => {
    expect(
      AttendanceMarkModel.schema.path("studentUserId").isRequired,
    ).toBe(true);
  });

  it("2d. recognizedAt is required", () => {
    expect(
      AttendanceMarkModel.schema.path("recognizedAt").isRequired,
    ).toBe(true);
  });

  it("2e. status is required", () => {
    expect(AttendanceMarkModel.schema.path("status").isRequired).toBe(
      true,
    );
  });

  it("2f. source is required", () => {
    expect(AttendanceMarkModel.schema.path("source").isRequired).toBe(
      true,
    );
  });
});

// =============================================================================
// 3 — status enum (PHASE 6.4 + 6.6)
// =============================================================================

describe("AttendanceMark model / status enum", () => {
  it("3a. status supports 'present' (PHASE 6.4)", () => {
    expect(ATTENDANCE_MARK_STATUSES).toContain("present");
  });

  it("3b. status supports 'absent' (PHASE 6.6)", () => {
    expect(ATTENDANCE_MARK_STATUSES).toContain("absent");
  });

  it("3c. status does NOT support 'late'", () => {
    expect(ATTENDANCE_MARK_STATUSES).not.toContain("late");
  });

  it("3d. status does NOT support 'excused'", () => {
    expect(ATTENDANCE_MARK_STATUSES).not.toContain("excused");
  });

  it("3e. status enum values match schema (present + absent)", () => {
    const statusPath = AttendanceMarkModel.schema.path("status");
    const enumOption = (statusPath as unknown as { options: { enum?: unknown } })
      .options.enum;
    const enumValues: readonly string[] = Array.isArray(enumOption)
      ? (enumOption as readonly string[])
      : ((enumOption as { values: readonly string[] }).values ?? []);
    expect(enumValues).toEqual(["present", "absent"]);
  });
});

// =============================================================================
// 4 — recognizedAt
// =============================================================================

describe("AttendanceMark model / recognizedAt", () => {
  it("4. recognizedAt defaults to a Date (server current time on insert)", () => {
    const path = AttendanceMarkModel.schema.path("recognizedAt");
    const defaultValue = path.options.default;
    // The default factory returns `new Date()`. It is a function.
    expect(typeof defaultValue).toBe("function");
    // Calling it returns a Date instance.
    expect(defaultValue()).toBeInstanceOf(Date);
  });
});

// =============================================================================
// 5 — source enum (PHASE 6.4 + 6.6)
// =============================================================================

describe("AttendanceMark model / source enum", () => {
  it("5a. source supports 'face_recognition' (PHASE 6.4)", () => {
    expect(ATTENDANCE_MARK_SOURCES).toContain("face_recognition");
  });

  it("5b. source supports 'session_finalization' (PHASE 6.6)", () => {
    expect(ATTENDANCE_MARK_SOURCES).toContain("session_finalization");
  });

  it("5c. source does NOT support 'manual'", () => {
    expect(ATTENDANCE_MARK_SOURCES).not.toContain("manual");
  });

  it("5d. source does NOT support 'teacher_override'", () => {
    expect(ATTENDANCE_MARK_SOURCES).not.toContain("teacher_override");
  });

  it("5e. source enum values match schema (face_recognition + session_finalization)", () => {
    const sourcePath = AttendanceMarkModel.schema.path("source");
    const enumOption = (sourcePath as unknown as { options: { enum?: unknown } })
      .options.enum;
    const enumValues: readonly string[] = Array.isArray(enumOption)
      ? (enumOption as readonly string[])
      : ((enumOption as { values: readonly string[] }).values ?? []);
    expect(enumValues).toEqual(["face_recognition", "session_finalization"]);
  });
});

// =============================================================================
// 6 — unique compound index
// =============================================================================

describe("AttendanceMark model / unique index", () => {
  it("6. unique compound index exists on (sessionId, studentUserId)", () => {
    const indexes = AttendanceMarkModel.schema.indexes();
    const uniqueIndex = indexes.find(([keys, options]) => {
      const k = keys as Record<string, number>;
      const o = options as { unique?: boolean } | undefined;
      return (
        k.sessionId === 1 &&
        k.studentUserId === 1 &&
        o?.unique === true
      );
    });
    expect(uniqueIndex).toBeDefined();
  });

  it("unique compound index has the documented name", () => {
    const indexes = AttendanceMarkModel.schema.indexes();
    const named = indexes.find(
      ([, options]) =>
        (options as { name?: string } | undefined)?.name ===
        "sessionId_studentUserId_unique",
    );
    expect(named).toBeDefined();
  });

  it("plain sessionId index exists", () => {
    const indexes = AttendanceMarkModel.schema.indexes();
    const sessionIdIndex = indexes.find(([keys]) => {
      const k = keys as Record<string, number>;
      return k.sessionId === 1 && k.studentUserId === undefined;
    });
    expect(sessionIdIndex).toBeDefined();
  });

  it("plain classId index exists", () => {
    const indexes = AttendanceMarkModel.schema.indexes();
    const classIdIndex = indexes.find(([keys]) => {
      const k = keys as Record<string, number>;
      return k.classId === 1 && k.studentUserId === undefined;
    });
    expect(classIdIndex).toBeDefined();
  });
});

// =============================================================================
// Privacy — schema field inventory
// =============================================================================

describe("AttendanceMark model / privacy posture", () => {
  it("schema does NOT declare embedding / centroid / biometric / FaceProfile fields", () => {
    const pathNames = Object.keys(AttendanceMarkModel.schema.paths);
    const forbidden = [
      "embedding",
      "centroid",
      "biometric",
      "FaceProfile",
      "faceProfile",
      "rawImage",
      "frame",
      "ciphertext",
      "aesKey",
      "biometricCiphertext",
    ];
    for (const forbiddenField of forbidden) {
      expect(pathNames).not.toContain(forbiddenField);
    }
  });
});