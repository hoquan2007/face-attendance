/**
 * FaceProfile Mongoose model.
 *
 * PHASE 4.2 — FaceProfile + FaceEnrollmentSession database foundation.
 *
 * A `FaceProfile` represents the user's ACTIVE biometric enrollment.
 * There is at most ONE active FaceProfile per Better Auth user; this is
 * enforced with a unique index on `userId`.
 *
 * Collection: `face_profiles`
 *
 * Important privacy posture:
 *   - The schema stores ONLY encrypted biometric vectors and aggregated,
 *     non-identifying quality metadata.
 *   - Plaintext embeddings, raw images, base64 frames, face crops, and
 *     image hashes are NEVER stored here.
 *   - Decryption happens only inside server-only modules, and only for
 *     short-lived computation.
 *
 * Better Auth owns `user`, `account`, `session`, `verification`. Those
 * collections are NOT modified by this model.
 */

import mongoose, {
  type HydratedDocument,
  type Model,
  Schema,
} from "mongoose";

import {
  EncryptedBiometricValueSchema,
  FaceSampleQualitySchema,
  NORMALIZATIONS,
  type EncryptedBiometricValueDoc,
  type FaceSampleQualityDoc,
  type Normalization,
} from "@/lib/biometrics/biometric-schema";

/**
 * Status of a FaceProfile.
 *
 * PHASE 4.2 only persists `active` profiles. Future phases may add
 * `revoked`, `superseded`, or `pending` values when re-enrollment is
 * implemented.
 */
export const FACE_PROFILE_STATUSES = ["active"] as const;
export type FaceProfileStatus = (typeof FACE_PROFILE_STATUSES)[number];

/**
 * Plain TypeScript representation of a FaceProfile document.
 *
 * Aggregated quality summary fields are optional because the enrollment
 * pipeline fills them in only when enough samples are available.
 *
 * PHASE 4.6B2B — `sourceEnrollmentGenerationId` records which temporary
 * `FaceEnrollmentSession` generation created this FaceProfile. It is a
 * server-internal lineage marker used for:
 *   - idempotent persistence of the same finalization generation,
 *   - safe recovery when the B2B process crashes between FaceProfile
 *     persistence and the B2C session cleanup,
 *   - preventing a different generation from silently overwriting a
 *     profile created by an earlier finalize attempt.
 *
 * The field is OPTIONAL on the read shape so legacy FaceProfile
 * documents (created before B2B) remain readable. New persistence
 * writes always stamp a non-empty value.
 *
 * The field is NEVER serialized into any browser-visible DTO.
 */
export interface FaceProfileAttrs {
  userId: string;
  status: FaceProfileStatus;
  modelIdentity: string;
  modelName: string;
  embeddingDimension: number;
  normalization: Normalization;
  templateVersion: number;
  requiredSampleCount: number;
  sampleCount: number;
  samples: FaceProfileSampleDoc[];
  centroid: EncryptedBiometricValueDoc;
  qualitySummary?: FaceProfileQualitySummaryDoc;
  enrolledAt: Date;
  /**
   * PHASE 4.6B2B — server-only lineage field. Optional at the read
   * layer for legacy compatibility; required on writes performed by
   * the B2B persistence service.
   */
  sourceEnrollmentGenerationId?: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One encrypted enrollment sample.
 *
 * `encryptedVector` matches the PHASE 4.1 `EncryptedBiometricValue`
 * shape and never carries plaintext bytes.
 */
export interface FaceProfileSampleDoc {
  encryptedVector: EncryptedBiometricValueDoc;
  sampleIndex: number;
  quality?: FaceSampleQualityDoc;
}

/**
 * Aggregated, non-biometric quality summary over all enrollment
 * samples. Values are optional because they are filled in as the
 * enrollment pipeline collects enough measurements.
 */
export interface FaceProfileQualitySummaryDoc {
  meanDetectionScore?: number;
  meanBlurScore?: number;
  meanBrightness?: number;
  minSelfSimilarity?: number;
  meanSelfSimilarity?: number;
}

// =============================================================================
// Schema
// =============================================================================

const FaceProfileSampleSchema = new Schema<FaceProfileSampleDoc>(
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
  },
  {
    _id: false,
  },
);

const FaceProfileQualitySummarySchema = new Schema<FaceProfileQualitySummaryDoc>(
  {
    meanDetectionScore: { type: Number, required: false },
    meanBlurScore: { type: Number, required: false },
    meanBrightness: { type: Number, required: false },
    minSelfSimilarity: { type: Number, required: false },
    meanSelfSimilarity: { type: Number, required: false },
  },
  {
    _id: false,
  },
);

const FaceProfileSchema = new Schema<FaceProfileAttrs>(
  {
    userId: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    status: {
      type: String,
      enum: FACE_PROFILE_STATUSES,
      required: true,
      default: "active",
    },
    modelIdentity: {
      type: String,
      required: true,
      trim: true,
      minlength: [1, "modelIdentity must not be empty."],
    },
    modelName: {
      type: String,
      required: true,
      trim: true,
      minlength: [1, "modelName must not be empty."],
    },
    embeddingDimension: {
      type: Number,
      required: true,
      min: [1, "embeddingDimension must be a positive integer."],
      validate: {
        validator: Number.isInteger,
        message: "embeddingDimension must be an integer.",
      },
    },
    normalization: {
      type: String,
      enum: NORMALIZATIONS,
      required: true,
      default: "l2",
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
    sampleCount: {
      type: Number,
      required: true,
      min: [1, "sampleCount must be >= 1."],
      validate: {
        validator: Number.isInteger,
        message: "sampleCount must be an integer.",
      },
    },
    samples: {
      type: [FaceProfileSampleSchema],
      required: true,
      default: [],
    },
    centroid: {
      type: EncryptedBiometricValueSchema,
      required: true,
    },
    qualitySummary: {
      type: FaceProfileQualitySummarySchema,
      required: false,
      default: undefined,
    },
    enrolledAt: {
      type: Date,
      required: true,
    },
    // PHASE 4.6B2B — server-only lineage marker.
    //
    // `required: false` at the schema level preserves read
    // compatibility with legacy FaceProfile documents that pre-date
    // PHASE 4.6B2B and therefore never received the field. New
    // persistence writes (driven by `face-profile-finalization-service`)
    // MUST stamp a non-empty value; the persistence service enforces
    // that contract, not Mongoose.
    //
    // The field is intentionally NOT indexed. The unique ownership
    // index remains `userId`. A `sourceEnrollmentGenerationId` is
    // only meaningful in the context of a specific user's profile;
    // a global unique index would create a write bottleneck for an
    // identifier only consumed locally by the B2B / B2C pipeline.
    sourceEnrollmentGenerationId: {
      type: String,
      required: false,
      default: undefined,
      minlength: [
        1,
        "sourceEnrollmentGenerationId must be a non-empty string.",
      ],
    },
  },
  {
    timestamps: true,
    collection: "face_profiles",
  },
);

/**
 * Unique index on `userId` is created automatically by the field-level
 * `unique: true, index: true` declaration above. That guarantees at
 * most one FaceProfile per Better Auth user. Service code is
 * responsible for mapping duplicate-key errors to user-safe messages.
 *
 * No additional indexes are declared in PHASE 4.2 — the only access
 * pattern is lookup-by-userId, which the unique index already covers.
 */

/**
 * Hot-reload safe model reuse. Mirrors the pattern used by
 * `apps/web/src/lib/profile-model.ts` so Next.js dev server re-evaluating
 * this module does not produce `OverwriteModelError`.
 */
const modelKey = "FaceProfile";
export const FaceProfileModel: Model<FaceProfileAttrs> =
  (mongoose.models[modelKey] as Model<FaceProfileAttrs> | undefined) ||
  mongoose.model<FaceProfileAttrs>(modelKey, FaceProfileSchema);

export type FaceProfileDoc = HydratedDocument<FaceProfileAttrs>;
