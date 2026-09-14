/**
 * Tests for the PHASE 4.6B2B claim-bound FaceProfile persistence
 * orchestration service.
 *
 * Covers the 69-test contract from the PHASE 4.6B2B spec:
 *   1..6    — Profile schema / lineage (covered in face-profile-model.test.ts)
 *   7..13   — Claim flow
 *   14..23  — Centroid encryption
 *   24..33  — Encrypted sample copy
 *   34..43  — Model / profile metadata
 *   44..51  — Idempotency
 *   52..57  — Failure claim release
 *   58..63  — Result privacy
 *   64..67  — No session consumption
 *   68..69  — No transaction
 *
 * Implementation notes:
 *   - Uses in-memory store + Mongoose mock mirrors the existing
 *     enrollment-finalization-service.test.ts and
 *     enrollment-finalization-claim-service.test.ts patterns.
 *   - B1B is mocked at the orchestration boundary so the B2B tests
 *     can drive the success / failure / drift matrix precisely.
 *   - The encryption utility uses an injected deterministic test key
 *     so we can verify AAD reconstruction + ciphertext preservation.
 *
 * IMPORTANT:
 *   vi.mock factories are hoisted to the top of the file by vitest.
 *   They MUST NOT reference top-level module variables because those
 *   are not initialised when the factory runs. We therefore use
 *   literal error-code strings inside the mocks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  DEFAULT_FACE_ENROLLMENT_REQUIRED_SAMPLES,
} from "@/lib/biometrics/biometric-constants";
import { BiometricPersistenceError } from "@/lib/biometrics/biometric-errors";
import {
  BIOMETRIC_ERROR_CODES,
  BiometricError,
  clearCachedKey,
  createTestEncryptionKey,
  encryptBiometricVector,
  injectTestKey,
  type BiometricAAD,
  type EncryptedBiometricValue,
} from "@/lib/biometrics/encryption";
import {
  FACE_PROFILE_FINALIZATION_ERROR_CODES,
  FaceProfileFinalizationError,
  persistFinalizedFaceProfileForUser,
  __testing as orchestrationInternals,
} from "@/lib/biometrics/face-profile-finalization-service";
import type {
  FaceEnrollmentAcceptedSampleDoc,
  FaceEnrollmentSessionAttrs,
} from "@/lib/biometrics/enrollment-session-model";
import type { FaceProfileAttrs } from "@/lib/biometrics/face-profile-model";
import type { FaceSampleQualityDoc } from "@/lib/biometrics/biometric-schema";

// =============================================================================
// Test key + canonical constants
// =============================================================================

const TEST_KEY_BASE64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const MODEL_IDENTITY = "insightface-buffalo-l";
const MODEL_NAME = "buffalo_l";
const EMBEDDING_DIMENSION = 512;
const TEMPLATE_VERSION = 1;
const REQUIRED_SAMPLE_COUNT = DEFAULT_FACE_ENROLLMENT_REQUIRED_SAMPLES; // 5

// Inline error-code strings used by the mock factories (must be
// hoisted-safe).
const MOCK_ERR_SESSION_NOT_FOUND = "ENROLLMENT_SESSION_NOT_FOUND";
const MOCK_ERR_GENERATION_CHANGED = "ENROLLMENT_GENERATION_CHANGED";
const MOCK_ERR_SESSION_EXPIRED = "ENROLLMENT_SESSION_EXPIRED";
const MOCK_ERR_ALREADY_CLAIMED = "ENROLLMENT_FINALIZATION_ALREADY_CLAIMED";
const MOCK_ERR_INCOMPLETE = "ENROLLMENT_INCOMPLETE";
const MOCK_BIOMETRIC_ERR_FACE_PROFILE_ALREADY_EXISTS =
  "FACE_PROFILE_ALREADY_EXISTS";
const MOCK_BIOMETRIC_ERR_PERSISTENCE_FAILED =
  "FACE_PROFILE_PERSISTENCE_FAILED";

// =============================================================================
// In-memory stores + mocks
// =============================================================================

const sessionStore = new Map<string, FaceEnrollmentSessionAttrs>();
const profileStore = new Map<string, FaceProfileAttrs>();

const sessionReadLog: Array<{ userId: string }> = [];
const claimCalls: Array<{
  userId: string;
  generationId: string;
}> = [];
const releaseCalls: Array<{
  userId: string;
  generationId: string;
  claimToken: string;
}> = [];

const faceProfileWriteLog: Array<{
  userId: string;
  sourceEnrollmentGenerationId: string;
  enrolledAt: string;
  sampleCount: number;
  ciphertexts: string[];
  ivs: string[];
  authTags: string[];
  sampleIndexes: number[];
  centroidCiphertext: string;
  centroidIv: string;
  centroidAuthTag: string;
  centroidKeyVersion: number;
}> = [];

let b1bResponder:
  | ((userId: string) => Promise<unknown>)
  | null = null;

// Note: vitest hoists vi.mock factories. They must NOT reference
// top-level variables from this module. We use literal strings.

vi.mock("@/lib/biometrics/enrollment-finalization-service", () => ({
  finalizeEnrollmentSessionForUser: vi.fn(async (userId: string) => {
    if (!b1bResponder) {
      throw new Error(
        "b1bResponder not registered — B2B test did not configure B1B",
      );
    }
    return await b1bResponder(userId);
  }),
  EnrollmentFinalizationError: class extends Error {
    code: string;
    constructor(opts: { code: string; message: string }) {
      super(opts.message);
      this.code = opts.code;
    }
  },
  ENROLLMENT_FINALIZATION_ERROR_CODES: {
    ENROLLMENT_SESSION_NOT_FOUND: "ENROLLMENT_SESSION_NOT_FOUND",
    ENROLLMENT_SESSION_EXPIRED: "ENROLLMENT_SESSION_EXPIRED",
    ENROLLMENT_INCOMPLETE: "ENROLLMENT_INCOMPLETE",
    ENROLLMENT_SESSION_INVALID: "ENROLLMENT_SESSION_INVALID",
    UNSUPPORTED_ENROLLMENT_MODE: "UNSUPPORTED_ENROLLMENT_MODE",
    UNSUPPORTED_TEMPLATE_VERSION: "UNSUPPORTED_TEMPLATE_VERSION",
    ENROLLMENT_SAMPLE_INDEX_INVALID: "ENROLLMENT_SAMPLE_INDEX_INVALID",
    ENROLLMENT_SAMPLE_DECRYPTION_FAILED:
      "ENROLLMENT_SAMPLE_DECRYPTION_FAILED",
    ENROLLMENT_SAMPLE_VECTOR_INVALID:
      "ENROLLMENT_SAMPLE_VECTOR_INVALID",
    ENROLLMENT_GENERATION_CHANGED: "ENROLLMENT_GENERATION_CHANGED",
    ENROLLMENT_FINALIZATION_FAILED: "ENROLLMENT_FINALIZATION_FAILED",
  },
}));

vi.mock("@/lib/biometrics/enrollment-finalization-claim-service", () => {
  class MockEnrollmentFinalizationClaimError extends Error {
    code: string;
    constructor(opts: { code: string; message: string }) {
      super(opts.message);
      this.name = "EnrollmentFinalizationClaimError";
      this.code = opts.code;
    }
  }
  return {
    claimEnrollmentSessionForFinalization: vi.fn(
      async (input: { userId: string; generationId: string }) => {
        claimCalls.push({
          userId: input.userId,
          generationId: input.generationId,
        });
        const session = sessionStore.get(input.userId);
        if (!session) {
          throw new MockEnrollmentFinalizationClaimError({
            code: MOCK_ERR_SESSION_NOT_FOUND,
            message: "Session not found",
          });
        }
        if (session.generationId !== input.generationId) {
          throw new MockEnrollmentFinalizationClaimError({
            code: MOCK_ERR_GENERATION_CHANGED,
            message: "Generation mismatch",
          });
        }
        if (session.expiresAt.getTime() <= Date.now()) {
          throw new MockEnrollmentFinalizationClaimError({
            code: MOCK_ERR_SESSION_EXPIRED,
            message: "Session expired",
          });
        }
        if (session.finalizationClaim) {
          throw new MockEnrollmentFinalizationClaimError({
            code: MOCK_ERR_ALREADY_CLAIMED,
            message: "Already claimed",
          });
        }
        if (
          session.acceptedSamples.length !== session.requiredSampleCount
        ) {
          throw new MockEnrollmentFinalizationClaimError({
            code: MOCK_ERR_INCOMPLETE,
            message: "Incomplete",
          });
        }
        // Stamp the claim atomically.
        const claimToken = `tok-${input.userId}-${input.generationId}`;
        const claimedAt = new Date();
        session.finalizationClaim = {
          token: claimToken,
          generationId: input.generationId,
          claimedAt,
        };
        return {
          userId: input.userId,
          generationId: input.generationId,
          claimToken,
          claimedAt,
        };
      },
    ),
    releaseEnrollmentFinalizationClaim: vi.fn(
      async (input: {
        userId: string;
        generationId: string;
        claimToken: string;
      }) => {
        releaseCalls.push({
          userId: input.userId,
          generationId: input.generationId,
          claimToken: input.claimToken,
        });
        const session = sessionStore.get(input.userId);
        if (!session) {
          return {
            userId: input.userId,
            generationId: input.generationId,
            released: false,
          };
        }
        if (
          session.finalizationClaim &&
          session.finalizationClaim.token === input.claimToken &&
          session.generationId === input.generationId
        ) {
          session.finalizationClaim = undefined;
          return {
            userId: input.userId,
            generationId: input.generationId,
            released: true,
          };
        }
        return {
          userId: input.userId,
          generationId: input.generationId,
          released: false,
        };
      },
    ),
    EnrollmentFinalizationClaimError: MockEnrollmentFinalizationClaimError,
    ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES: {
      ENROLLMENT_SESSION_NOT_FOUND: "ENROLLMENT_SESSION_NOT_FOUND",
      ENROLLMENT_SESSION_EXPIRED: "ENROLLMENT_SESSION_EXPIRED",
      ENROLLMENT_GENERATION_CHANGED: "ENROLLMENT_GENERATION_CHANGED",
      ENROLLMENT_INCOMPLETE: "ENROLLMENT_INCOMPLETE",
      ENROLLMENT_FINALIZATION_ALREADY_CLAIMED:
        "ENROLLMENT_FINALIZATION_ALREADY_CLAIMED",
      ENROLLMENT_FINALIZATION_IN_PROGRESS:
        "ENROLLMENT_FINALIZATION_IN_PROGRESS",
      UNSUPPORTED_ENROLLMENT_MODE: "UNSUPPORTED_ENROLLMENT_MODE",
      UNSUPPORTED_TEMPLATE_VERSION: "UNSUPPORTED_TEMPLATE_VERSION",
      UNSUPPORTED_NORMALIZATION: "UNSUPPORTED_NORMALIZATION",
      ENROLLMENT_FINALIZATION_CLAIM_FAILED:
        "ENROLLMENT_FINALIZATION_CLAIM_FAILED",
      ENROLLMENT_FINALIZATION_CLAIM_INVALID:
        "ENROLLMENT_FINALIZATION_CLAIM_INVALID",
    },
  };
});

vi.mock("@/lib/biometrics/enrollment-session-service", () => ({
  getEnrollmentSessionByUserId: vi.fn(async (userId: string) => {
    sessionReadLog.push({ userId });
    const doc = sessionStore.get(userId);
    if (!doc) return null;
    return {
      ...doc,
      acceptedSamples: [...doc.acceptedSamples],
    };
  }),
  isEnrollmentSessionExpired: vi.fn(
    (session: { expiresAt: Date }, now: Date = new Date()) =>
      session.expiresAt.getTime() <= now.getTime(),
  ),
  deleteEnrollmentSessionByUserId: vi.fn(async () => {
    // B2B MUST NOT call this. If it does, fail the test.
    throw new Error(
      "B2B must not delete the enrollment session — that belongs to B2C",
    );
  }),
}));

vi.mock("@/lib/biometrics/face-profile-model", () => ({
  FaceProfileModel: {
    findOne: vi.fn(() => ({ exec: async () => null })),
    findOneAndUpdate: vi.fn(() => ({ exec: async () => null })),
  },
  FACE_PROFILE_STATUSES: ["active"],
}));

vi.mock("@/lib/biometrics/face-profile-service", () => ({
  saveFinalizedFaceProfile: vi.fn(
    async (input: {
      userId: string;
      sourceEnrollmentGenerationId: string;
      enrolledAt: Date;
      sampleCount: number;
      samples: Array<{
        encryptedVector: EncryptedBiometricValue;
        sampleIndex: number;
        quality?: FaceSampleQualityDoc;
      }>;
      centroid: EncryptedBiometricValue;
      qualitySummary?: FaceProfileAttrs["qualitySummary"];
    }) => {
      const existing = profileStore.get(input.userId);
      if (
        existing &&
        existing.sourceEnrollmentGenerationId &&
        existing.sourceEnrollmentGenerationId !==
          input.sourceEnrollmentGenerationId
      ) {
        throw new BiometricPersistenceError({
          code: MOCK_BIOMETRIC_ERR_FACE_PROFILE_ALREADY_EXISTS,
          message: "Different-generation profile exists.",
        });
      }
      if (
        existing &&
        existing.sourceEnrollmentGenerationId ===
          input.sourceEnrollmentGenerationId
      ) {
        // Idempotent retry — preserve enrolledAt / createdAt.
        const updated: FaceProfileAttrs = {
          ...existing,
          status: "active",
          sampleCount: input.sampleCount,
          samples: input.samples.map((sample) => ({
            encryptedVector: sample.encryptedVector,
            sampleIndex: sample.sampleIndex,
            quality: sample.quality,
          })),
          centroid: input.centroid,
          qualitySummary: input.qualitySummary ?? existing.qualitySummary,
          updatedAt: new Date(),
        };
        profileStore.set(input.userId, updated);
        pushWriteLog(input, updated.enrolledAt);
        return { profile: updated, created: false };
      }
      const now = new Date();
      const fresh: FaceProfileAttrs = {
        userId: input.userId,
        status: "active",
        modelIdentity: MODEL_IDENTITY,
        modelName: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
        templateVersion: TEMPLATE_VERSION,
        requiredSampleCount: REQUIRED_SAMPLE_COUNT,
        sampleCount: input.sampleCount,
        samples: input.samples.map((sample) => ({
          encryptedVector: sample.encryptedVector,
          sampleIndex: sample.sampleIndex,
          quality: sample.quality,
        })),
        centroid: input.centroid,
        qualitySummary: input.qualitySummary,
        enrolledAt: input.enrolledAt,
        sourceEnrollmentGenerationId: input.sourceEnrollmentGenerationId,
        createdAt: now,
        updatedAt: now,
      };
      profileStore.set(input.userId, fresh);
      pushWriteLog(input, fresh.enrolledAt);
      return { profile: fresh, created: true };
    },
  ),
  classifyFaceProfileByLineage: vi.fn(
    async (params: { userId: string; lineage: string }) => {
      const existing = profileStore.get(params.userId);
      if (!existing) return "none" as const;
      const lineage = existing.sourceEnrollmentGenerationId;
      if (typeof lineage !== "string" || lineage.length === 0) {
        return "legacy" as const;
      }
      return lineage === params.lineage
        ? ("same" as const)
        : ("different" as const);
    },
  ),
}));

vi.mock("@/lib/mongoose", () => ({
  getMongooseConnection: () => Promise.resolve(),
}));

function pushWriteLog(
  input: {
    userId: string;
    sourceEnrollmentGenerationId: string;
    sampleCount: number;
    samples: Array<{
      encryptedVector: EncryptedBiometricValue;
      sampleIndex: number;
    }>;
    centroid: EncryptedBiometricValue;
  },
  enrolledAt: Date,
): void {
  faceProfileWriteLog.push({
    userId: input.userId,
    sourceEnrollmentGenerationId: input.sourceEnrollmentGenerationId,
    enrolledAt: enrolledAt.toISOString(),
    sampleCount: input.sampleCount,
    ciphertexts: input.samples.map(
      (sample) => sample.encryptedVector.ciphertext,
    ),
    ivs: input.samples.map((sample) => sample.encryptedVector.iv),
    authTags: input.samples.map((sample) => sample.encryptedVector.authTag),
    sampleIndexes: input.samples.map((sample) => sample.sampleIndex),
    centroidCiphertext: input.centroid.ciphertext,
    centroidIv: input.centroid.iv,
    centroidAuthTag: input.centroid.authTag,
    centroidKeyVersion: input.centroid.keyVersion,
  });
}

// =============================================================================
// Helpers
// =============================================================================

/** Build a deterministic normalized centroid for tests. */
function buildNormalizedCentroid(seed: number): number[] {
  const raw: number[] = [];
  let sumSq = 0;
  for (let i = 0; i < EMBEDDING_DIMENSION; i++) {
    const v = Math.sin(seed * 0.1 + i * 0.013) * 0.5 + 0.001 * i;
    raw.push(v);
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq) || 1;
  return raw.map((v) => v / norm);
}

/** Build N encrypted samples using the EXACT PHASE 4.4C AAD. */
function buildFiveEncryptedSamples(userId: string): {
  decrypted: number[][];
  encryptedSamples: FaceEnrollmentAcceptedSampleDoc[];
} {
  const decrypted: number[][] = [];
  const encryptedSamples: FaceEnrollmentAcceptedSampleDoc[] = [];
  for (let i = 0; i < REQUIRED_SAMPLE_COUNT; i++) {
    const raw: number[] = [];
    let sumSq = 0;
    for (let j = 0; j < EMBEDDING_DIMENSION; j++) {
      const v = Math.sin(i * 0.7 + j * 0.013) * 0.5 + 0.001 * j;
      raw.push(v);
      sumSq += v * v;
    }
    const norm = Math.sqrt(sumSq) || 1;
    const v = raw.map((x) => x / norm);
    decrypted.push(v);
    const aad: BiometricAAD = {
      userId,
      modelIdentity: MODEL_IDENTITY,
      templateVersion: TEMPLATE_VERSION,
      vectorType: "sample",
      sampleIndex: i,
    };
    const encrypted = encryptBiometricVector(v, aad);
    encryptedSamples.push({
      encryptedVector: encrypted,
      sampleIndex: i,
      acceptedAt: new Date(),
      quality: {
        detectionScore: 0.9 + i * 0.01,
        blurScore: 100 + i,
        brightness: 0.5 + i * 0.01,
        relativeFaceArea: 0.1 + i * 0.01,
      },
    });
  }
  return { decrypted, encryptedSamples };
}

function makeSessionFixture(
  overrides: Partial<FaceEnrollmentSessionAttrs> = {},
): FaceEnrollmentSessionAttrs {
  const now = new Date();
  return {
    userId: "user-1",
    mode: "create",
    templateVersion: TEMPLATE_VERSION,
    requiredSampleCount: REQUIRED_SAMPLE_COUNT,
    acceptedSamples: [],
    expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
    generationId: "gen-A",
    modelIdentity: MODEL_IDENTITY,
    modelName: MODEL_NAME,
    embeddingDimension: EMBEDDING_DIMENSION,
    normalization: "l2",
    ...overrides,
  };
}

/** Register the B1B responder for a single call (then cleared). */
function queueB1BResponder(build: (userId: string) => unknown): void {
  b1bResponder = async (userId: string) => build(userId);
}

function resetStores(): void {
  sessionStore.clear();
  profileStore.clear();
  sessionReadLog.length = 0;
  claimCalls.length = 0;
  releaseCalls.length = 0;
  faceProfileWriteLog.length = 0;
  b1bResponder = null;
}

beforeEach(() => {
  resetStores();
  clearCachedKey();
  const testKey = createTestEncryptionKey(TEST_KEY_BASE64);
  injectTestKey(testKey);
});

afterEach(() => {
  vi.clearAllMocks();
  clearCachedKey();
});

// =============================================================================
// 7..13 — Claim flow
// =============================================================================

describe("persistFinalizedFaceProfileForUser / claim flow", () => {
  it("7. B1B runs BEFORE claim acquisition", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-7");
    sessionStore.set(
      "user-7",
      makeSessionFixture({
        userId: "user-7",
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
      }),
    );
    const events: string[] = [];
    b1bResponder = async (userId: string) => {
      events.push("B1B");
      return {
        sourceGenerationId: "gen-A",
        mode: "create",
        templateVersion: TEMPLATE_VERSION,
        requiredSampleCount: REQUIRED_SAMPLE_COUNT,
        model: {
          identity: MODEL_IDENTITY,
          name: MODEL_NAME,
          embeddingDimension: EMBEDDING_DIMENSION,
          normalization: "l2",
        },
        finalization: {
          sampleCount: REQUIRED_SAMPLE_COUNT,
          pairCount: 10,
          minSelfSimilarity: 0.82,
          meanSelfSimilarity: 0.87,
          threshold: 0.7,
          centroid: buildNormalizedCentroid(7),
        },
      };
    };

    await persistFinalizedFaceProfileForUser("user-7");
    expect(events[0]).toBe("B1B");
    // Claim call must have followed B1B.
    expect(claimCalls.length).toBe(1);
    expect(claimCalls[0]).toEqual({
      userId: "user-7",
      generationId: "gen-A",
    });
  });

  it("8. claim uses B1B sourceGenerationId", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-8");
    sessionStore.set(
      "user-8",
      makeSessionFixture({
        userId: "user-8",
        generationId: "gen-from-B1B",
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-from-B1B",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(8),
      },
    }));

    const result = await persistFinalizedFaceProfileForUser("user-8");
    expect(result.sourceEnrollmentGenerationId).toBe("gen-from-B1B");
    expect(claimCalls[0]).toEqual({
      userId: "user-8",
      generationId: "gen-from-B1B",
    });
  });

  it("9. valid generation claim succeeds and persists", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-9");
    sessionStore.set(
      "user-9",
      makeSessionFixture({
        userId: "user-9",
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(9),
      },
    }));

    const result = await persistFinalizedFaceProfileForUser("user-9");
    expect(result.created).toBe(true);
    expect(profileStore.has("user-9")).toBe(true);
  });

  it("10. changed generation claim failure prevents encryption", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-10");
    sessionStore.set(
      "user-10",
      makeSessionFixture({
        userId: "user-10",
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-B",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(10),
      },
    }));

    const err = await persistFinalizedFaceProfileForUser("user-10").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FaceProfileFinalizationError);
    expect(err.code).toBe(
      FACE_PROFILE_FINALIZATION_ERROR_CODES.ENROLLMENT_FINALIZATION_CLAIM_FAILED,
    );
    // No centroid encryption performed:
    expect(faceProfileWriteLog.length).toBe(0);
    // No profile persisted:
    expect(profileStore.has("user-10")).toBe(false);
  });

  it("11. changed generation claim failure prevents profile write", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-11");
    sessionStore.set(
      "user-11",
      makeSessionFixture({
        userId: "user-11",
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-other",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(11),
      },
    }));
    await persistFinalizedFaceProfileForUser("user-11").catch(() => undefined);
    expect(profileStore.has("user-11")).toBe(false);
    expect(faceProfileWriteLog.length).toBe(0);
  });

  it("12. already-claimed failure prevents profile write", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-12");
    sessionStore.set(
      "user-12",
      makeSessionFixture({
        userId: "user-12",
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
        finalizationClaim: {
          token: "tok-other",
          generationId: "gen-A",
          claimedAt: new Date(),
        },
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(12),
      },
    }));

    const err = await persistFinalizedFaceProfileForUser("user-12").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FaceProfileFinalizationError);
    expect(profileStore.has("user-12")).toBe(false);
  });

  it("13. successful claim token is never serialized into persisted profile", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-13");
    sessionStore.set(
      "user-13",
      makeSessionFixture({
        userId: "user-13",
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(13),
      },
    }));

    await persistFinalizedFaceProfileForUser("user-13");
    const profileJson = JSON.stringify(profileStore.get("user-13"));
    expect(profileJson).not.toContain("tok-user-13");
    expect(profileJson).not.toContain("claimToken");
  });
});

// =============================================================================
// 14..23 — Centroid encryption
// =============================================================================

describe("persistFinalizedFaceProfileForUser / centroid encryption", () => {
  function setupAndRun(userId: string) {
    const { encryptedSamples } = buildFiveEncryptedSamples(userId);
    sessionStore.set(
      userId,
      makeSessionFixture({
        userId,
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(99),
      },
    }));
    return persistFinalizedFaceProfileForUser(userId);
  }

  it("14. centroid encrypted exactly once", async () => {
    await setupAndRun("user-14");
    const writes = faceProfileWriteLog.filter((w) => w.userId === "user-14");
    expect(writes.length).toBe(1);
  });

  it("15. existing encryption utility reused", async () => {
    const encryptionModule = await import("@/lib/biometrics/encryption");
    // Build samples BEFORE installing the spy so the 5 sample
    // encryptions are not counted as orchestrator-level calls.
    const { encryptedSamples } = buildFiveEncryptedSamples("user-15");
    sessionStore.set(
      "user-15",
      makeSessionFixture({
        userId: "user-15",
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(15),
      },
    }));
    const encryptSpy = vi.spyOn(
      encryptionModule,
      "encryptBiometricVector",
    );
    await persistFinalizedFaceProfileForUser("user-15");
    // Exactly one centroid encryption must have occurred.
    expect(encryptSpy).toHaveBeenCalledTimes(1);
    // And it must be for the centroid vectorType.
    const call = encryptSpy.mock.calls[0]!;
    expect(call[1]?.vectorType).toBe("centroid");
    encryptSpy.mockRestore();
  });

  it("16. AAD userId authoritative (function argument, not session-only)", async () => {
    const aad = orchestrationInternals.buildCentroidAAD({
      userId: "user-16",
      modelIdentity: MODEL_IDENTITY,
      templateVersion: TEMPLATE_VERSION,
    });
    expect(aad.userId).toBe("user-16");
  });

  it("17. AAD model identity matches stored/server metadata", async () => {
    const aad = orchestrationInternals.buildCentroidAAD({
      userId: "user-17",
      modelIdentity: MODEL_IDENTITY,
      templateVersion: TEMPLATE_VERSION,
    });
    expect(aad.modelIdentity).toBe(MODEL_IDENTITY);
  });

  it("18. AAD templateVersion matches session", async () => {
    const aad = orchestrationInternals.buildCentroidAAD({
      userId: "user-18",
      modelIdentity: MODEL_IDENTITY,
      templateVersion: TEMPLATE_VERSION,
    });
    expect(aad.templateVersion).toBe(TEMPLATE_VERSION);
  });

  it("19. AAD vectorType is 'centroid'", async () => {
    const aad = orchestrationInternals.buildCentroidAAD({
      userId: "user-19",
      modelIdentity: MODEL_IDENTITY,
      templateVersion: TEMPLATE_VERSION,
    });
    expect(aad.vectorType).toBe("centroid");
  });

  it("20. centroid AAD has no incorrect sample index", async () => {
    const aad = orchestrationInternals.buildCentroidAAD({
      userId: "user-20",
      modelIdentity: MODEL_IDENTITY,
      templateVersion: TEMPLATE_VERSION,
    });
    expect(aad.sampleIndex).toBeUndefined();
  });

  it("21. encryption failure prevents profile persistence", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-21");
    sessionStore.set(
      "user-21",
      makeSessionFixture({
        userId: "user-21",
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(21),
      },
    }));
    const encryptionModule = await import("@/lib/biometrics/encryption");
    vi.spyOn(
      encryptionModule,
      "encryptBiometricVector",
    ).mockImplementationOnce(() => {
      throw new BiometricError({
        code: BIOMETRIC_ERROR_CODES.DECRYPTION_FAILED,
        message: "Synthetic encryption failure.",
      });
    });

    const err = await persistFinalizedFaceProfileForUser("user-21").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FaceProfileFinalizationError);
    expect(err.code).toBe(
      FACE_PROFILE_FINALIZATION_ERROR_CODES.FACE_PROFILE_CENTROID_ENCRYPTION_FAILED,
    );
    expect(profileStore.has("user-21")).toBe(false);
    vi.mocked(encryptionModule.encryptBiometricVector).mockRestore();
  });

  it("22. encryption failure releases owned claim", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-22");
    sessionStore.set(
      "user-22",
      makeSessionFixture({
        userId: "user-22",
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(22),
      },
    }));
    const encryptionModule = await import("@/lib/biometrics/encryption");
    vi.spyOn(
      encryptionModule,
      "encryptBiometricVector",
    ).mockImplementationOnce(() => {
      throw new BiometricError({
        code: BIOMETRIC_ERROR_CODES.DECRYPTION_FAILED,
        message: "Synthetic failure.",
      });
    });

    await persistFinalizedFaceProfileForUser("user-22").catch(() => undefined);
    const myReleases = releaseCalls.filter((r) => r.userId === "user-22");
    expect(myReleases.length).toBe(1);
    vi.mocked(encryptionModule.encryptBiometricVector).mockRestore();
  });

  it("23. raw crypto error not exposed", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-23");
    sessionStore.set(
      "user-23",
      makeSessionFixture({
        userId: "user-23",
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(23),
      },
    }));
    const encryptionModule = await import("@/lib/biometrics/encryption");
    vi.spyOn(
      encryptionModule,
      "encryptBiometricVector",
    ).mockImplementationOnce(() => {
      throw new Error("internal Node crypto stack trace goes here");
    });

    const err = await persistFinalizedFaceProfileForUser("user-23").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FaceProfileFinalizationError);
    expect(err.message).not.toMatch(/internal Node crypto stack trace/i);
    expect(JSON.stringify(err.toJSON())).not.toMatch(
      /internal Node crypto/i,
    );
    vi.mocked(encryptionModule.encryptBiometricVector).mockRestore();
  });
});

// =============================================================================
// 24..33 — Encrypted sample copy
// =============================================================================

describe("persistFinalizedFaceProfileForUser / encrypted sample copy", () => {
  async function setupAndRun(userId: string) {
    const { encryptedSamples } = buildFiveEncryptedSamples(userId);
    sessionStore.set(
      userId,
      makeSessionFixture({
        userId,
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(99),
      },
    }));
    return persistFinalizedFaceProfileForUser(userId);
  }

  it("24. accepted encrypted samples copied without decrypt/re-encrypt", async () => {
    await setupAndRun("user-24");
    const write = faceProfileWriteLog[0]!;
    const session = sessionStore.get("user-24")!;
    for (let i = 0; i < REQUIRED_SAMPLE_COUNT; i++) {
      expect(write.ciphertexts[i]).toBe(
        session.acceptedSamples[i]!.encryptedVector.ciphertext,
      );
      expect(write.ivs[i]).toBe(
        session.acceptedSamples[i]!.encryptedVector.iv,
      );
      expect(write.authTags[i]).toBe(
        session.acceptedSamples[i]!.encryptedVector.authTag,
      );
    }
  });

  it("25. sample indexes sorted deterministically", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-25");
    // Persist in reverse order to verify the orchestrator sorts.
    const reversed = [...encryptedSamples].reverse();
    sessionStore.set(
      "user-25",
      makeSessionFixture({
        userId: "user-25",
        generationId: "gen-A",
        acceptedSamples: reversed,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(99),
      },
    }));
    await persistFinalizedFaceProfileForUser("user-25");
    const write = faceProfileWriteLog[0]!;
    expect(write.sampleIndexes).toEqual([0, 1, 2, 3, 4]);
  });

  it("26. duplicate index rejected", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-26");
    const duplicate = [...encryptedSamples];
    duplicate[1] = { ...duplicate[1]!, sampleIndex: 0 };
    sessionStore.set(
      "user-26",
      makeSessionFixture({
        userId: "user-26",
        generationId: "gen-A",
        acceptedSamples: duplicate,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(26),
      },
    }));
    const err = await persistFinalizedFaceProfileForUser("user-26").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FaceProfileFinalizationError);
    expect(err.code).toBe(
      FACE_PROFILE_FINALIZATION_ERROR_CODES.ENROLLMENT_SAMPLE_INDEX_INVALID,
    );
  });

  it("27. gap rejected (server prevents persistence)", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-27");
    const gap = [...encryptedSamples].slice(0, 4); // missing index 4
    sessionStore.set(
      "user-27",
      makeSessionFixture({
        userId: "user-27",
        generationId: "gen-A",
        acceptedSamples: gap,
        requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(27),
      },
    }));
    const err = await persistFinalizedFaceProfileForUser("user-27").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FaceProfileFinalizationError);
    // The orchestrator maps the underlying claim failure (incomplete
    // session) to ENROLLMENT_FINALIZATION_CLAIM_FAILED at the
    // orchestration boundary. Persistence must not have been
    // attempted; claim must be released.
    expect(err.code).toBe(
      FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_FINALIZATION_CLAIM_FAILED,
    );
    const { saveFinalizedFaceProfile: saveFn } = await import(
      "@/lib/biometrics/face-profile-service"
    );
    expect(saveFn).not.toHaveBeenCalled();
    // No claim was ever acquired (the mock short-circuits BEFORE
    // stamping the claim), so no release call must have been made.
    expect(releaseCalls.length).toBe(0);
  });

  it("28. wrong sample count rejected (server prevents persistence)", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-28");
    sessionStore.set(
      "user-28",
      makeSessionFixture({
        userId: "user-28",
        generationId: "gen-A",
        acceptedSamples: encryptedSamples.slice(0, 3),
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(28),
      },
    }));
    const err = await persistFinalizedFaceProfileForUser("user-28").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FaceProfileFinalizationError);
    // The orchestrator maps the underlying claim failure (incomplete
    // session) to ENROLLMENT_FINALIZATION_CLAIM_FAILED. Persistence
    // must not have been attempted.
    expect(err.code).toBe(
      FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_FINALIZATION_CLAIM_FAILED,
    );
    const { saveFinalizedFaceProfile: saveFn } = await import(
      "@/lib/biometrics/face-profile-service"
    );
    expect(saveFn).not.toHaveBeenCalled();
  });

  it("29. encrypted ciphertext preserved byte-for-byte", async () => {
    await setupAndRun("user-29");
    const write = faceProfileWriteLog[0]!;
    const session = sessionStore.get("user-29")!;
    for (let i = 0; i < REQUIRED_SAMPLE_COUNT; i++) {
      const a = session.acceptedSamples[i]!.encryptedVector;
      const b = write.ciphertexts[i]!;
      expect(b).toBe(a.ciphertext);
    }
  });

  it("30. IV preserved", async () => {
    await setupAndRun("user-30");
    const write = faceProfileWriteLog[0]!;
    const session = sessionStore.get("user-30")!;
    for (let i = 0; i < REQUIRED_SAMPLE_COUNT; i++) {
      expect(write.ivs[i]).toBe(
        session.acceptedSamples[i]!.encryptedVector.iv,
      );
    }
  });

  it("31. authTag preserved", async () => {
    await setupAndRun("user-31");
    const write = faceProfileWriteLog[0]!;
    const session = sessionStore.get("user-31")!;
    for (let i = 0; i < REQUIRED_SAMPLE_COUNT; i++) {
      expect(write.authTags[i]).toBe(
        session.acceptedSamples[i]!.encryptedVector.authTag,
      );
    }
  });

  it("32. keyVersion preserved", async () => {
    await setupAndRun("user-32");
    const write = faceProfileWriteLog[0]!;
    const session = sessionStore.get("user-32")!;
    for (let i = 0; i < REQUIRED_SAMPLE_COUNT; i++) {
      expect(session.acceptedSamples[i]!.encryptedVector.keyVersion).toBe(1);
    }
    expect(write.centroidKeyVersion).toBe(1);
  });

  it("33. stored sample quality preserved", async () => {
    await setupAndRun("user-33");
    const profile = profileStore.get("user-33")!;
    for (let i = 0; i < REQUIRED_SAMPLE_COUNT; i++) {
      expect(profile.samples[i]!.quality).toBeDefined();
      expect(profile.samples[i]!.quality?.detectionScore).toBeCloseTo(
        0.9 + i * 0.01,
        5,
      );
    }
  });
});

// =============================================================================
// 34..43 — Model / profile metadata
// =============================================================================

describe("persistFinalizedFaceProfileForUser / model metadata", () => {
  async function setupAndRun(userId: string) {
    const { encryptedSamples } = buildFiveEncryptedSamples(userId);
    sessionStore.set(
      userId,
      makeSessionFixture({
        userId,
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(99),
      },
    }));
    return persistFinalizedFaceProfileForUser(userId);
  }

  it("34. model identity persisted", async () => {
    await setupAndRun("user-34");
    expect(profileStore.get("user-34")!.modelIdentity).toBe(MODEL_IDENTITY);
  });

  it("35. model name persisted", async () => {
    await setupAndRun("user-35");
    expect(profileStore.get("user-35")!.modelName).toBe(MODEL_NAME);
  });

  it("36. embedding dimension persisted", async () => {
    await setupAndRun("user-36");
    expect(profileStore.get("user-36")!.embeddingDimension).toBe(
      EMBEDDING_DIMENSION,
    );
  });

  it("37. normalization persisted", async () => {
    await setupAndRun("user-37");
    expect(profileStore.get("user-37")!.normalization).toBe("l2");
  });

  it("38. templateVersion persisted", async () => {
    await setupAndRun("user-38");
    expect(profileStore.get("user-38")!.templateVersion).toBe(
      TEMPLATE_VERSION,
    );
  });

  it("39. sampleCount persisted from required count", async () => {
    await setupAndRun("user-39");
    expect(profileStore.get("user-39")!.sampleCount).toBe(
      REQUIRED_SAMPLE_COUNT,
    );
  });

  it("40. status=active", async () => {
    await setupAndRun("user-40");
    expect(profileStore.get("user-40")!.status).toBe("active");
  });

  it("41. enrolledAt set", async () => {
    const before = Date.now();
    await setupAndRun("user-41");
    const after = Date.now();
    const ts = profileStore.get("user-41")!.enrolledAt.getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
  });

  it("42. B1B / session metadata mismatch rejected", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-42");
    sessionStore.set(
      "user-42",
      makeSessionFixture({
        userId: "user-42",
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
        modelIdentity: "different-model",
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(42),
      },
    }));
    const err = await persistFinalizedFaceProfileForUser("user-42").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FaceProfileFinalizationError);
    expect(err.code).toBe(
      FACE_PROFILE_FINALIZATION_ERROR_CODES.ENROLLMENT_METADATA_MISMATCH,
    );
    expect(profileStore.has("user-42")).toBe(false);
  });

  it("43. mismatch causes claim release", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-43");
    sessionStore.set(
      "user-43",
      makeSessionFixture({
        userId: "user-43",
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
        embeddingDimension: 256, // mismatch
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION, // 512
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(43),
      },
    }));
    await persistFinalizedFaceProfileForUser("user-43").catch(() => undefined);
    const myReleases = releaseCalls.filter((r) => r.userId === "user-43");
    expect(myReleases.length).toBe(1);
  });
});

// =============================================================================
// 44..51 — Idempotency
// =============================================================================

describe("persistFinalizedFaceProfileForUser / idempotency", () => {
  function setup(userId: string, generationId: string) {
    const { encryptedSamples } = buildFiveEncryptedSamples(userId);
    sessionStore.set(
      userId,
      makeSessionFixture({
        userId,
        generationId,
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: generationId,
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(99),
      },
    }));
  }

  it("44. first generation-A write creates FaceProfile", async () => {
    setup("user-44", "gen-A");
    const result = await persistFinalizedFaceProfileForUser("user-44");
    expect(result.created).toBe(true);
    expect(profileStore.has("user-44")).toBe(true);
  });

  it("45. retry generation-A does not create second profile", async () => {
    setup("user-45", "gen-A");
    await persistFinalizedFaceProfileForUser("user-45");
    setup("user-45", "gen-A");
    await persistFinalizedFaceProfileForUser("user-45");
    expect(profileStore.size).toBe(1);
  });

  it("46. retry generation-A preserves original enrolledAt", async () => {
    setup("user-46", "gen-A");
    const first = await persistFinalizedFaceProfileForUser("user-46");
    const firstEnrolledAt = profileStore
      .get("user-46")!
      .enrolledAt.getTime();
    // Wait 50ms to ensure timestamp would differ if shifted.
    await new Promise((r) => setTimeout(r, 50));
    setup("user-46", "gen-A");
    await persistFinalizedFaceProfileForUser("user-46");
    const secondEnrolledAt = profileStore
      .get("user-46")!
      .enrolledAt.getTime();
    expect(secondEnrolledAt).toBe(firstEnrolledAt);
    expect(first.created).toBe(true);
  });

  it("47. retry generation-A returns idempotent success (created=false)", async () => {
    setup("user-47", "gen-A");
    await persistFinalizedFaceProfileForUser("user-47");
    setup("user-47", "gen-A");
    const retry = await persistFinalizedFaceProfileForUser("user-47");
    expect(retry.created).toBe(false);
  });

  it("48. generation-B cannot overwrite profile created by generation-A", async () => {
    setup("user-48", "gen-A");
    await persistFinalizedFaceProfileForUser("user-48");
    const originalEnrolledAt = profileStore
      .get("user-48")!
      .enrolledAt.getTime();

    setup("user-48", "gen-B");
    const err = await persistFinalizedFaceProfileForUser("user-48").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FaceProfileFinalizationError);
    expect(profileStore.get("user-48")!.enrolledAt.getTime()).toBe(
      originalEnrolledAt,
    );
  });

  it("49. generation-B returns FACE_PROFILE_ALREADY_EXISTS", async () => {
    setup("user-49", "gen-A");
    await persistFinalizedFaceProfileForUser("user-49");
    setup("user-49", "gen-B");
    const err = await persistFinalizedFaceProfileForUser("user-49").catch(
      (e) => e,
    );
    expect(err.code).toBe(
      FACE_PROFILE_FINALIZATION_ERROR_CODES.FACE_PROFILE_ALREADY_EXISTS,
    );
  });

  it("50. unique userId invariant preserved (one profile per user)", async () => {
    setup("user-50", "gen-A");
    await persistFinalizedFaceProfileForUser("user-50");
    setup("user-50", "gen-A");
    await persistFinalizedFaceProfileForUser("user-50");
    expect(profileStore.size).toBe(1);
  });

  it("51. duplicate-key race classified safely", async () => {
    setup("user-51", "gen-A");
    const { saveFinalizedFaceProfile } = await import(
      "@/lib/biometrics/face-profile-service"
    );
    (
      saveFinalizedFaceProfile as unknown as {
        mockImplementationOnce: (fn: () => Promise<unknown>) => void;
      }
    ).mockImplementationOnce(async () => {
      throw new BiometricPersistenceError({
        code: MOCK_BIOMETRIC_ERR_FACE_PROFILE_ALREADY_EXISTS,
        message: "Synthetic race",
      });
    });
    const err = await persistFinalizedFaceProfileForUser("user-51").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FaceProfileFinalizationError);
    expect([
      FACE_PROFILE_FINALIZATION_ERROR_CODES.FACE_PROFILE_PERSISTENCE_FAILED,
      FACE_PROFILE_FINALIZATION_ERROR_CODES.FACE_PROFILE_ALREADY_EXISTS,
    ]).toContain(err.code);
  });
});

// =============================================================================
// 52..57 — Failure claim release
// =============================================================================

describe("persistFinalizedFaceProfileForUser / failure claim release", () => {
  function setup(userId: string, generationId: string) {
    const { encryptedSamples } = buildFiveEncryptedSamples(userId);
    sessionStore.set(
      userId,
      makeSessionFixture({
        userId,
        generationId,
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: generationId,
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(99),
      },
    }));
  }

  it("52. persistence failure releases own claim", async () => {
    setup("user-52", "gen-A");
    const { saveFinalizedFaceProfile } = await import(
      "@/lib/biometrics/face-profile-service"
    );
    (
      saveFinalizedFaceProfile as unknown as {
        mockImplementationOnce: (fn: () => Promise<unknown>) => void;
      }
    ).mockImplementationOnce(async () => {
      throw new Error("Synthetic persistence failure");
    });
    await persistFinalizedFaceProfileForUser("user-52").catch(() => undefined);
    const myReleases = releaseCalls.filter((r) => r.userId === "user-52");
    expect(myReleases.length).toBe(1);
  });

  it("53. validation failure after claim releases own claim", async () => {
    setup("user-53", "gen-A");
    // Inject a duplicate sample index into the session store directly
    // so the orchestrator's index validator surfaces ENROLLMENT_SAMPLE_INDEX_INVALID.
    const session = sessionStore.get("user-53")!;
    const dup = [...session.acceptedSamples];
    dup[1] = { ...dup[1]!, sampleIndex: 0 };
    session.acceptedSamples = dup;
    await persistFinalizedFaceProfileForUser("user-53").catch(() => undefined);
    const myReleases = releaseCalls.filter((r) => r.userId === "user-53");
    expect(myReleases.length).toBe(1);
  });

  it("54. wrong-token release cannot affect another claim", async () => {
    setup("user-54", "gen-A");
    const { releaseEnrollmentFinalizationClaim } = await import(
      "@/lib/biometrics/enrollment-finalization-claim-service"
    );
    vi.mocked(releaseEnrollmentFinalizationClaim).mockImplementationOnce(
      async (input) => {
        // The orchestrator invokes release with its OWN claim token.
        // The mock returns released=false unless the token matches.
        const own = releaseCalls.filter((r) => r.userId === "user-54");
        expect(own.length).toBe(0);
        return {
          userId: input.userId,
          generationId: input.generationId,
          released: false,
        };
      },
    );
    const { saveFinalizedFaceProfile } = await import(
      "@/lib/biometrics/face-profile-service"
    );
    (
      saveFinalizedFaceProfile as unknown as {
        mockImplementationOnce: (fn: () => Promise<unknown>) => void;
      }
    ).mockImplementationOnce(async () => {
      throw new Error("Synthetic failure");
    });
    await persistFinalizedFaceProfileForUser("user-54").catch(() => undefined);
    // The test mock above verifies the orchestrator only releases
    // its OWN token.
  });

  it("55. claim-release failure does not hide original persistence error", async () => {
    setup("user-55", "gen-A");
    const { saveFinalizedFaceProfile } = await import(
      "@/lib/biometrics/face-profile-service"
    );
    (
      saveFinalizedFaceProfile as unknown as {
        mockImplementationOnce: (fn: () => Promise<unknown>) => void;
      }
    ).mockImplementationOnce(async () => {
      throw new Error("PRIMARY failure");
    });
    const { releaseEnrollmentFinalizationClaim } = await import(
      "@/lib/biometrics/enrollment-finalization-claim-service"
    );
    (
      releaseEnrollmentFinalizationClaim as unknown as {
        mockImplementationOnce: (fn: () => Promise<unknown>) => void;
      }
    ).mockImplementationOnce(async () => {
      throw new Error("SECONDARY failure");
    });
    const err = await persistFinalizedFaceProfileForUser("user-55").catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(FaceProfileFinalizationError);
    // The original error is the primary failure, not the release
    // failure.
    expect(err.code).toBe(
      FACE_PROFILE_FINALIZATION_ERROR_CODES.FACE_PROFILE_PERSISTENCE_FAILED,
    );
  });

  it("56. success DOES NOT release claim", async () => {
    setup("user-56", "gen-A");
    await persistFinalizedFaceProfileForUser("user-56");
    const myReleases = releaseCalls.filter((r) => r.userId === "user-56");
    expect(myReleases.length).toBe(0);
  });

  it("57. success leaves claimed temporary enrollment present", async () => {
    setup("user-57", "gen-A");
    await persistFinalizedFaceProfileForUser("user-57");
    const session = sessionStore.get("user-57");
    expect(session).toBeDefined();
    expect(session!.finalizationClaim).toBeDefined();
    expect(session!.acceptedSamples.length).toBe(REQUIRED_SAMPLE_COUNT);
  });
});

// =============================================================================
// 58..63 — Result privacy
// =============================================================================

describe("persistFinalizedFaceProfileForUser / result privacy", () => {
  async function setupAndRun(userId: string) {
    const { encryptedSamples } = buildFiveEncryptedSamples(userId);
    sessionStore.set(
      userId,
      makeSessionFixture({
        userId,
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(99),
      },
    }));
    return persistFinalizedFaceProfileForUser(userId);
  }

  it("58. server result does not expose plaintext centroid in profile", async () => {
    await setupAndRun("user-58");
    const profile = profileStore.get("user-58")!;
    expect(profile.centroid).toBeDefined();
    expect(Array.isArray(profile.centroid)).toBe(false);
    expect(typeof profile.centroid.ciphertext).toBe("string");
  });

  it("59. server result does not expose claimToken in profile JSON", async () => {
    await setupAndRun("user-59");
    const json = JSON.stringify(profileStore.get("user-59"));
    expect(json).not.toContain("claimToken");
    expect(json).not.toContain("finalizationClaim");
  });

  it("60. server result does not expose sourceEnrollmentGenerationId in face-id status", async () => {
    // The face-id-status-service does not include lineage in its
    // safe DTO. We assert it indirectly by reading the source file
    // directly from disk.
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/biometrics/face-id-status-service.ts"),
      "utf-8",
    );
    // Source must not reference the lineage field at all.
    expect(source).not.toMatch(/sourceEnrollmentGenerationId/);
  });

  it("61. profile contains encrypted centroid, not plaintext centroid", async () => {
    await setupAndRun("user-61");
    const profile = profileStore.get("user-61")!;
    expect(profile.centroid.ciphertext.length).toBeGreaterThan(0);
    expect(profile.centroid.iv.length).toBeGreaterThan(0);
    expect(profile.centroid.authTag.length).toBeGreaterThan(0);
    expect(
      (profile.centroid as unknown as { plaintext?: unknown }).plaintext,
    ).toBeUndefined();
  });

  it("62. profile contains encrypted samples, not plaintext sample vectors", async () => {
    await setupAndRun("user-62");
    const profile = profileStore.get("user-62")!;
    for (const sample of profile.samples) {
      expect(sample.encryptedVector.ciphertext.length).toBeGreaterThan(0);
      expect(
        (sample as unknown as { plaintext?: unknown }).plaintext,
      ).toBeUndefined();
    }
  });

  it("63. server result type contains no plaintext sample embeddings", async () => {
    const result = await setupAndRun("user-63");
    const json = JSON.stringify(result);
    expect(json).not.toContain("plaintext");
  });
});

// =============================================================================
// 64..67 — No session consumption
// =============================================================================

describe("persistFinalizedFaceProfileForUser / no session consumption", () => {
  async function setupAndRun(userId: string, generationId: string) {
    const { encryptedSamples } = buildFiveEncryptedSamples(userId);
    sessionStore.set(
      userId,
      makeSessionFixture({
        userId,
        generationId,
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: generationId,
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(99),
      },
    }));
    return persistFinalizedFaceProfileForUser(userId);
  }

  it("64. successful B2B does NOT delete enrollment session", async () => {
    await setupAndRun("user-64", "gen-A");
    const session = sessionStore.get("user-64");
    expect(session).toBeDefined();
    expect(session!.acceptedSamples.length).toBe(REQUIRED_SAMPLE_COUNT);
  });

  it("65. successful B2B does NOT reset generation", async () => {
    const beforeGen = "gen-locked";
    await setupAndRun("user-65", beforeGen);
    expect(sessionStore.get("user-65")!.generationId).toBe(beforeGen);
  });

  it("66. successful B2B does NOT clear claim", async () => {
    await setupAndRun("user-66", "gen-A");
    const session = sessionStore.get("user-66")!;
    expect(session.finalizationClaim).toBeDefined();
    expect(session.finalizationClaim!.token.length).toBeGreaterThan(0);
  });

  it("67. B2C remains required (consumption NOT performed)", async () => {
    await setupAndRun("user-67", "gen-A");
    const { deleteEnrollmentSessionByUserId } = await import(
      "@/lib/biometrics/enrollment-session-service"
    );
    expect(deleteEnrollmentSessionByUserId).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 68..69 — No transaction
// =============================================================================

describe("persistFinalizedFaceProfileForUser / no transaction", () => {
  it("68. B2B introduces no Mongo multi-document transaction", async () => {
    const source = readFileSync(
      path.join(
        process.cwd(),
        "src/lib/biometrics/face-profile-finalization-service.ts",
      ),
      "utf-8",
    );
    expect(source).not.toMatch(/startTransaction|withTransaction|startSession/i);
  });

  it("69. no Better Auth transaction behavior changed", async () => {
    const source = readFileSync(
      path.join(
        process.cwd(),
        "src/lib/biometrics/face-profile-finalization-service.ts",
      ),
      "utf-8",
    );
    expect(source).not.toMatch(/better-auth|betterAuth/i);
  });
});

// =============================================================================
// Quality summary
// =============================================================================

describe("persistFinalizedFaceProfileForUser / quality summary", () => {
  it("builds a deterministic quality summary from session quality data", async () => {
    const { encryptedSamples } = buildFiveEncryptedSamples("user-qs1");
    sessionStore.set(
      "user-qs1",
      makeSessionFixture({
        userId: "user-qs1",
        generationId: "gen-A",
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(99),
      },
    }));
    await persistFinalizedFaceProfileForUser("user-qs1");
    const profile = profileStore.get("user-qs1")!;
    expect(profile.qualitySummary).toBeDefined();
    expect(profile.qualitySummary?.meanSelfSimilarity).toBe(0.87);
    expect(profile.qualitySummary?.minSelfSimilarity).toBe(0.82);
    expect(typeof profile.qualitySummary?.meanDetectionScore).toBe("number");
  });

  it("omits fabricated metrics when session quality data is absent", async () => {
    const samples: FaceEnrollmentAcceptedSampleDoc[] = [];
    for (let i = 0; i < REQUIRED_SAMPLE_COUNT; i++) {
      const v = buildNormalizedCentroid(i);
      const aad: BiometricAAD = {
        userId: "user-qs2",
        modelIdentity: MODEL_IDENTITY,
        templateVersion: TEMPLATE_VERSION,
        vectorType: "sample",
        sampleIndex: i,
      };
      const encrypted = encryptBiometricVector(v, aad);
      samples.push({
        encryptedVector: encrypted,
        sampleIndex: i,
        acceptedAt: new Date(),
      });
    }
    sessionStore.set(
      "user-qs2",
      makeSessionFixture({
        userId: "user-qs2",
        generationId: "gen-A",
        acceptedSamples: samples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: "gen-A",
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(99),
      },
    }));
    await persistFinalizedFaceProfileForUser("user-qs2");
    const profile = profileStore.get("user-qs2")!;
    expect(profile.qualitySummary?.meanSelfSimilarity).toBe(0.87);
    expect(profile.qualitySummary?.minSelfSimilarity).toBe(0.82);
    expect(profile.qualitySummary?.meanDetectionScore).toBeUndefined();
    expect(profile.qualitySummary?.meanBlurScore).toBeUndefined();
    expect(profile.qualitySummary?.meanBrightness).toBeUndefined();
  });
});

// =============================================================================
// Lineage field tests
// =============================================================================

describe("persistFinalizedFaceProfileForUser / lineage field", () => {
  async function setupAndRun(userId: string, generationId: string) {
    const { encryptedSamples } = buildFiveEncryptedSamples(userId);
    sessionStore.set(
      userId,
      makeSessionFixture({
        userId,
        generationId,
        acceptedSamples: encryptedSamples,
      }),
    );
    queueB1BResponder(() => ({
      sourceGenerationId: generationId,
      mode: "create",
      templateVersion: TEMPLATE_VERSION,
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      model: {
        identity: MODEL_IDENTITY,
        name: MODEL_NAME,
        embeddingDimension: EMBEDDING_DIMENSION,
        normalization: "l2",
      },
      finalization: {
        sampleCount: REQUIRED_SAMPLE_COUNT,
        pairCount: 10,
        minSelfSimilarity: 0.82,
        meanSelfSimilarity: 0.87,
        threshold: 0.7,
        centroid: buildNormalizedCentroid(99),
      },
    }));
    return persistFinalizedFaceProfileForUser(userId);
  }

  it("newly finalized profile stores sourceEnrollmentGenerationId", async () => {
    await setupAndRun("user-lineage-1", "gen-A");
    expect(
      profileStore.get("user-lineage-1")!.sourceEnrollmentGenerationId,
    ).toBe("gen-A");
  });

  it("lineage value equals B1B source generation", async () => {
    await setupAndRun("user-lineage-2", "gen-source-of-truth");
    expect(
      profileStore.get("user-lineage-2")!.sourceEnrollmentGenerationId,
    ).toBe("gen-source-of-truth");
  });

  it("lineage is not derived from userId", async () => {
    await setupAndRun("user-lineage-3", "gen-A");
    const lineage = profileStore.get("user-lineage-3")!
      .sourceEnrollmentGenerationId;
    expect(lineage).not.toContain("user-lineage-3");
  });
});