/**
 * Schema tests for the AttendanceSession Mongoose model.
 *
 * PHASE 6.1 — ATTENDANCE SESSION FOUNDATION.
 *
 * These tests inspect the Mongoose schema (collection name, required
 * fields, indexes, partial unique index on active status, sub-schema
 * shape) without connecting to MongoDB. They use the production model
 * so the configuration under test matches what runs in the
 * application.
 */

import { describe, expect, it } from "vitest";

import {
  AttendanceSessionModel,
  ATTENDANCE_SESSION_STATUSES,
  type AttendanceSessionAttrs,
} from "./attendance-session-model";

// =============================================================================
// Helpers
// =============================================================================

function makeValidSession(
  overrides: Partial<AttendanceSessionAttrs> = {},
): AttendanceSessionAttrs {
  const objectIdLike = {
    toString: () => "507f1f77bcf86cd799439011",
  } as unknown as AttendanceSessionAttrs["classId"];
  return {
    classId: objectIdLike,
    status: "active",
    startedAt: new Date("2026-09-16T10:00:00Z"),
    endedAt: null,
    startedByUserId: "teacher-better-auth-id-001",
    rosterSnapshot: [],
    createdAt: new Date("2026-09-16T10:00:00Z"),
    updatedAt: new Date("2026-09-16T10:00:00Z"),
    ...overrides,
  };
}

// =============================================================================
// Collection
// =============================================================================

describe("AttendanceSession model / collection", () => {
  it("1. uses the expected collection name", () => {
    expect(AttendanceSessionModel.collection.name).toBe(
      "attendance_sessions",
    );
  });

  it("uses 'attendance_sessions' (NOT Better Auth collections)", () => {
    const name = AttendanceSessionModel.collection.name;
    expect(name).not.toBe("user");
    expect(name).not.toBe("session");
    expect(name).not.toBe("account");
    expect(name).not.toBe("verification");
    expect(name).not.toBe("classes");
    expect(name).not.toBe("class_memberships");
    expect(name).not.toBe("profiles");
    expect(name).not.toBe("face_profiles");
    expect(name).not.toBe("face_enrollment_sessions");
  });
});

// =============================================================================
// Field requirements
// =============================================================================

describe("AttendanceSession model / required fields", () => {
  it("2. classId is required", () => {
    expect(
      AttendanceSessionModel.schema.path("classId").isRequired,
    ).toBe(true);
  });

  it("status is required", () => {
    expect(
      AttendanceSessionModel.schema.path("status").isRequired,
    ).toBe(true);
  });

  it("startedAt is required", () => {
    expect(
      AttendanceSessionModel.schema.path("startedAt").isRequired,
    ).toBe(true);
  });

  it("startedByUserId is required", () => {
    expect(
      AttendanceSessionModel.schema.path("startedByUserId").isRequired,
    ).toBe(true);
  });

  it("rosterSnapshot is required", () => {
    expect(
      AttendanceSessionModel.schema.path("rosterSnapshot").isRequired,
    ).toBe(true);
  });

  it("rosterSnapshot defaults to an empty array", () => {
    const path = AttendanceSessionModel.schema.path("rosterSnapshot");
    const defaultValue = path.options.default;
    expect(Array.isArray(defaultValue)).toBe(true);
    expect(defaultValue).toHaveLength(0);
  });
});

// =============================================================================
// Status enum
// =============================================================================

describe("AttendanceSession model / status enum", () => {
  it("3. supports 'active' and 'closed'", () => {
    expect(ATTENDANCE_SESSION_STATUSES).toContain("active");
    expect(ATTENDANCE_SESSION_STATUSES).toContain("closed");
  });

  it("rejects an invalid status", () => {
    expect(ATTENDANCE_SESSION_STATUSES).not.toContain("paused");
    expect(ATTENDANCE_SESSION_STATUSES).not.toContain("deleted");
    expect(ATTENDANCE_SESSION_STATUSES).not.toContain("");
  });

  it("declares status enum values on the schema path", () => {
    const statusPath = AttendanceSessionModel.schema.path("status");
    // Mongoose accepts `enum: { values: [...], message: "..." }`
    // OR `enum: [...]`. Our schema uses the object form, so the
    // canonical values live on `options.enum.values`.
    const enumOption = (
      statusPath as unknown as {
        options: { enum?: unknown };
      }
    ).options.enum;
    const enumValues: readonly string[] = Array.isArray(enumOption)
      ? (enumOption as readonly string[])
      : ((enumOption as { values: readonly string[] }).values ?? []);
    expect(enumValues).toEqual(ATTENDANCE_SESSION_STATUSES);
  });
});

// =============================================================================
// endedAt is optional (null while active)
// =============================================================================

describe("AttendanceSession model / endedAt", () => {
  it("endedAt is NOT required (null is the active-state default)", () => {
    expect(
      AttendanceSessionModel.schema.path("endedAt").isRequired,
    ).toBe(false);
  });

  it("endedAt defaults to null", () => {
    const path = AttendanceSessionModel.schema.path("endedAt");
    expect(path.options.default).toBe(null);
  });
});

// =============================================================================
// Indexes
// =============================================================================

describe("AttendanceSession model / indexes", () => {
  it("classId index exists", () => {
    const indexes = AttendanceSessionModel.schema.indexes();
    const classIdIndex = indexes.find(([keys]) => {
      const k = keys as Record<string, number>;
      return k.classId === 1;
    });
    expect(classIdIndex).toBeDefined();
  });

  it("status index exists", () => {
    const indexes = AttendanceSessionModel.schema.indexes();
    const statusIndex = indexes.find(([keys]) => {
      const k = keys as Record<string, number>;
      return k.status === 1;
    });
    expect(statusIndex).toBeDefined();
  });

  it("startedAt index exists (descending for chronological listing)", () => {
    const indexes = AttendanceSessionModel.schema.indexes();
    const startedAtIndex = indexes.find(([keys]) => {
      const k = keys as Record<string, number>;
      return k.startedAt === -1;
    });
    expect(startedAtIndex).toBeDefined();
  });

  it("4. partial unique index exists on (classId, status) WHERE status = active", () => {
    const indexes = AttendanceSessionModel.schema.indexes();
    const partialIndex = indexes.find(
      ([keys, options]) => {
        const k = keys as Record<string, number>;
        const o = options as
          | { unique?: boolean; partialFilterExpression?: unknown }
          | undefined;
        return (
          k.classId === 1 &&
          k.status === 1 &&
          o?.unique === true &&
          o?.partialFilterExpression !== undefined
        );
      },
    );
    expect(partialIndex).toBeDefined();
  });

  it("partial unique index filter is exactly { status: 'active' }", () => {
    const indexes = AttendanceSessionModel.schema.indexes();
    const partialIndex = indexes.find(
      ([keys, options]) => {
        const k = keys as Record<string, number>;
        const o = options as
          | { unique?: boolean; partialFilterExpression?: unknown }
          | undefined;
        return (
          k.classId === 1 &&
          k.status === 1 &&
          o?.unique === true &&
          o?.partialFilterExpression !== undefined
        );
      },
    );
    const options = partialIndex?.[1] as
      | { partialFilterExpression?: Record<string, unknown> }
      | undefined;
    expect(options?.partialFilterExpression).toEqual({ status: "active" });
  });

  it("partial unique index has the documented name", () => {
    const indexes = AttendanceSessionModel.schema.indexes();
    const named = indexes.find(
      ([, options]) =>
        (options as { name?: string } | undefined)?.name ===
        "classId_status_active_unique",
    );
    expect(named).toBeDefined();
  });

  it("no index on endedAt (cheap field, infrequently queried)", () => {
    const indexes = AttendanceSessionModel.schema.indexes();
    const endedAtIndex = indexes.find(([keys]) => {
      const k = keys as Record<string, number>;
      return k.endedAt === 1 || k.endedAt === -1;
    });
    expect(endedAtIndex).toBeUndefined();
  });
});

// =============================================================================
// Roster snapshot sub-schema
// =============================================================================

describe("AttendanceSession model / rosterSnapshot sub-schema", () => {
  it("5. rosterSnapshot stores studentUserId", () => {
    const path = AttendanceSessionModel.schema.path("rosterSnapshot");
    const subSchema = path.schema as {
      paths: Record<string, { isRequired?: boolean }>;
    };
    expect(subSchema.paths.studentUserId?.isRequired).toBe(true);
  });

  it("6. rosterSnapshot stores fullNameSnapshot", () => {
    const path = AttendanceSessionModel.schema.path("rosterSnapshot");
    const subSchema = path.schema as {
      paths: Record<string, { isRequired?: boolean }>;
    };
    expect(subSchema.paths.fullNameSnapshot?.isRequired).toBe(true);
  });

  it("7. rosterSnapshot stores identificationCodeSnapshot", () => {
    const path = AttendanceSessionModel.schema.path("rosterSnapshot");
    const subSchema = path.schema as {
      paths: Record<string, { isRequired?: boolean }>;
    };
    expect(subSchema.paths.identificationCodeSnapshot?.isRequired).toBe(
      true,
    );
  });

  it("sub-schema items carry no biometric / password / embedding fields", () => {
    const path = AttendanceSessionModel.schema.path("rosterSnapshot");
    const subSchema = path.schema as {
      paths: Record<string, unknown>;
    };
    const samplePaths = Object.keys(subSchema.paths);
    const forbidden = [
      "embedding",
      "centroid",
      "biometric",
      "password",
      "passwordHash",
      "rawPassword",
      "faceProfile",
      "encryptedVector",
      "ciphertext",
      "iv",
      "authTag",
    ];
    for (const term of forbidden) {
      const found = samplePaths.some((p) =>
        p.toLowerCase().includes(term.toLowerCase()),
      );
      expect(found, `Field '${term}' should not exist`).toBe(false);
    }
  });

  it("sub-schema items do NOT expose emailSnapshot / phone / Better Auth ids", () => {
    const path = AttendanceSessionModel.schema.path("rosterSnapshot");
    const subSchema = path.schema as {
      paths: Record<string, unknown>;
    };
    const samplePaths = Object.keys(subSchema.paths);
    expect(samplePaths).not.toContain("emailSnapshot");
    expect(samplePaths).not.toContain("phone");
    expect(samplePaths).not.toContain("email");
    expect(samplePaths).not.toContain("teacherUserId");
  });

  it("sub-schema items do NOT carry a Mongo _id", () => {
    const path = AttendanceSessionModel.schema.path("rosterSnapshot");
    const subSchemaOptions = (path.schema as { options?: { _id?: boolean } })
      .options;
    expect(subSchemaOptions?._id).toBe(false);
  });
});

// =============================================================================
// No biometric / password fields
// =============================================================================

describe("AttendanceSession model / no biometric fields", () => {
  it("does not contain biometric fields", () => {
    const schemaPaths = Object.keys(
      AttendanceSessionModel.schema.paths,
    );
    const forbidden = [
      "embedding",
      "centroid",
      "faceProfile",
      "biometric",
      "encryptedVector",
      "ciphertext",
      "passwordHash",
      "password",
      "rawPassword",
    ];
    for (const term of forbidden) {
      const found = schemaPaths.some((p) =>
        p.toLowerCase().includes(term.toLowerCase()),
      );
      expect(found, `Field '${term}' should not exist`).toBe(false);
    }
  });
});

// =============================================================================
// Timestamps
// =============================================================================

describe("AttendanceSession model / timestamps", () => {
  it("has timestamps enabled", () => {
    expect(AttendanceSessionModel.schema.options.timestamps).toBe(true);
  });

  it("declares createdAt and updatedAt", () => {
    expect(
      AttendanceSessionModel.schema.path("createdAt"),
    ).toBeDefined();
    expect(
      AttendanceSessionModel.schema.path("updatedAt"),
    ).toBeDefined();
  });
});

// =============================================================================
// Model factory test
// =============================================================================

describe("AttendanceSession model / factory", () => {
  it("makeValidSession produces a valid-looking document", () => {
    const doc = makeValidSession();
    expect(doc.status).toBe("active");
    expect(doc.rosterSnapshot).toEqual([]);
    expect(doc.startedByUserId).toBeTruthy();
    expect(doc.startedAt).toBeInstanceOf(Date);
  });
});
