/**
 * FaceEnrollmentSession Mongoose model.
 *
 * PHASE 4.2 — FaceProfile + FaceEnrollmentSession database foundation.
 *
 * A `FaceEnrollmentSession` stores accepted encrypted samples
 * temporarily while a user is in the middle of enrolling their face.
 * This is necessary because future Next.js server requests cannot
 * depend on in-process memory between camera captures.
 *
 * Collection: `face_enrollment_sessions`
 *
 * TTL behavior:
 *   - Each session carries an `expiresAt` Date.
 *   - A MongoDB TTL index with `expireAfterSeconds: 0` instructs Mongo
 *     to delete the document once `expiresAt` is in the past.
 *   - MongoDB TTL deletion is ASYNCHRONOUS. Service code must treat
 *     `expiresAt <= now` as expired even if Mongo has not yet deleted
 *     the document. The service helper `isEnrollmentSessionExpired`
 *     encapsulates that logic.
 *
 * Important privacy posture:
 *   - The schema stores ONLY encrypted biometric vectors and
 *     non-identifying quality metadata.
 *   - Plaintext embeddings, raw images, base64 frames are NEVER
 *     stored.
 */

import mongoose, {
  type HydratedDocument,
  type Model,
  Schema,
} from "mongoose";

import {
  EncryptedBiometricValueSchema,
  ENROLLMENT_MODES,
  FaceSampleQualitySchema,
  NORMALIZATIONS,
  type EncryptedBiometricValueDoc,
  type EnrollmentMode,
  type FaceSampleQualityDoc,
  type Normalization,
} from "@/lib/biometrics/biometric-schema";

/**
 * Plain TypeScript representation of a FaceEnrollmentSession document.
 *
 * `generationId` is the stable, server-generated identity of an
 * enrollment generation. It is created exactly once when the
 * session is born (via `createOrResetEnrollmentSession`) and is
 * backfilled lazily (atomically) for legacy documents created by
 * earlier PHASE 4.x code that pre-dates this field. See
 * `enrollment-session-service.ts` for the backfill contract.
 */
export interface FaceEnrollmentSessionAttrs {
  userId: string;
  mode: EnrollmentMode;
  modelIdentity?: string;
  modelName?: string;
  embeddingDimension?: number;
  normalization?: Normalization;
  templateVersion: number;
  requiredSampleCount: number;
  acceptedSamples: FaceEnrollmentAcceptedSampleDoc[];
  expiresAt: Date;
  generationId: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One accepted encrypted sample inside an enrollment session.
 *
 * `acceptedAt` records the wall-clock time the sample was accepted by
 * the future enrollment pipeline; PHASE 4.2 does not write to this
 * field — only the schema shape is fixed here.
 */
export interface FaceEnrollmentAcceptedSampleDoc {
  encryptedVector: EncryptedBiometricValueDoc;
  sampleIndex: number;
  quality?: FaceSampleQualityDoc;
  acceptedAt: Date;
}

// =============================================================================
// Schema
// =============================================================================

const FaceEnrollmentAcceptedSampleSchema =
  new Schema<FaceEnrollmentAcceptedSampleDoc>(
    {
      encryptedVector: {
        type: EncryptedBiometricValueSchema,
        required: true,
      },
      sampleIndex: {
        type: Number,
        required: true,
        min: [0, "sampleIndex must be >= 0."],
        validate: {
          validator: Number.isInteger,
          message: "sampleIndex must be an integer.",
        },
      },
      quality: {
        type: FaceSampleQualitySchema,
        required: false,
        default: undefined,
      },
      acceptedAt: {
        type: Date,
        required: true,
      },
    },
    {
      _id: false,
    },
  );

const FaceEnrollmentSessionSchema = new Schema<FaceEnrollmentSessionAttrs>(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    mode: {
      type: String,
      enum: ENROLLMENT_MODES,
      required: true,
    },
    modelIdentity: {
      type: String,
      required: false,
      default: undefined,
    },
    modelName: {
      type: String,
      required: false,
      default: undefined,
    },
    embeddingDimension: {
      type: Number,
      required: false,
      min: [1, "embeddingDimension must be a positive integer."],
      validate: {
        validator: Number.isInteger,
        message: "embeddingDimension must be an integer.",
      },
    },
    normalization: {
      type: String,
      enum: NORMALIZATIONS,
      required: false,
      default: undefined,
    },
    templateVersion: {
      type: Number,
      required: true,
      min: [1, "templateVersion must be a positive integer."],
      validate: {
        validator: Number.isInteger,
        message: "templateVersion must be an integer.",
      },
    },
    requiredSampleCount: {
      type: Number,
      required: true,
      min: [1, "requiredSampleCount must be >= 1."],
      validate: {
        validator: Number.isInteger,
        message: "requiredSampleCount must be an integer.",
      },
    },
    acceptedSamples: {
      type: [FaceEnrollmentAcceptedSampleSchema],
      required: true,
      default: [],
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    generationId: {
      type: String,
      required: true,
      // The generationId is created on document creation (via
      // createOrResetEnrollmentSession) and lazily backfilled for
      // legacy documents that pre-date this field. There is
      // intentionally NO unique index on generationId: userId
      // remains the unique ownership index, and a generationId is
      // only meaningful in the context of a specific user's session.
      minlength: [1, "generationId must be a non-empty string."],
    },
  },
  {
    timestamps: true,
    collection: "face_enrollment_sessions",
  },
);

/**
 * Unique index on `userId` is created automatically by the field-level
 * `unique: true, index: true` declaration above — at most one
 * enrollment session per Better Auth user at any time.
 *
 * `generationId` does NOT carry a unique index. Its purpose is purely
 * as a stable per-generation discriminator for multi-tab / reload
 * resilience. The unique ownership index is still `userId`.
 */

/**
 * TTL index on `expiresAt`.
 *
 * `expireAfterSeconds: 0` means Mongo will delete the document as soon
 * as `expiresAt` is in the past. Service code must still treat
 * `expiresAt <= now` as expired because TTL deletion is asynchronous.
 */
FaceEnrollmentSessionSchema.index(
  { expiresAt: 1 },
  { expireAfterSeconds: 0, name: "expiresAt_ttl" },
);

/**
 * Hot-reload safe model reuse. Mirrors the pattern used by
 * `apps/web/src/lib/profile-model.ts` so Next.js dev server re-evaluating
 * this module does not produce `OverwriteModelError`.
 */
const modelKey = "FaceEnrollmentSession";
export const FaceEnrollmentSessionModel: Model<FaceEnrollmentSessionAttrs> =
  (mongoose.models[modelKey] as
    | Model<FaceEnrollmentSessionAttrs>
    | undefined) ||
  mongoose.model<FaceEnrollmentSessionAttrs>(
    modelKey,
    FaceEnrollmentSessionSchema,
  );

export type FaceEnrollmentSessionDoc =
  HydratedDocument<FaceEnrollmentSessionAttrs>;
