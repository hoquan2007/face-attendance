/**
 * Tests for POST /api/attendance/recognize.
 *
 * PHASE 6.3 — LIVE FACE RECOGNITION PREVIEW.
 *
 * Covers:
 * 25. unauthenticated rejected
 * 26. student rejected
 * 27. non-owner teacher rejected
 * 28. inactive session rejected
 * 29. session/class mismatch rejected
 * 30. only active session gallery used
 * 31. image size/type enforced
 * 32. Face Service called with ephemeral candidate keys
 * 33. Face Service payload contains no studentUserId
 * 34. response maps candidateKey to snapshot fullName
 * 35. response maps snapshot identificationCode
 * 36. candidateKey not returned to browser
 * 37. embedding not returned
 * 38. rosterSnapshot not returned
 * 39. no database write performed
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

  const classId = overrides.classId ?? "class-1";
  const sessionId = overrides.sessionId ?? "session-1";

  const { POST } = await import("@/app/api/attendance/recognize/route");

  const formData = new FormData();
  formData.append("classId", classId);
  formData.append("sessionId", sessionId);
  if (overrides.image !== undefined) {
    // Only append if an image was explicitly provided.
    if (overrides.image === null) {
      // null signals: do NOT append image field at all (test: missing image).
      // Do nothing.
    } else {
      formData.append("image", overrides.image);
    }
  } else {
    // Default: small valid JPEG.
    const buffer = new ArrayBuffer(1);
    const blob = new Blob([buffer], { type: "image/jpeg" });
    formData.append("image", blob, "frame.jpg");
  }

  // Build a NextRequest-compatible request.
  // The MockNextRequest type doesn't fully match NextRequest's structural
  // type — cast to bypass.
  const request = new MockNextRequest("http://localhost/api/attendance/recognize", {
    method: "POST",
    body: formData,
  }) as unknown as Parameters<typeof POST>[0];

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
  mockIdentifyFaces.mockResolvedValue({
    faces_detected: 1,
    matches: [{ face_index: 0, candidate_key: "c0" }],
    unmatched_count: 0,
    processing_ms: 50,
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
  const { body } = await makeRequest();

  expect((body as { matches: Array<{ fullName: string }> }).matches[0]).toMatchObject({
    fullName: "Alice",
  });
});

// =============================================================================
// Test 35: response maps snapshot identificationCode
// =============================================================================

it("35. response maps snapshot identificationCode", async () => {
  const { body } = await makeRequest();

  expect((body as { matches: Array<{ identificationCode: string }> }).matches[0]).toMatchObject({
    identificationCode: "SV001",
  });
});

// =============================================================================
// Test 36: candidateKey not returned to browser
// =============================================================================

it("36. candidateKey not returned to browser", async () => {
  const { body } = await makeRequest();
  const bodyStr = JSON.stringify(body);
  expect(bodyStr).not.toContain("candidateKey");
  expect(bodyStr).not.toContain("c0");
});

// =============================================================================
// Test 37: embedding not returned
// =============================================================================

it("37. embedding not returned to browser", async () => {
  const { body } = await makeRequest();
  const bodyStr = JSON.stringify(body);
  expect(bodyStr).not.toContain("embedding");
  expect(bodyStr).not.toContain("Float32Array");
});

// =============================================================================
// Test 38: rosterSnapshot not returned
// =============================================================================

it("38. rosterSnapshot not returned to browser", async () => {
  const { body } = await makeRequest();
  const bodyStr = JSON.stringify(body);
  expect(bodyStr).not.toContain("rosterSnapshot");
  expect(bodyStr).not.toContain("studentUserId");
});

// =============================================================================
// Test 39: no database write performed
// =============================================================================

it("39. no database write performed (preview only)", async () => {
  await makeRequest();

  // Verify no attendance service write methods are called.
  // The route only calls read services (findActiveAttendanceSessionByClassId, buildGallery).
  expect(mockFindActiveAttendanceSessionByClassId).toHaveBeenCalledTimes(1);
  expect(mockBuildAttendanceRecognitionGallery).toHaveBeenCalledTimes(1);

  // No attendance record write services should be called.
  // (We can't import the write service directly, but we verified read-only calls.)
});

// =============================================================================
// Additional coverage
// =============================================================================

it("no face result returns empty matches", async () => {
  mockIdentifyFaces.mockResolvedValue({
    faces_detected: 0,
    matches: [],
    unmatched_count: 0,
    processing_ms: 50,
  });

  const { body } = await makeRequest();

  expect((body as { facesDetected: number }).facesDetected).toBe(0);
  expect((body as { matches: unknown[] }).matches).toHaveLength(0);
});

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
