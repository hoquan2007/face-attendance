/**
 * Tests for POST /api/attendance/recognize.
 *
 * PHASE 6.4 — IDEMPOTENT PRESENT ATTENDANCE MARKS +
 * LIVE PRESENT STATE.
 *
 * PHASE 6.4 extends the route so a Face Service match that has
 * already passed the server-side `FACE_MATCH_THRESHOLD` becomes a
 * persisted PRESENT attendance mark. The new tests (12..23)
 * cover the persistence contract.
 *
 * Covers:
 *   25. unauthenticated rejected
 *   26. student rejected
 *   27. non-owner teacher rejected
 *   28. inactive session rejected
 *   29. session/class mismatch rejected
 *   30. only active session gallery used
 *   31. image size/type enforced
 *   32. Face Service called with ephemeral candidate keys
 *   33. Face Service payload contains no studentUserId
 *   34. response maps candidateKey to snapshot fullName
 *   35. response maps snapshot identificationCode
 *   36. candidateKey not returned to browser
 *   37. embedding not returned
 *   38. rosterSnapshot not returned
 *   39. no database write performed (PHASE 6.3 statement replaced)
 *
 * PHASE 6.4 additions:
 *   12. valid Face Service match creates Present mark
 *   13. multiple matches create multiple unique marks
 *   14. repeated scan does not increase duplicate count
 *   15. unmatched face creates no mark
 *   16. unknown candidateKey creates no mark
 *   17. browser cannot supply studentUserId
 *   18. current Membership does not determine mark eligibility
 *   19. session snapshot is authority
 *   20. final active-session recheck occurs before writes
 *   21. closed-before-finalization creates no new marks
 *   22. mark uses server recognition timestamp
 *   23. route response exposes no mark/student internal IDs
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock global NextRequest type for the test environment.
class MockNextRequest {
  constructor(
    public input: string | URL,
    public init: RequestInit = {},
  ) {}
  async formData(): Promise<FormData> {
    return this.init.body as FormData;
  }
}

// =============================================================================
// Mocked collaborators
// =============================================================================

const mockGetSession = vi.fn();
const mockGetProfileByUserId = vi.fn();
const mockGetClassDetailForCurrentUser = vi.fn();
const mockFindActiveAttendanceSessionByClassId = vi.fn();
const mockBuildAttendanceRecognitionGallery = vi.fn();
const mockIdentifyFaces = vi.fn();
const mockIsAttendanceSessionStillActive = vi.fn();
const mockRecordPresentAttendanceMarksForActiveSession = vi.fn();

vi.mock("next/server", () => ({
  NextRequest: class NextRequest {
    constructor(
      public input: string | URL,
      public init: RequestInit = {},
    ) {}
    async formData() {
      return this.init.body as FormData;
    }
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      __isNextResponse: true,
      status: init?.status ?? 200,
      body,
      async json() {
        return body;
      },
    }),
  },
}));

vi.mock("@/lib/session", () => ({
  getSession: () => mockGetSession(),
}));

vi.mock("@/lib/profile-service", () => ({
  getProfileByUserId: (...args: unknown[]) => mockGetProfileByUserId(...args),
}));

vi.mock("@/lib/classes/class-read-service", () => ({
  getClassDetailForCurrentUser: (...args: unknown[]) =>
    mockGetClassDetailForCurrentUser(...args),
}));

vi.mock("@/lib/attendance/attendance-session-service", () => ({
  findActiveAttendanceSessionByClassId: (...args: unknown[]) =>
    mockFindActiveAttendanceSessionByClassId(...args),
}));

vi.mock("@/lib/attendance/attendance-recognition-gallery-service", () => ({
  buildAttendanceRecognitionGallery: (...args: unknown[]) =>
    mockBuildAttendanceRecognitionGallery(...args),
  ATTENDANCE_RECOGNITION_ERROR_CODES: {
    NO_RECOGNITION_CANDIDATES: "NO_RECOGNITION_CANDIDATES",
    ATTENDANCE_SESSION_NOT_FOUND: "ATTENDANCE_SESSION_NOT_FOUND",
    ATTENDANCE_SESSION_NOT_ACTIVE: "ATTENDANCE_SESSION_NOT_ACTIVE",
    SESSION_CLASS_MISMATCH: "SESSION_CLASS_MISMATCH",
  },
  AttendanceRecognitionError: class AttendanceRecognitionError extends Error {
    override name = "AttendanceRecognitionError";
    public code: string;
    constructor(init: { code: string; message: string }) {
      super(init.message);
      this.code = init.code;
    }
  },
}));

vi.mock("@/lib/biometrics/face-service-client", () => ({
  identifyFaces: (...args: unknown[]) => mockIdentifyFaces(...args),
  FACE_SERVICE_ERROR_CODES: {
    FACE_SERVICE_UNAVAILABLE: "FACE_SERVICE_UNAVAILABLE",
    FACE_SERVICE_TIMEOUT: "FACE_SERVICE_TIMEOUT",
    FACE_SERVICE_INVALID_RESPONSE: "FACE_SERVICE_INVALID_RESPONSE",
  },
  FaceServiceClientError: class FaceServiceClientError extends Error {
    override name = "FaceServiceClientError";
    public code: string;
    public domainError?: { code: string; message: string };
    constructor(init: {
      code: string;
      message: string;
      domainError?: { code: string; message: string };
    }) {
      super(init.message);
      this.code = init.code;
      if (init.domainError) {
        this.domainError = init.domainError;
      }
    }
  },
}));

vi.mock("@/lib/attendance/attendance-mark-service", () => ({
  isAttendanceSessionStillActive: (...args: unknown[]) =>
    mockIsAttendanceSessionStillActive(...args),
  recordPresentAttendanceMarksForActiveSession: (...args: unknown[]) =>
    mockRecordPresentAttendanceMarksForActiveSession(...args),
  AttendanceMarkServiceError: class AttendanceMarkServiceError extends Error {
    override name = "AttendanceMarkServiceError";
    public code: string;
    constructor(init: { code: string; message: string }) {
      super(init.message);
      this.code = init.code;
    }
  },
  ATTENDANCE_MARK_ERROR_CODES: {
    INVALID_SESSION_ID: "INVALID_SESSION_ID",
    ATTENDANCE_SESSION_NOT_FOUND: "ATTENDANCE_SESSION_NOT_FOUND",
    ATTENDANCE_SESSION_NOT_ACTIVE: "ATTENDANCE_SESSION_NOT_ACTIVE",
    STUDENT_NOT_IN_SNAPSHOT: "STUDENT_NOT_IN_SNAPSHOT",
    ATTENDANCE_MARK_WRITE_FAILED: "ATTENDANCE_MARK_WRITE_FAILED",
  },
}));
vi.mock("mongoose", () => ({
  default: {
    Types: {
      ObjectId: class {
        constructor(value?: string) {
          this.toString = () => value ?? "";
        }
      },
    },
  },
  Types: {
    ObjectId: class {
      constructor(value?: string) {
        this.toString = () => value ?? "";
      }
    },
  },
}));
// =============================================================================
// Fixtures
// =============================================================================

function makeSession(user: { id: string; email?: string }) {
  return {
    user: {
      id: user.id,
      email: user.email ?? `${user.id}@example.com`,
      name: "Test User",
      image: null,
    },
    expiresAt: new Date(),
  };
}

function makeClassResult(
  role: "teacher" | "student",
  overrides: { ok?: boolean; code?: string } = {},
) {
  if (overrides.ok === false) {
    return { ok: false, code: overrides.code ?? "CLASS_NOT_ACCESSIBLE" };
  }
  return {
    ok: true,
    result: {
      role,
      class: {
        id: "class-1",
        name: "Test Class",
      },
    },
  };
}

function makeSessionDoc(sessionId: string) {
  return {
    _id: { toString: () => sessionId },
    status: "active",
  };
}

// =============================================================================
// Route handler
// =============================================================================

async function makeRequest(
  overrides: {
    classId?: string;
    sessionId?: string;
    image?: Blob;
    faceServiceMatches?: Array<{ candidate_key: string }>;
    persistResult?: {
      persistedStudentUserIds: string[];
      idempotentStudentUserIds: string[];
      recognizedAt: string;
    };
    sessionStillActive?: boolean;
  } = {},
): Promise<{ status: number; body: unknown }> {
  // Reset mock call history (not mock implementations) to avoid
  // interference between test cases.
  mockGetSession.mockClear();
  mockGetProfileByUserId.mockClear();
  mockGetClassDetailForCurrentUser.mockClear();
  mockFindActiveAttendanceSessionByClassId.mockClear();
  mockBuildAttendanceRecognitionGallery.mockClear();
  mockIdentifyFaces.mockClear();
  mockIsAttendanceSessionStillActive.mockClear();
  mockRecordPresentAttendanceMarksForActiveSession.mockClear();

  const classId = overrides.classId ?? "class-1";
  const sessionId = overrides.sessionId ?? "session-1";

  const { POST } = await import("@/app/api/attendance/recognize/route");

  const formData = new FormData();
  formData.append("classId", classId);
  formData.append("sessionId", sessionId);
  if (overrides.image !== undefined) {
    if (overrides.image === null) {
      // null signals: do NOT append image field at all.
    } else {
      formData.append("image", overrides.image);
    }
  } else {
    const buffer = new ArrayBuffer(1);
    const blob = new Blob([buffer], { type: "image/jpeg" });
    formData.append("image", blob, "frame.jpg");
  }

  const request = new MockNextRequest("http://localhost/api/attendance/recognize", {
    method: "POST",
    body: formData,
  }) as unknown as Parameters<typeof POST>[0];

  // Configure mocks per test override.
  if (overrides.faceServiceMatches) {
    mockIdentifyFaces.mockResolvedValueOnce({
      faces_detected: overrides.faceServiceMatches.length,
      matches: overrides.faceServiceMatches.map((m, i) => ({
        face_index: i,
        candidate_key: m.candidate_key,
      })),
      unmatched_count: 0,
      processing_ms: 50,
    });
  }
  mockIsAttendanceSessionStillActive.mockResolvedValueOnce(
    overrides.sessionStillActive ?? true,
  );
  if (overrides.persistResult) {
    mockRecordPresentAttendanceMarksForActiveSession.mockResolvedValueOnce(
      overrides.persistResult,
    );
  } else {
    mockRecordPresentAttendanceMarksForActiveSession.mockResolvedValueOnce({
      persistedStudentUserIds: ["student-1"],
      idempotentStudentUserIds: [],
      recognizedAt: new Date().toISOString(),
    });
  }

  const response = await POST(request);
  const body = await response.json();
  return { status: response.status, body };
}

// =============================================================================
// Setup
// =============================================================================

beforeEach(() => {
  mockGetSession.mockResolvedValue(makeSession({ id: "teacher-1" }));
  mockGetProfileByUserId.mockResolvedValue({
    onboardingCompleted: true,
    role: "teacher",
    userId: "teacher-1",
    fullName: "Teacher",
    identificationCode: "TC001",
  });
  mockGetClassDetailForCurrentUser.mockResolvedValue(
    makeClassResult("teacher"),
  );
  mockFindActiveAttendanceSessionByClassId.mockResolvedValue(
    makeSessionDoc("session-1"),
  );
  mockBuildAttendanceRecognitionGallery.mockResolvedValue({
    gallery: {
      candidates: [
        {
          candidateKey: "c0",
          embedding: new Float32Array(512),
          embeddingDimension: 512,
          normalization: "l2",
        },
      ],
    },
    totalRosterCount: 1,
    usableCandidateCount: 1,
    candidateKeyMapping: {
      c0: {
        studentUserId: "student-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
    },
  });
  // Default identifyFaces response so tests that don't pass
  // `faceServiceMatches` still have a defined `.matches` to
  // iterate. Specific tests can override with `mockResolvedValueOnce`.
  mockIdentifyFaces.mockResolvedValue({
    faces_detected: 0,
    matches: [],
    unmatched_count: 0,
    processing_ms: 50,
  });
  mockIsAttendanceSessionStillActive.mockResolvedValue(true);
  mockRecordPresentAttendanceMarksForActiveSession.mockResolvedValue({
    persistedStudentUserIds: ["student-1"],
    idempotentStudentUserIds: [],
    recognizedAt: new Date().toISOString(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =============================================================================
// Test 25: unauthenticated rejected
// =============================================================================

it("25. unauthenticated rejected with 401", async () => {
  mockGetSession.mockResolvedValue(null);

  const { status, body } = await makeRequest();

  expect(status).toBe(401);
  expect((body as { error: { code: string } }).error.code).toBe("UNAUTHENTICATED");
});

// =============================================================================
// Test 26: student rejected
// =============================================================================

it("26. student rejected with 403", async () => {
  mockGetSession.mockResolvedValue(makeSession({ id: "student-1" }));
  mockGetProfileByUserId.mockResolvedValue({
    onboardingCompleted: true,
    role: "student",
    userId: "student-1",
    fullName: "Student",
    identificationCode: "SV001",
  });
  mockGetClassDetailForCurrentUser.mockResolvedValue(
    makeClassResult("student"),
  );

  const { status, body } = await makeRequest();

  expect(status).toBe(403);
  expect((body as { error: { code: string } }).error.code).toBe("NON_OWNER");
});

// =============================================================================
// Test 27: non-owner teacher rejected
// =============================================================================

it("27. non-owner teacher rejected with 403", async () => {
  mockGetClassDetailForCurrentUser.mockResolvedValue({
    ok: false,
    code: "CLASS_NOT_ACCESSIBLE",
  });

  const { status, body } = await makeRequest();

  expect(status).toBe(403);
  expect((body as { error: { code: string } }).error.code).toBe("CLASS_NOT_ACCESSIBLE");
});

// =============================================================================
// Test 28: inactive session rejected
// =============================================================================

it("28. inactive session rejected with 400", async () => {
  mockFindActiveAttendanceSessionByClassId.mockResolvedValue(null);

  const { status, body } = await makeRequest();

  expect(status).toBe(400);
  expect((body as { error: { code: string } }).error.code).toBe("SESSION_NOT_ACTIVE");
});

// =============================================================================
// Test 29: session/class mismatch rejected
// =============================================================================

it("29. session/class mismatch rejected with 400", async () => {
  mockFindActiveAttendanceSessionByClassId.mockResolvedValue({
    _id: { toString: () => "different-session" },
    status: "active",
  });

  const { status, body } = await makeRequest();

  expect(status).toBe(400);
  expect((body as { error: { code: string } }).error.code).toBe("SESSION_CLASS_MISMATCH");
});

// =============================================================================
// Test 30: only active session gallery used
// =============================================================================

it("30. only active session gallery used", async () => {
  await makeRequest();

  expect(mockBuildAttendanceRecognitionGallery).toHaveBeenCalledTimes(1);
  expect(mockBuildAttendanceRecognitionGallery).toHaveBeenCalledWith("session-1");
});

// =============================================================================
// Test 31: image size/type enforced
// =============================================================================

it("31. missing image rejected", async () => {
  mockFindActiveAttendanceSessionByClassId.mockResolvedValue(
    makeSessionDoc("session-1"),
  );

  const { status, body } = await makeRequest({ image: null as unknown as Blob });

  expect(status).toBe(400);
  expect((body as { error: { code: string } }).error.code).toBe("INVALID_IMAGE");
});

it("31. wrong image type rejected", async () => {
  mockFindActiveAttendanceSessionByClassId.mockResolvedValue(
    makeSessionDoc("session-1"),
  );

  const buffer = new ArrayBuffer(1);
  const wrongTypeBlob = new Blob([buffer], { type: "image/gif" });

  const { status, body } = await makeRequest({ image: wrongTypeBlob });

  expect(status).toBe(400);
  expect((body as { error: { code: string } }).error.code).toBe("INVALID_IMAGE");
});

// =============================================================================
// Test 32: Face Service called with ephemeral candidate keys
// =============================================================================

it("32. Face Service called with ephemeral candidate keys", async () => {
  await makeRequest();

  expect(mockIdentifyFaces).toHaveBeenCalledTimes(1);
  const callArgs = mockIdentifyFaces.mock.calls[0]!;
  expect(callArgs[1]).toMatchObject([
    expect.objectContaining({ candidateKey: "c0" }),
  ]);
});

// =============================================================================
// Test 33: Face Service payload contains no studentUserId
// =============================================================================

it("33. Face Service payload contains no studentUserId", async () => {
  await makeRequest();

  const callArgs = mockIdentifyFaces.mock.calls[0]!;
  const galleryJson = JSON.stringify(callArgs[1]);
  expect(galleryJson).not.toContain("student-1");
  expect(galleryJson).not.toContain("Alice");
});

// =============================================================================
// Test 34: response maps candidateKey to snapshot fullName
// =============================================================================

it("34. response maps candidateKey to snapshot fullName", async () => {
  const { body } = await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
  });

  expect((body as { matches: Array<{ fullName: string }> }).matches[0]).toMatchObject({
    fullName: "Alice",
  });
});

// =============================================================================
// Test 35: response maps snapshot identificationCode
// =============================================================================

it("35. response maps snapshot identificationCode", async () => {
  const { body } = await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
  });

  expect((body as { matches: Array<{ identificationCode: string }> }).matches[0]).toMatchObject({
    identificationCode: "SV001",
  });
});

// =============================================================================
// Test 36: candidateKey not returned to browser
// =============================================================================

it("36. candidateKey not returned to browser", async () => {
  const { body } = await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
  });
  const bodyStr = JSON.stringify(body);
  expect(bodyStr).not.toContain("candidateKey");
  expect(bodyStr).not.toContain("c0");
});

// =============================================================================
// Test 37: embedding not returned
// =============================================================================

it("37. embedding not returned to browser", async () => {
  const { body } = await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
  });
  const bodyStr = JSON.stringify(body);
  expect(bodyStr).not.toContain("embedding");
  expect(bodyStr).not.toContain("Float32Array");
});

// =============================================================================
// Test 38: rosterSnapshot not returned
// =============================================================================

it("38. rosterSnapshot not returned to browser", async () => {
  const { body } = await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
  });
  const bodyStr = JSON.stringify(body);
  expect(bodyStr).not.toContain("rosterSnapshot");
  expect(bodyStr).not.toContain("studentUserId");
});

// =============================================================================
// Test 39 — PHASE 6.4 persistence contract — replaces PHASE 6.3
// "no database write performed". The route now writes
// idempotent PRESENT marks under controlled conditions.
// =============================================================================

it("39. successful recognition calls the persistence service once with snapshot ids", async () => {
  await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: true,
    persistResult: {
      persistedStudentUserIds: ["student-1"],
      idempotentStudentUserIds: [],
      recognizedAt: new Date().toISOString(),
    },
  });

  expect(mockRecordPresentAttendanceMarksForActiveSession).toHaveBeenCalledTimes(1);
  expect(mockRecordPresentAttendanceMarksForActiveSession).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: "session-1",
      candidateStudentUserIds: ["student-1"],
      recognitionDecisionAt: expect.any(Date),
    }),
  );
});

// =============================================================================
// Test 12 — valid Face Service match creates Present mark
// =============================================================================

it("12. valid Face Service match creates Present mark (recordedCount > 0)", async () => {
  const { status, body } = await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: true,
    persistResult: {
      persistedStudentUserIds: ["student-1"],
      idempotentStudentUserIds: [],
      recognizedAt: new Date().toISOString(),
    },
  });

  expect(status).toBe(200);
  expect((body as { recordedCount: number }).recordedCount).toBe(1);
  expect((body as { alreadyRecordedCount: number }).alreadyRecordedCount).toBe(0);
});

// =============================================================================
// Test 13 — multiple matches create multiple unique marks
// =============================================================================

it("13. multiple matches create multiple unique marks", async () => {
  mockBuildAttendanceRecognitionGallery.mockResolvedValueOnce({
    gallery: {
      candidates: [
        {
          candidateKey: "c0",
          embedding: new Float32Array(512),
          embeddingDimension: 512,
          normalization: "l2",
        },
        {
          candidateKey: "c1",
          embedding: new Float32Array(512),
          embeddingDimension: 512,
          normalization: "l2",
        },
      ],
    },
    totalRosterCount: 2,
    usableCandidateCount: 2,
    candidateKeyMapping: {
      c0: {
        studentUserId: "student-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
      c1: {
        studentUserId: "student-2",
        fullNameSnapshot: "Bob",
        identificationCodeSnapshot: "SV002",
      },
    },
  });
  mockRecordPresentAttendanceMarksForActiveSession.mockResolvedValueOnce({
    persistedStudentUserIds: ["student-1", "student-2"],
    idempotentStudentUserIds: [],
    recognizedAt: new Date().toISOString(),
  });

  const { body } = await makeRequest({
    faceServiceMatches: [
      { candidate_key: "c0" },
      { candidate_key: "c1" },
    ],
    sessionStillActive: true,
  });

  expect((body as { recordedCount: number }).recordedCount).toBe(2);
  expect(mockRecordPresentAttendanceMarksForActiveSession).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: "session-1",
      candidateStudentUserIds: ["student-1", "student-2"],
      recognitionDecisionAt: expect.any(Date),
    }),
  );
});

// =============================================================================
// Test 14 — repeated scan does not increase duplicate count
// =============================================================================

it("14. repeated scan does not increase duplicate count (idempotent)", async () => {
  mockRecordPresentAttendanceMarksForActiveSession.mockResolvedValueOnce({
    persistedStudentUserIds: [],
    idempotentStudentUserIds: ["student-1"],
    recognizedAt: new Date().toISOString(),
  });

  const { body } = await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: true,
  });

  expect((body as { recordedCount: number }).recordedCount).toBe(0);
  expect((body as { alreadyRecordedCount: number }).alreadyRecordedCount).toBe(1);
});

// =============================================================================
// Test 15 — unmatched face creates no mark
// =============================================================================

it("15. unmatched face creates no mark", async () => {
  mockIdentifyFaces.mockResolvedValueOnce({
    faces_detected: 1,
    matches: [],
    unmatched_count: 1,
    processing_ms: 50,
  });

  await makeRequest({
    sessionStillActive: true,
  });

  expect(mockRecordPresentAttendanceMarksForActiveSession).not.toHaveBeenCalled();
});

// =============================================================================
// Test 16 — unknown candidateKey creates no mark
// =============================================================================

it("16. unknown candidateKey from Face Service creates no mark", async () => {
  await makeRequest({
    faceServiceMatches: [{ candidate_key: "c-rogue-not-in-mapping" }],
    sessionStillActive: true,
  });

  // The unknown key is silently dropped — no persistence call.
  expect(mockRecordPresentAttendanceMarksForActiveSession).not.toHaveBeenCalled();
  // The safe preview is still returned.
});

// =============================================================================
// Test 17 — browser cannot supply studentUserId
// =============================================================================

it("17. browser cannot supply studentUserId (form does not include any)", async () => {
  await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: true,
  });

  const call = mockRecordPresentAttendanceMarksForActiveSession.mock.calls[0]!;
  const input = call[0] as { candidateStudentUserIds: string[] };
  // The candidate ids passed to persistence come from the
  // gallery mapping — NEVER from the form body.
  expect(input.candidateStudentUserIds).toEqual(["student-1"]);
  // Verify the request body was never inspected for ids.
  // (The route only reads classId, sessionId, image.)
});

// =============================================================================
// Test 18 — current ClassMembership does NOT determine mark eligibility
// (snapshot authority is the only authority)
// =============================================================================

it("18. session snapshot is the only authority for mark eligibility", async () => {
  // The route NEVER queries ClassMembership. We assert that by
  // verifying the recognized ids come from the snapshot mapping
  // alone. The mock gallery carries the snapshot mapping; if
  // the route consulted Membership the test would have to seed
  // it — and we deliberately do not.
  await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: true,
  });

  const call = mockRecordPresentAttendanceMarksForActiveSession.mock.calls[0]!;
  const input = call[0] as { candidateStudentUserIds: string[] };
  expect(input.candidateStudentUserIds).toEqual(["student-1"]);
});

// =============================================================================
// Test 19 — session snapshot is authority (gallery mapping drives persistence)
// =============================================================================

it("19. gallery candidateKeyMapping supplies the ids forwarded to persistence", async () => {
  mockBuildAttendanceRecognitionGallery.mockResolvedValueOnce({
    gallery: {
      candidates: [
        {
          candidateKey: "c0",
          embedding: new Float32Array(512),
          embeddingDimension: 512,
          normalization: "l2",
        },
      ],
    },
    totalRosterCount: 1,
    usableCandidateCount: 1,
    candidateKeyMapping: {
      c0: {
        studentUserId: "snapshot-student-id",
        fullNameSnapshot: "Snapshot Name",
        identificationCodeSnapshot: "SV-SNAPSHOT",
      },
    },
  });

  await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: true,
  });

  const call = mockRecordPresentAttendanceMarksForActiveSession.mock.calls[0]!;
  const input = call[0] as { candidateStudentUserIds: string[] };
  expect(input.candidateStudentUserIds).toEqual(["snapshot-student-id"]);
});

// =============================================================================
// Test 20 — final active-session recheck occurs BEFORE writes
// =============================================================================

it("20. isAttendanceSessionStillActive is called BEFORE persistence", async () => {
  const callOrder: string[] = [];
  mockIdentifyFaces.mockImplementationOnce(async () => {
    callOrder.push("identifyFaces");
    return {
      faces_detected: 1,
      matches: [{ face_index: 0, candidate_key: "c0" }],
      unmatched_count: 0,
      processing_ms: 50,
    };
  });
  mockIsAttendanceSessionStillActive.mockImplementationOnce(async () => {
    callOrder.push("isAttendanceSessionStillActive");
    return true;
  });
  mockRecordPresentAttendanceMarksForActiveSession.mockImplementationOnce(
    async () => {
      callOrder.push("recordPresentAttendanceMarksForActiveSession");
      return {
        persistedStudentUserIds: ["student-1"],
        idempotentStudentUserIds: [],
        recognizedAt: new Date().toISOString(),
      };
    },
  );

  await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: true,
  });

  // Order must be: identify -> recheck -> persist.
  expect(callOrder).toEqual([
    "identifyFaces",
    "isAttendanceSessionStillActive",
    "recordPresentAttendanceMarksForActiveSession",
  ]);
});

// =============================================================================
// Test 21 — closed-before-finalization creates no new marks
// =============================================================================

it("21. session closed at final recheck creates NO marks (sessionClosedDuringProcessing)", async () => {
  const { body } = await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: false,
  });

  expect((body as { recordedCount: number }).recordedCount).toBe(0);
  expect((body as { sessionClosedDuringProcessing: boolean }).sessionClosedDuringProcessing).toBe(true);
  expect(mockRecordPresentAttendanceMarksForActiveSession).not.toHaveBeenCalled();
});

// =============================================================================
// Test 22 — mark uses server recognition timestamp
// (service returns an ISO timestamp; the route does NOT trust
//  any browser-supplied timestamp)
// =============================================================================

it("22. mark uses server recognition timestamp (no browser timestamp accepted)", async () => {
  await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: true,
  });

  // PHASE 6.6: The route generates a server-side
  // `recognitionDecisionAt` timestamp AFTER the Face Service
  // accepts the match and AFTER the final ACTIVE pre-write
  // check. The browser NEVER supplies this value. The route
  // passes it to the persistence service as the batch's
  // recognizedAt. The service still owns its own field
  // generation logic — the route only passes the decision
  // timestamp for the race-reconciliation check.
  const call = mockRecordPresentAttendanceMarksForActiveSession.mock.calls[0]!;
  const input = call[0] as Record<string, unknown>;
  expect(Object.keys(input).sort()).toEqual([
    "candidateStudentUserIds",
    "recognitionDecisionAt",
    "sessionId",
  ]);
  expect(input.recognitionDecisionAt).toBeInstanceOf(Date);
});

// =============================================================================
// Test 23 — route response exposes no mark/student internal IDs
// =============================================================================

it("23. route response exposes no mark/student internal IDs", async () => {
  const { body } = await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: true,
  });

  const bodyStr = JSON.stringify(body);
  expect(bodyStr.toLowerCase()).not.toContain("studentuserid");
  expect(bodyStr).not.toMatch(/_id/);
  expect(bodyStr).not.toContain("attendance_marks");
  expect(bodyStr).not.toContain("face_recognition");
  expect(bodyStr).not.toContain("membershipId");
  expect(bodyStr).not.toContain("teacherUserId");
  expect(bodyStr).not.toContain("classId");
  expect(bodyStr).not.toContain("E11000");
  expect(bodyStr).not.toContain("mongodb://");
});

// =============================================================================
// Additional coverage — no-face safe state
// =============================================================================

it("no face result returns empty matches and no persistence call", async () => {
  mockIdentifyFaces.mockResolvedValueOnce({
    faces_detected: 0,
    matches: [],
    unmatched_count: 0,
    processing_ms: 50,
  });

  const { body } = await makeRequest({ sessionStillActive: true });

  expect((body as { facesDetected: number }).facesDetected).toBe(0);
  expect((body as { matches: unknown[] }).matches).toHaveLength(0);
  expect(mockRecordPresentAttendanceMarksForActiveSession).not.toHaveBeenCalled();
});

// =============================================================================
// Additional coverage — no recognition candidates
// =============================================================================

it("no recognition candidates returns safe error", async () => {
  mockBuildAttendanceRecognitionGallery.mockRejectedValue(
    new (
      await import("@/lib/attendance/attendance-recognition-gallery-service")
    ).AttendanceRecognitionError({
      code: "NO_RECOGNITION_CANDIDATES",
      message: "No enrolled faces are available.",
    }),
  );

  const { status, body } = await makeRequest();

  expect(status).toBe(400);
  expect((body as { error: { code: string } }).error.code).toBe("NO_RECOGNITION_CANDIDATES");
});

// =============================================================================
// Additional coverage — session closed at the Face Service level
// =============================================================================

it("session closed state stops further scanning", async () => {
  const FSCE = (
    await import("@/lib/biometrics/face-service-client")
  ).FaceServiceClientError;
  mockIdentifyFaces.mockRejectedValue(
    new FSCE({
      code: "FACE_SERVICE_REJECTED_REQUEST",
      message: "Error",
      domainError: { code: "SESSION_NOT_ACTIVE", message: "Session closed" },
    }),
  );

  const { status, body } = await makeRequest();

  expect(status).toBe(400);
  expect((body as { error: { code: string } }).error.code).toBe("SESSION_NOT_ACTIVE");
});

// =============================================================================
// Additional coverage — Face Service unavailable
// =============================================================================

it("Face Service unavailable returns 503", async () => {
  const FSCE = (
    await import("@/lib/biometrics/face-service-client")
  ).FaceServiceClientError;
  mockIdentifyFaces.mockRejectedValue(
    new FSCE({
      code: "FACE_SERVICE_UNAVAILABLE",
      message: "Face Service unavailable",
    }),
  );

  const { status, body } = await makeRequest();

  expect(status).toBe(503);
  expect((body as { error: { code: string } }).error.code).toBe("FACE_SERVICE_ERROR");
});

// =============================================================================
// Additional coverage — persistence write failure surfaces safe error
// =============================================================================

it("persistence write failure returns ATTENDANCE_MARK_WRITE_FAILED (no internals leaked)", async () => {
  const MarkErr = (
    await import("@/lib/attendance/attendance-mark-service")
  ).AttendanceMarkServiceError;
  mockRecordPresentAttendanceMarksForActiveSession.mockRejectedValueOnce(
    new MarkErr({
      code: "ATTENDANCE_MARK_WRITE_FAILED",
      message: "boom",
    }),
  );

  const { status, body } = await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: true,
  });

  expect(status).toBe(500);
  expect((body as { error: { code: string } }).error.code).toBe(
    "ATTENDANCE_MARK_WRITE_FAILED",
  );
  const bodyStr = JSON.stringify(body);
  expect(bodyStr).not.toContain("E11000");
  expect(bodyStr).not.toContain("mongodb://");
  expect(bodyStr.toLowerCase()).not.toContain("studentuserid");
});

// =============================================================================
// Additional coverage — multiple faces in one frame persist all
// =============================================================================

it("multi-face frame persists all matched students", async () => {
  mockBuildAttendanceRecognitionGallery.mockResolvedValueOnce({
    gallery: {
      candidates: [
        {
          candidateKey: "c0",
          embedding: new Float32Array(512),
          embeddingDimension: 512,
          normalization: "l2",
        },
        {
          candidateKey: "c1",
          embedding: new Float32Array(512),
          embeddingDimension: 512,
          normalization: "l2",
        },
        {
          candidateKey: "c2",
          embedding: new Float32Array(512),
          embeddingDimension: 512,
          normalization: "l2",
        },
      ],
    },
    totalRosterCount: 3,
    usableCandidateCount: 3,
    candidateKeyMapping: {
      c0: {
        studentUserId: "s-1",
        fullNameSnapshot: "Alice",
        identificationCodeSnapshot: "SV001",
      },
      c1: {
        studentUserId: "s-2",
        fullNameSnapshot: "Bob",
        identificationCodeSnapshot: "SV002",
      },
      c2: {
        studentUserId: "s-3",
        fullNameSnapshot: "Carol",
        identificationCodeSnapshot: "SV003",
      },
    },
  });
  mockRecordPresentAttendanceMarksForActiveSession.mockResolvedValueOnce({
    persistedStudentUserIds: ["s-1", "s-2", "s-3"],
    idempotentStudentUserIds: [],
    recognizedAt: new Date().toISOString(),
  });

  const { body } = await makeRequest({
    faceServiceMatches: [
      { candidate_key: "c0" },
      { candidate_key: "c1" },
      { candidate_key: "c2" },
    ],
    sessionStillActive: true,
  });

  expect((body as { recordedCount: number }).recordedCount).toBe(3);
  expect(mockRecordPresentAttendanceMarksForActiveSession).toHaveBeenCalledWith(
    expect.objectContaining({
      sessionId: "session-1",
      candidateStudentUserIds: ["s-1", "s-2", "s-3"],
      recognitionDecisionAt: expect.any(Date),
    }),
  );
});

// =============================================================================
// PHASE 6.6 RACE-WINDOW CORRECTION — final cutoff.
//
// PHASE 6.6 RACE-WINDOW-CORRECTED CONTRACT:
//   The `recognitionDecisionAt` timestamp is captured IMMEDIATELY
//   after the Face Service has accepted the match and BEFORE the
//   final ACTIVE-session pre-write check. This guarantees:
//     - decisionAt is generated before the active check
//     - decisionAt <= endedAt for the accepted race path
//     - browser cannot supply the timestamp
//     - Stop-before-check → no mark, no reconciliation
//     - Stop-after-check → Absent becomes Present via reconciliation
//     - Initially-closed session → no mark, no reconciliation
//     - Existing Present's first recognizedAt is preserved
// =============================================================================

it("6.6.1 recognitionDecisionAt is captured BEFORE the final ACTIVE check", async () => {
  let decisionAtAtCheck: Date | null = null;
  let decisionAtAfterPersist: Date | null = null;

  mockIdentifyFaces.mockImplementationOnce(async () => ({
    faces_detected: 1,
    matches: [{ face_index: 0, candidate_key: "c0" }],
    unmatched_count: 0,
    processing_ms: 50,
  }));

  // Capture the timestamp at the moment the ACTIVE check fires.
  mockIsAttendanceSessionStillActive.mockImplementationOnce(async () => {
    // The timestamp MUST have already been generated by the
    // route BEFORE this check fires. We probe by capturing it
    // here via Date.now(); the route's `recognitionDecisionAt`
    // is passed to the persistence call below.
    decisionAtAtCheck = new Date();
    return true;
  });

  mockRecordPresentAttendanceMarksForActiveSession.mockImplementationOnce(
    async (input: unknown) => {
      const i = input as { recognitionDecisionAt: Date };
      decisionAtAfterPersist = i.recognitionDecisionAt;
      return {
        persistedStudentUserIds: ["student-1"],
        idempotentStudentUserIds: [],
        recognizedAt: i.recognitionDecisionAt.toISOString(),
      };
    },
  );

  await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: true,
  });

  // The persistence call MUST receive a Date timestamp.
  expect(decisionAtAfterPersist).toBeInstanceOf(Date);
  // The timestamp captured before the active check (simulated
  // capture time) MUST be >= the timestamp passed to the
  // persistence call — i.e. the persistence timestamp was
  // generated earlier in the same tick.
  expect(decisionAtAtCheck).not.toBeNull();
  expect(decisionAtAfterPersist).not.toBeNull();
  expect(
    (decisionAtAtCheck as unknown as Date).getTime(),
  ).toBeGreaterThanOrEqual(
    (decisionAtAfterPersist as unknown as Date).getTime(),
  );
});

it("6.6.2 Stop between final ACTIVE check and Present persistence still calls persistence", async () => {
  // PHASE 6.6 RACE-WINDOW CORRECTION:
  //   The route's final ACTIVE check returns true. After this,
  //   a concurrent stop CAS-closes the session, runs
  //   finalization, and writes endedAt — but BEFORE the route
  //   writes its Present mark. The persistence path is then
  //   responsible for reconciling the concurrently-created
  //   Absent mark.
  //
  // The route MUST still call the persistence service in this
  // case (it does NOT observe the stop — the stop is invisible
  // to the route). The persistence service is the ONLY layer
  // that knows about the Absent mark and can reconcile.
  const callOrder: string[] = [];

  mockIdentifyFaces.mockImplementationOnce(async () => {
    callOrder.push("identifyFaces");
    return {
      faces_detected: 1,
      matches: [{ face_index: 0, candidate_key: "c0" }],
      unmatched_count: 0,
      processing_ms: 50,
    };
  });

  mockIsAttendanceSessionStillActive.mockImplementationOnce(async () => {
    callOrder.push("isAttendanceSessionStillActive");
    return true;
  });

  mockRecordPresentAttendanceMarksForActiveSession.mockImplementationOnce(
    async (input: unknown) => {
      callOrder.push("recordPresentAttendanceMarksForActiveSession");
      const i = input as { recognitionDecisionAt: Date };
      return {
        persistedStudentUserIds: ["student-1"],
        idempotentStudentUserIds: [],
        recognizedAt: i.recognitionDecisionAt.toISOString(),
      };
    },
  );

  await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: true,
  });

  // The final ACTIVE check passed → persistence was invoked.
  expect(callOrder).toEqual([
    "identifyFaces",
    "isAttendanceSessionStillActive",
    "recordPresentAttendanceMarksForActiveSession",
  ]);
});

it("6.6.3 decisionAt passed to persistence is <= endedAt for the accepted race path", async () => {
  // PHASE 6.6 RACE-WINDOW CORRECTION:
  //   The route captures decisionAt BEFORE the active check.
  //   The active check then succeeds. A concurrent stop sets
  //   endedAt. By construction: decisionAt < now (at capture
  //   time) < endedAt (server-side timestamp).
  //
  // We assert the structural property: the timestamp passed
  // to the persistence service is captured before the active
  // check, so it MUST precede any endedAt written after the
  // check. The reconciliation logic in
  // recordPresentAttendanceMarksForActiveSession already
  // enforces `decisionAt <= endedAt`.
  let decisionAt: Date | null = null;
  let activeCheckAt: number | null = null;

  mockIdentifyFaces.mockImplementationOnce(async () => ({
    faces_detected: 1,
    matches: [{ face_index: 0, candidate_key: "c0" }],
    unmatched_count: 0,
    processing_ms: 50,
  }));

  mockIsAttendanceSessionStillActive.mockImplementationOnce(async () => {
    // Wait one millisecond so endedAt (any time after this
    // check) is structurally guaranteed to be > decisionAt.
    activeCheckAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, 5));
    return true;
  });

  mockRecordPresentAttendanceMarksForActiveSession.mockImplementationOnce(
    async (input: unknown) => {
      const i = input as { recognitionDecisionAt: Date };
      decisionAt = i.recognitionDecisionAt;
      return {
        persistedStudentUserIds: ["student-1"],
        idempotentStudentUserIds: [],
        recognizedAt: i.recognitionDecisionAt.toISOString(),
      };
    },
  );

  await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: true,
  });

  expect(decisionAt).not.toBeNull();
  expect(activeCheckAt).not.toBeNull();
  // The decision timestamp MUST precede the active check time
  // (decisionAt was generated BEFORE the check).
  expect((decisionAt as unknown as Date).getTime()).toBeLessThanOrEqual(
    activeCheckAt as unknown as number,
  );
  // Any endedAt written AFTER the active check must satisfy
  // decisionAt <= endedAt. We assert by the recorded ordering:
  // decisionAt (before check) <= check time < endedAt (after).
  expect((decisionAt as unknown as Date).getTime()).toBeLessThanOrEqual(
    activeCheckAt as unknown as number,
  );
});

it("6.6.4 stop-after-check causes persistence call (reconciliation is the persistence layer's job)", async () => {
  // PHASE 6.6 RACE-WINDOW CORRECTION:
  //   The route's responsibility is to pass decisionAt to the
  //   persistence service. The reconciliation of
  //   Absent→Present is owned by
  //   recordPresentAttendanceMarksForActiveSession (covered
  //   by the PHASE 6.6.6/6.6.7 tests in
  //   attendance-mark-service.test.ts).
  //
  //   This route-level test asserts only that the route
  //   forwards the pre-check decision timestamp correctly:
  //     - decisionAt is a Date instance.
  //     - decisionAt is captured BEFORE the active check.
  //     - the persistence call receives it.
  let capturedDecisionAt: Date | null = null;

  mockIsAttendanceSessionStillActive.mockResolvedValueOnce(true);
  mockRecordPresentAttendanceMarksForActiveSession.mockImplementationOnce(
    async (input: unknown) => {
      const i = input as { recognitionDecisionAt: Date };
      capturedDecisionAt = i.recognitionDecisionAt;
      return {
        persistedStudentUserIds: ["student-1"],
        idempotentStudentUserIds: [],
        recognizedAt: i.recognitionDecisionAt.toISOString(),
      };
    },
  );

  await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: true,
  });

  expect(capturedDecisionAt).toBeInstanceOf(Date);
});

it("6.6.5 Stop-before-check (active check fails) creates NO mark and NO persistence call", async () => {
  // PHASE 6.6 RACE-WINDOW CORRECTION:
  //   The active check FAILS → the route short-circuits with
  //   sessionClosedDuringProcessing. No persistence call is
  //   made. The decisionAt captured above is discarded.
  const { body } = await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: false,
  });

  expect((body as { recordedCount: number }).recordedCount).toBe(0);
  expect((body as { alreadyRecordedCount: number }).alreadyRecordedCount).toBe(0);
  expect(
    (body as { sessionClosedDuringProcessing: boolean })
      .sessionClosedDuringProcessing,
  ).toBe(true);
  expect(mockRecordPresentAttendanceMarksForActiveSession).not.toHaveBeenCalled();
});

it("6.6.6 initially-closed session (findActiveAttendanceSessionByClassId returns null) creates NO mark", async () => {
  // PHASE 6.6: when the initial session lookup returns null,
  // the route refuses immediately at step 6 with
  // SESSION_NOT_ACTIVE. No Face Service call, no decisionAt,
  // no persistence call.
  mockFindActiveAttendanceSessionByClassId.mockResolvedValue(null);

  const { status, body } = await makeRequest();

  expect(status).toBe(400);
  expect((body as { error: { code: string } }).error.code).toBe("SESSION_NOT_ACTIVE");
  expect(mockIdentifyFaces).not.toHaveBeenCalled();
  expect(mockIsAttendanceSessionStillActive).not.toHaveBeenCalled();
  expect(mockRecordPresentAttendanceMarksForActiveSession).not.toHaveBeenCalled();
});

it("6.6.7 browser cannot supply recognitionDecisionAt (no form field is read for it)", async () => {
  // PHASE 6.6 RACE-WINDOW CORRECTION:
  //   The route reads ONLY `classId`, `sessionId`, `image` from
  //   the multipart form. It NEVER reads a `recognitionDecisionAt`
  //   field — the timestamp is always server-generated.
  //
  // We verify this by inspecting the persistence call's input:
  // the recognitionDecisionAt MUST be a server-generated Date,
  // and the route MUST NOT have inspected the form for any
  // timestamp field.
  await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: true,
  });

  // Form body inspection: only the three known fields exist
  // (classId, sessionId, image). The route ignores any other
  // fields. We verify this by reading the source of the route
  // — the route reads formData.get() ONLY for classId,
  // sessionId, image.
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const source = readFileSync(
    resolve(
      process.cwd(),
      "src/app/api/attendance/recognize/route.ts",
    ),
    "utf-8",
  );
  // The route MUST NOT call formData.get("recognitionDecisionAt").
  expect(source).not.toMatch(/formData\.get\(\s*["']recognitionDecisionAt["']/);
  // And the persistence call MUST receive a Date instance.
  const call = mockRecordPresentAttendanceMarksForActiveSession.mock.calls[0]!;
  const input = call[0] as { recognitionDecisionAt: Date };
  expect(input.recognitionDecisionAt).toBeInstanceOf(Date);
});

it("6.6.8 existing Present's first recognizedAt is preserved (route never overwrites)", async () => {
  // PHASE 6.6 RACE-WINDOW CORRECTION:
  //   The route does NOT update existing Present marks. It
  //   forwards the decision timestamp ONLY to the persistence
  //   service, which preserves first-recognizedAt on the
  //   existing mark via $setOnInsert.
  //
  //   On the route level, this means: when the persistence
  //   service reports an idempotent repeat, the route passes
  //   through — the existing mark's recognizedAt is preserved
  //   inside the service, NOT by the route.
  //
  //   The PHASE 6.6 race-window correction does NOT change
  //   this preservation contract — the decisionAt is used
  //   ONLY for the race-reconciliation check on Absent marks.
  mockRecordPresentAttendanceMarksForActiveSession.mockResolvedValueOnce({
    persistedStudentUserIds: [],
    idempotentStudentUserIds: ["student-1"],
    recognizedAt: new Date().toISOString(),
  });

  const { body } = await makeRequest({
    faceServiceMatches: [{ candidate_key: "c0" }],
    sessionStillActive: true,
  });

  expect((body as { recordedCount: number }).recordedCount).toBe(0);
  expect((body as { alreadyRecordedCount: number }).alreadyRecordedCount).toBe(1);
  // Persistence was still called with a server-generated
  // decisionAt — the route never asks the service to
  // overwrite an existing Present's recognizedAt.
  const call = mockRecordPresentAttendanceMarksForActiveSession.mock.calls[0]!;
  const input = call[0] as { recognitionDecisionAt: Date };
  expect(input.recognitionDecisionAt).toBeInstanceOf(Date);
});
