/**
 * Schema tests for the AttendanceMark Mongoose model.
 *
 * PHASE 6.4 — IDEMPOTENT PRESENT ATTENDANCE MARKS.
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
 *   3. status only "present"
 *   4. recognizedAt stored
 *   5. source face_recognition
 *   6. unique sessionId + studentUserId index
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
// 3 — status enum
// =============================================================================

describe("AttendanceMark model / status enum", () => {
  it("3. status only supports 'present' (no absent/late/excused)", () => {
    expect(ATTENDANCE_MARK_STATUSES).toEqual(["present"]);
    const statusPath = AttendanceMarkModel.schema.path("status");
    const enumOption = (statusPath as unknown as { options: { enum?: unknown } })
      .options.enum;
    const enumValues: readonly string[] = Array.isArray(enumOption)
      ? (enumOption as readonly string[])
      : ((enumOption as { values: readonly string[] }).values ?? []);
    expect(enumValues).toEqual(["present"]);
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
// 5 — source enum
// =============================================================================

describe("AttendanceMark model / source enum", () => {
  it("5. source only supports 'face_recognition'", () => {
    expect(ATTENDANCE_MARK_SOURCES).toEqual(["face_recognition"]);
    const sourcePath = AttendanceMarkModel.schema.path("source");
    const enumOption = (sourcePath as unknown as { options: { enum?: unknown } })
      .options.enum;
    const enumValues: readonly string[] = Array.isArray(enumOption)
      ? (enumOption as readonly string[])
      : ((enumOption as { values: readonly string[] }).values ?? []);
    expect(enumValues).toEqual(["face_recognition"]);
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
