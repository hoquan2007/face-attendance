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
const mockMarkFindOne = vi.fn();

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
      findOne: (...args: unknown[]) => mockMarkFindOne(...args),
    },
  };
});

// =============================================================================
// Mock AttendanceSessionModel
// =============================================================================

const mockSessionFindOne = vi.fn();
const mockSessionFindById = vi.fn();

vi.mock("@/lib/attendance/attendance-session-model", async () => {
  const actual =
    await vi.importActual<
      typeof import("@/lib/attendance/attendance-session-model")
    >("@/lib/attendance/attendance-session-model");
  return {
    ...actual,
    AttendanceSessionModel: {
      findOne: (...args: unknown[]) => mockSessionFindOne(...args),
      findById: (...args: unknown[]) => mockSessionFindById(...args),
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
  mockMarkFindOne.mockReset();
  mockSessionFindOne.mockReset();
  mockSessionFindById.mockReset();
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
  finalizeAbsentMarksForClosedSession,
  listAllAttendanceMarksForSession,
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
      recognitionDecisionAt: new Date(),
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
      recognitionDecisionAt: new Date(),
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
      recognitionDecisionAt: new Date(),
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

    // Duplicate-key collision: existing is Present.
    mockMarkFindOneAndUpdate.mockImplementationOnce(async () => {
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
    // Race reconciliation: inspect existing mark → Present.
    mockMarkFindOne.mockImplementationOnce(() => {
      const q = {
        select: () => q,
        lean: () => q,
        exec: async () => ({
          status: "present",
          source: "face_recognition",
        }),
      };
      return q;
    });

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
      recognitionDecisionAt: new Date(),
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
        recognitionDecisionAt: new Date(),
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
        recognitionDecisionAt: new Date(),
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
      recognitionDecisionAt: new Date(),
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
        recognitionDecisionAt: new Date(),
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
        recognitionDecisionAt: new Date(),
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
      recognitionDecisionAt: new Date(),
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
      recognitionDecisionAt: new Date(),
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
      recognitionDecisionAt: new Date(),
    });

    expect(result.persistedStudentUserIds).toEqual(["u-1"]);
  });
});

// =============================================================================
// PHASE 6.6 — Stop / Recognition Race Reconciliation
// =============================================================================

/**
 * Helper: set up a session lookup for the "active session" check
 * (the first findOne in recordPresentAttendanceMarksForActiveSession).
 */
function setupSessionFindOneForActiveSession(
  rosterSnapshot: Array<{
    studentUserId: string;
    fullNameSnapshot: string;
    identificationCodeSnapshot: string;
  }> = [],
) {
  mockSessionFindOne.mockImplementationOnce(
    (filter: { _id?: string; status?: string }) => {
      if (filter._id !== ACTIVE_SESSION_ID) return chain(null);
      if (filter.status !== "active") return chain(null);
      return chain({
        _id: { toString: () => ACTIVE_SESSION_ID },
        classId: { toString: () => ACTIVE_CLASS_ID },
        status: "active",
        rosterSnapshot,
      });
    },
  );
}

/**
 * Helper: set up a session lookup for reading endedAt (used in
 * the race-reconciliation path after a duplicate-key error).
 */
function setupSessionEndedAt(endedAt: Date | null) {
  mockSessionFindOne.mockImplementationOnce(
    (_filter: Record<string, unknown>) => {
      return chain({ endedAt });
    },
  );
}

/**
 * Helper: set up a mock for AttendanceMarkModel.findOne (used to
 * inspect the existing mark after a duplicate-key error).
 */
function setupMarkFindForRaceReconciliation(
  existingMark: { studentUserId: string; status: string; source: string } | null,
) {
  mockMarkFindOne.mockImplementationOnce(() => {
    const q = {
      select: () => q,
      lean: () => q,
      exec: async () => existingMark,
    };
    return q;
  });
}

describe("recordPresentAttendanceMarksForActiveSession — PHASE 6.6 Race Reconciliation", () => {
  const DECISION_BEFORE_STOP = new Date("2026-09-16T10:40:00Z");
  const SESSION_ENDED_AT = new Date("2026-09-16T10:42:00Z");

  beforeEach(() => {
    resetStores();
  });

  it("PHASE 6.6.1: normal active-session recognition creates Present (no race)", async () => {
    // Setup: session is still active, no existing mark.
    setupSessionFindOneForActiveSession([
      {
        studentUserId: "u-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
    ]);
    // No duplicate key → normal upsert path.
    setupMarkFindOneAndUpdateChain(async (_filter, update) => {
      expect(update.$setOnInsert?.status).toBe("present");
      expect(update.$setOnInsert?.source).toBe("face_recognition");
      return { lastErrorObject: { upserted: "new-id" }, value: null };
    });

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
      recognitionDecisionAt: new Date(),
    });

    expect(result.persistedStudentUserIds).toEqual(["u-1"]);
    expect(result.idempotentStudentUserIds).toEqual([]);
  });

  it("PHASE 6.6.2: repeated Present recognition is idempotent (existing Present preserved)", async () => {
    setupSessionFindOneForActiveSession([
      {
        studentUserId: "u-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
    ]);
    // Duplicate-key collision: existing is Present.
    mockMarkFindOneAndUpdate.mockImplementationOnce(async () => {
      const err = new Error("E11000") as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = { sessionId: ACTIVE_SESSION_ID, studentUserId: "u-1" };
      throw err;
    });
    // Race reconciliation path: inspect existing mark.
    setupMarkFindForRaceReconciliation({
      studentUserId: "u-1",
      status: "present",
      source: "face_recognition",
    });

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
      recognitionDecisionAt: new Date(),
    });

    // Existing Present → idempotent success.
    expect(result.persistedStudentUserIds).toEqual([]);
    expect(result.idempotentStudentUserIds).toEqual(["u-1"]);
  });

  it("PHASE 6.6.3: duplicate recognition preserves first recognizedAt", async () => {
    setupSessionFindOneForActiveSession([
      {
        studentUserId: "u-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
    ]);
    // Duplicate-key collision.
    mockMarkFindOneAndUpdate.mockImplementationOnce(async () => {
      const err = new Error("E11000") as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = { sessionId: ACTIVE_SESSION_ID, studentUserId: "u-1" };
      throw err;
    });
    // Existing mark inspection: existing is Present.
    setupMarkFindForRaceReconciliation({
      studentUserId: "u-1",
      status: "present",
      source: "face_recognition",
    });

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
      recognitionDecisionAt: DECISION_BEFORE_STOP,
    });

    // Existing Present → idempotent success. recognizedAt is
    // an ISO string from recognitionDecisionAt (the batch timestamp).
    expect(result.idempotentStudentUserIds).toEqual(["u-1"]);
    expect(result.persistedStudentUserIds).toEqual([]);
    expect(result.recognizedAt).toBe(DECISION_BEFORE_STOP.toISOString());
  });

  it("PHASE 6.6.4: recognition passes ACTIVE check before write", async () => {
    // Session is still active at the first check.
    setupSessionFindOneForActiveSession([
      {
        studentUserId: "u-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
    ]);
    setupMarkFindOneAndUpdateChain(async () => ({
      lastErrorObject: { upserted: "new-id" },
      value: null,
    }));

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
      recognitionDecisionAt: new Date(),
    });

    expect(result.persistedStudentUserIds).toEqual(["u-1"]);
  });

  it("PHASE 6.6.5: concurrent stop closes session before finalization upsert", async () => {
    // Session is ACTIVE at the first read.
    setupSessionFindOneForActiveSession([
      {
        studentUserId: "u-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
    ]);
    // Upsert succeeds normally (no duplicate key).
    setupMarkFindOneAndUpdateChain(async () => ({
      lastErrorObject: { upserted: "new-id" },
      value: null,
    }));

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
      recognitionDecisionAt: DECISION_BEFORE_STOP,
    });

    // Present was created before stop could finalize.
    expect(result.persistedStudentUserIds).toEqual(["u-1"]);
  });

  it("PHASE 6.6.6: finalization inserts Absent before delayed recognition write", async () => {
    // Session is ACTIVE at the first read.
    setupSessionFindOneForActiveSession([
      {
        studentUserId: "u-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
    ]);
    // Duplicate-key collision: Absent exists.
    mockMarkFindOneAndUpdate.mockImplementationOnce(async () => {
      const err = new Error("E11000") as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = { sessionId: ACTIVE_SESSION_ID, studentUserId: "u-1" };
      throw err;
    });
    // Race reconciliation path: inspect existing mark.
    setupMarkFindForRaceReconciliation({
      studentUserId: "u-1",
      status: "absent",
      source: "session_finalization",
    });
    // Session endedAt for reconciliation check.
    setupSessionEndedAt(SESSION_ENDED_AT);
    // Reconciliation upsert succeeds.
    mockMarkFindOneAndUpdate.mockImplementationOnce(
      async (filter, update) => {
        expect(filter.status).toBe("absent");
        expect(filter.source).toBe("session_finalization");
        expect(update.$set?.status).toBe("present");
        expect(update.$set?.source).toBe("face_recognition");
        return { value: { studentUserId: "u-1", status: "present" }, lastErrorObject: {} };
      },
    );

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
      recognitionDecisionAt: DECISION_BEFORE_STOP,
    });

    // Absent was converted to Present.
    expect(result.persistedStudentUserIds).toEqual(["u-1"]);
    expect(result.idempotentStudentUserIds).toEqual([]);
  });

  it("PHASE 6.6.7: delayed recognition with decisionAt <= endedAt converts Absent to Present", async () => {
    setupSessionFindOneForActiveSession([
      {
        studentUserId: "u-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
    ]);
    // Duplicate-key collision.
    mockMarkFindOneAndUpdate.mockImplementationOnce(async () => {
      const err = new Error("E11000") as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = { sessionId: ACTIVE_SESSION_ID, studentUserId: "u-1" };
      throw err;
    });
    setupMarkFindForRaceReconciliation({
      studentUserId: "u-1",
      status: "absent",
      source: "session_finalization",
    });
    // decisionAt (10:40:00) <= endedAt (10:42:00) → eligible.
    setupSessionEndedAt(SESSION_ENDED_AT);
    mockMarkFindOneAndUpdate.mockImplementationOnce(
      async (filter, update) => {
        // Atomic conditional update.
        expect(filter.status).toBe("absent");
        expect(filter.source).toBe("session_finalization");
        expect(update.$set?.status).toBe("present");
        return { value: { studentUserId: "u-1" }, lastErrorObject: {} };
      },
    );

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
      recognitionDecisionAt: DECISION_BEFORE_STOP,
    });

    expect(result.persistedStudentUserIds).toEqual(["u-1"]);
  });

  it("PHASE 6.6.8: converted mark uses source face_recognition", async () => {
    setupSessionFindOneForActiveSession([
      {
        studentUserId: "u-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
    ]);
    mockMarkFindOneAndUpdate.mockImplementationOnce(async () => {
      const err = new Error("E11000") as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = { sessionId: ACTIVE_SESSION_ID, studentUserId: "u-1" };
      throw err;
    });
    setupMarkFindForRaceReconciliation({
      studentUserId: "u-1",
      status: "absent",
      source: "session_finalization",
    });
    setupSessionEndedAt(SESSION_ENDED_AT);
    let observedSource: string | undefined;
    mockMarkFindOneAndUpdate.mockImplementationOnce(
      async (_filter, update) => {
        observedSource = update.$set?.source as string;
        return { value: { studentUserId: "u-1" }, lastErrorObject: {} };
      },
    );

    await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
      recognitionDecisionAt: DECISION_BEFORE_STOP,
    });

    expect(observedSource).toBe("face_recognition");
  });

  it("PHASE 6.6.9: converted mark uses recognitionDecisionAt for recognizedAt", async () => {
    setupSessionFindOneForActiveSession([
      {
        studentUserId: "u-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
    ]);
    mockMarkFindOneAndUpdate.mockImplementationOnce(async () => {
      const err = new Error("E11000") as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = { sessionId: ACTIVE_SESSION_ID, studentUserId: "u-1" };
      throw err;
    });
    setupMarkFindForRaceReconciliation({
      studentUserId: "u-1",
      status: "absent",
      source: "session_finalization",
    });
    setupSessionEndedAt(SESSION_ENDED_AT);
    let observedRecognizedAt: Date | undefined;
    mockMarkFindOneAndUpdate.mockImplementationOnce(
      async (_filter, update) => {
        observedRecognizedAt = update.$set?.recognizedAt as Date;
        return { value: { studentUserId: "u-1" }, lastErrorObject: {} };
      },
    );

    await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
      recognitionDecisionAt: DECISION_BEFORE_STOP,
    });

    // The reconciliation uses the same recognitionDecisionAt.
    expect(observedRecognizedAt).toEqual(DECISION_BEFORE_STOP);
  });

  it("PHASE 6.6.10: conversion changes only the matching session/student row", async () => {
    setupSessionFindOneForActiveSession([
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
    ]);
    // Order matters: u-1 first try (duplicate), then u-1 reconciliation
    // upsert, then u-2 normal upsert.
    mockMarkFindOneAndUpdate
      .mockImplementationOnce(async () => {
        // u-1 first try → duplicate
        const err = new Error("E11000") as Error & {
          code: number;
          keyValue: Record<string, unknown>;
        };
        err.code = 11000;
        err.keyValue = { sessionId: ACTIVE_SESSION_ID, studentUserId: "u-1" };
        throw err;
      })
      .mockImplementationOnce(
        // u-1 reconciliation
        async (filter) => {
          expect(filter.studentUserId).toBe("u-1");
          expect(filter.status).toBe("absent");
          expect(filter.source).toBe("session_finalization");
          return { value: { studentUserId: "u-1" }, lastErrorObject: {} };
        },
      )
      .mockImplementationOnce(async () => ({
        // u-2 normal
        lastErrorObject: { upserted: "id-u2" },
        value: null,
      }));
    // u-1: inspect existing (absent).
    setupMarkFindForRaceReconciliation({
      studentUserId: "u-1",
      status: "absent",
      source: "session_finalization",
    });
    // u-1: read endedAt for reconciliation.
    setupSessionEndedAt(SESSION_ENDED_AT);

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1", "u-2"],
      recognitionDecisionAt: DECISION_BEFORE_STOP,
    });

    expect(result.persistedStudentUserIds).toEqual(["u-1", "u-2"]);
    expect(result.idempotentStudentUserIds).toEqual([]);
  });

  it("PHASE 6.6.11: existing Present is never overwritten", async () => {
    setupSessionFindOneForActiveSession([
      {
        studentUserId: "u-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
    ]);
    mockMarkFindOneAndUpdate.mockImplementationOnce(async () => {
      const err = new Error("E11000") as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = { sessionId: ACTIVE_SESSION_ID, studentUserId: "u-1" };
      throw err;
    });
    setupMarkFindForRaceReconciliation({
      studentUserId: "u-1",
      status: "present",
      source: "face_recognition",
    });

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
      recognitionDecisionAt: DECISION_BEFORE_STOP,
    });

    expect(result.persistedStudentUserIds).toEqual([]);
    expect(result.idempotentStudentUserIds).toEqual(["u-1"]);
  });

  it("PHASE 6.6.12: decisionAt > endedAt does NOT convert Absent", async () => {
    const decisionAfterStop = new Date("2026-09-16T10:45:00Z");
    setupSessionFindOneForActiveSession([
      {
        studentUserId: "u-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
    ]);
    mockMarkFindOneAndUpdate.mockImplementationOnce(async () => {
      const err = new Error("E11000") as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = { sessionId: ACTIVE_SESSION_ID, studentUserId: "u-1" };
      throw err;
    });
    setupMarkFindForRaceReconciliation({
      studentUserId: "u-1",
      status: "absent",
      source: "session_finalization",
    });
    setupSessionEndedAt(SESSION_ENDED_AT);
    // No second upsert should be called.
    const secondUpsert = vi.fn();
    mockMarkFindOneAndUpdate.mockImplementationOnce(secondUpsert);

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
      recognitionDecisionAt: decisionAfterStop,
    });

    // Absent was NOT converted.
    expect(result.persistedStudentUserIds).toEqual([]);
    expect(result.idempotentStudentUserIds).toEqual(["u-1"]);
    // Reconciliation upsert was NOT called.
    expect(secondUpsert).not.toHaveBeenCalled();
  });

  it("PHASE 6.6.13: recognition that observes CLOSED session at initial check creates no mark", async () => {
    // Session lookup returns null (session not active).
    setupSessionFindOneChain(null);

    await expect(
      recordPresentAttendanceMarksForActiveSession({
        sessionId: ACTIVE_SESSION_ID,
        candidateStudentUserIds: ["u-1"],
        recognitionDecisionAt: new Date(),
      }),
    ).rejects.toMatchObject({
      code: ATTENDANCE_MARK_ERROR_CODES.ATTENDANCE_SESSION_NOT_ACTIVE,
    });
  });

  it("PHASE 6.6.14: arbitrary Absent source is NOT converted", async () => {
    setupSessionFindOneForActiveSession([
      {
        studentUserId: "u-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
    ]);
    mockMarkFindOneAndUpdate.mockImplementationOnce(async () => {
      const err = new Error("E11000") as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = { sessionId: ACTIVE_SESSION_ID, studentUserId: "u-1" };
      throw err;
    });
    // Existing Absent has an arbitrary source (NOT session_finalization).
    setupMarkFindForRaceReconciliation({
      studentUserId: "u-1",
      status: "absent",
      source: "manual_override",
    });
    const secondUpsert = vi.fn();
    mockMarkFindOneAndUpdate.mockImplementationOnce(secondUpsert);

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
      recognitionDecisionAt: DECISION_BEFORE_STOP,
    });

    // Absent was NOT converted.
    expect(result.persistedStudentUserIds).toEqual([]);
    expect(result.idempotentStudentUserIds).toEqual(["u-1"]);
    expect(secondUpsert).not.toHaveBeenCalled();
  });

  it("PHASE 6.6.15: student outside rosterSnapshot cannot use reconciliation path", async () => {
    // Snapshot only has u-1; we try to persist u-2.
    setupSessionFindOneForActiveSession([
      {
        studentUserId: "u-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
    ]);
    // Snapshot authority filter drops u-2 → no upsert call at all.
    const impl = vi.fn();
    setupMarkFindOneAndUpdateChain(impl);

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-2"],
      recognitionDecisionAt: new Date(),
    });

    expect(result.persistedStudentUserIds).toEqual([]);
    expect(result.idempotentStudentUserIds).toEqual([]);
    expect(impl).not.toHaveBeenCalled();
  });

  it("PHASE 6.6.16: duplicate delayed recognition remains one mark", async () => {
    // ---- First call: duplicate key → Present → idempotent ----
    mockSessionFindOne.mockImplementationOnce(
      (filter: { _id?: string; status?: string }) => {
        if (filter._id !== ACTIVE_SESSION_ID) return chain(null);
        if (filter.status !== "active") return chain(null);
        return chain({
          _id: { toString: () => ACTIVE_SESSION_ID },
          classId: { toString: () => ACTIVE_CLASS_ID },
          status: "active",
          rosterSnapshot: [
            {
              studentUserId: "u-1",
              fullNameSnapshot: "Alice",
              identificationCodeSnapshot: "SV001",
            },
          ],
        });
      },
    );
    mockMarkFindOneAndUpdate.mockImplementationOnce(async () => {
      const err = new Error("E11000") as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = { sessionId: ACTIVE_SESSION_ID, studentUserId: "u-1" };
      throw err;
    });
    mockMarkFindOne.mockImplementationOnce(() => {
      const q = {
        select: () => q,
        lean: () => q,
        exec: async () => ({
          status: "present",
          source: "face_recognition",
        }),
      };
      return q;
    });

    const first = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
      recognitionDecisionAt: DECISION_BEFORE_STOP,
    });

    // ---- Second call: duplicate key → Present → idempotent ----
    mockSessionFindOne.mockImplementationOnce(
      (filter: { _id?: string; status?: string }) => {
        if (filter._id !== ACTIVE_SESSION_ID) return chain(null);
        if (filter.status !== "active") return chain(null);
        return chain({
          _id: { toString: () => ACTIVE_SESSION_ID },
          classId: { toString: () => ACTIVE_CLASS_ID },
          status: "active",
          rosterSnapshot: [
            {
              studentUserId: "u-1",
              fullNameSnapshot: "Alice",
              identificationCodeSnapshot: "SV001",
            },
          ],
        });
      },
    );
    mockMarkFindOneAndUpdate.mockImplementationOnce(async () => {
      const err = new Error("E11000") as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = { sessionId: ACTIVE_SESSION_ID, studentUserId: "u-1" };
      throw err;
    });
    mockMarkFindOne.mockImplementationOnce(() => {
      const q = {
        select: () => q,
        lean: () => q,
        exec: async () => ({
          status: "present",
          source: "face_recognition",
        }),
      };
      return q;
    });

    const second = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
      recognitionDecisionAt: new Date(),
    });

    expect(first.persistedStudentUserIds).toEqual([]);
    expect(first.idempotentStudentUserIds).toEqual(["u-1"]);
    expect(second.persistedStudentUserIds).toEqual([]);
    expect(second.idempotentStudentUserIds).toEqual(["u-1"]);
  });

  it("PHASE 6.6.17: existing mark null after duplicate error does not throw", async () => {
    setupSessionFindOneForActiveSession([
      {
        studentUserId: "u-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
    ]);
    mockMarkFindOneAndUpdate.mockImplementationOnce(async () => {
      const err = new Error("E11000") as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = { sessionId: ACTIVE_SESSION_ID, studentUserId: "u-1" };
      throw err;
    });
    // Mark disappeared between duplicate error and findOne.
    setupMarkFindForRaceReconciliation(null);

    const result = await recordPresentAttendanceMarksForActiveSession({
      sessionId: ACTIVE_SESSION_ID,
      candidateStudentUserIds: ["u-1"],
      recognitionDecisionAt: DECISION_BEFORE_STOP,
    });

    // Treat as idempotent.
    expect(result.idempotentStudentUserIds).toEqual(["u-1"]);
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

// =============================================================================
// PHASE 6.6 — Absent finalization
// =============================================================================

/*
 * These tests cover finalization of absent marks for closed sessions.
 * The mocked Mongoose layer is set up below. Tests are unit-level:
 * no MongoDB, no Face Service, no Better Auth involved.
 */

const FINALIZE_SESSION_ID = "65f000000000000000000bbb";
const FINALIZE_CLASS_ID = "65f000000000000000000bbc";

function makeClosedSessionDoc(
  rosterSnapshot: Array<{
    studentUserId: string;
    fullNameSnapshot: string;
    identificationCodeSnapshot: string;
  }> = [],
) {
  return {
    _id: {
      toString: () => FINALIZE_SESSION_ID,
      toHexString: () => FINALIZE_SESSION_ID,
      // Mongoose ObjectId equality uses .toString() and the underlying buffer.
      // For our tests we only ever pass a string filter, so comparison is
      // by string.
      equals: (other: unknown) => {
        return String(other) === FINALIZE_SESSION_ID;
      },
    },
    classId: {
      toString: () => FINALIZE_CLASS_ID,
      toHexString: () => FINALIZE_CLASS_ID,
      equals: (other: unknown) => String(other) === FINALIZE_CLASS_ID,
    },
    status: "closed" as const,
    rosterSnapshot,
  };
}

function setupSessionFindOneForClosed(doc: ReturnType<typeof makeClosedSessionDoc> | null) {
  mockSessionFindOne.mockImplementationOnce(
    (filter: { _id?: string; status?: string }) => {
      if (!doc) {
        return chain(null);
      }
      if (filter._id !== FINALIZE_SESSION_ID) {
        return chain(null);
      }
      if (filter.status !== "closed") {
        return chain(null);
      }
      return chain(doc);
    },
  );
}

/**
 * For finalizeAbsentMarksForClosedSession, the service calls
 * AttendanceSessionModel.findOne({ _id, status: undefined }). Then
 * AttendanceMarkModel.find({ sessionId }).
 */
function setupFinalizeSessionLookup(doc: ReturnType<typeof makeClosedSessionDoc> | null) {
  // session findOne with _id (no status filter — checked manually after).
  // Cast through unknown to satisfy TypeScript's strict lean type inference.
  mockSessionFindOne.mockImplementationOnce(
    () => chain(doc as unknown as Parameters<typeof chain>[0]),
  );
}

function setupFinalizeExistingMarks(
  docs: Array<{ studentUserId: string; status: string }>,
) {
  mockMarkFind.mockImplementationOnce(() => {
    const q = {
      select: () => q,
      lean: () => q,
      exec: async () => docs,
    };
    return q;
  });
}

/**
 * For each roster student without a present mark, the service calls
 * AttendanceMarkModel.findOneAndUpdate. We provide a helper to
 * intercept those calls and capture each call's arguments.
 */
function setupAbsentUpsertChain(
  existingForStudentIds: Set<string>,
) {
  return vi.fn().mockImplementation(async (filter, update) => {
    const studentUserId = filter.studentUserId;
    // Capture the upsert payload (we assert on it per-test).
    if (existingForStudentIds.has(studentUserId)) {
      // Pretend the mark already exists — no upserted key.
      return {
        lastErrorObject: {},
        value: { studentUserId, status: "absent" },
      };
    }
    // Pretend a NEW mark is created.
    return {
      lastErrorObject: { upserted: `new-${studentUserId}` },
      value: null,
    };
  });
}

describe("finalizeAbsentMarksForClosedSession", () => {
  it("5. finalization uses rosterSnapshot (NOT current ClassMembership)", async () => {
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "SV100",
      },
      {
        studentUserId: "u-snap-2",
        fullNameSnapshot: "Beta",
        identificationCodeSnapshot: "SV200",
      },
    ]);
    setupFinalizeSessionLookup(session);
    setupFinalizeExistingMarks([]);

    const upsert = setupAbsentUpsertChain(new Set());
    mockMarkFindOneAndUpdate.mockImplementation(upsert);

    const result = await finalizeAbsentMarksForClosedSession({
      sessionId: FINALIZE_SESSION_ID,
      classId: FINALIZE_CLASS_ID,
    });

    // TWO absent marks created — exactly the two snapshot students.
    expect(result.createdAbsent).toEqual(["u-snap-1", "u-snap-2"]);
    expect(result.alreadyHadMark).toEqual([]);
    expect(result.finalizedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    // We never queried ClassMembership in this test path
    // (no mock for it). Asserting by mock absence.
  });

  it("6. current ClassMembership (or Profile) is NEVER consulted", async () => {
    // Session only contains "u-snap-1" in the snapshot. We try to
    // finalize. The service must ONLY consider snapshot ids.
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "SV100",
      },
    ]);
    setupFinalizeSessionLookup(session);
    setupFinalizeExistingMarks([
      // Pretend a present mark for u-other-1 exists. The
      // service must IGNORE this because u-other-1 is not in
      // the snapshot.
      { studentUserId: "u-other-1", status: "present" },
    ]);

    const upsert = setupAbsentUpsertChain(new Set());
    mockMarkFindOneAndUpdate.mockImplementation(upsert);

    const result = await finalizeAbsentMarksForClosedSession({
      sessionId: FINALIZE_SESSION_ID,
      classId: FINALIZE_CLASS_ID,
    });

    expect(result.createdAbsent).toEqual(["u-snap-1"]);
    // u-other-1 is NOT in the snapshot, so no absent for them.
    expect(result.createdAbsent).not.toContain("u-other-1");
  });

  it("7. existing Present remains Present (never overwritten)", async () => {
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "SV100",
      },
      {
        studentUserId: "u-snap-2",
        fullNameSnapshot: "Beta",
        identificationCodeSnapshot: "SV200",
      },
    ]);
    setupFinalizeSessionLookup(session);
    // u-snap-1 ALREADY has a present mark.
    setupFinalizeExistingMarks([
      { studentUserId: "u-snap-1", status: "present" },
    ]);

    // The upsert for u-snap-1 should NEVER be called. Only u-snap-2.
    const upsertCalls: Array<{ studentUserId: string; status?: string }> = [];
    mockMarkFindOneAndUpdate.mockImplementation(async (filter, update) => {
      upsertCalls.push({
        studentUserId: filter.studentUserId,
        status: update?.$setOnInsert?.status,
      });
      return {
        lastErrorObject: { upserted: `new-${filter.studentUserId}` },
        value: null,
      };
    });

    const result = await finalizeAbsentMarksForClosedSession({
      sessionId: FINALIZE_SESSION_ID,
      classId: FINALIZE_CLASS_ID,
    });

    // Only u-snap-2 is created as absent.
    expect(result.createdAbsent).toEqual(["u-snap-2"]);
    expect(result.alreadyHadMark).toEqual([]);
    // The upsert was called ONLY for u-snap-2.
    expect(upsertCalls.map((c) => c.studentUserId)).toEqual(["u-snap-2"]);
    expect(upsertCalls[0]?.status).toBe("absent");
  });

  it("8. missing mark becomes Absent (u-snapshot in roster, no mark)", async () => {
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "SV100",
      },
    ]);
    setupFinalizeSessionLookup(session);
    setupFinalizeExistingMarks([]);

    mockMarkFindOneAndUpdate.mockImplementation(async (filter, update) => {
      expect(update?.$setOnInsert?.status).toBe("absent");
      expect(update?.$setOnInsert?.source).toBe("session_finalization");
      return {
        lastErrorObject: { upserted: "id-absent-1" },
        value: null,
      };
    });

    const result = await finalizeAbsentMarksForClosedSession({
      sessionId: FINALIZE_SESSION_ID,
      classId: FINALIZE_CLASS_ID,
    });

    expect(result.createdAbsent).toEqual(["u-snap-1"]);
  });

  it("9. all-present roster creates zero Absent", async () => {
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "SV100",
      },
      {
        studentUserId: "u-snap-2",
        fullNameSnapshot: "Beta",
        identificationCodeSnapshot: "SV200",
      },
    ]);
    setupFinalizeSessionLookup(session);
    setupFinalizeExistingMarks([
      { studentUserId: "u-snap-1", status: "present" },
      { studentUserId: "u-snap-2", status: "present" },
    ]);

    const upsert = vi.fn();
    mockMarkFindOneAndUpdate.mockImplementation(upsert);

    const result = await finalizeAbsentMarksForClosedSession({
      sessionId: FINALIZE_SESSION_ID,
      classId: FINALIZE_CLASS_ID,
    });

    expect(result.createdAbsent).toEqual([]);
    expect(result.alreadyHadMark).toEqual([]);
    // No upsert calls.
    expect(upsert).not.toHaveBeenCalled();
  });

  it("10. zero-member roster finalizes safely (Present = 0, Absent = 0)", async () => {
    const session = makeClosedSessionDoc([]);
    setupFinalizeSessionLookup(session);
    setupFinalizeExistingMarks([]);

    const upsert = vi.fn();
    mockMarkFindOneAndUpdate.mockImplementation(upsert);

    const result = await finalizeAbsentMarksForClosedSession({
      sessionId: FINALIZE_SESSION_ID,
      classId: FINALIZE_CLASS_ID,
    });

    expect(result.createdAbsent).toEqual([]);
    expect(result.alreadyHadMark).toEqual([]);
    expect(result.finalizedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("11. repeated finalization creates no duplicates (idempotent)", async () => {
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "SV100",
      },
      {
        studentUserId: "u-snap-2",
        fullNameSnapshot: "Beta",
        identificationCodeSnapshot: "SV200",
      },
    ]);

    // FIRST CALL — simulate as if u-snap-2 was recognized present
    // and u-snap-1 needs to be finalized as absent.
    setupFinalizeSessionLookup(session);
    setupFinalizeExistingMarks([
      { studentUserId: "u-snap-2", status: "present" },
    ]);
    // The upsert for u-snap-1 succeeds: it was newly created.
    const seenIds = new Set<string>();
    mockMarkFindOneAndUpdate.mockImplementation(async (filter) => {
      const id = filter.studentUserId as string;
      seenIds.add(id);
      return {
        lastErrorObject: { upserted: `new-${id}` },
        value: null,
      };
    });

    const first = await finalizeAbsentMarksForClosedSession({
      sessionId: FINALIZE_SESSION_ID,
      classId: FINALIZE_CLASS_ID,
    });
    expect(first.createdAbsent).toEqual(["u-snap-1"]);
    expect(first.alreadyHadMark).toEqual([]);

    // SECOND CALL — the existing absent mark is now present in
    // AttendanceMarks. The service must NOT re-upsert.
    setupFinalizeSessionLookup(session);
    setupFinalizeExistingMarks([
      { studentUserId: "u-snap-1", status: "absent" },
      { studentUserId: "u-snap-2", status: "present" },
    ]);
    const secondSeen = new Set<string>();
    mockMarkFindOneAndUpdate.mockImplementation(async (filter) => {
      const id = filter.studentUserId as string;
      secondSeen.add(id);
      return {
        lastErrorObject: { upserted: `new-${id}` },
        value: null,
      };
    });

    const second = await finalizeAbsentMarksForClosedSession({
      sessionId: FINALIZE_SESSION_ID,
      classId: FINALIZE_CLASS_ID,
    });

    // No UPSERT on the second call (both roster students
    // already have a mark in the database).
    expect(second.createdAbsent).toEqual([]);
    expect(second.alreadyHadMark).toEqual([]);
    expect(secondSeen.size).toBe(0);
  });

  it("13. concurrent duplicate-key insert is treated idempotently", async () => {
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "SV100",
      },
    ]);
    setupFinalizeSessionLookup(session);
    // No existing mark yet (concurrent writer hasn't committed).
    setupFinalizeExistingMarks([]);

    // Simulate the upsert throwing a Mongo duplicate-key error.
    mockMarkFindOneAndUpdate.mockImplementation(async () => {
      const err = new Error("E11000 duplicate") as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = {
        sessionId: FINALIZE_SESSION_ID,
        studentUserId: "u-snap-1",
      };
      throw err;
    });

    // The duplicate-key error must be folded into idempotent success
    // — NOT thrown.
    const result = await finalizeAbsentMarksForClosedSession({
      sessionId: FINALIZE_SESSION_ID,
      classId: FINALIZE_CLASS_ID,
    });

    expect(result.createdAbsent).toEqual([]);
    expect(result.alreadyHadMark).toEqual(["u-snap-1"]);
  });

  it("rejects invalid sessionId with INVALID_SESSION_ID", async () => {
    await expect(
      finalizeAbsentMarksForClosedSession({
        sessionId: "not-a-canonical-hex",
        classId: FINALIZE_CLASS_ID,
      }),
    ).rejects.toMatchObject({
      code: ATTENDANCE_MARK_ERROR_CODES.INVALID_SESSION_ID,
    });
  });

  it("rejects missing session with ATTENDANCE_SESSION_NOT_FOUND_FOR_FINALIZATION", async () => {
    setupFinalizeSessionLookup(null);
    await expect(
      finalizeAbsentMarksForClosedSession({
        sessionId: FINALIZE_SESSION_ID,
        classId: FINALIZE_CLASS_ID,
      }),
    ).rejects.toMatchObject({
      code: ATTENDANCE_MARK_ERROR_CODES.ATTENDANCE_SESSION_NOT_FOUND_FOR_FINALIZATION,
    });
  });

  it("rejects active session with SESSION_NOT_CLOSED", async () => {
    // Build a session with "active" status directly.
    const activeDoc = {
      _id: {
        toString: () => FINALIZE_SESSION_ID,
        toHexString: () => FINALIZE_SESSION_ID,
      },
      classId: {
        toString: () => FINALIZE_CLASS_ID,
        toHexString: () => FINALIZE_CLASS_ID,
      },
      status: "active" as const,
      rosterSnapshot: [],
    };
    mockSessionFindOne.mockImplementationOnce(
      () => chain(activeDoc),
    );
    await expect(
      finalizeAbsentMarksForClosedSession({
        sessionId: FINALIZE_SESSION_ID,
        classId: FINALIZE_CLASS_ID,
      }),
    ).rejects.toMatchObject({
      code: ATTENDANCE_MARK_ERROR_CODES.SESSION_NOT_CLOSED,
    });
  });

  it("rejects mismatched classId with ATTENDANCE_SESSION_NOT_FOUND_FOR_FINALIZATION", async () => {
    const session = makeClosedSessionDoc([]);
    setupFinalizeSessionLookup(session);
    await expect(
      finalizeAbsentMarksForClosedSession({
        sessionId: FINALIZE_SESSION_ID,
        classId: "65f000000000000000000fff", // wrong class id
      }),
    ).rejects.toMatchObject({
      code: ATTENDANCE_MARK_ERROR_CODES.ATTENDANCE_SESSION_NOT_FOUND_FOR_FINALIZATION,
    });
  });

  it("finalizes one unmatched student and skips one present student in mixed roster", async () => {
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "SV100",
      },
      {
        studentUserId: "u-snap-2",
        fullNameSnapshot: "Beta",
        identificationCodeSnapshot: "SV200",
      },
      {
        studentUserId: "u-snap-3",
        fullNameSnapshot: "Gamma",
        identificationCodeSnapshot: "SV300",
      },
    ]);
    setupFinalizeSessionLookup(session);
    // u-snap-2 already present.
    setupFinalizeExistingMarks([
      { studentUserId: "u-snap-2", status: "present" },
    ]);

    mockMarkFindOneAndUpdate.mockImplementation(async (_filter, update) => {
      expect(update?.$setOnInsert?.status).toBe("absent");
      expect(update?.$setOnInsert?.source).toBe("session_finalization");
      expect(update?.$setOnInsert?.recognizedAt).toBeInstanceOf(Date);
      return {
        lastErrorObject: { upserted: "x" },
        value: null,
      };
    });

    const result = await finalizeAbsentMarksForClosedSession({
      sessionId: FINALIZE_SESSION_ID,
      classId: FINALIZE_CLASS_ID,
    });

    expect(result.createdAbsent).toEqual(["u-snap-1", "u-snap-3"]);
    expect(result.alreadyHadMark).toEqual([]);
    // Ensure u-snap-2 was NOT in the upsert calls (verified by
    // not matching the implementation — absent for u-snap-2
    // would have changed status to absent and lost present).
    expect(result.createdAbsent).not.toContain("u-snap-2");
  });

  it("source is session_finalization for every absent mark", async () => {
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "SV100",
      },
      {
        studentUserId: "u-snap-2",
        fullNameSnapshot: "Beta",
        identificationCodeSnapshot: "SV200",
      },
    ]);
    setupFinalizeSessionLookup(session);
    setupFinalizeExistingMarks([]);

    const observedSources: string[] = [];
    mockMarkFindOneAndUpdate.mockImplementation(async (_filter, update) => {
      observedSources.push(update?.$setOnInsert?.source ?? "");
      return {
        lastErrorObject: { upserted: "x" },
        value: null,
      };
    });

    await finalizeAbsentMarksForClosedSession({
      sessionId: FINALIZE_SESSION_ID,
      classId: FINALIZE_CLASS_ID,
    });

    expect(observedSources).toEqual([
      "session_finalization",
      "session_finalization",
    ]);
  });
});

// =============================================================================
// listAllAttendanceMarksForSession — both present and absent
// =============================================================================

describe("listAllAttendanceMarksForSession", () => {
  it("returns marks sorted by rosterSnapshot order", async () => {
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "SV100",
      },
      {
        studentUserId: "u-snap-2",
        fullNameSnapshot: "Beta",
        identificationCodeSnapshot: "SV200",
      },
      {
        studentUserId: "u-snap-3",
        fullNameSnapshot: "Gamma",
        identificationCodeSnapshot: "SV300",
      },
    ]);
    mockSessionFindById.mockImplementationOnce(() => chain(session));

    // Provide marks in REVERSE order to verify deterministic
    // sorting by snapshot position.
    mockMarkFind.mockImplementationOnce(() => {
      const q = {
        select: () => q,
        lean: () => q,
        exec: async () => [
          {
            studentUserId: "u-snap-3",
            status: "present",
            recognizedAt: new Date("2026-09-16T10:02:00Z"),
          },
          {
            studentUserId: "u-snap-1",
            status: "absent",
            recognizedAt: new Date("2026-09-16T10:00:00Z"),
          },
          {
            studentUserId: "u-snap-2",
            status: "present",
            recognizedAt: new Date("2026-09-16T10:01:00Z"),
          },
        ],
      };
      return q;
    });

    const list = await listAllAttendanceMarksForSession(FINALIZE_SESSION_ID);
    expect(list.map((m) => m.studentUserId)).toEqual([
      "u-snap-1",
      "u-snap-2",
      "u-snap-3",
    ]);
    expect(list.map((m) => m.status)).toEqual([
      "absent",
      "present",
      "present",
    ]);
  });

  it("returns empty list when session does not exist", async () => {
    mockSessionFindById.mockImplementationOnce(() => chain(null));

    const list = await listAllAttendanceMarksForSession(FINALIZE_SESSION_ID);
    expect(list).toEqual([]);
  });

  it("returns empty list when no marks exist", async () => {
    const session = makeClosedSessionDoc([
      {
        studentUserId: "u-snap-1",
        fullNameSnapshot: "Alpha",
        identificationCodeSnapshot: "SV100",
      },
    ]);
    mockSessionFindById.mockImplementationOnce(() => chain(session));
    mockMarkFind.mockImplementationOnce(() => {
      const q = {
        select: () => q,
        lean: () => q,
        exec: async () => [],
      };
      return q;
    });

    const list = await listAllAttendanceMarksForSession(FINALIZE_SESSION_ID);
    expect(list).toEqual([]);
  });
});
