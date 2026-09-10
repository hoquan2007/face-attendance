/**
 * Schema tests for the FaceEnrollmentSession Mongoose model.
 *
 * PHASE 4.2 — FaceProfile + FaceEnrollmentSession database foundation.
 *
 * These tests inspect the Mongoose schema (collection name, required
 * fields, unique and TTL indexes, validation, plaintext-embedding
 * absence) without connecting to MongoDB. They use the production
 * model so the configuration under test matches what runs in the
 * application.
 */

import { describe, expect, it } from "vitest";

import { FaceEnrollmentSessionModel } from "@/lib/biometrics/enrollment-session-model";
import { ENROLLMENT_MODES } from "@/lib/biometrics/biometric-schema";

describe("FaceEnrollmentSession model / collection", () => {
  it("uses the expected collection name", () => {
    expect(FaceEnrollmentSessionModel.collection.name).toBe(
      "face_enrollment_sessions",
    );
  });
});

describe("FaceEnrollmentSession model / userId index", () => {
  it("is required", () => {
    expect(FaceEnrollmentSessionModel.schema.path("userId").isRequired).toBe(
      true,
    );
  });

  it("has a unique index on userId", () => {
    const indexes = FaceEnrollmentSessionModel.schema.indexes();
    const userIdIndex = indexes.find(([keys]) => {
      const k = keys as Record<string, number>;
      return k.userId === 1;
    });
    expect(userIdIndex).toBeDefined();
    const options = userIdIndex?.[1] as { unique?: boolean } | undefined;
    expect(options?.unique).toBe(true);
  });
});

describe("FaceEnrollmentSession model / mode field", () => {
  it("accepts mode: create", () => {
    const path = FaceEnrollmentSessionModel.schema.path("mode");
    const enumValues = path.options.enum as readonly string[];
    expect(enumValues).toEqual(ENROLLMENT_MODES);
    expect(enumValues).toContain("create");
  });

  it("accepts mode: replace", () => {
    const enumValues = ENROLLMENT_MODES as readonly string[];
    expect(enumValues).toContain("replace");
  });

  it("rejects an invalid mode", () => {
    const enumValues = ENROLLMENT_MODES as readonly string[];
    expect(enumValues).not.toContain("renew");
    expect(enumValues).not.toContain("delete");
    expect(enumValues).not.toContain("");
  });
});

describe("FaceEnrollmentSession model / defaults", () => {
  it("defaults acceptedSamples to an empty array", () => {
    const path = FaceEnrollmentSessionModel.schema.path("acceptedSamples");
    // The default is declared on the schema options.
    const defaultValue = path.options.default;
    expect(Array.isArray(defaultValue)).toBe(true);
    expect(defaultValue).toHaveLength(0);
  });
});

describe("FaceEnrollmentSession model / expiresAt and TTL", () => {
  it("requires expiresAt", () => {
    expect(
      FaceEnrollmentSessionModel.schema.path("expiresAt").isRequired,
    ).toBe(true);
  });

  it("declares a TTL index on expiresAt", () => {
    const indexes = FaceEnrollmentSessionModel.schema.indexes();
    const ttlIndex = indexes.find(([keys]) => {
      const k = keys as Record<string, number>;
      return k.expiresAt === 1;
    });
    expect(ttlIndex).toBeDefined();
  });

  it("TTL index uses expireAfterSeconds: 0", () => {
    const indexes = FaceEnrollmentSessionModel.schema.indexes();
    const ttlIndex = indexes.find(([keys]) => {
      const k = keys as Record<string, number>;
      return k.expiresAt === 1;
    });
    const options = ttlIndex?.[1] as
      | { expireAfterSeconds?: number }
      | undefined;
    expect(options?.expireAfterSeconds).toBe(0);
  });
});

describe("FaceEnrollmentSession model / template + sample configuration", () => {
  it("requires templateVersion to be a positive integer", () => {
    const path = FaceEnrollmentSessionModel.schema.path("templateVersion");
    expect(path.isRequired).toBe(true);
    const min = path.options.min;
    expect(Array.isArray(min) ? min[0] : min).toBe(1);
  });

  it("requires requiredSampleCount >= 1", () => {
    const path = FaceEnrollmentSessionModel.schema.path("requiredSampleCount");
    expect(path.isRequired).toBe(true);
    const min = path.options.min;
    expect(Array.isArray(min) ? min[0] : min).toBe(1);
  });

  it("allows modelIdentity to be absent before the first sample", () => {
    const path = FaceEnrollmentSessionModel.schema.path("modelIdentity");
    expect(path.isRequired).toBe(false);
  });

  it("allows modelName to be absent before the first sample", () => {
    const path = FaceEnrollmentSessionModel.schema.path("modelName");
    expect(path.isRequired).toBe(false);
  });

  it("allows embeddingDimension to be absent before the first sample", () => {
    const path = FaceEnrollmentSessionModel.schema.path("embeddingDimension");
    expect(path.isRequired).toBe(false);
  });

  it("allows normalization to be absent before the first sample", () => {
    const path = FaceEnrollmentSessionModel.schema.path("normalization");
    expect(path.isRequired).toBe(false);
  });
});

describe("FaceEnrollmentSession model / encrypted accepted sample shape", () => {
  it("accepts an encrypted accepted sample with sampleIndex, encryptedVector, acceptedAt, quality", () => {
    const path = FaceEnrollmentSessionModel.schema.path("acceptedSamples");
    const subSchema = path.schema as {
      paths: Record<string, { isRequired?: boolean }>;
    };
    expect(subSchema.paths.encryptedVector?.isRequired).toBe(true);
    expect(subSchema.paths.sampleIndex?.isRequired).toBe(true);
    expect(subSchema.paths.acceptedAt?.isRequired).toBe(true);
    expect(subSchema.paths.quality).toBeDefined();
  });

  it("encryptedVector carries ciphertext, iv, authTag, keyVersion", () => {
    const path = FaceEnrollmentSessionModel.schema.path("acceptedSamples");
    const subSchema = path.schema as {
      paths: Record<string, { schema: { paths: Record<string, { isRequired?: boolean }> } }>;
    };
    const ev = subSchema.paths.encryptedVector?.schema;
    expect(ev?.paths.ciphertext?.isRequired).toBe(true);
    expect(ev?.paths.iv?.isRequired).toBe(true);
    expect(ev?.paths.authTag?.isRequired).toBe(true);
    expect(ev?.paths.keyVersion?.isRequired).toBe(true);
  });

  it("does not expose any plaintext embedding field on the schema", () => {
    const pathNames = Object.keys(FaceEnrollmentSessionModel.schema.paths);
    expect(pathNames).not.toContain("embedding");
    expect(pathNames).not.toContain("vector");
    expect(pathNames).not.toContain("rawEmbedding");
    expect(pathNames).not.toContain("plaintextEmbedding");
  });

  it("does not expose any raw-image field on the schema", () => {
    const pathNames = Object.keys(FaceEnrollmentSessionModel.schema.paths);
    expect(pathNames).not.toContain("rawImage");
    expect(pathNames).not.toContain("image");
    expect(pathNames).not.toContain("base64Image");
    expect(pathNames).not.toContain("faceCrop");
    expect(pathNames).not.toContain("frame");
    expect(pathNames).not.toContain("photo");
  });

  it("does not embed plaintext vector fields inside accepted samples", () => {
    const path = FaceEnrollmentSessionModel.schema.path("acceptedSamples");
    const subSchema = path.schema as { paths: Record<string, unknown> };
    const samplePaths = Object.keys(subSchema.paths);
    expect(samplePaths).not.toContain("embedding");
    expect(samplePaths).not.toContain("vector");
    expect(samplePaths).not.toContain("rawEmbedding");
    expect(samplePaths).not.toContain("plaintextEmbedding");
  });
});

describe("FaceEnrollmentSession model / timestamps", () => {
  it("declares createdAt and updatedAt", () => {
    expect(
      FaceEnrollmentSessionModel.schema.path("createdAt"),
    ).toBeDefined();
    expect(
      FaceEnrollmentSessionModel.schema.path("updatedAt"),
    ).toBeDefined();
    const timestampsOption = FaceEnrollmentSessionModel.schema.options.timestamps;
    expect(Boolean(timestampsOption)).toBe(true);
  });
});
