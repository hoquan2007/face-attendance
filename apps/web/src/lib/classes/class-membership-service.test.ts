/**
 * Tests for class-membership-service.ts
 *
 * PHASE 5.1A — Class + Membership persistence foundation.
 *
 * These tests use mocks for the Mongoose connection and ClassMembership
 * model so we can exercise the service logic without spinning up a real
 * MongoDB.
 *
 * Coverage:
 *  42. create membership succeeds.
 *  43. duplicate logical membership rejected safely.
 *  44. get membership returns expected student/class pair.
 *  45. list memberships by student works.
 *  46. list memberships by class works.
 *  47. another class membership does not leak into result.
 *  48. another student's memberships excluded.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type { ClassMembershipAttrs } from "./class-membership-model";

// =============================================================================
// In-memory store + mock
// =============================================================================

interface StoredMembership extends ClassMembershipAttrs {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const store = new Map<string, StoredMembership>();

function makeStoredMembership(
  overrides: Partial<StoredMembership> = {},
): StoredMembership {
  const now = new Date();
  return {
    _id: new Types.ObjectId(),
    classId: new Types.ObjectId(),
    studentUserId: "student-1",
    joinedAt: now,
    status: "active",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeKey(classId: Types.ObjectId, studentUserId: string): string {
  return `${classId.toString()}::${studentUserId}`;
}

// Mock that supports duplicate-key errors via test flag.
let duplicateKey: { classId: string; studentUserId: string } | null = null;

const mockCreate = vi.fn(async (doc: ClassMembershipAttrs) => {
  if (
    duplicateKey &&
    duplicateKey.classId === doc.classId.toString() &&
    duplicateKey.studentUserId === doc.studentUserId
  ) {
    const err = new Error("Duplicate key") as Error & { code: number };
    err.code = 11000;
    throw err;
  }

  const stored: StoredMembership = {
    ...makeStoredMembership(),
    ...doc,
    _id: new Types.ObjectId(),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  store.set(makeKey(stored.classId, stored.studentUserId), stored);

  const created = { ...stored, _id: stored._id } as StoredMembership & {
    toObject: () => StoredMembership;
    toString: () => string;
  };
  created.toObject = () => ({ ...stored });
  created.toString = () => stored._id.toString();
  // Mimic HydratedDocument: _id is the ObjectId directly (not wrapped).
  return created;
});

const mockFindById = vi.fn((id: string | Types.ObjectId) => ({
  lean: () => ({
    exec: async () => {
      const idStr = typeof id === "string" ? id : id.toString();
      for (const doc of store.values()) {
        if (doc._id.toString() === idStr) return { ...doc };
      }
      return null;
    },
  }),
}));

const mockFindOne = vi.fn(
  (filter: { classId: Types.ObjectId; studentUserId: string }) => ({
    lean: () => ({
      exec: async (): Promise<ClassMembershipAttrs | null> => {
        const doc = store.get(
          makeKey(filter.classId, filter.studentUserId),
        );
        return doc ? { ...doc } : null;
      },
    }),
  }),
);

type MembershipQuery = {
  sort: (criteria: unknown) => MembershipQuery;
  lean: () => { exec: () => Promise<ClassMembershipAttrs[]> };
};

const mockFind = vi.fn(
  (filter: { studentUserId?: string; classId?: Types.ObjectId }) => {
    const query: MembershipQuery = {
      sort: () => query,
      lean: () => ({
        exec: async (): Promise<ClassMembershipAttrs[]> => {
          const results: ClassMembershipAttrs[] = [];
          for (const doc of store.values()) {
            let match = true;
            if (
              filter.studentUserId &&
              doc.studentUserId !== filter.studentUserId
            ) {
              match = false;
            }
            if (
              filter.classId &&
              !doc.classId.equals(filter.classId)
            ) {
              match = false;
            }
            if (match) results.push({ ...doc });
          }
          results.sort(
            (a, b) =>
              new Date(b.joinedAt).getTime() -
              new Date(a.joinedAt).getTime(),
          );
          return results;
        },
      }),
    };
    return query;
  },
);

vi.mock("./class-membership-model", async () => {
  const actual =
    await vi.importActual<typeof import("./class-membership-model")>(
      "./class-membership-model",
    );
  return {
    ...actual,
    ClassMembershipModel: {
      create: (...args: unknown[]) =>
        mockCreate(...(args as [ClassMembershipAttrs])),
      findById: (...args: unknown[]) =>
        mockFindById(...(args as [string | Types.ObjectId])),
      findOne: (...args: unknown[]) =>
        mockFindOne(
          ...(args as [{ classId: Types.ObjectId; studentUserId: string }]),
        ),
      find: (...args: unknown[]) =>
        mockFind(
          ...(args as [
            { studentUserId?: string; classId?: Types.ObjectId },
          ]),
        ),
    },
  };
});

vi.mock("@/lib/mongoose", () => ({
  getMongooseConnection: () => Promise.resolve(),
}));

import {
  createMembership,
  getMembershipById,
  getMembership,
  listMembershipsByStudentUserId,
  listMembershipsByClassId,
  MembershipServiceError,
} from "./class-membership-service";

// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
  store.clear();
  duplicateKey = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// createMembership
// =============================================================================

describe("createMembership", () => {
  it("42. creates a membership successfully", async () => {
    const classId = new Types.ObjectId();

    const membership = await createMembership({
      classId: classId.toString(),
      studentUserId: "student-001",
    });

    expect(membership).toBeDefined();
    expect(membership.studentUserId).toBe("student-001");
    expect(membership.status).toBe("active");
    expect(membership.joinedAt).toBeDefined();
  });

  it("membership DTO does not contain passwordHash or biometric fields", async () => {
    const classId = new Types.ObjectId();

    const membership = await createMembership({
      classId: classId.toString(),
      studentUserId: "student-001",
    });

    expect(membership).not.toHaveProperty("passwordHash");
    expect(membership).not.toHaveProperty("embedding");
    expect(membership).not.toHaveProperty("centroid");
    expect(membership).not.toHaveProperty("faceProfile");
  });

  it("can create membership with ObjectId classId", async () => {
    const classId = new Types.ObjectId();

    const membership = await createMembership({
      classId,
      studentUserId: "student-001",
    });

    expect(membership.classId).toBe(classId.toString());
  });

  it("can create membership with string classId", async () => {
    const classId = new Types.ObjectId();

    const membership = await createMembership({
      classId: classId.toString(),
      studentUserId: "student-001",
    });

    expect(membership.classId).toBe(classId.toString());
  });
});

// =============================================================================
// duplicate membership
// =============================================================================

describe("duplicate membership rejection", () => {
  it("43. duplicate logical membership rejected safely", async () => {
    const classId = new Types.ObjectId();
    const studentId = "student-dup";

    await createMembership({ classId: classId.toString(), studentUserId: studentId });

    // Trigger duplicate-key error on the second call.
    duplicateKey = { classId: classId.toString(), studentUserId: studentId };

    await expect(
      createMembership({ classId: classId.toString(), studentUserId: studentId }),
    ).rejects.toThrow(MembershipServiceError);
  });

  it("duplicate rejection uses safe error code", async () => {
    const classId = new Types.ObjectId();
    const studentId = "student-err";

    await createMembership({ classId: classId.toString(), studentUserId: studentId });
    duplicateKey = { classId: classId.toString(), studentUserId: studentId };

    try {
      await createMembership({
        classId: classId.toString(),
        studentUserId: studentId,
      });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MembershipServiceError);
      expect((err as MembershipServiceError).code).toBe(
        "MEMBERSHIP_ALREADY_EXISTS",
      );
    }
  });

  it("same student can join a different class", async () => {
    const classId1 = new Types.ObjectId();
    const classId2 = new Types.ObjectId();
    const studentId = "student-multi";

    await createMembership({
      classId: classId1.toString(),
      studentUserId: studentId,
    });

    const membership2 = await createMembership({
      classId: classId2.toString(),
      studentUserId: studentId,
    });

    expect(membership2.studentUserId).toBe(studentId);
  });
});

// =============================================================================
// getMembership
// =============================================================================

describe("getMembership", () => {
  it("44. get membership returns expected student/class pair", async () => {
    const classId = new Types.ObjectId();
    const studentId = "student-get";

    await createMembership({
      classId: classId.toString(),
      studentUserId: studentId,
    });

    const found = await getMembership(classId.toString(), studentId);

    expect(found).not.toBeNull();
    expect(found?.studentUserId).toBe(studentId);
    expect(found?.classId.toString()).toBe(classId.toString());
  });

  it("returns null when membership does not exist", async () => {
    const classId = new Types.ObjectId();
    const found = await getMembership(classId.toString(), "nonexistent-student");
    expect(found).toBeNull();
  });

  it("getMembership is case-sensitive for studentUserId", async () => {
    const classId = new Types.ObjectId();
    await createMembership({
      classId: classId.toString(),
      studentUserId: "StudentCase",
    });

    const found = await getMembership(classId.toString(), "studentcase");
    expect(found).toBeNull();
  });
});

// =============================================================================
// listMembershipsByStudentUserId
// =============================================================================

describe("listMembershipsByStudentUserId", () => {
  it("45. list memberships by student works", async () => {
    const classId1 = new Types.ObjectId();
    const classId2 = new Types.ObjectId();
    const studentId = "list-student";

    await createMembership({
      classId: classId1.toString(),
      studentUserId: studentId,
    });
    await createMembership({
      classId: classId2.toString(),
      studentUserId: studentId,
    });

    const memberships = await listMembershipsByStudentUserId(studentId);

    expect(memberships.length).toBe(2);
    const classIds = memberships.map((m) => m.classId.toString());
    expect(classIds).toContain(classId1.toString());
    expect(classIds).toContain(classId2.toString());
  });

  it("48. another student's memberships excluded", async () => {
    const classId = new Types.ObjectId();

    await createMembership({
      classId: classId.toString(),
      studentUserId: "student-a",
    });
    await createMembership({
      classId: classId.toString(),
      studentUserId: "student-b",
    });

    const aMemberships = await listMembershipsByStudentUserId("student-a");
    const bMemberships = await listMembershipsByStudentUserId("student-b");

    expect(aMemberships.length).toBe(1);
    expect(aMemberships[0]?.studentUserId).toBe("student-a");

    expect(bMemberships.length).toBe(1);
    expect(bMemberships[0]?.studentUserId).toBe("student-b");
  });

  it("returns empty array for student with no memberships", async () => {
    const memberships = await listMembershipsByStudentUserId("lonely-student");
    expect(memberships).toEqual([]);
  });
});

// =============================================================================
// listMembershipsByClassId
// =============================================================================

describe("listMembershipsByClassId", () => {
  it("46. list memberships by class works", async () => {
    const classId = new Types.ObjectId();

    await createMembership({
      classId: classId.toString(),
      studentUserId: "member-1",
    });
    await createMembership({
      classId: classId.toString(),
      studentUserId: "member-2",
    });
    await createMembership({
      classId: classId.toString(),
      studentUserId: "member-3",
    });

    const memberships = await listMembershipsByClassId(classId.toString());

    expect(memberships.length).toBe(3);
    const studentIds = memberships.map((m) => m.studentUserId);
    expect(studentIds).toContain("member-1");
    expect(studentIds).toContain("member-2");
    expect(studentIds).toContain("member-3");
  });

  it("47. another class membership does not leak into result", async () => {
    const classId1 = new Types.ObjectId();
    const classId2 = new Types.ObjectId();

    await createMembership({
      classId: classId1.toString(),
      studentUserId: "student-1",
    });
    await createMembership({
      classId: classId2.toString(),
      studentUserId: "student-2",
    });

    const cls1Memberships = await listMembershipsByClassId(classId1.toString());

    expect(cls1Memberships.length).toBe(1);
    expect(cls1Memberships[0]?.studentUserId).toBe("student-1");
  });

  it("returns empty array for class with no members", async () => {
    const classId = new Types.ObjectId();
    const memberships = await listMembershipsByClassId(classId.toString());
    expect(memberships).toEqual([]);
  });
});

// =============================================================================
// getMembershipById
// =============================================================================

describe("getMembershipById", () => {
  it("returns membership by id", async () => {
    const classId = new Types.ObjectId();

    const created = await createMembership({
      classId: classId.toString(),
      studentUserId: "by-id-student",
    });

    const found = await getMembershipById(created.id);
    expect(found).not.toBeNull();
    expect(found?.studentUserId).toBe("by-id-student");
  });

  it("returns null for non-existent id", async () => {
    const fakeId = new Types.ObjectId().toString();
    const found = await getMembershipById(fakeId);
    expect(found).toBeNull();
  });
});
