/**
 * Tests for class-service.ts
 *
 * PHASE 5.1A — Class + Membership persistence foundation.
 *
 * These tests use mocks for the Mongoose connection and Class model so
 * we can exercise the service logic without spinning up a real
 * MongoDB.
 *
 * Coverage:
 *  26. create valid class.
 *  27. created class has normalized code.
 *  28. created class stores passwordHash only.
 *  29. created class does not return plaintext password.
 *  30. get by normalized code succeeds.
 *  31. lowercase user-entered code resolves through normalization.
 *  32. list teacher classes filters by teacherUserId.
 *  33. another teacher's classes excluded.
 *  34. missing class returns null/safe result.
 *  35. archived model value remains readable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Types } from "mongoose";
import type { ClassAttrs } from "./class-model";

// =============================================================================
// In-memory store + mock
// =============================================================================

const store = new Map<string, ClassAttrs & { _id: Types.ObjectId }>();

function makeClassFixture(
  overrides: Partial<ClassAttrs> = {},
): ClassAttrs & { _id: Types.ObjectId } {
  return {
    _id: new Types.ObjectId(),
    name: "Test Class",
    teacherUserId: "teacher-1",
    classCode: "TEST1234",
    passwordHash: "salt:key",
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Mock Model.create handles duplicate-key errors via the test `duplicateCode` flag.
let duplicateCode: string | null = null;

const mockCreate = vi.fn(async (doc: ClassAttrs) => {
  if (duplicateCode && doc.classCode === duplicateCode) {
    // Simulate the canonical Mongo / Mongoose duplicate-key error shape
    // that PHASE 5.1B relies on for retry classification. The `keyValue`
    // field identifies the collided index — the service classifier
    // accepts a collision only when `keyValue.classCode` is present.
    const err = new Error("Duplicate key") as Error & {
      code: number;
      keyValue: Record<string, unknown>;
    };
    err.code = 11000;
    err.keyValue = { classCode: doc.classCode };
    throw err;
  }

  const stored = {
    ...makeClassFixture(),
    ...doc,
    _id: new Types.ObjectId(),
  };
  store.set(stored.classCode, stored);
  return {
    ...stored,
    toObject: () => ({ ...stored }),
    _id: stored._id,
  };
});

const mockFindById = vi.fn((id: string | Types.ObjectId) => ({
  lean: () => ({
    exec: async (): Promise<ClassAttrs | null> => {
      const idStr = typeof id === "string" ? id : id.toString();
      for (const doc of store.values()) {
        if (doc._id.toString() === idStr) {
          return { ...doc };
        }
      }
      return null;
    },
  }),
}));

const mockFindOne = vi.fn((filter: { classCode: string }) => ({
  lean: () => ({
    exec: async (): Promise<ClassAttrs | null> => {
      const doc = store.get(filter.classCode);
      return doc ? { ...doc } : null;
    },
  }),
}));

type ClassQuery = {
  sort: (criteria: unknown) => ClassQuery;
  lean: () => { exec: () => Promise<ClassAttrs[]> };
};

const mockFind = vi.fn((filter: { teacherUserId: string }) => {
  const query: ClassQuery = {
    sort: () => query,
    lean: () => ({
      exec: async (): Promise<ClassAttrs[]> => {
        const results: ClassAttrs[] = [];
        for (const doc of store.values()) {
          if (doc.teacherUserId === filter.teacherUserId) {
            results.push({ ...doc });
          }
        }
        // Sort by createdAt descending.
        results.sort(
          (a, b) =>
            new Date(b.createdAt).getTime() -
            new Date(a.createdAt).getTime(),
        );
        return results;
      },
    }),
  };
  return query;
});

const mockUpdateOne = vi.fn(
  async (filter: { _id: Types.ObjectId }, update: { $set: Partial<ClassAttrs> }) => {
    for (const [key, doc] of store.entries()) {
      if (doc._id.equals(filter._id)) {
        const updated = { ...doc, ...update.$set };
        store.set(key, updated);
        return { modifiedCount: 1 };
      }
    }
    return { modifiedCount: 0 };
  },
);

vi.mock("./class-model", async () => {
  const actual = await vi.importActual<typeof import("./class-model")>(
    "./class-model",
  );
  return {
    ...actual,
    ClassModel: {
      create: (...args: unknown[]) => mockCreate(...(args as [ClassAttrs])),
      findById: (...args: unknown[]) => mockFindById(...(args as [string | Types.ObjectId])),
      findOne: (...args: unknown[]) => mockFindOne(...(args as [{ classCode: string }])),
      find: (...args: unknown[]) => mockFind(...(args as [{ teacherUserId: string }])),
      updateOne: (...args: unknown[]) => mockUpdateOne(...(args as [{ _id: Types.ObjectId }, { $set: Partial<ClassAttrs> }])),
    },
  };
});

vi.mock("@/lib/mongoose", () => ({
  getMongooseConnection: () => Promise.resolve(),
}));

import {
  createClass,
  getClassById,
  getClassByCode,
  listClassesByTeacherUserId,
  ClassServiceError,
} from "./class-service";

// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
  store.clear();
  duplicateCode = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// createClass
// =============================================================================

describe("createClass", () => {
  it("26. creates a valid class", async () => {
    const result = await createClass({
      name: "Web Development - D22",
      teacherUserId: "teacher-001",
      rawPassword: "MyClassPassword",
    });

    expect(result).toBeDefined();
    expect(result.name).toBe("Web Development - D22");
    expect(result.teacherUserId).toBe("teacher-001");
    expect(result.status).toBe("active");
    expect(result.id).toBeDefined();
  });

  it("27. created class has normalized code (uppercase)", async () => {
    const result = await createClass({
      name: "Test Class",
      teacherUserId: "teacher-001",
      rawPassword: "secret",
      classCode: "ab12cd",
    });

    expect(result.classCode).toBe("AB12CD");
  });

  it("28. created class stores passwordHash only", async () => {
    const result = await createClass({
      name: "Password Test",
      teacherUserId: "teacher-001",
      rawPassword: "MySecret123",
    });

    // Find in store.
    const stored = store.get(result.classCode);
    expect(stored).toBeDefined();

    // Verify passwordHash is set and is NOT plaintext.
    expect(stored!.passwordHash).toBeDefined();
    expect(stored!.passwordHash).not.toBe("MySecret123");

    // No plaintext password field exists.
    const storedRecord: Record<string, unknown> = stored as unknown as Record<string, unknown>;
    expect(storedRecord["password"]).toBeUndefined();
    expect(storedRecord["rawPassword"]).toBeUndefined();
    expect(storedRecord["joinPassword"]).toBeUndefined();
  });

  it("29. created class does not return plaintext password in DTO", async () => {
    const result = await createClass({
      name: "DTO Test",
      teacherUserId: "teacher-001",
      rawPassword: "MySecret123",
    });

    expect(result).not.toHaveProperty("password");
    expect(result).not.toHaveProperty("passwordHash");
    expect(result).not.toHaveProperty("rawPassword");
    expect(result).not.toHaveProperty("plaintextPassword");
  });

  it("generates a class code if none provided", async () => {
    const result = await createClass({
      name: "Auto Code",
      teacherUserId: "teacher-001",
      rawPassword: "secret",
    });

    expect(result.classCode).toBeDefined();
    expect(result.classCode.length).toBeGreaterThan(0);
    expect(result.classCode).toBe(result.classCode.toUpperCase());
  });

  it("rejects duplicate class codes at service level", async () => {
    const code = "DUP1234";

    await createClass({
      name: "Class A",
      teacherUserId: "teacher-001",
      rawPassword: "secret",
      classCode: code,
    });

    duplicateCode = code;

    await expect(
      createClass({
        name: "Class B",
        teacherUserId: "teacher-001",
        rawPassword: "secret",
        classCode: code,
      }),
    ).rejects.toThrow(ClassServiceError);
  });

  it("trims class name", async () => {
    const result = await createClass({
      name: "  Trimmed Name  ",
      teacherUserId: "teacher-001",
      rawPassword: "secret",
    });

    expect(result.name).toBe("Trimmed Name");
  });
});

// =============================================================================
// getClassByCode
// =============================================================================

describe("getClassByCode", () => {
  it("30. get by normalized code succeeds", async () => {
    await createClass({
      name: "Find Me",
      teacherUserId: "teacher-001",
      rawPassword: "secret",
      classCode: "FINDME1",
    });

    const found = await getClassByCode("FINDME1");
    expect(found).not.toBeNull();
    expect(found?.classCode).toBe("FINDME1");
    expect(found?.name).toBe("Find Me");
  });

  it("31. lowercase user-entered code resolves through normalization", async () => {
    await createClass({
      name: "Case Test",
      teacherUserId: "teacher-001",
      rawPassword: "secret",
      classCode: "CASETST",
    });

    // User enters lowercase.
    const found = await getClassByCode("casetst");
    expect(found).not.toBeNull();
    expect(found?.classCode).toBe("CASETST");

    // User enters mixed case.
    const found2 = await getClassByCode("CaseTst");
    expect(found2).not.toBeNull();
  });

  it("34. missing class returns null", async () => {
    const found = await getClassByCode("NOTEXIST");
    expect(found).toBeNull();
  });
});

// =============================================================================
// listClassesByTeacherUserId
// =============================================================================

describe("listClassesByTeacherUserId", () => {
  it("32. lists classes owned by teacher", async () => {
    const teacherId = "teacher-list-001";

    await createClass({
      name: "Class 1",
      teacherUserId: teacherId,
      rawPassword: "secret",
      classCode: "LIST001",
    });

    await createClass({
      name: "Class 2",
      teacherUserId: teacherId,
      rawPassword: "secret",
      classCode: "LIST002",
    });

    const classes = await listClassesByTeacherUserId(teacherId);
    expect(classes.length).toBe(2);
  });

  it("33. another teacher's classes excluded", async () => {
    await createClass({
      name: "Teacher A Class",
      teacherUserId: "teacher-a",
      rawPassword: "secret",
      classCode: "TEACHA",
    });

    await createClass({
      name: "Teacher B Class",
      teacherUserId: "teacher-b",
      rawPassword: "secret",
      classCode: "TEACHB",
    });

    const aClasses = await listClassesByTeacherUserId("teacher-a");
    const bClasses = await listClassesByTeacherUserId("teacher-b");

    expect(aClasses.length).toBe(1);
    expect(aClasses[0]?.name).toBe("Teacher A Class");

    expect(bClasses.length).toBe(1);
    expect(bClasses[0]?.name).toBe("Teacher B Class");
  });

  it("returns empty array for teacher with no classes", async () => {
    const classes = await listClassesByTeacherUserId("teacher-no-classes");
    expect(classes).toEqual([]);
  });

  it("results are sorted by createdAt descending (newest first)", async () => {
    const teacherId = "teacher-sort";

    await createClass({
      name: "Older Class",
      teacherUserId: teacherId,
      rawPassword: "secret",
      classCode: "OLDER1",
    });

    // Small delay to ensure different timestamps.
    await new Promise((r) => setTimeout(r, 5));

    await createClass({
      name: "Newer Class",
      teacherUserId: teacherId,
      rawPassword: "secret",
      classCode: "NEWER1",
    });

    const classes = await listClassesByTeacherUserId(teacherId);

    expect(classes.length).toBe(2);
    expect(classes[0]?.name).toBe("Newer Class");
    expect(classes[1]?.name).toBe("Older Class");
  });
});

// =============================================================================
// archived class
// =============================================================================

describe("archived class", () => {
  it("35. archived model value remains readable", async () => {
    const result = await createClass({
      name: "Archived Class",
      teacherUserId: "teacher-001",
      rawPassword: "secret",
      classCode: "ARCHIVD",
    });

    // Manually set status to archived via mock.
    const stored = store.get(result.classCode);
    if (stored) {
      store.set(result.classCode, { ...stored, status: "archived" });
    }

    const found = await getClassById(result.id);
    expect(found).not.toBeNull();
    expect(found?.status).toBe("archived");
    expect(found?.name).toBe("Archived Class");
  });
});

// =============================================================================
// getClassById
// =============================================================================

describe("getClassById", () => {
  it("returns class by id", async () => {
    const created = await createClass({
      name: "Find By ID",
      teacherUserId: "teacher-001",
      rawPassword: "secret",
      classCode: "FID1234",
    });

    const found = await getClassById(created.id);
    expect(found).not.toBeNull();
    expect(found?.name).toBe("Find By ID");
  });

  it("returns null for non-existent id", async () => {
    const fakeId = new Types.ObjectId().toString();
    const found = await getClassById(fakeId);
    expect(found).toBeNull();
  });
});
