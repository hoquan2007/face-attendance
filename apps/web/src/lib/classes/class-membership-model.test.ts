/**
 * Schema tests for the ClassMembership Mongoose model.
 *
 * PHASE 5.1A — Class + Membership persistence foundation.
 *
 * These tests inspect the Mongoose schema (collection name, required
 * fields, unique indexes, validation, biometric/attendance field
 * absence) without connecting to MongoDB. They use the production
 * model so the configuration under test matches what runs in the
 * application.
 */

import { describe, expect, it } from "vitest";
import {
  ClassMembershipModel,
  MEMBERSHIP_STATUSES,
  type ClassMembershipAttrs,
  toSafeMembershipDto,
} from "./class-membership-model";

// =============================================================================
// Helpers
// =============================================================================

function makeValidMembership(
  overrides: Partial<ClassMembershipAttrs> = {},
): ClassMembershipAttrs {
  const classId = {
    toString: () => "class-id-123",
  } as unknown as ClassMembershipAttrs["classId"];
  return {
    classId,
    studentUserId: "student-1",
    joinedAt: new Date("2026-01-01T00:00:00Z"),
    status: "active",
    ...overrides,
  };
}

// =============================================================================
// Collection
// =============================================================================

describe("ClassMembership model / collection", () => {
  it("uses the expected collection name", () => {
    expect(ClassMembershipModel.collection.name).toBe("class_memberships");
  });
});

// =============================================================================
// Field requirements
// =============================================================================

describe("ClassMembership model / required fields", () => {
  it("36. classId is required", () => {
    expect(ClassMembershipModel.schema.path("classId").isRequired).toBe(true);
  });

  it("37. studentUserId is required", () => {
    expect(
      ClassMembershipModel.schema.path("studentUserId").isRequired,
    ).toBe(true);
  });
});

// =============================================================================
// joinedAt
// =============================================================================

describe("ClassMembership model / joinedAt", () => {
  it("38. joinedAt is required", () => {
    expect(ClassMembershipModel.schema.path("joinedAt").isRequired).toBe(true);
  });

  it("joinedAt has a default function returning a Date", () => {
    const defaultFn = ClassMembershipModel.schema.path("joinedAt").options.default;
    expect(typeof defaultFn).toBe("function");
    const result = defaultFn();
    expect(result).toBeInstanceOf(Date);
  });
});

// =============================================================================
// Status enum
// =============================================================================

describe("ClassMembership model / status enum", () => {
  it("status defaults to 'active'", () => {
    expect(ClassMembershipModel.schema.path("status").options.default).toBe(
      "active",
    );
  });

  it("supports 'active' value", () => {
    expect(MEMBERSHIP_STATUSES).toContain("active");
  });
});

// =============================================================================
// Unique index
// =============================================================================

describe("ClassMembership model / unique constraint", () => {
  it("39. compound unique index on classId+studentUserId exists", () => {
    const indexes = ClassMembershipModel.schema.indexes();
    const compoundIndex = indexes.find(([keys]) => {
      const k = keys as Record<string, number>;
      return k.classId === 1 && k.studentUserId === 1;
    });
    expect(compoundIndex).toBeDefined();
    const options = compoundIndex?.[1] as { unique?: boolean } | undefined;
    expect(options?.unique).toBe(true);
  });
});

// =============================================================================
// Indexes for listing
// =============================================================================

describe("ClassMembership model / listing indexes", () => {
  it("has index on studentUserId for 'list by student' queries", () => {
    // The compound index on classId+studentUserId satisfies
    // class-first queries. For student-first queries, an index on
    // studentUserId alone should be present.
    const studentIndex = ClassMembershipModel.schema.indexes().find(([keys]) => {
      const k = keys as Record<string, number>;
      return k.studentUserId === 1 && !("classId" in k);
    });
    expect(studentIndex).toBeDefined();
  });
});

// =============================================================================
// No attendance data
// =============================================================================

describe("ClassMembership model / no attendance data", () => {
  it("40. no attendance-related fields exist", () => {
    const schemaPaths = Object.keys(ClassMembershipModel.schema.paths);
    const attendanceTerms = [
      "attendance",
      "present",
      "absent",
      "late",
      "checkedIn",
      "attendanceSession",
      "attendanceRecord",
    ];
    for (const term of attendanceTerms) {
      const found = schemaPaths.some(
        (p) => p.toLowerCase().includes(term.toLowerCase()),
      );
      expect(found, `Field '${term}' should not exist`).toBe(false);
    }
  });
});

// =============================================================================
// No biometric data
// =============================================================================

describe("ClassMembership model / no biometric data", () => {
  it("41. no biometric fields exist", () => {
    const schemaPaths = Object.keys(ClassMembershipModel.schema.paths);
    const biometricTerms = [
      "embedding",
      "centroid",
      "faceProfile",
      "biometric",
      "encryptedVector",
      "ciphertext",
      "faceEmbedding",
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
// Timestamps
// =============================================================================

describe("ClassMembership model / timestamps", () => {
  it("has timestamps enabled", () => {
    expect(ClassMembershipModel.schema.options.timestamps).toBe(true);
  });
});

// =============================================================================
// Safe DTO
// =============================================================================

describe("toSafeMembershipDto", () => {
  it("DTO has expected shape", () => {
    const fakeDoc = {
      _id: { toString: () => "membership-id-123" },
      classId: { toString: () => "class-id-456" },
      studentUserId: "student-1",
      joinedAt: new Date("2026-01-01"),
      status: "active" as const,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    } as unknown as Parameters<typeof toSafeMembershipDto>[0];

    const dto = toSafeMembershipDto(fakeDoc);

    expect(dto).toHaveProperty("id");
    expect(dto).toHaveProperty("classId");
    expect(dto).toHaveProperty("studentUserId");
    expect(dto).toHaveProperty("joinedAt");
    expect(dto).toHaveProperty("status");
    expect(dto).toHaveProperty("createdAt");
    expect(dto).toHaveProperty("updatedAt");
  });

  it("DTO has no biometric fields", () => {
    const fakeDoc = {
      _id: { toString: () => "membership-id-123" },
      classId: { toString: () => "class-id-456" },
      studentUserId: "student-1",
      joinedAt: new Date(),
      status: "active" as const,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as unknown as Parameters<typeof toSafeMembershipDto>[0];

    const dto = toSafeMembershipDto(fakeDoc);

    expect(dto).not.toHaveProperty("embedding");
    expect(dto).not.toHaveProperty("centroid");
    expect(dto).not.toHaveProperty("faceProfile");
    expect(dto).not.toHaveProperty("biometric");
  });
});

// =============================================================================
// Better Auth independence
// =============================================================================

describe("ClassMembership model / Better Auth independence", () => {
  it("uses 'class_memberships' collection", () => {
    const name = ClassMembershipModel.collection.name;
    expect(name).toBe("class_memberships");
    expect(name).not.toBe("user");
    expect(name).not.toBe("session");
    expect(name).not.toBe("account");
    expect(name).not.toBe("verification");
  });
});
