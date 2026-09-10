/**
 * Shared Mongoose sub-schemas for biometric storage.
 *
 * PHASE 4.2 — FaceProfile + FaceEnrollmentSession database foundation.
 *
 * ⚠️  SERVER-ONLY MODULE ⚠️
 *
 * This module is imported by Mongoose model definitions and server-side
 * service code only. It must NEVER be imported from Client Components.
 *
 * Design notes:
 *   - This file mirrors the PHASE 4.1 `EncryptedBiometricValue` TypeScript
 *     type (server-only encryption module) so the database schema is
 *     the only place where ciphertexts are stored.
 *   - The same shape is reused across both FaceProfile and
 *     FaceEnrollmentSession collections.
 *   - We do not store plaintext embeddings, raw images, or any biometric
 *     bytes in the database. Plaintext bytes are decrypted only inside
 *     Server Actions / Route Handlers, and only for short-lived
 *     computation.
 */

import { Schema } from "mongoose";

// =============================================================================
// Encrypted Biometric Value (embedded sub-schema)
// =============================================================================

/**
 * Reusable sub-schema for an encrypted biometric vector value.
 *
 * Fields:
 *   - `ciphertext` — base64-encoded AES-256-GCM ciphertext
 *   - `iv`         — base64-encoded 12-byte IV (fresh per encryption)
 *   - `authTag`    — base64-encoded 16-byte GCM auth tag
 *   - `keyVersion` — encryption key version (currently `1`)
 *
 * The PHASE 4.1 encryption module writes these four fields together;
 * no additional fields are stored at the database layer.
 *
 * We deliberately avoid adding a MongoDB `_id` on embedded values —
 * they have no identity outside their parent document.
 */
export const EncryptedBiometricValueSchema = new Schema(
  {
    ciphertext: {
      type: String,
      required: true,
    },
    iv: {
      type: String,
      required: true,
    },
    authTag: {
      type: String,
      required: true,
    },
    keyVersion: {
      type: Number,
      required: true,
      min: [1, "keyVersion must be a positive integer."],
      validate: {
        validator: Number.isInteger,
        message: "keyVersion must be an integer.",
      },
    },
  },
  {
    _id: false,
  },
);

/**
 * Plain TypeScript shape of an embedded encrypted biometric value.
 *
 * Mirrors the PHASE 4.1 `EncryptedBiometricValue` interface so service
 * code can pass the encrypted output of the encryption module directly
 * into Mongoose without translation.
 */
export interface EncryptedBiometricValueDoc {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

// =============================================================================
// Sample Quality (embedded sub-schema)
// =============================================================================

/**
 * Diagnostic, non-biometric quality metrics for one enrollment sample.
 *
 * Allowed fields are all optional because the enrollment pipeline may
 * learn quality metrics incrementally and the schema must accept
 * partial quality information.
 *
 * We deliberately do NOT store:
 *   - face landmarks
 *   - bounding boxes
 *   - raw face crops
 *   - image hashes
 *   - camera frames
 *
 * These belong to a future calibration phase if/when a real need exists.
 */
export const FaceSampleQualitySchema = new Schema(
  {
    detectionScore: {
      type: Number,
      required: false,
      min: [0, "detectionScore must be >= 0."],
      max: [1, "detectionScore must be <= 1."],
    },
    blurScore: {
      type: Number,
      required: false,
      min: [0, "blurScore must be >= 0."],
    },
    brightness: {
      type: Number,
      required: false,
      min: [0, "brightness must be >= 0."],
      max: [1, "brightness must be <= 1."],
    },
    relativeFaceArea: {
      type: Number,
      required: false,
      min: [0, "relativeFaceArea must be >= 0."],
      max: [1, "relativeFaceArea must be <= 1."],
    },
  },
  {
    _id: false,
  },
);

export interface FaceSampleQualityDoc {
  detectionScore?: number;
  blurScore?: number;
  brightness?: number;
  relativeFaceArea?: number;
}

// =============================================================================
// Normalization
// =============================================================================

/**
 * Vector normalization strategies supported in PHASE 4.
 *
 * Only `l2` is currently supported because ArcFace / InsightFace
 * embeddings are L2-normalised. Additional strategies (e.g. cosine
 * normalization) will be added in a future phase.
 */
export const NORMALIZATIONS = ["l2"] as const;
export type Normalization = (typeof NORMALIZATIONS)[number];

// =============================================================================
// Enrollment Mode
// =============================================================================

/**
 * Why an enrollment session exists.
 *
 * `create` — user has no active FaceProfile.
 * `replace` — user already has an active FaceProfile; the old one
 * remains active until a future successful finalization replaces it.
 *
 * PHASE 4.2 stores this mode but does not implement replacement
 * behavior.
 */
export const ENROLLMENT_MODES = ["create", "replace"] as const;
export type EnrollmentMode = (typeof ENROLLMENT_MODES)[number];
