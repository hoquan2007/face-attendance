/**
 * Schema tests for the Class Mongoose model.
 *
 * PHASE 5.1A — Class + Membership persistence foundation.
 *
 * These tests inspect the Mongoose schema (collection name, required
 * fields, unique indexes, validation, password field absence) without
 * connecting to MongoDB. They use the production model so the
 * configuration under test matches what runs in the application.
 */

import { describe, expect, it } from "vitest";
import {
  ClassModel,
  CLASS_STATUSES,
  type ClassAttrs,
  toSafeClassDto,
} from "./class-model";

// =============================================================================
// Helpers
// =============================================================================

function makeValidClass(overrides: Partial<ClassAttrs> = {}): ClassAttrs {
  return {
    name: "Web Development - D22",
    teacherUserId: "teacher-1",
    classCode: "ABC1234",
    passwordHash: "salt:key",
    status: "active",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

// =============================================================================
// Collection
// =============================================================================

describe("Class model / collection", () => {
  it("uses the expected collection name", () => {
    expect(ClassModel.collection.name).toBe("classes");
  });
});

// =============================================================================
// Field requirements
// =============================================================================

describe("Class model / required fields", () => {
  it("10. name is required", () => {
    expect(ClassModel.schema.path("name").isRequired).toBe(true);
  });

  it("name has trim option enabled", () => {
    expect(ClassModel.schema.path("name").options.trim).toBe(true);
  });

  it("name has maxlength of 200", () => {
    const maxlength = ClassModel.schema.path("name").options.maxlength;
    expect(Array.isArray(maxlength) ? maxlength[0] : maxlength).toBe(200);
  });

  it("11. teacherUserId is required", () => {
    expect(ClassModel.schema.path("teacherUserId").isRequired).toBe(true);
  });

  it("12. classCode is required", () => {
    expect(ClassModel.schema.path("classCode").isRequired).toBe(true);
  });

  it("13. passwordHash is required", () => {
    expect(ClassModel.schema.path("passwordHash").isRequired).toBe(true);
  });
});

// =============================================================================
// Status enum
// =============================================================================

describe("Class model / status enum", () => {
  it("14. status defaults to 'active'", () => {
    expect(ClassModel.schema.path("status").options.default).toBe("active");
  });

  it("supports 'active' and 'archived'", () => {
    expect(CLASS_STATUSES).toContain("active");
    expect(CLASS_STATUSES).toContain("archived");
  });
});

// =============================================================================
// Indexes
// =============================================================================

describe("Class model / indexes", () => {
  it("15. unique index on classCode exists", () => {
    const indexes = ClassModel.schema.indexes();
    const classCodeIndex = indexes.find(([keys]) => {
      const k = keys as Record<string, number>;
      return k.classCode === 1;
    });
    expect(classCodeIndex).toBeDefined();
    const options = classCodeIndex?.[1] as { unique?: boolean } | undefined;
    expect(options?.unique).toBe(true);
  });

  it("16. teacherUserId index exists", () => {
    const indexes = ClassModel.schema.indexes();
    const teacherIndex = indexes.find(([keys]) => {
      const k = keys as Record<string, number>;
      return k.teacherUserId === 1;
    });
    expect(teacherIndex).toBeDefined();
  });
});

// =============================================================================
// Password field absence
// =============================================================================

describe("Class model / password field absence", () => {
  it("17. raw 'password' field does NOT exist", () => {
    const schemaPaths = Object.keys(ClassModel.schema.paths);
    expect(schemaPaths).not.toContain("password");
  });

  it("'rawPassword' field does NOT exist", () => {
    const schemaPaths = Object.keys(ClassModel.schema.paths);
    expect(schemaPaths).not.toContain("rawPassword");
  });

  it("'joinPassword' field does NOT exist", () => {
    const schemaPaths = Object.keys(ClassModel.schema.paths);
    expect(schemaPaths).not.toContain("joinPassword");
  });

  it("'plaintextPassword' field does NOT exist", () => {
    const schemaPaths = Object.keys(ClassModel.schema.paths);
    expect(schemaPaths).not.toContain("plaintextPassword");
  });
});

// =============================================================================
// Timestamps
// =============================================================================

describe("Class model / timestamps", () => {
  it("has timestamps enabled", () => {
    expect(ClassModel.schema.options.timestamps).toBe(true);
  });
});

// =============================================================================
// No biometric fields
// =============================================================================

describe("Class model / no biometric fields", () => {
  it("does not contain biometric fields", () => {
    const schemaPaths = Object.keys(ClassModel.schema.paths);
    const biometricTerms = [
      "embedding",
      "centroid",
      "faceProfile",
      "biometric",
      "encryptedVector",
      "ciphertext",
    ];
    for (const term of biometricTerms) {
      const found = schemaPaths.some(
        (p) => p.toLowerCase().includes(term.toLowerCase()),
      );
      expect(found, `Field '${term}' should not exist`).toBe(false);
    }
  });
});

// =============================================================================
// Safe DTO
// =============================================================================

describe("toSafeClassDto", () => {
  it("49. safe DTO contains no passwordHash", () => {
    // Create a fake hydrated document shape.
    const fakeDoc = {
      _id: { toString: () => "507f1f77bcf86cd799439011" },
      name: "Test Class",
      teacherUserId: "teacher-1",
      classCode: "TEST1234",
      passwordHash: "secret-hash",
      status: "active" as const,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    } as unknown as Parameters<typeof toSafeClassDto>[0];

    const dto = toSafeClassDto(fakeDoc);

    // passwordHash should NOT be in the safe DTO.
    expect(dto).not.toHaveProperty("passwordHash");
    expect(dto).not.toHaveProperty("password");
    expect(dto).not.toHaveProperty("rawPassword");

    // Other fields should be present.
    expect(dto).toHaveProperty("name");
    expect(dto).toHaveProperty("classCode");
    expect(dto).toHaveProperty("teacherUserId");
    expect(dto).toHaveProperty("status");
    expect(dto).toHaveProperty("id");
  });

  it("safe DTO id is the string form of the ObjectId", () => {
    const fakeDoc = {
      _id: { toString: () => "fake-id-123" },
      name: "Test",
      teacherUserId: "teacher-1",
      classCode: "TEST1234",
      passwordHash: "hash",
      status: "active" as const,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    } as unknown as Parameters<typeof toSafeClassDto>[0];

    const dto = toSafeClassDto(fakeDoc);
    expect(dto.id).toBe("fake-id-123");
  });
});

// =============================================================================
// No Better Auth collection modification
// =============================================================================

describe("Class model / Better Auth independence", () => {
  it("18. uses 'classes' collection (not 'user', 'session', 'account', 'verification')", () => {
    const name = ClassModel.collection.name;
    expect(name).toBe("classes");
    expect(name).not.toBe("user");
    expect(name).not.toBe("session");
    expect(name).not.toBe("account");
    expect(name).not.toBe("verification");
  });
});
