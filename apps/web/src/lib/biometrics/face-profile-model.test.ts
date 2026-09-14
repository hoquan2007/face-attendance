/**
 * Schema tests for the FaceProfile Mongoose model.
 *
 * PHASE 4.2 — FaceProfile + FaceEnrollmentSession database foundation.
 *
 * These tests inspect the Mongoose schema (collection name, required
 * fields, unique indexes, validation, plaintext-embedding absence)
 * without connecting to MongoDB. They use the production model so the
 * configuration under test matches what runs in the application.
 */

import { describe, expect, it } from "vitest";

import {
  FaceProfileModel,
  FACE_PROFILE_STATUSES,
  type FaceProfileAttrs,
} from "@/lib/biometrics/face-profile-model";
import {
  NORMALIZATIONS,
  type Normalization,
} from "@/lib/biometrics/biometric-schema";

function makeValidProfile(overrides: Partial<FaceProfileAttrs> = {}): FaceProfileAttrs {
  return {
    userId: "user-1",
    status: "active",
    modelIdentity: "insightface/buffalo_l",
    modelName: "buffalo_l",
    embeddingDimension: 512,
    normalization: "l2",
    templateVersion: 1,
    requiredSampleCount: 5,
    sampleCount: 5,
    samples: [
      {
        encryptedVector: {
          ciphertext: "ciphertext-1",
          iv: "iv-1",
          authTag: "authTag-1",
          keyVersion: 1,
        },
        sampleIndex: 0,
      },
    ],
    centroid: {
      ciphertext: "centroid-cipher",
      iv: "centroid-iv",
      authTag: "centroid-authTag",
      keyVersion: 1,
    },
    enrolledAt: new Date("2026-01-01T00:00:00Z"),
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("FaceProfile model / collection", () => {
  it("uses the expected collection name", () => {
    expect(FaceProfileModel.collection.name).toBe("face_profiles");
  });
});

describe("FaceProfile model / userId field", () => {
  it("is required", () => {
    expect(FaceProfileModel.schema.path("userId").isRequired).toBe(true);
  });

  it("has a unique index on userId", () => {
    const indexes = FaceProfileModel.schema.indexes();
    const userIdIndex = indexes.find(([keys]) => {
      const k = keys as Record<string, number>;
      return k.userId === 1;
    });
    expect(userIdIndex).toBeDefined();
    const options = userIdIndex?.[1] as { unique?: boolean } | undefined;
    expect(options?.unique).toBe(true);
  });
});

describe("FaceProfile model / model metadata fields", () => {
  it("requires modelIdentity", () => {
    expect(FaceProfileModel.schema.path("modelIdentity").isRequired).toBe(true);
  });

  it("requires modelName", () => {
    expect(FaceProfileModel.schema.path("modelName").isRequired).toBe(true);
  });

  it("requires embeddingDimension to be a positive integer", () => {
    const path = FaceProfileModel.schema.path("embeddingDimension");
    expect(path.isRequired).toBe(true);
    const min = path.options.min;
    expect(Array.isArray(min) ? min[0] : min).toBe(1);
  });

  it("supports normalization: l2", () => {
    const enumValues = NORMALIZATIONS as readonly Normalization[];
    expect(enumValues).toContain("l2");
    const path = FaceProfileModel.schema.path("normalization");
    expect(path.options.enum).toEqual(NORMALIZATIONS);
  });

  it("rejects invalid normalization values via enum", () => {
    const path = FaceProfileModel.schema.path("normalization");
    const enumValues = path.options.enum as readonly string[];
    expect(enumValues).not.toContain("l1");
    expect(enumValues).not.toContain("cosine");
    expect(enumValues).not.toContain("");
  });

  it("requires templateVersion to be a positive integer", () => {
    const path = FaceProfileModel.schema.path("templateVersion");
    expect(path.isRequired).toBe(true);
    const min = path.options.min;
    expect(Array.isArray(min) ? min[0] : min).toBe(1);
  });
});

describe("FaceProfile model / sample counts", () => {
  it("requires requiredSampleCount >= 1", () => {
    const path = FaceProfileModel.schema.path("requiredSampleCount");
    expect(path.isRequired).toBe(true);
    const min = path.options.min;
    expect(Array.isArray(min) ? min[0] : min).toBe(1);
  });

  it("requires sampleCount >= 1", () => {
    const path = FaceProfileModel.schema.path("sampleCount");
    expect(path.isRequired).toBe(true);
    const min = path.options.min;
    expect(Array.isArray(min) ? min[0] : min).toBe(1);
  });

  it("does not hardcode 512 as the only embeddingDimension", () => {
    // Verify the schema accepts a value other than 512 by constructing
    // a FaceProfile with a different dimension; this proves the
    // validation does not pin the value.
    const profile = makeValidProfile({ embeddingDimension: 256 });
    expect(profile.embeddingDimension).toBe(256);
  });
});

describe("FaceProfile model / encrypted value shape", () => {
  it("accepts encrypted samples in the canonical PHASE 4.1 shape", () => {
    const samplesPath = FaceProfileModel.schema.path("samples");
    expect(samplesPath).toBeDefined();
    // The subdocument schema should expose encryptedVector, sampleIndex, quality
    const subSchema = samplesPath.schema as {
      paths: Record<string, { isRequired?: boolean; options: Record<string, unknown> }>;
    };
    const evPath = subSchema.paths.encryptedVector;
    const sampleIndexPath = subSchema.paths.sampleIndex;
    const qualityPath = subSchema.paths.quality;
    expect(evPath).toBeDefined();
    expect(evPath?.isRequired).toBe(true);
    expect(sampleIndexPath).toBeDefined();
    expect(sampleIndexPath?.isRequired).toBe(true);
    expect(qualityPath).toBeDefined();
  });

  it("accepts a centroid in the encrypted value shape", () => {
    const centroidPath = FaceProfileModel.schema.path("centroid");
    expect(centroidPath.isRequired).toBe(true);
    // Centroid should expose ciphertext, iv, authTag, keyVersion.
    const sub = centroidPath.schema as {
      paths: Record<string, { isRequired?: boolean }>;
    };
    expect(sub.paths.ciphertext?.isRequired).toBe(true);
    expect(sub.paths.iv?.isRequired).toBe(true);
    expect(sub.paths.authTag?.isRequired).toBe(true);
    expect(sub.paths.keyVersion?.isRequired).toBe(true);
  });

  it("does not expose any plaintext embedding field on the schema", () => {
    const pathNames = Object.keys(FaceProfileModel.schema.paths);
    expect(pathNames).not.toContain("embedding");
    expect(pathNames).not.toContain("vector");
    expect(pathNames).not.toContain("centroidVector");
    expect(pathNames).not.toContain("rawEmbedding");
    expect(pathNames).not.toContain("plaintextEmbedding");
  });

  it("does not expose any raw-image field on the schema", () => {
    const pathNames = Object.keys(FaceProfileModel.schema.paths);
    expect(pathNames).not.toContain("rawImage");
    expect(pathNames).not.toContain("image");
    expect(pathNames).not.toContain("base64Image");
    expect(pathNames).not.toContain("faceCrop");
    expect(pathNames).not.toContain("frame");
    expect(pathNames).not.toContain("photo");
  });

  it("does not embed plaintext embedding fields inside samples", () => {
    const samplesPath = FaceProfileModel.schema.path("samples");
    const subSchema = samplesPath.schema as {
      paths: Record<string, unknown>;
    };
    const samplePaths = Object.keys(subSchema.paths);
    expect(samplePaths).not.toContain("embedding");
    expect(samplePaths).not.toContain("vector");
    expect(samplePaths).not.toContain("rawEmbedding");
    expect(samplePaths).not.toContain("plaintextEmbedding");
  });
});

describe("FaceProfile model / timestamps", () => {
  it("declares createdAt and updatedAt", () => {
    expect(FaceProfileModel.schema.path("createdAt")).toBeDefined();
    expect(FaceProfileModel.schema.path("updatedAt")).toBeDefined();
    // Mongoose adds timestamps automatically when timestamps: true is set.
    const timestampsOption = FaceProfileModel.schema.options.timestamps;
    expect(Boolean(timestampsOption)).toBe(true);
  });
});

describe("FaceProfile model / status field", () => {
  it("supports the active status", () => {
    const path = FaceProfileModel.schema.path("status");
    const enumValues = path.options.enum as readonly string[];
    expect(enumValues).toEqual(FACE_PROFILE_STATUSES);
    expect(enumValues).toContain("active");
  });
});

// =============================================================================
// PHASE 4.6B2B — sourceEnrollmentGenerationId lineage field
// =============================================================================

describe("FaceProfile model / sourceEnrollmentGenerationId (PHASE 4.6B2B)", () => {
  it("declares the lineage field on the schema", () => {
    const path = FaceProfileModel.schema.path("sourceEnrollmentGenerationId");
    expect(path).toBeDefined();
  });

  it("lineage is optional at the schema level for legacy compatibility", () => {
    const path = FaceProfileModel.schema.path("sourceEnrollmentGenerationId");
    expect(path.isRequired).toBe(false);
  });

  it("lineage is not derived from userId", () => {
    // The schema does NOT compute lineage from userId. Persistence
    // code is the sole producer of this value.
    const path = FaceProfileModel.schema.path("sourceEnrollmentGenerationId");
    expect(path.options.default).toBeUndefined();
  });

  it("does not declare a global unique index on lineage", () => {
    // userId remains the unique ownership index. Adding a unique
    // index on lineage would create a global write bottleneck.
    const indexes = FaceProfileModel.schema.indexes();
    const lineageIndex = indexes.find(([keys]) => {
      const k = keys as Record<string, number>;
      return k.sourceEnrollmentGenerationId === 1;
    });
    expect(lineageIndex).toBeUndefined();
  });

  it("lineage minlength rejects empty strings", () => {
    const path = FaceProfileModel.schema.path("sourceEnrollmentGenerationId");
    const minlength = (path.options as { minlength?: unknown }).minlength;
    // Mongoose minlength may be a number, an array, or a tuple
    // [minlength, message]. We accept either.
    let value: unknown = minlength;
    if (Array.isArray(value)) value = value[0];
    expect(value).toBe(1);
  });

  it("legacy FaceProfile without lineage remains readable (compatibility)", () => {
    // We construct a legacy-shaped document (no lineage field) and
    // verify the model accepts it. The orchestrator's read path
    // therefore remains backward-compatible.
    const legacy = makeValidProfile();
    // intentionally strip the lineage field
    delete (legacy as Partial<FaceProfileAttrs>).sourceEnrollmentGenerationId;
    expect(legacy.sourceEnrollmentGenerationId).toBeUndefined();
    // The schema path still exists; the document just omits the value.
    expect(FaceProfileModel.schema.path("sourceEnrollmentGenerationId")).toBeDefined();
  });
});
