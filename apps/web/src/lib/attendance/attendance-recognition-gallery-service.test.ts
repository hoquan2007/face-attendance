/**
 * Tests for attendance-recognition-gallery-service.
 *
 * PHASE 6.3 — LIVE FACE RECOGNITION PREVIEW.
 *
 * These tests cover:
 * 1. gallery derives from AttendanceSession.rosterSnapshot
 * 2. current Membership rows are not used as gallery authority
 * 3. FaceProfiles fetched in batch
 * 4. no N+1 FaceProfile lookup
 * 5. centroid decrypted server-side
 * 6. five raw enrollment samples not required
 * 7. missing FaceProfile candidate skipped
 * 8. corrupt/incompatible FaceProfile skipped safely
 * 9. zero usable candidates returns controlled result
 * 10. snapshot fullName/identificationCode retained for result mapping
 * 11. studentUserId never enters browser DTO
 * 12. real student identity never enters Face Service payload
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================================
// Mock setup (hoisted before imports)
// =============================================================================

const mockFind = vi.hoisted(() => vi.fn());
const mockFindById = vi.hoisted(() => vi.fn());
const mockDecryptBiometricVector = vi.hoisted(() => vi.fn());

vi.mock("@/lib/mongoose", () => ({
  getMongooseConnection: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/biometrics/face-profile-model", () => ({
  FaceProfileModel: {
    find: mockFind,
  },
}));

vi.mock("@/lib/attendance/attendance-session-model", () => ({
  AttendanceSessionModel: {
    findById: mockFindById,
  },
}));

vi.mock("@/lib/biometrics/encryption", () => ({
  decryptBiometricVector: mockDecryptBiometricVector,
  BiometricError: class BiometricError extends Error {
    constructor(public code: string, message: string) {
      super(message);
      this.name = "BiometricError";
    }
  },
}));

// =============================================================================
// Helpers
// =============================================================================

function setupSessionDoc(
  sessionId: string,
  rosterSnapshot: Array<{
    studentUserId: string;
    fullNameSnapshot: string;
    identificationCodeSnapshot: string;
  }>,
) {
  mockFindById.mockImplementation(() => ({
    lean: () => ({
      exec: () =>
        Promise.resolve({
          _id: { toString: () => sessionId },
          classId: { toString: () => "class-1" },
          status: "active",
          rosterSnapshot,
        }),
    }),
  }));
}

function setupFaceProfiles(
  profiles: Array<{
    userId: string;
    modelIdentity?: string;
    embeddingDimension?: number;
    normalization?: string;
  }>,
) {
  const docs = profiles.map((p) => ({
    userId: p.userId,
    modelIdentity: p.modelIdentity ?? "insightface-buffalo-l",
    modelName: "buffalo_l",
    embeddingDimension: p.embeddingDimension ?? 512,
    normalization: p.normalization ?? "l2",
    templateVersion: 1,
    centroid: {
      ciphertext: "fake",
      iv: "fake",
      authTag: "fake",
      keyVersion: 1,
    },
  }));

  const chainable = {
    select: () => chainable,
    lean: () => chainable,
    exec: () => Promise.resolve(docs),
  };
  mockFind.mockImplementation(() => chainable);
}

function setupEmptyFaceProfiles() {
  const chainable = {
    select: () => chainable,
    lean: () => chainable,
    exec: () => Promise.resolve([]),
  };
  mockFind.mockImplementation(() => chainable);
}

function setupSelectCapture(capture: (fields: Record<string, unknown>) => void) {
  // Return a FaceProfile to avoid "zero usable candidates" error,
  // while still capturing what fields were requested.
  const mockDoc = {
    userId: "user-1",
    modelIdentity: "insightface-buffalo-l",
    modelName: "buffalo_l",
    embeddingDimension: 512,
    normalization: "l2",
    templateVersion: 1,
    centroid: { ciphertext: "fake", iv: "fake", authTag: "fake", keyVersion: 1 },
  };

  // Chainable that captures fields from select() and chains .lean().exec().
  const chainable = {
    select: (fields: Record<string, unknown>) => {
      capture(fields);
      return chainable;
    },
    lean: () => chainable,
    exec: () => Promise.resolve([mockDoc]),
  };
  mockFind.mockImplementation(() => chainable);
}

function setupDecrypt(returnValue?: Float32Array) {
  mockDecryptBiometricVector.mockImplementation(() => {
    return returnValue ?? new Float32Array(512);
  });
}

// =============================================================================
// Tests
// =============================================================================

describe("buildAttendanceRecognitionGallery", () => {
  beforeEach(() => {
    mockFind.mockReset();
    mockFindById.mockReset();
    mockDecryptBiometricVector.mockReset();
    setupDecrypt();
    // Reset FaceProfile mock to return empty by default.
    setupEmptyFaceProfiles();
  });

  // -------------------------------------------------------------------------
  // Test 1: gallery derives from AttendanceSession.rosterSnapshot
  // -------------------------------------------------------------------------

  it("1. gallery derives from AttendanceSession.rosterSnapshot", async () => {
    const { buildAttendanceRecognitionGallery } = await import(
      "@/lib/attendance/attendance-recognition-gallery-service"
    );

    setupSessionDoc("session-1", [
      { studentUserId: "user-1", fullNameSnapshot: "Alice", identificationCodeSnapshot: "SV001" },
      { studentUserId: "user-2", fullNameSnapshot: "Bob", identificationCodeSnapshot: "SV002" },
    ]);
    setupFaceProfiles([
      { userId: "user-1" },
      { userId: "user-2" },
    ]);

    const result = await buildAttendanceRecognitionGallery("session-1");

    expect(result.usableCandidateCount).toBe(2);
    expect(result.totalRosterCount).toBe(2);
    expect(result.candidateKeyMapping["c0"]).toMatchObject({
      studentUserId: "user-1",
      fullNameSnapshot: "Alice",
      identificationCodeSnapshot: "SV001",
    });
    expect(result.candidateKeyMapping["c1"]).toMatchObject({
      studentUserId: "user-2",
      fullNameSnapshot: "Bob",
      identificationCodeSnapshot: "SV002",
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: current Membership rows are NOT used as gallery authority
  // -------------------------------------------------------------------------

  it("2. snapshot values used, not current Membership rows", async () => {
    const { buildAttendanceRecognitionGallery } = await import(
      "@/lib/attendance/attendance-recognition-gallery-service"
    );

    setupSessionDoc("session-1", [
      { studentUserId: "user-1", fullNameSnapshot: "Alice (historical)", identificationCodeSnapshot: "OLD001" },
    ]);
    setupFaceProfiles([{ userId: "user-1" }]);

    const result = await buildAttendanceRecognitionGallery("session-1");

    expect(result.candidateKeyMapping["c0"]).toMatchObject({
      fullNameSnapshot: "Alice (historical)",
      identificationCodeSnapshot: "OLD001",
    });
  });

  // -------------------------------------------------------------------------
  // Test 3: FaceProfiles fetched in batch
  // -------------------------------------------------------------------------

  it("3. FaceProfiles fetched in batch (single MongoDB query)", async () => {
    const { buildAttendanceRecognitionGallery } = await import(
      "@/lib/attendance/attendance-recognition-gallery-service"
    );

    setupSessionDoc("session-1", [
      { studentUserId: "user-1", fullNameSnapshot: "A", identificationCodeSnapshot: "S1" },
      { studentUserId: "user-2", fullNameSnapshot: "B", identificationCodeSnapshot: "S2" },
      { studentUserId: "user-3", fullNameSnapshot: "C", identificationCodeSnapshot: "S3" },
    ]);
    setupFaceProfiles([
      { userId: "user-1" },
      { userId: "user-2" },
      { userId: "user-3" },
    ]);

    await buildAttendanceRecognitionGallery("session-1");

    expect(mockFind).toHaveBeenCalledTimes(1);
    const filterArg = mockFind.mock.calls[0]?.[0];
    expect(filterArg).toMatchObject({
      userId: { $in: ["user-1", "user-2", "user-3"] },
      status: "active",
    });
  });

  // -------------------------------------------------------------------------
  // Test 4: no N+1 FaceProfile lookup
  // -------------------------------------------------------------------------

  it("4. no N+1 FaceProfile lookup", async () => {
    const { buildAttendanceRecognitionGallery } = await import(
      "@/lib/attendance/attendance-recognition-gallery-service"
    );

    setupSessionDoc("session-1", [
      { studentUserId: "user-1", fullNameSnapshot: "A", identificationCodeSnapshot: "S1" },
      { studentUserId: "user-2", fullNameSnapshot: "B", identificationCodeSnapshot: "S2" },
    ]);
    setupFaceProfiles([{ userId: "user-1" }, { userId: "user-2" }]);

    await buildAttendanceRecognitionGallery("session-1");

    expect(mockFind).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Test 5: centroid decrypted server-side using AAD contract
  // -------------------------------------------------------------------------

  it("5. centroid decrypted server-side using AAD contract", async () => {
    const { buildAttendanceRecognitionGallery } = await import(
      "@/lib/attendance/attendance-recognition-gallery-service"
    );

    setupSessionDoc("session-1", [
      { studentUserId: "user-1", fullNameSnapshot: "Alice", identificationCodeSnapshot: "SV001" },
    ]);
    setupFaceProfiles([{ userId: "user-1" }]);

    const decryptedEmbedding = new Float32Array(512);
    setupDecrypt(decryptedEmbedding);

    const result = await buildAttendanceRecognitionGallery("session-1");

    expect(mockDecryptBiometricVector).toHaveBeenCalled();
    const aad = mockDecryptBiometricVector.mock.calls[0]?.[1];
    expect(aad).toMatchObject({
      userId: "user-1",
      modelIdentity: "insightface-buffalo-l",
      templateVersion: 1,
      vectorType: "centroid",
    });
    expect(result.gallery.candidates[0]?.embedding).toBe(decryptedEmbedding);
  });

  // -------------------------------------------------------------------------
  // Test 6: five raw enrollment samples not required
  // -------------------------------------------------------------------------

  it("6. five raw enrollment samples NOT loaded", async () => {
    const { buildAttendanceRecognitionGallery } = await import(
      "@/lib/attendance/attendance-recognition-gallery-service"
    );

    setupSessionDoc("session-1", [
      { studentUserId: "user-1", fullNameSnapshot: "A", identificationCodeSnapshot: "S1" },
    ]);

    let capturedFields: Record<string, unknown> | null = null;
    setupSelectCapture((fields) => {
      capturedFields = fields;
    });

    await buildAttendanceRecognitionGallery("session-1");

    expect(capturedFields).not.toBeNull();
    expect(JSON.stringify(capturedFields)).not.toContain("samples");
  });

  // -------------------------------------------------------------------------
  // Test 7: missing FaceProfile candidate skipped
  // -------------------------------------------------------------------------

  it("7. missing FaceProfile candidate skipped safely", async () => {
    const { buildAttendanceRecognitionGallery } = await import(
      "@/lib/attendance/attendance-recognition-gallery-service"
    );

    setupSessionDoc("session-1", [
      { studentUserId: "user-1", fullNameSnapshot: "Alice", identificationCodeSnapshot: "SV001" },
      { studentUserId: "user-2", fullNameSnapshot: "Bob", identificationCodeSnapshot: "SV002" },
      { studentUserId: "user-3", fullNameSnapshot: "Charlie", identificationCodeSnapshot: "SV003" },
    ]);
    setupFaceProfiles([
      { userId: "user-1" },
      { userId: "user-2" },
    ]);

    const result = await buildAttendanceRecognitionGallery("session-1");

    expect(result.usableCandidateCount).toBe(2);
    expect(result.totalRosterCount).toBe(3);
    const allKeys = Object.keys(result.candidateKeyMapping);
    expect(allKeys).toHaveLength(2);
    expect(allKeys).not.toContain("user-3");
  });

  // -------------------------------------------------------------------------
  // Test 8: corrupt/incompatible FaceProfile skipped safely
  // -------------------------------------------------------------------------

  it("8. corrupt/incompatible FaceProfile skipped safely", async () => {
    const { buildAttendanceRecognitionGallery } = await import(
      "@/lib/attendance/attendance-recognition-gallery-service"
    );

    setupSessionDoc("session-1", [
      { studentUserId: "user-1", fullNameSnapshot: "Alice", identificationCodeSnapshot: "SV001" },
      { studentUserId: "user-2", fullNameSnapshot: "Bob", identificationCodeSnapshot: "SV002" },
    ]);
    // user-2 has empty modelIdentity (corrupt).
    mockFind.mockImplementation(() => ({
      select: () => ({
        lean: () => ({
          exec: () =>
            Promise.resolve([
              {
                userId: "user-1",
                modelIdentity: "insightface-buffalo-l",
                modelName: "buffalo_l",
                embeddingDimension: 512,
                normalization: "l2",
                templateVersion: 1,
                centroid: { ciphertext: "x", iv: "y", authTag: "z", keyVersion: 1 },
              },
              {
                userId: "user-2",
                modelIdentity: "",
                modelName: "buffalo_l",
                embeddingDimension: 512,
                normalization: "l2",
                templateVersion: 1,
                centroid: { ciphertext: "x", iv: "y", authTag: "z", keyVersion: 1 },
              },
            ]),
        }),
      }),
    }));

    const result = await buildAttendanceRecognitionGallery("session-1");

    expect(result.usableCandidateCount).toBe(1);
    expect(result.totalRosterCount).toBe(2);
    expect(result.candidateKeyMapping["c0"]).toMatchObject({
      studentUserId: "user-1",
    });
  });

  // -------------------------------------------------------------------------
  // Test 9: zero usable candidates returns controlled result
  // -------------------------------------------------------------------------

  it("9. zero usable candidates returns NO_RECOGNITION_CANDIDATES", async () => {
    const { buildAttendanceRecognitionGallery, ATTENDANCE_RECOGNITION_ERROR_CODES } = await import(
      "@/lib/attendance/attendance-recognition-gallery-service"
    );

    setupSessionDoc("session-1", [
      { studentUserId: "user-1", fullNameSnapshot: "Alice", identificationCodeSnapshot: "SV001" },
    ]);
    setupEmptyFaceProfiles();

    await expect(buildAttendanceRecognitionGallery("session-1")).rejects.toMatchObject({
      code: ATTENDANCE_RECOGNITION_ERROR_CODES.NO_RECOGNITION_CANDIDATES,
    });
  });

  // -------------------------------------------------------------------------
  // Test 10: snapshot fullName/identificationCode retained for result mapping
  // -------------------------------------------------------------------------

  it("10. snapshot fullName/identificationCode retained", async () => {
    const { buildAttendanceRecognitionGallery } = await import(
      "@/lib/attendance/attendance-recognition-gallery-service"
    );

    setupSessionDoc("session-1", [
      {
        studentUserId: "user-1",
        fullNameSnapshot: "Nguyen Van A",
        identificationCodeSnapshot: "SV001",
      },
    ]);
    setupFaceProfiles([{ userId: "user-1" }]);

    const result = await buildAttendanceRecognitionGallery("session-1");

    expect(result.candidateKeyMapping["c0"]).toMatchObject({
      fullNameSnapshot: "Nguyen Van A",
      identificationCodeSnapshot: "SV001",
    });
  });

  // -------------------------------------------------------------------------
  // Test 11: studentUserId never enters browser DTO
  // -------------------------------------------------------------------------

  it("11. studentUserId never in gallery.candidates", async () => {
    const { buildAttendanceRecognitionGallery } = await import(
      "@/lib/attendance/attendance-recognition-gallery-service"
    );

    setupSessionDoc("session-1", [
      { studentUserId: "user-1", fullNameSnapshot: "Alice", identificationCodeSnapshot: "SV001" },
    ]);
    setupFaceProfiles([{ userId: "user-1" }]);

    const result = await buildAttendanceRecognitionGallery("session-1");

    const candidatesJson = JSON.stringify(result.gallery.candidates);
    expect(candidatesJson).not.toContain("user-1");
    expect(candidatesJson).not.toContain("studentUserId");

    // Mapping (internal) does contain studentUserId.
    expect(JSON.stringify(result.candidateKeyMapping)).toContain("user-1");
  });

  // -------------------------------------------------------------------------
  // Test 12: real student identity never in Face Service payload
  // -------------------------------------------------------------------------

  it("12. real student identity never in Face Service payload", async () => {
    const { buildAttendanceRecognitionGallery } = await import(
      "@/lib/attendance/attendance-recognition-gallery-service"
    );

    setupSessionDoc("session-1", [
      { studentUserId: "real-user-1", fullNameSnapshot: "Alice", identificationCodeSnapshot: "SV001" },
      { studentUserId: "real-user-2", fullNameSnapshot: "Bob", identificationCodeSnapshot: "SV002" },
    ]);
    setupFaceProfiles([
      { userId: "real-user-1" },
      { userId: "real-user-2" },
    ]);

    const result = await buildAttendanceRecognitionGallery("session-1");

    const keys = result.gallery.candidates.map((c) => c.candidateKey);
    expect(keys).toEqual(["c0", "c1"]);

    const galleryJson = JSON.stringify(result.gallery);
    expect(galleryJson).not.toContain("real-user-1");
    expect(galleryJson).not.toContain("real-user-2");
    expect(galleryJson).not.toContain("Alice");
    expect(galleryJson).not.toContain("SV001");
  });
});
