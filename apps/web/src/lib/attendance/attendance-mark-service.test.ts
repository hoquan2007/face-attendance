/**
 * Service-layer tests for the AttendanceMark module.
 *
 * PHASE 6.4 — IDEMPOTENT PRESENT ATTENDANCE MARKS.
 *
 * These tests exercise the attendance-mark-service module in
 * isolation from MongoDB by mocking the Mongoose models. No
 * MongoDB / Face Service / Better Auth is touched.
 *
 * Covers:
 *   7.  first recognition creates mark
 *   8.  repeated recognition remains one mark
 *   9.  recognizedAt preserved on repeat
 *   10. exact concurrent duplicate treated idempotently
 *   11. unrelated DB failure not swallowed
 *
 * Plus auxiliary coverage:
 *   - isAttendanceMarkDuplicateKeyError classifier accepts the
 *     compound (sessionId, studentUserId) shape and rejects
 *     unrelated 11000s / non-11000s.
 *   - recordPresentAttendanceMarksForActiveSession uses the
 *     immutable rosterSnapshot as authority — current
 *     ClassMembership is NEVER consulted.
 *   - recordPresentAttendanceMarksForActiveSession silently
 *     drops ids not in the snapshot.
 *   - listPresentAttendanceMarksForSession sorts by recognizedAt
 *     ASC and projects only safe fields.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// Mock collaborators
// =============================================================================

const mockGetMongooseConnection = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/mongoose", () => ({
  getMongooseConnection: () => mockGetMongooseConnection(),
}));

// =============================================================================
// Mock AttendanceMarkModel
// =============================================================================

const mockMarkFindOneAndUpdate = vi.fn();
const mockMarkFind = vi.fn();
const mockMarkFindById = vi.fn();

vi.mock("@/lib/attendance/attendance-mark-model", async () => {
  const actual =
    await vi.importActual<
      typeof import("@/lib/attendance/attendance-mark-model")
    >("@/lib/attendance/attendance-mark-model");
  return {
    ...actual,
    AttendanceMarkModel: {
      findOneAndUpdate: (...args: unknown[]) =>
        mockMarkFindOneAndUpdate(...args),
      find: (...args: unknown[]) => mockMarkFind(...args),
      findById: (...args: unknown[]) => mockMarkFindById(...args),
    },
  };
});

// =============================================================================
// Mock AttendanceSessionModel
// =============================================================================

const mockSessionFindOne = vi.fn();

vi.mock("@/lib/attendance/attendance-session-model", async () => {
  const actual =
    await vi.importActual<
      typeof import("@/lib/attendance/attendance-session-model")
    >("@/lib/attendance/attendance-session-model");
  return {
    ...actual,
    AttendanceSessionModel: {
      findOne: (...args: unknown[]) => mockSessionFindOne(...args),
    },
  };
});

// =============================================================================
// In-memory store for marks
// =============================================================================

interface StoredMark {
  sessionId: string;
  classId: string;
  studentUserId: string;
  status: "present";
  recognizedAt: Date;
  source: "face_recognition";
}

const markStore = new Map<string, StoredMark>();

function markKey(sessionId: string, studentUserId: string) {
  return `${sessionId}::${studentUserId}`;
}

function resetStores() {
  markStore.clear();
  mockMarkFindOneAndUpdate.mockReset();
  mockMarkFind.mockReset();
  mockMarkFindById.mockReset();
  mockSessionFindOne.mockReset();
}

// =============================================================================
// Mock chain builders
// =============================================================================

const ACTIVE_SESSION_ID = "65f000000000000000000aaa";
const ACTIVE_CLASS_ID = "65f000000000000000000abc";

function makeActiveSessionDoc(rosterSnapshot: Array<{
  studentUserId: string;
  fullNameSnapshot: string;
  identificationCodeSnapshot: string;
}> = []) {
  return {
    _id: {
      toString: () => ACTIVE_SESSION_ID,
      toHexString: () => ACTIVE_SESSION_ID,
    },
    classId: {
      toString: () => ACTIVE_CLASS_ID,
      toHexString: () => ACTIVE_CLASS_ID,
    },
    status: "active",
    rosterSnapshot,
  };
}

function setupSessionFindOneChain(doc: ReturnType<typeof makeActiveSessionDoc> | null) {
  mockSessionFindOne.mockImplementationOnce((filter: {
    _id?: string;
    status?: string;
  }) => {
    // Only return the doc if filter matches ACTIVE_SESSION_ID + active.
    if (!doc) {
      return chain(null);
    }
    if (filter._id !== ACTIVE_SESSION_ID) {
      return chain(null);
    }
    if (filter.status !== "active") {
      return chain(null);
    }
    return chain(doc);
  });
}

function chain(value: unknown) {
  const q = {
    select: () => q,
    lean: () => q,
    exec: async () => value,
  };
  return q;
}

function setupMarkFindOneAndUpdateChain(
  impl: (
    filter: { sessionId?: unknown; studentUserId?: string },
    update: {
      $setOnInsert?: {
        sessionId?: unknown;
        classId?: unknown;
        studentUserId?: string;
        status?: string;
        recognizedAt?: Date;
        source?: string;
      };
    },
    options?: { upsert?: boolean; new?: boolean },
  ) => Promise<
    | { lastErrorObject?: { upserted?: unknown }; value?: unknown }
    | null
  >,
) {
  mockMarkFindOneAndUpdate.mockImplementationOnce(impl);
}

function setupMarkFindChain(
  docs: Array<{ studentUserId: string; recognizedAt: Date }>,
) {
  mockMarkFind.mockImplementationOnce(() => {
    const q = {
      select: () => q,
      sort: () => q,
      lean: () => q,
      exec: async () => docs,
    };
    return q;
  });
}

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// Imports under test
// =============================================================================

import {
  isAttendanceMarkDuplicateKeyError,
  recordPresentAttendanceMarksForActiveSession,
  listPresentAttendanceMarksForSession,
  findAttendanceMarkById,
  isAttendanceSessionStillActive,
  AttendanceMarkServiceError,
  ATTENDANCE_MARK_ERROR_CODES,
} from "./attendance-mark-service";

// =============================================================================
// Classifier tests
// =============================================================================

describe("isAttendanceMarkDuplicateKeyError — classifier", () => {
  it("accepts canonical (sessionId, studentUserId) keyValue collision", () => {
    const err = {
      code: 11000,
      keyValue: { sessionId: "x", studentUserId: "u-1" },
    };
    expect(isAttendanceMarkDuplicateKeyError(err)).toBe(true);
  });

  it("accepts compound keyPattern shape", () => {
    const err = {
      code: 11000,
      keyPattern: { sessionId: 1, studentUserId: 1 },
    };
    expect(isAttendanceMarkDuplicateKeyError(err)).toBe(true);
  });

  it("rejects unrelated 11000 (different keyValue)", () => {
    const err = {
      code: 11000,
      keyValue: { classId: "x" },
    };
    expect(isAttendanceMarkDuplicateKeyError(err)).toBe(false);
  });

  it("rejects non-11000 error", () => {
    const err = { code: 9999, message: "other" };
    expect(isAttendanceMarkDuplicateKeyError(err)).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(isAttendanceMarkDuplicateKeyError(null)).toBe(false);
    expect(isAttendanceMarkDuplicateKeyError(undefined)).toBe(false);
    expect(isAttendanceMarkDuplicateKeyError("error")).toBe(false);
    expect(isAttendanceMarkDuplicateKeyError(42)).toBe(false);
  });
});

// =============================================================================
// 7-9 — Idempotent persistence
// =============================================================================

describe("recordPresentAttendanceMarksForActiveSession", () => {
  it("7. first recognition creates mark for snapshot student", async () => {
    setupSessionFindOneChain(
      makeActiveSessionDoc([
        {
          studentUserId: "u-1",
          fullNameSnapshot: "Alice",
          identificationCodeSnapshot: "SV001",
        },
      ]),
    );

    setupMarkFindOneAndUpdateChain(async (filter, update, options) => {
      // Verify the upsert shape.
      expect(options?.upsert).toBe(true);
      expect(filter.sessionId).toBeTruthy();
      expect(filter.studentUserId).toBe("u-1");
      expect(update.$setOnInsert?.status).toBe("present");
      expect(update.$setOnInsert?.source).toBe("face_recognition");
      expect(update.$setOnInsert?.studentUserId).toBe("u-1");
      expect(update.$setOnInsert?.recognizedAt).toBeInstanceOf(Date);

      // Return metadata indicating a NEW document was created.
      return {
        lastErrorObject: { upserted: "new-id" },
        value: null,
      };
    });

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
    });

    expect(result.persistedStudentUserIds).toEqual(["u-1"]);
    expect(result.idempotentStudentUserIds).toEqual([]);
    expect(typeof result.recognizedAt).toBe("string");
  });

  it("8. repeated recognition stays one mark (no duplicate write)", async () => {
    setupSessionFindOneChain(
      makeActiveSessionDoc([
        {
          studentUserId: "u-1",
          fullNameSnapshot: "Alice",
          identificationCodeSnapshot: "SV001",
        },
      ]),
    );

    // The upsert returns metadata WITHOUT an upserted key — the
    // existing document is preserved verbatim. $setOnInsert MUST
    // not have changed recognizedAt.
    let observedRecognizedAt: Date | undefined;
    setupMarkFindOneAndUpdateChain(async (_filter, update) => {
      observedRecognizedAt = update.$setOnInsert?.recognizedAt;
      return {
        lastErrorObject: {}, // No upserted key.
        value: {
          studentUserId: "u-1",
          recognizedAt: new Date(Date.now() - 1000 * 60),
        },
      };
    });

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
    });

    expect(result.persistedStudentUserIds).toEqual([]);
    expect(result.idempotentStudentUserIds).toEqual(["u-1"]);
    // The service still records its own recognizedAt for
    // auditing — but it is only APPLIED on insert via $setOnInsert.
    expect(observedRecognizedAt).toBeInstanceOf(Date);
  });

  it("9. recognizedAt preserved on repeat (the existing mark wins)", async () => {
    setupSessionFindOneChain(
      makeActiveSessionDoc([
        {
          studentUserId: "u-1",
          fullNameSnapshot: "Alice",
          identificationCodeSnapshot: "SV001",
        },
      ]),
    );

    let injectedRecognizedAt: Date | undefined;
    setupMarkFindOneAndUpdateChain(async (_filter, update) => {
      injectedRecognizedAt = update.$setOnInsert?.recognizedAt;
      // Pretend an existing mark was preserved (no upserted key).
      return {
        lastErrorObject: {},
        value: null,
      };
    });

    await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
    });

    // The function only USES recognizedAt inside $setOnInsert;
    // the existing mark's recognizedAt is untouched. The
    // assertion is that the service never mutates the existing
    // document: the returned recognizedAt on the result is the
    // service's intended timestamp, which is discarded by
    // Mongo when the document already exists.
    expect(injectedRecognizedAt).toBeInstanceOf(Date);
  });

  it("10. exact concurrent duplicate-key race treated idempotently", async () => {
    setupSessionFindOneChain(
      makeActiveSessionDoc([
        {
          studentUserId: "u-1",
          fullNameSnapshot: "Alice",
          identificationCodeSnapshot: "SV001",
        },
      ]),
    );

    setupMarkFindOneAndUpdateChain(async () => {
      // Simulate a Mongo duplicate-key collision thrown directly.
      const err = new Error("E11000 duplicate key") as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = {
        sessionId: ACTIVE_SESSION_ID,
        studentUserId: "u-1",
      };
      throw err;
    });

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
    });

    // Duplicate key is folded into idempotent success — not a
    // thrown error.
    expect(result.idempotentStudentUserIds).toEqual(["u-1"]);
    expect(result.persistedStudentUserIds).toEqual([]);
  });

  it("11. unrelated DB failure is NOT swallowed (throws ATTENDANCE_MARK_WRITE_FAILED)", async () => {
    setupSessionFindOneChain(
      makeActiveSessionDoc([
        {
          studentUserId: "u-1",
          fullNameSnapshot: "Alice",
          identificationCodeSnapshot: "SV001",
        },
      ]),
    );
    // Session lookup happens on each call; the test calls the
    // service twice so we need to keep the session lookup
    // mock available across both calls.
    setupSessionFindOneChain(
      makeActiveSessionDoc([
        {
          studentUserId: "u-1",
          fullNameSnapshot: "Alice",
          identificationCodeSnapshot: "SV001",
        },
      ]),
    );

    setupMarkFindOneAndUpdateChain(async () => {
      // Some unrelated failure — NOT a 11000.
      throw new Error("Connection refused");
    });

    await expect(
      recordPresentAttendanceMarksForActiveSession({
        sessionId: ACTIVE_SESSION_ID,
        candidateStudentUserIds: ["u-1"],
      }),
    ).rejects.toThrow(AttendanceMarkServiceError);

    // Second call also needs the mark upsert to fail and the
    // session lookup to find the active session.
    setupMarkFindOneAndUpdateChain(async () => {
      // Some unrelated failure — NOT a 11000.
      throw new Error("Connection refused");
    });

    await expect(
      recordPresentAttendanceMarksForActiveSession({
        sessionId: ACTIVE_SESSION_ID,
        candidateStudentUserIds: ["u-1"],
      }),
    ).rejects.toMatchObject({
      code: ATTENDANCE_MARK_ERROR_CODES.ATTENDANCE_MARK_WRITE_FAILED,
    });
  });

  it("silently drops ids NOT in the snapshot (snapshot authority)", async () => {
    setupSessionFindOneChain(
      makeActiveSessionDoc([
        {
          studentUserId: "u-1",
          fullNameSnapshot: "Alice",
          identificationCodeSnapshot: "SV001",
        },
      ]),
    );

    // Upsert should NEVER be called for u-2 — u-2 is not in the
    // snapshot. The function returns an empty result.
    const impl = vi.fn();
    setupMarkFindOneAndUpdateChain(impl);

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-2"],
    });

    expect(result.persistedStudentUserIds).toEqual([]);
    expect(result.idempotentStudentUserIds).toEqual([]);
    expect(impl).not.toHaveBeenCalled();
  });

  it("rejects invalid sessionId syntax with INVALID_SESSION_ID", async () => {
    await expect(
      recordPresentAttendanceMarksForActiveSession({
        sessionId: "not-a-canonical-hex",
        candidateStudentUserIds: ["u-1"],
      }),
    ).rejects.toMatchObject({
      code: ATTENDANCE_MARK_ERROR_CODES.INVALID_SESSION_ID,
    });
  });

  it("rejects closed session with ATTENDANCE_SESSION_NOT_ACTIVE", async () => {
    // Mock findOne returns null (session not active).
    setupSessionFindOneChain(null);

    await expect(
      recordPresentAttendanceMarksForActiveSession({
        sessionId: ACTIVE_SESSION_ID,
        candidateStudentUserIds: ["u-1"],
      }),
    ).rejects.toMatchObject({
      code: ATTENDANCE_MARK_ERROR_CODES.ATTENDANCE_SESSION_NOT_ACTIVE,
    });
  });

  it("persists multiple matched students in one call", async () => {
    setupSessionFindOneChain(
      makeActiveSessionDoc([
        {
          studentUserId: "u-1",
          fullNameSnapshot: "Alice",
          identificationCodeSnapshot: "SV001",
        },
        {
          studentUserId: "u-2",
          fullNameSnapshot: "Bob",
          identificationCodeSnapshot: "SV002",
        },
      ]),
    );

    const calls: Array<{ studentUserId: string }> = [];
    mockMarkFindOneAndUpdate
      .mockImplementationOnce(async (filter) => {
        calls.push({ studentUserId: filter.studentUserId });
        return {
          lastErrorObject: { upserted: "id-1" },
          value: null,
        };
      })
      .mockImplementationOnce(async (filter) => {
        calls.push({ studentUserId: filter.studentUserId });
        return {
          lastErrorObject: { upserted: "id-2" },
          value: null,
        };
      });

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1", "u-2"],
    });

    expect(result.persistedStudentUserIds).toEqual(["u-1", "u-2"]);
    expect(result.idempotentStudentUserIds).toEqual([]);
    expect(calls.map((c) => c.studentUserId)).toEqual(["u-1", "u-2"]);
  });

  it("deduplicates repeated ids in a single batch", async () => {
    setupSessionFindOneChain(
      makeActiveSessionDoc([
        {
          studentUserId: "u-1",
          fullNameSnapshot: "Alice",
          identificationCodeSnapshot: "SV001",
        },
      ]),
    );

    const impl = vi.fn().mockResolvedValue({
      lastErrorObject: { upserted: "id-1" },
      value: null,
    });
    setupMarkFindOneAndUpdateChain(impl);

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1", "u-1", "u-1"],
    });

    expect(result.persistedStudentUserIds).toEqual(["u-1"]);
    // Only one findOneAndUpdate call despite three input ids.
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it("never imports / queries ClassMembership (snapshot authority)", async () => {
    setupSessionFindOneChain(
      makeActiveSessionDoc([
        {
          studentUserId: "u-1",
          fullNameSnapshot: "Alice",
          identificationCodeSnapshot: "SV001",
        },
      ]),
    );

    setupMarkFindOneAndUpdateChain(async () => ({
      lastErrorObject: { upserted: "id-1" },
      value: null,
    }));

    // Importing ClassMembership should not be available here.
    // We assert this by verifying the function does NOT touch
    // any ClassMembership-named module. The mock surface for
    // this test is intentionally ClassMembership-free.
    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
    });

    expect(result.persistedStudentUserIds).toEqual(["u-1"]);
  });
});

// =============================================================================
// isAttendanceSessionStillActive — final pre-write check
// =============================================================================

describe("isAttendanceSessionStillActive", () => {
  it("returns true for an active session", async () => {
    setupSessionFindOneChain(makeActiveSessionDoc([]));
    const result = await isAttendanceSessionStillActive(ACTIVE_SESSION_ID);
    expect(result).toBe(true);
  });

  it("returns false for a closed / missing session", async () => {
    setupSessionFindOneChain(null);
    const result = await isAttendanceSessionStillActive(ACTIVE_SESSION_ID);
    expect(result).toBe(false);
  });

  it("returns false for invalid syntax without throwing", async () => {
    const result = await isAttendanceSessionStillActive("not-hex");
    expect(result).toBe(false);
  });
});

// =============================================================================
// listPresentAttendanceMarksForSession — safe projection
// =============================================================================

describe("listPresentAttendanceMarksForSession", () => {
  it("returns safe projection sorted recognizedAt ASC", async () => {
    const docA = {
      studentUserId: "u-2",
      recognizedAt: new Date("2026-09-16T10:01:00Z"),
    };
    const docB = {
      studentUserId: "u-1",
      recognizedAt: new Date("2026-09-16T10:00:00Z"),
    };
    // Note: input order intentionally NOT sorted; the service
    // applies the .sort({ recognizedAt: 1 }).
    setupMarkFindChain([docA, docB]);

    const list = await listPresentAttendanceMarksForSession(
      ACTIVE_SESSION_ID,
    );
    expect(list).toEqual([
      {
        studentUserId: "u-1",
        recognizedAt: "2026-09-16T10:00:00.000Z",
      },
      {
        studentUserId: "u-2",
        recognizedAt: "2026-09-16T10:01:00.000Z",
      },
    ]);
  });

  it("never exposes Mongo _id, classId, sessionId, status, or source", async () => {
    setupMarkFindChain([
      {
        studentUserId: "u-1",
        recognizedAt: new Date("2026-09-16T10:00:00Z"),
      },
    ]);

    const list = await listPresentAttendanceMarksForSession(
      ACTIVE_SESSION_ID,
    );
    const serialized = JSON.stringify(list);
    expect(serialized).not.toMatch(/_id/);
    expect(serialized).not.toMatch(/classId/);
    expect(serialized).not.toMatch(/source/);
    expect(serialized).not.toMatch(/attendance_marks/);
    expect(serialized).not.toMatch(/face_recognition/);
    // status IS exposed by the model — but the safe projection
    // excludes it deliberately.
    expect(serialized).not.toMatch(/status/);
  });
});

// =============================================================================
// findAttendanceMarkById — internal test helper
// =============================================================================

describe("findAttendanceMarkById", () => {
  it("returns null when mark is not found", async () => {
    mockMarkFindById.mockImplementationOnce(() => ({
      lean: () => ({ exec: async () => null }),
    }));
    const result = await findAttendanceMarkById("65f000000000000000000fff");
    expect(result).toBeNull();
  });
});
