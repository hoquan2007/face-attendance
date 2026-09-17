/**
 * Attendance recognition gallery types.
 *
 * PHASE 6.3 — LIVE FACE RECOGNITION PREVIEW.
 *
 * These types represent the ephemeral, in-memory recognition gallery
 * built from an active AttendanceSession's immutable roster snapshot.
 *
 * Privacy contract:
 *   - Gallery candidates use EPHEMERAL candidate keys (c0, c1, c2...)
 *     instead of real student identities.
 *   - studentUserId, fullName, identificationCode, email, Profile id
 *     are NEVER sent to the Face Service.
 *   - Embeddings exist only: Mongo (encrypted) → Next server (decrypted)
 *     → Face Service (transient). They are NEVER sent to the browser.
 */

import "server-only";

/**
 * Ephemeral candidate key — "c0", "c1", "c2", etc.
 * This is the ONLY identifier sent to the Face Service.
 */
export type EphemeralCandidateKey = string; // e.g. "c0", "c1"

/**
 * One candidate in the recognition gallery.
 *
 * Contains the ephemeral candidate key (mapped server-side to a student)
 * and the decrypted centroid embedding.
 */
export interface RecognitionGalleryCandidate {
  /** Ephemeral key sent to Face Service. NOT a real student identity. */
  candidateKey: EphemeralCandidateKey;
  /** Decrypted centroid embedding (Float32Array from AES-256-GCM decryption). */
  embedding: Float32Array;
  /** Expected embedding dimension. */
  embeddingDimension: number;
  /** Normalization method (must be "l2"). */
  normalization: "l2";
}

/**
 * The complete session-scoped recognition gallery.
 *
 * Built from AttendanceSession.rosterSnapshot + batch-loaded FaceProfiles.
 * This is an EPHEMERAL, in-memory structure — never persisted.
 */
export interface AttendanceRecognitionGallery {
  /**
   * Ordered list of valid candidates.
   * Order matches the roster snapshot order.
   * Candidates with corrupt/incompatible FaceProfiles are SKIPPED (not removed from snapshot).
   */
  candidates: RecognitionGalleryCandidate[];

  /**
   * Total number of roster members in the snapshot.
   * Includes those skipped due to missing/incompatible FaceProfile.
   */
  totalRosterCount: number;

  /**
   * Count of usable candidates (candidates with valid decrypted centroids).
   */
  usableCandidateCount: number;

  /**
   * Whether any usable candidates exist.
   */
  hasUsableCandidates: boolean;
}

/**
 * Mapping from ephemeral candidate key back to snapshot identity.
 * This mapping is kept in-memory for the duration of ONE recognition request.
 */
export interface CandidateKeyMapping {
  [candidateKey: string]: {
    studentUserId: string;
    fullNameSnapshot: string;
    identificationCodeSnapshot: string;
  };
}

/**
 * One recognized face result.
 * Uses SESSION SNAPSHOT values for identity.
 */
export interface RecognizedFaceResult {
  fullName: string;
  identificationCode: string;
}

/**
 * The complete recognition result returned to the browser.
 *
 * Contains ONLY safe display data:
 *   - fullName from session snapshot
 *   - identificationCode from session snapshot
 *
 * NEVER contains:
 *   - studentUserId
 *   - candidateKey
 *   - embedding / centroid
 *   - FaceProfile id
 *   - membershipId
 */
export interface AttendanceRecognitionResult {
  facesDetected: number;
  unmatchedCount: number;
  matches: RecognizedFaceResult[];
}
