/**
 * Attendance Recognition Gallery Service.
 *
 * PHASE 6.3 — LIVE FACE RECOGNITION PREVIEW.
 *
 * Server-only module that builds an ephemeral, in-memory recognition
 * gallery from an active AttendanceSession's immutable roster snapshot.
 *
 * Key design decisions:
 *
 *   1. Gallery source is EXCLUSIVELY the active AttendanceSession
 *      roster snapshot. Current ClassMembership rows are NEVER used
 *      as authority — the snapshot is.
 *
 *   2. FaceProfiles are batch-loaded in ONE MongoDB query — no N+1.
 *      Only the enrolled centroid is fetched; the five raw samples
 *      are NOT loaded.
 *
 *   3. Centroid decryption is performed server-side using the exact
 *      existing AAD contract from the FaceProfile finalization service.
 *
 *   4. Corrupt / incompatible FaceProfiles are skipped safely — the
 *      attendance session continues normally. Missing FaceProfiles are
 *      skipped (those students cannot be recognized in this phase).
 *
 *   5. Ephemeral candidate keys (c0, c1, c2...) replace real student
 *      identities when communicating with the Face Service.
 *
 *   6. Embeddings exist only: Mongo (encrypted) → Next server
 *      (decrypted) → Face Service (transient). They are NEVER sent to
 *      the browser.
 *
 * Privacy guarantees:
 *   - studentUserId, fullName, identificationCode, email, Profile id
 *     are NEVER sent to the Face Service.
 *   - Candidate keys are ephemeral and in-memory only.
 *   - Embeddings never reach the browser.
 */

import "server-only";

import { Types } from "mongoose";

import {
  AttendanceSessionModel,
  type AttendanceRosterSnapshotItemDoc,
} from "@/lib/attendance/attendance-session-model";
import { getMongooseConnection } from "@/lib/mongoose";
import {
  BiometricError,
  decryptBiometricVector,
  type BiometricAAD,
} from "@/lib/biometrics/encryption";
import {
  FaceProfileModel,
  type FaceProfileAttrs,
} from "@/lib/biometrics/face-profile-model";

// =============================================================================
// Stable gallery-building error codes
// =============================================================================

export const ATTENDANCE_RECOGNITION_ERROR_CODES = {
  /** No usable FaceProfiles available in the session roster. */
  NO_RECOGNITION_CANDIDATES: "NO_RECOGNITION_CANDIDATES",
  /** Attendance session not found. */
  ATTENDANCE_SESSION_NOT_FOUND: "ATTENDANCE_SESSION_NOT_FOUND",
  /** Attendance session is not active. */
  ATTENDANCE_SESSION_NOT_ACTIVE: "ATTENDANCE_SESSION_NOT_ACTIVE",
  /** Session does not belong to the specified class. */
  SESSION_CLASS_MISMATCH: "SESSION_CLASS_MISMATCH",
} as const;

export type AttendanceRecognitionErrorCode =
  (typeof ATTENDANCE_RECOGNITION_ERROR_CODES)[keyof typeof ATTENDANCE_RECOGNITION_ERROR_CODES];

export class AttendanceRecognitionError extends Error {
  public readonly code: AttendanceRecognitionErrorCode;

  constructor({
    code,
    message,
  }: {
    code: AttendanceRecognitionErrorCode;
    message: string;
  }) {
    super(message);
    this.name = "AttendanceRecognitionError";
    this.code = code;
  }
}

// =============================================================================
// Internal helpers
// =============================================================================

async function ensureConnection(): Promise<void> {
  await getMongooseConnection();
}

/**
 * Batch-loads FaceProfiles for a list of student user IDs.
 *
 * Uses `FaceProfileModel.find()` with an `$in` filter — ONE MongoDB
 * query regardless of roster size. No N+1.
 *
 * Only fetches the centroid + model metadata fields needed for
 * recognition. The five raw samples are NOT loaded.
 */
async function batchLoadFaceProfiles(
  studentUserIds: string[],
): Promise<Map<string, FaceProfileAttrs>> {
  await ensureConnection();

  if (studentUserIds.length === 0) {
    return new Map();
  }

  const docs = await FaceProfileModel.find({
    userId: { $in: studentUserIds },
    status: "active",
  })
    .select({
      userId: 1,
      modelIdentity: 1,
      modelName: 1,
      embeddingDimension: 1,
      normalization: 1,
      templateVersion: 1,
      centroid: 1,
    })
    .lean<FaceProfileAttrs[]>()
    .exec();

  const map = new Map<string, FaceProfileAttrs>();
  for (const doc of docs) {
    map.set(doc.userId, doc);
  }
  return map;
}

/**
 * Validates and decrypts a FaceProfile centroid using the exact AAD
 * contract from the FaceProfile finalization service.
 *
 * AAD contract:
 *   - userId: from roster snapshot
 *   - modelIdentity: from FaceProfile
 *   - templateVersion: from FaceProfile
 *   - vectorType: "centroid" (not "sample")
 *
 * Returns the decrypted Float32Array embedding, or throws
 * AttendanceRecognitionError on any validation / decryption failure.
 *
 * Corrupt / incompatible profiles are skipped by the caller, not
 * propagated as fatal errors.
 */
function decryptCentroid(
  profile: FaceProfileAttrs,
  studentUserId: string,
): Float32Array {
  // Validate required metadata fields exist.
  if (
    typeof profile.modelIdentity !== "string" ||
    profile.modelIdentity.length === 0
  ) {
    throw new AttendanceRecognitionError({
      code: ATTENDANCE_RECOGNITION_ERROR_CODES.NO_RECOGNITION_CANDIDATES,
      message: "FaceProfile has no modelIdentity.",
    });
  }

  if (
    typeof profile.templateVersion !== "number" ||
    !Number.isInteger(profile.templateVersion) ||
    profile.templateVersion < 1
  ) {
    throw new AttendanceRecognitionError({
      code: ATTENDANCE_RECOGNITION_ERROR_CODES.NO_RECOGNITION_CANDIDATES,
      message: "FaceProfile has invalid templateVersion.",
    });
  }

  if (
    typeof profile.embeddingDimension !== "number" ||
    !Number.isInteger(profile.embeddingDimension) ||
    profile.embeddingDimension < 1
  ) {
    throw new AttendanceRecognitionError({
      code: ATTENDANCE_RECOGNITION_ERROR_CODES.NO_RECOGNITION_CANDIDATES,
      message: "FaceProfile has invalid embeddingDimension.",
    });
  }

  if (profile.normalization !== "l2") {
    throw new AttendanceRecognitionError({
      code: ATTENDANCE_RECOGNITION_ERROR_CODES.NO_RECOGNITION_CANDIDATES,
      message: `FaceProfile normalization "${profile.normalization}" is not supported.`,
    });
  }

  // Build the AAD using the exact centroid contract.
  const aad: BiometricAAD = {
    userId: studentUserId,
    modelIdentity: profile.modelIdentity,
    templateVersion: profile.templateVersion,
    vectorType: "centroid",
  };

  try {
    const embedding = decryptBiometricVector(profile.centroid, aad);
    return embedding;
  } catch (err: unknown) {
    if (err instanceof BiometricError) {
      // Decryption failed — skip this candidate safely.
      // Common causes: key mismatch, data corruption, wrong AAD.
      throw new AttendanceRecognitionError({
        code: ATTENDANCE_RECOGNITION_ERROR_CODES.NO_RECOGNITION_CANDIDATES,
        message: "FaceProfile centroid could not be decrypted.",
      });
    }
    // Unexpected error — propagate as-is for debugging.
    if (err instanceof Error) {
      throw new AttendanceRecognitionError({
        code: ATTENDANCE_RECOGNITION_ERROR_CODES.NO_RECOGNITION_CANDIDATES,
        message: `FaceProfile centroid decryption failed: ${err.message}`,
      });
    }
    throw new AttendanceRecognitionError({
      code: ATTENDANCE_RECOGNITION_ERROR_CODES.NO_RECOGNITION_CANDIDATES,
      message: "FaceProfile centroid decryption failed for an unknown reason.",
    });
  }
}

// =============================================================================
// Public API
// =============================================================================

export interface BuildGalleryResult {
  /**
   * The session-scoped recognition gallery.
   * Contains only candidates with successfully decrypted centroids.
   */
  gallery: {
    candidates: Array<{
      candidateKey: string;
      embedding: Float32Array;
      embeddingDimension: number;
      normalization: "l2";
    }>;
  };
  /**
   * Total roster members in the session snapshot.
   */
  totalRosterCount: number;
  /**
   * Roster members with usable FaceProfiles.
   */
  usableCandidateCount: number;
  /**
   * Ephemeral key → snapshot identity mapping.
   * Valid for the lifetime of ONE recognition request.
   */
  candidateKeyMapping: Record<
    string,
    {
      studentUserId: string;
      fullNameSnapshot: string;
      identificationCodeSnapshot: string;
    }
  >;
}

/**
 * Builds a session-scoped recognition gallery from an active
 * AttendanceSession's immutable roster snapshot.
 *
 * Source of authority:
 *   - AttendanceSession.rosterSnapshot ONLY
 *   - Current ClassMembership rows are NEVER used
 *
 * Privacy:
 *   - studentUserId, fullName, identificationCode are NEVER sent
 *     to the Face Service
 *   - Ephemeral candidate keys (c0, c1, c2...) replace real identities
 *   - Embeddings are decrypted transiently and sent to Face Service only
 *
 * Error handling:
 *   - Missing FaceProfile → skip candidate (no error)
 *   - Corrupt / incompatible FaceProfile → skip candidate (no error)
 *   - Zero usable candidates → AttendanceRecognitionError(NO_RECOGNITION_CANDIDATES)
 *
 * Gallery is ephemeral — not persisted.
 *
 * @param sessionId - The Mongo ObjectId of the active AttendanceSession.
 * @returns Gallery with ephemeral candidate keys, decrypted embeddings, and identity mapping.
 * @throws AttendanceRecognitionError on session not found, inactive, or zero usable candidates.
 */
export async function buildAttendanceRecognitionGallery(
  sessionId: string | Types.ObjectId,
): Promise<BuildGalleryResult> {
  await ensureConnection();

  const sessionDoc = await AttendanceSessionModel.findById(sessionId)
    .lean<{
      _id: Types.ObjectId;
      classId: Types.ObjectId;
      status: string;
      rosterSnapshot: AttendanceRosterSnapshotItemDoc[];
    } | null>()
    .exec();

  if (!sessionDoc) {
    throw new AttendanceRecognitionError({
      code: ATTENDANCE_RECOGNITION_ERROR_CODES.ATTENDANCE_SESSION_NOT_FOUND,
      message: "Attendance session not found.",
    });
  }

  if (sessionDoc.status !== "active") {
    throw new AttendanceRecognitionError({
      code: ATTENDANCE_RECOGNITION_ERROR_CODES.ATTENDANCE_SESSION_NOT_ACTIVE,
      message: "Attendance session is not active.",
    });
  }

  const rosterSnapshot = sessionDoc.rosterSnapshot ?? [];
  const totalRosterCount = rosterSnapshot.length;

  if (totalRosterCount === 0) {
    throw new AttendanceRecognitionError({
      code: ATTENDANCE_RECOGNITION_ERROR_CODES.NO_RECOGNITION_CANDIDATES,
      message: "Session roster is empty.",
    });
  }

  // Batch-load FaceProfiles for all roster members — ONE MongoDB query.
  const studentUserIds = rosterSnapshot.map((item) => item.studentUserId);
  const profileMap = await batchLoadFaceProfiles(studentUserIds);

  // Build gallery with ephemeral candidate keys.
  const candidates: BuildGalleryResult["gallery"]["candidates"] = [];
  const candidateKeyMapping: BuildGalleryResult["candidateKeyMapping"] = {};

  let usableCandidateCount = 0;

  for (let i = 0; i < rosterSnapshot.length; i++) {
    const snapshotItem = rosterSnapshot[i]!;
    const profile = profileMap.get(snapshotItem.studentUserId);

    if (!profile) {
      // No FaceProfile — skip safely.
      continue;
    }

    let embedding: Float32Array;
    try {
      embedding = decryptCentroid(profile, snapshotItem.studentUserId);
    } catch {
      // Corrupt / incompatible FaceProfile — skip safely.
      continue;
    }

    const candidateKey = `c${usableCandidateCount}`;
    usableCandidateCount += 1;

    candidates.push({
      candidateKey,
      embedding,
      embeddingDimension: profile.embeddingDimension,
      normalization: "l2" as const,
    });

    candidateKeyMapping[candidateKey] = {
      studentUserId: snapshotItem.studentUserId,
      fullNameSnapshot: snapshotItem.fullNameSnapshot,
      identificationCodeSnapshot: snapshotItem.identificationCodeSnapshot,
    };
  }

  if (usableCandidateCount === 0) {
    throw new AttendanceRecognitionError({
      code: ATTENDANCE_RECOGNITION_ERROR_CODES.NO_RECOGNITION_CANDIDATES,
      message: "No enrolled faces are available for recognition in this session.",
    });
  }

  return {
    gallery: { candidates },
    totalRosterCount,
    usableCandidateCount,
    candidateKeyMapping,
  };
}
