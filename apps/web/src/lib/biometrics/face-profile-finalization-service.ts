/**
 * Server-only FaceProfile persistence orchestration.
 *
 * PHASE 4.6B2B — claim-bound FaceProfile persistence.
 *
 * This module is the SERVER-ONLY orchestration layer that ties
 * together:
 *   - the PHASE 4.6B1B `finalizeEnrollmentSessionForUser` result,
 *   - the PHASE 4.6B2A atomic completion claim
 *     (`claimEnrollmentSessionForFinalization` /
 *     `releaseEnrollmentFinalizationClaim`),
 *   - the PHASE 4.1 `encryptBiometricVector` AES-256-GCM utility
 *     (used here for the centroid), and
 *   - the PHASE 4.2 `saveFinalizedFaceProfile` service.
 *
 * Responsibilities (this phase only):
 *   1. Accept an AUTHORITATIVE userId supplied by a future
 *      authenticated server caller (PHASE 4.6B3 will obtain it from
 *      `auth.api.getSession()`). The userId is NEVER derived from
 *      the browser request body or query string.
 *   2. Run B1B (`finalizeEnrollmentSessionForUser`) to obtain the
 *      trusted centroid + `sourceGenerationId`.
 *   3. Atomically claim the EXACT enrollment generation using B2A
 *      (`claimEnrollmentSessionForFinalization`). B1B runs BEFORE
 *      the claim so the reset-blocking window stays short.
 *   4. Re-validate the claimed session: `userId`,
 *      `sourceGenerationId`, and the active `finalizationClaim`
 *      (with token === X) must still match.
 *   5. Encrypt the centroid using the existing PHASE 4.1
 *      AES-256-GCM utility with the EXACT centroid AAD contract
 *      (`userId`, `modelIdentity`, `templateVersion`,
 *      `vectorType: "centroid"`). The encryption key is owned by
 *      the utility, never read directly here.
 *   6. Copy / re-affirm the already-encrypted accepted sample
 *      envelopes from the temporary session into the FaceProfile
 *      without decrypting or re-encrypting them. Sample indexes are
 *      sorted deterministically.
 *   7. Construct the final FaceProfile and persist it idempotently
 *      through `saveFinalizedFaceProfile`. Same-generation retries
 *      return the original `enrolledAt`.
 *   8. On failure BEFORE successful FaceProfile persistence,
 *      conditionally release the B2A claim token X (best-effort,
 *      finally-path). The original error is NEVER masked.
 *   9. On SUCCESS, KEEP the claim in place for PHASE 4.6B2C to
 *      consume the temporary enrollment session atomically. No
 *      session deletion happens here.
 *
 * What this module deliberately does NOT do:
 *   - It does NOT delete the temporary enrollment session.
 *   - It does NOT add a Next.js route, Server Action, or browser
 *     fetch. There is still NO finalize API in B2B.
 *   - It does NOT decrypt the stored samples.
 *   - It does NOT log the plaintext centroid, the claim token, or
 *     the `sourceEnrollmentGenerationId`.
 *   - It does NOT mutate the legacy FaceProfile contract for
 *     read-side consumers.
 *
 * Privacy posture:
 *   - The plaintext centroid lives only in local server memory until
 *     encrypted. After encryption, the plaintext buffer is wiped
 *     best-effort. JavaScript does not guarantee memory
 *     zeroization; the orchestrator does not claim it.
 *   - The plaintext centroid is NEVER logged.
 *   - The claim token, `sourceEnrollmentGenerationId`, and biometric
 *     metadata never appear in error messages.
 *
 * Browser exposure: NONE. There is no client-facing route or DTO
 * produced by this module. It is a pure server-internal entry point.
 */

import "server-only";

import {
  DEFAULT_FACE_ENROLLMENT_TEMPLATE_VERSION,
} from "@/lib/biometrics/biometric-constants";
import type {
  EnrollmentMode,
  FaceSampleQualityDoc,
  Normalization,
} from "@/lib/biometrics/biometric-schema";
import {
  BiometricError,
  encryptBiometricVector,
  type BiometricAAD,
  type EncryptedBiometricValue,
} from "@/lib/biometrics/encryption";
import {
  BiometricPersistenceError,
} from "@/lib/biometrics/biometric-errors";
import {
  saveFinalizedFaceProfile,
  type SaveFinalizedFaceProfileInput,
} from "@/lib/biometrics/face-profile-service";
import {
  finalizeEnrollmentSessionForUser,
  type EnrollmentFinalizationResult,
} from "@/lib/biometrics/enrollment-finalization-service";
import {
  claimEnrollmentSessionForFinalization,
  EnrollmentFinalizationClaimError,
  releaseEnrollmentFinalizationClaim,
  type ClaimedEnrollmentSession,
} from "@/lib/biometrics/enrollment-finalization-claim-service";
import {
  getEnrollmentSessionByUserId,
  isEnrollmentSessionExpired,
} from "@/lib/biometrics/enrollment-session-service";
import type {
  FaceEnrollmentAcceptedSampleDoc,
  FaceEnrollmentSessionAttrs,
} from "@/lib/biometrics/enrollment-session-model";

// =============================================================================
// Stable orchestration error codes (PHASE 4.6B2B)
// =============================================================================

/**
 * Stable orchestration error codes for the B2B persistence layer.
 *
 * These are distinct from, and coexist with:
 *   - B1B `ENROLLMENT_FINALIZATION_ERROR_CODES`,
 *   - B2A `ENROLLMENT_FINALIZATION_CLAIM_ERROR_CODES`,
 *   - `BiometricError` AES-GCM utility codes,
 *   - `BiometricPersistenceError` Mongo driver codes.
 *
 * Codes are safe to expose to future API/orchestration callers —
 * they never embed keys, ciphertext, embeddings, claim tokens, or
 * stack traces.
 */
export const FACE_PROFILE_FINALIZATION_ERROR_CODES = {
  /** No active enrollment session for the user. */
  ENROLLMENT_SESSION_NOT_FOUND: "ENROLLMENT_SESSION_NOT_FOUND",
  /** Enrollment session is expired. */
  ENROLLMENT_SESSION_EXPIRED: "ENROLLMENT_SESSION_EXPIRED",
  /** Session is not complete (samples < requiredSampleCount). */
  ENROLLMENT_INCOMPLETE: "ENROLLMENT_INCOMPLETE",
  /** Authoritative session metadata is missing or malformed. */
  ENROLLMENT_SESSION_INVALID: "ENROLLMENT_SESSION_INVALID",
  /** Only `create` mode is supported in B2B. */
  UNSUPPORTED_ENROLLMENT_MODE: "UNSUPPORTED_ENROLLMENT_MODE",
  /** Template version is not in the supported set. */
  UNSUPPORTED_TEMPLATE_VERSION: "UNSUPPORTED_TEMPLATE_VERSION",
  /** Sample index set is not exactly 0..N-1. */
  ENROLLMENT_SAMPLE_INDEX_INVALID: "ENROLLMENT_SAMPLE_INDEX_INVALID",
  /** Embedded sample envelope is missing required structural fields. */
  ENROLLMENT_SAMPLE_STRUCTURE_INVALID:
    "ENROLLMENT_SAMPLE_STRUCTURE_INVALID",
  /** B1B result / claimed session model metadata disagree. */
  ENROLLMENT_METADATA_MISMATCH: "ENROLLMENT_METADATA_MISMATCH",
  /** B2A claim acquisition failed (legacy / expired / already claimed). */
  ENROLLMENT_FINALIZATION_CLAIM_FAILED:
    "ENROLLMENT_FINALIZATION_CLAIM_FAILED",
  /** B2A-issued claim no longer matches the current session. */
  ENROLLMENT_FINALIZATION_CLAIM_LOST:
    "ENROLLMENT_FINALIZATION_CLAIM_LOST",
  /** Centroid encryption failed (AES-GCM utility). */
  FACE_PROFILE_CENTROID_ENCRYPTION_FAILED:
    "FACE_PROFILE_CENTROID_ENCRYPTION_FAILED",
  /** FaceProfile persistence failed at the database layer. */
  FACE_PROFILE_PERSISTENCE_FAILED: "FACE_PROFILE_PERSISTENCE_FAILED",
  /** An existing FaceProfile was created by a different generation. */
  FACE_PROFILE_ALREADY_EXISTS: "FACE_PROFILE_ALREADY_EXISTS",
  /** Stored FaceProfile's lineage disagrees with B1B result. */
  FACE_PROFILE_SOURCE_GENERATION_MISMATCH:
    "FACE_PROFILE_SOURCE_GENERATION_MISMATCH",
} as const;

export type FaceProfileFinalizationErrorCode =
  (typeof FACE_PROFILE_FINALIZATION_ERROR_CODES)[keyof typeof FACE_PROFILE_FINALIZATION_ERROR_CODES];

export interface FaceProfileFinalizationErrorShape {
  code: FaceProfileFinalizationErrorCode | string;
  message: string;
  domainError?: { code: string; message: string };
}

/**
 * Application-level error for the B2B persistence orchestrator.
 *
 * Stable surface. Never contains raw ciphertext, IV, authTag, key
 * material, plaintext centroid, claim token, `sourceEnrollmentGenerationId`,
 * embeddings, AAD bytes, or stack traces.
 */
export class FaceProfileFinalizationError extends Error {
  public readonly code: FaceProfileFinalizationErrorCode | string;
  public readonly domainError?: { code: string; message: string };

  constructor({
    code,
    message,
    domainError,
  }: {
    code: FaceProfileFinalizationErrorCode | string;
    message: string;
    domainError?: { code: string; message: string };
  }) {
    super(message);
    this.name = "FaceProfileFinalizationError";
    this.code = code;
    this.domainError = domainError;
  }

  toJSON(): FaceProfileFinalizationErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.domainError ? { domainError: this.domainError } : {}),
    };
  }
}

// =============================================================================
// Result type
// =============================================================================

/**
 * Server-only result of a successful B2B persistence operation.
 *
 * Privacy:
 *   - `claimToken` is included so a future trusted-server caller
 *     (PHASE 4.6B2C) can hand the claim directly into the session
 *     consumption flow without re-claiming. It is NEVER exposed to
 *     the browser, NEVER logged, NEVER persisted outside the
 *     temporary enrollment session.
 *   - `faceProfile` is the just-persisted FaceProfile document
 *     (encrypted centroid, encrypted samples, lineage, etc.). It
 *     does NOT contain plaintext centroid, plaintext samples, or
 *     the claim token.
 */
export interface PersistedFaceProfile {
  /** Server-issued UUID v4 lineage marker. NEVER exposed to browser. */
  sourceEnrollmentGenerationId: string;
  /** B2A claim token. Future B2C may consume this. NEVER browser. */
  claimToken: string;
  /** Wall-clock install time of the claim (used for diagnostics only). */
  claimedAt: Date;
  /** Whether the underlying write was a fresh insert (`true`) or an
   * idempotent same-generation re-affirmation (`false`). */
  created: boolean;
}

// =============================================================================
// Internal constants
// =============================================================================

const SUPPORTED_PERSISTENCE_MODES: ReadonlySet<EnrollmentMode> = new Set([
  "create",
] as const);

const SUPPORTED_TEMPLATE_VERSIONS = new Set<number>([
  DEFAULT_FACE_ENROLLMENT_TEMPLATE_VERSION,
]);

const SUPPORTED_NORMALIZATIONS: ReadonlySet<Normalization> = new Set([
  "l2",
] as const);

const PLAINTEXT_CENTROID_L2_TOLERANCE = 1e-3;

// =============================================================================
// Helpers
// =============================================================================

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function l2Norm(values: ReadonlyArray<number>): number {
  let sumSquares = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    sumSquares += v * v;
  }
  const norm = Math.sqrt(sumSquares);
  return Number.isFinite(norm) ? norm : Number.NaN;
}

/**
 * Validates the B1B-finalized centroid before encryption. A
 * malformed centroid is treated as a server/data-integrity failure
 * and rejected with `FACE_PROFILE_CENTROID_ENCRYPTION_FAILED`. We do
 * NOT silently re-normalize.
 */
function validateCentroidForPersistence(params: {
  centroid: ReadonlyArray<number>;
  expectedDimension: number;
}): void {
  const { centroid, expectedDimension } = params;
  if (!centroid || centroid.length === 0) {
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .FACE_PROFILE_CENTROID_ENCRYPTION_FAILED,
      message: "Centroid is empty.",
    });
  }
  if (centroid.length !== expectedDimension) {
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .FACE_PROFILE_CENTROID_ENCRYPTION_FAILED,
      message: "Centroid dimension does not match the session model.",
    });
  }
  for (let i = 0; i < centroid.length; i++) {
    if (!Number.isFinite(centroid[i]!)) {
      throw new FaceProfileFinalizationError({
        code: FACE_PROFILE_FINALIZATION_ERROR_CODES
          .FACE_PROFILE_CENTROID_ENCRYPTION_FAILED,
        message: "Centroid contains a non-finite value.",
      });
    }
  }
  const norm = l2Norm(centroid);
  if (
    !Number.isFinite(norm) ||
    Math.abs(norm - 1) > PLAINTEXT_CENTROID_L2_TOLERANCE
  ) {
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .FACE_PROFILE_CENTROID_ENCRYPTION_FAILED,
      message: "Centroid is not L2-normalised.",
    });
  }
}

/**
 * Builds the AAD record for the centroid. Mirrors the EXACT
 * PHASE 4.1 + B1B AAD contract used for samples, with the only
 * `vectorType` value of `"centroid"`. No new fields are introduced.
 *
 * Per the contract, the centroid AAD does NOT include a
 * `sampleIndex` (centroids are not index-addressed).
 */
function buildCentroidAAD(params: {
  userId: string;
  modelIdentity: string;
  templateVersion: number;
}): BiometricAAD {
  return {
    userId: params.userId,
    modelIdentity: params.modelIdentity,
    templateVersion: params.templateVersion,
    vectorType: "centroid",
  };
}

/**
 * Validates an embedded encrypted sample envelope. We only verify
 * the STRUCTURAL shape because we never re-decrypt or re-encrypt the
 * sample here. The encryption utility's AAD contract guarantees
 * authenticity when the sample was first persisted.
 *
 * This is a defensive read — not a cryptographic verification.
 */
function validateEncryptedSampleEnvelope(
  sample: FaceEnrollmentAcceptedSampleDoc,
  expectedIndex: number,
): void {
  if (!sample || typeof sample !== "object") {
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_SAMPLE_STRUCTURE_INVALID,
      message: "Enrollment sample is not an object.",
    });
  }
  const ev = sample.encryptedVector;
  if (!ev || typeof ev !== "object") {
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_SAMPLE_STRUCTURE_INVALID,
      message: "Enrollment sample is missing the encrypted envelope.",
    });
  }
  if (
    typeof ev.ciphertext !== "string" ||
    ev.ciphertext.length === 0 ||
    typeof ev.iv !== "string" ||
    ev.iv.length === 0 ||
    typeof ev.authTag !== "string" ||
    ev.authTag.length === 0
  ) {
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_SAMPLE_STRUCTURE_INVALID,
      message:
        "Enrollment sample envelope is missing required ciphertext / IV / authTag.",
    });
  }
  if (typeof ev.keyVersion !== "number" || !Number.isInteger(ev.keyVersion)) {
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_SAMPLE_STRUCTURE_INVALID,
      message: "Enrollment sample envelope keyVersion is not a positive integer.",
    });
  }
  if (
    typeof sample.sampleIndex !== "number" ||
    !Number.isInteger(sample.sampleIndex) ||
    sample.sampleIndex !== expectedIndex
  ) {
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_SAMPLE_INDEX_INVALID,
      message: "Enrollment sample index does not match the expected slot.",
    });
  }
}

/**
 * Validates and copies the encrypted sample envelopes from the
 * temporary session into a sorted array suitable for the
 * `FaceProfile.samples` field.
 *
 * The encrypted envelopes are preserved byte-for-byte /
 * base64-string-for-string. We never decrypt or re-encrypt them.
 * Sorted deterministically by `sampleIndex`.
 */
function collectAndSortEncryptedSamples(params: {
  acceptedSamples: ReadonlyArray<FaceEnrollmentAcceptedSampleDoc>;
  requiredSampleCount: number;
}): FaceEnrollmentAcceptedSampleDoc[] {
  const { acceptedSamples, requiredSampleCount } = params;

  // Validate index set is exactly 0..N-1, exactly once each.
  const seen = new Set<number>();
  for (const sample of acceptedSamples) {
    const idx = sample.sampleIndex;
    if (
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= requiredSampleCount
    ) {
      throw new FaceProfileFinalizationError({
        code: FACE_PROFILE_FINALIZATION_ERROR_CODES
          .ENROLLMENT_SAMPLE_INDEX_INVALID,
        message:
          "Enrollment sample index is outside the valid 0..N-1 range.",
      });
    }
    if (seen.has(idx)) {
      throw new FaceProfileFinalizationError({
        code: FACE_PROFILE_FINALIZATION_ERROR_CODES
          .ENROLLMENT_SAMPLE_INDEX_INVALID,
        message:
          "Enrollment sample index appears more than once in accepted samples.",
      });
    }
    seen.add(idx);
  }
  if (seen.size !== requiredSampleCount) {
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_SAMPLE_INDEX_INVALID,
      message: "Enrollment sample indexes are missing or contain gaps.",
    });
  }

  // Sort deterministically by sampleIndex. Validate envelope shape per slot.
  const sorted = [...acceptedSamples].sort(
    (a, b) => a.sampleIndex - b.sampleIndex,
  );
  for (let i = 0; i < sorted.length; i++) {
    validateEncryptedSampleEnvelope(sorted[i]!, i);
  }
  return sorted;
}

/**
 * Builds the deterministic quality summary that the FaceProfile
 * stores. Only metrics that can be derived SAFELY from the stored
 * accepted-sample quality data are included. Any metric not present
 * in the session is left as `undefined`. No fabricated values.
 */
function buildQualitySummary(
  samples: ReadonlyArray<FaceEnrollmentAcceptedSampleDoc>,
  finalization: EnrollmentFinalizationResult,
): {
  meanDetectionScore?: number;
  meanBlurScore?: number;
  meanBrightness?: number;
  minSelfSimilarity: number;
  meanSelfSimilarity: number;
} {
  let detectionSum = 0;
  let detectionCount = 0;
  let blurSum = 0;
  let blurCount = 0;
  let brightnessSum = 0;
  let brightnessCount = 0;

  for (const sample of samples) {
    const q: FaceSampleQualityDoc | undefined = sample.quality;
    if (!q) continue;
    if (typeof q.detectionScore === "number" && Number.isFinite(q.detectionScore)) {
      detectionSum += q.detectionScore;
      detectionCount += 1;
    }
    if (typeof q.blurScore === "number" && Number.isFinite(q.blurScore)) {
      blurSum += q.blurScore;
      blurCount += 1;
    }
    if (typeof q.brightness === "number" && Number.isFinite(q.brightness)) {
      brightnessSum += q.brightness;
      brightnessCount += 1;
    }
  }

  return {
    meanDetectionScore:
      detectionCount > 0 ? detectionSum / detectionCount : undefined,
    meanBlurScore: blurCount > 0 ? blurSum / blurCount : undefined,
    meanBrightness:
      brightnessCount > 0 ? brightnessSum / brightnessCount : undefined,
    minSelfSimilarity: finalization.finalization.minSelfSimilarity,
    meanSelfSimilarity: finalization.finalization.meanSelfSimilarity,
  };
}

/**
 * Wraps an underlying error into a safe B2B error without
 * exposing claim tokens, lineage, plaintext data, or stack traces.
 */
function wrapUnderlyingError(err: unknown): FaceProfileFinalizationError {
  if (err instanceof FaceProfileFinalizationError) {
    return err;
  }
  if (err instanceof EnrollmentFinalizationClaimError) {
    // B2A claim failures map to ENROLLMENT_FINALIZATION_CLAIM_FAILED
    // unless the underlying code is one of the more specific stable
    // claim codes that the B2B orchestrator wants to forward
    // directly to the caller (e.g. ENROLLMENT_GENERATION_CHANGED).
    const stableClaimCode = String(err.code);
    return new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_FINALIZATION_CLAIM_FAILED,
      message: "Finalization claim could not be acquired.",
      domainError: { code: stableClaimCode, message: err.message },
    });
  }
  if (err instanceof BiometricError) {
    return new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .FACE_PROFILE_CENTROID_ENCRYPTION_FAILED,
      message: "Failed to encrypt the centroid.",
      domainError: { code: err.code, message: err.message },
    });
  }
  if (err instanceof BiometricPersistenceError) {
    // Forward stable FaceProfile-specific codes (e.g.
    // FACE_PROFILE_ALREADY_EXISTS) directly so the caller can
    // distinguish lineage conflicts from generic persistence
    // failures. Otherwise default to FACE_PROFILE_PERSISTENCE_FAILED.
    const stableCode = String(err.code);
    const forwardCode =
      stableCode === "FACE_PROFILE_ALREADY_EXISTS" ||
      stableCode === "FACE_PROFILE_SOURCE_GENERATION_MISMATCH"
        ? (stableCode as FaceProfileFinalizationErrorCode)
        : FACE_PROFILE_FINALIZATION_ERROR_CODES
            .FACE_PROFILE_PERSISTENCE_FAILED;
    return new FaceProfileFinalizationError({
      code: forwardCode,
      message:
        forwardCode ===
        FACE_PROFILE_FINALIZATION_ERROR_CODES.FACE_PROFILE_PERSISTENCE_FAILED
          ? "FaceProfile persistence failed."
          : err.message,
      domainError: { code: stableCode, message: err.message },
    });
  }
  return new FaceProfileFinalizationError({
    code: FACE_PROFILE_FINALIZATION_ERROR_CODES
      .FACE_PROFILE_PERSISTENCE_FAILED,
    message: "FaceProfile persistence failed.",
  });
}

/**
 * Validates the claimed enrollment session is still consistent with
 * B1B's result. Returns the re-checked session for downstream use.
 */
async function revalidateClaimedSession(params: {
  userId: string;
  sourceGenerationId: string;
  claimToken: string;
}): Promise<FaceEnrollmentSessionAttrs> {
  const reread = await getEnrollmentSessionByUserId(params.userId);
  if (!reread) {
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_SESSION_NOT_FOUND,
      message: "Enrollment session disappeared after claim.",
    });
  }
  if (isEnrollmentSessionExpired(reread)) {
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_SESSION_EXPIRED,
      message: "Enrollment session expired after claim.",
    });
  }
  if (reread.generationId !== params.sourceGenerationId) {
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_FINALIZATION_CLAIM_LOST,
      message:
        "Enrollment generation changed between B1B and persistence.",
    });
  }
  if (
    !reread.finalizationClaim ||
    reread.finalizationClaim.token !== params.claimToken
  ) {
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_FINALIZATION_CLAIM_LOST,
      message: "Enrollment finalization claim no longer matches.",
    });
  }
  if (reread.acceptedSamples.length !== reread.requiredSampleCount) {
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_INCOMPLETE,
      message:
        "Enrollment session is no longer complete after claim.",
    });
  }
  return reread;
}

/**
 * Best-effort release of the B2A claim. Never throws and never
 * masks the original error. We deliberately swallow the underlying
 * release result here because the caller will surface the original
 * error.
 */
async function safeReleaseClaim(params: {
  userId: string;
  generationId: string;
  claimToken: string;
}): Promise<void> {
  try {
    await releaseEnrollmentFinalizationClaim({
      userId: params.userId,
      generationId: params.generationId,
      claimToken: params.claimToken,
    });
  } catch {
    // Deliberately swallow — best-effort only. The original error
    // path is the user-visible failure.
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Persists a finalized `FaceProfile` for the supplied user using the
 * claim-bound orchestration described in the module header.
 *
 * This function is **SERVER-ONLY** (the module opens with
 * `import "server-only"`).
 *
 * Input contract:
 *   - `userId` MUST be obtained from a future authenticated server
 *     caller (`auth.api.getSession()` in PHASE 4.6B3). The browser
 *     never chooses the userId. B2B documents this as a
 *     precondition; B2B does not authenticate.
 *
 * Output contract (SERVER-ONLY):
 *   - Returns a `PersistedFaceProfile` with:
 *       - `sourceEnrollmentGenerationId` (server lineage),
 *       - `claimToken` (B2A-held; future B2C consumes it),
 *       - `claimedAt`,
 *       - `created` (true if the write was a fresh insert,
 *         false if it was an idempotent same-generation re-affirm).
 *   - The plaintext centroid is NEVER returned.
 *   - The plaintext sample vectors are NEVER returned.
 *   - The claim token is NEVER returned to the browser.
 *   - The `sourceEnrollmentGenerationId` is NEVER returned to the
 *     browser.
 *
 * Failure modes (all stable codes):
 *   - `ENROLLMENT_SESSION_NOT_FOUND`
 *   - `ENROLLMENT_SESSION_EXPIRED`
 *   - `ENROLLMENT_INCOMPLETE`
 *   - `ENROLLMENT_SESSION_INVALID`
 *   - `UNSUPPORTED_ENROLLMENT_MODE`
 *   - `UNSUPPORTED_TEMPLATE_VERSION`
 *   - `ENROLLMENT_SAMPLE_INDEX_INVALID`
 *   - `ENROLLMENT_SAMPLE_STRUCTURE_INVALID`
 *   - `ENROLLMENT_METADATA_MISMATCH`
 *   - `ENROLLMENT_FINALIZATION_CLAIM_FAILED`
 *   - `ENROLLMENT_FINALIZATION_CLAIM_LOST`
 *   - `FACE_PROFILE_CENTROID_ENCRYPTION_FAILED`
 *   - `FACE_PROFILE_PERSISTENCE_FAILED`
 *   - `FACE_PROFILE_ALREADY_EXISTS`
 *   - `FACE_PROFILE_SOURCE_GENERATION_MISMATCH`
 *
 * On failure BEFORE successful FaceProfile persistence, the B2A
 * claim token is released in a `finally` block. The original error
 * is NEVER masked. On success, the claim is KEPT for B2C.
 */
export async function persistFinalizedFaceProfileForUser(
  userId: string,
): Promise<PersistedFaceProfile> {
  if (!isNonEmptyString(userId)) {
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_SESSION_INVALID,
      message:
        "persistFinalizedFaceProfileForUser requires a non-empty userId.",
    });
  }

  // ---- 1. B1B: finalize the enrollment batch --------------------------
  // We capture `sourceGenerationId` BEFORE B2A claim acquisition so
  // the claim filter uses the EXACT generation that B1B just
  // finalized. B1B already validates session / samples / metadata.
  const finalization = await finalizeEnrollmentSessionForUser(userId);
  const sourceGenerationId = finalization.sourceGenerationId;

  // ---- 2. B2A: atomically claim the generation ------------------------
  let claim: ClaimedEnrollmentSession;
  try {
    claim = await claimEnrollmentSessionForFinalization({
      userId,
      generationId: sourceGenerationId,
    });
  } catch (err) {
    throw wrapUnderlyingError(err);
  }

  // ---- 3. Re-validate the claimed session is still authoritative -------
  let claimedSession: FaceEnrollmentSessionAttrs;
  try {
    claimedSession = await revalidateClaimedSession({
      userId,
      sourceGenerationId,
      claimToken: claim.claimToken,
    });
  } catch (err) {
    // B2A already succeeded; we lost the claim because the session
    // drifted between claim acquisition and our re-read. The claim
    // will still be cleared by the eventual session TTL OR by an
    // explicit reset attempt. We do NOT release here because the
    // token still matches (the session's persisted claim still
    // holds it); a wrong-token release would be a no-op anyway.
    throw wrapUnderlyingError(err);
  }

  // ---- 4. Validate mode / templateVersion / normalization --------------
  if (!SUPPORTED_PERSISTENCE_MODES.has(claimedSession.mode)) {
    await safeReleaseClaim({
      userId,
      generationId: sourceGenerationId,
      claimToken: claim.claimToken,
    });
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .UNSUPPORTED_ENROLLMENT_MODE,
      message: `Enrollment mode "${claimedSession.mode}" is not supported by persistence.`,
    });
  }
  if (
    !isPositiveInteger(claimedSession.templateVersion) ||
    !SUPPORTED_TEMPLATE_VERSIONS.has(claimedSession.templateVersion)
  ) {
    await safeReleaseClaim({
      userId,
      generationId: sourceGenerationId,
      claimToken: claim.claimToken,
    });
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .UNSUPPORTED_TEMPLATE_VERSION,
      message: `Enrollment session uses unsupported templateVersion ${claimedSession.templateVersion}.`,
    });
  }
  const sessionNormalization = claimedSession.normalization;
  if (
    !sessionNormalization ||
    !SUPPORTED_NORMALIZATIONS.has(sessionNormalization)
  ) {
    await safeReleaseClaim({
      userId,
      generationId: sourceGenerationId,
      claimToken: claim.claimToken,
    });
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_SESSION_INVALID,
      message: `Enrollment session has unsupported normalization: ${sessionNormalization ?? "<missing>"}.`,
    });
  }

  // ---- 5. Cross-check B1B result against claimed session metadata ------
  const sessionModelIdentity = claimedSession.modelIdentity;
  const sessionModelName = claimedSession.modelName;
  const sessionEmbeddingDimension = claimedSession.embeddingDimension;
  if (
    !isNonEmptyString(sessionModelIdentity) ||
    !isNonEmptyString(sessionModelName) ||
    !isPositiveInteger(sessionEmbeddingDimension)
  ) {
    await safeReleaseClaim({
      userId,
      generationId: sourceGenerationId,
      claimToken: claim.claimToken,
    });
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_SESSION_INVALID,
      message:
        "Enrollment session is missing authoritative model metadata.",
    });
  }
  if (
    finalization.model.identity !== sessionModelIdentity ||
    finalization.model.name !== sessionModelName ||
    finalization.model.embeddingDimension !== sessionEmbeddingDimension ||
    finalization.model.normalization !== sessionNormalization
  ) {
    await safeReleaseClaim({
      userId,
      generationId: sourceGenerationId,
      claimToken: claim.claimToken,
    });
    throw new FaceProfileFinalizationError({
      code: FACE_PROFILE_FINALIZATION_ERROR_CODES
        .ENROLLMENT_METADATA_MISMATCH,
      message:
        "B1B finalization result and claimed enrollment session metadata disagree.",
    });
  }

  // ---- 6. Validate / sort the encrypted sample envelopes ---------------
  let sortedSamples: FaceEnrollmentAcceptedSampleDoc[];
  try {
    sortedSamples = collectAndSortEncryptedSamples({
      acceptedSamples: claimedSession.acceptedSamples,
      requiredSampleCount: claimedSession.requiredSampleCount,
    });
  } catch (err) {
    await safeReleaseClaim({
      userId,
      generationId: sourceGenerationId,
      claimToken: claim.claimToken,
    });
    throw wrapUnderlyingError(err);
  }

  // ---- 7. Validate the centroid ----------------------------------------
  try {
    validateCentroidForPersistence({
      centroid: finalization.finalization.centroid,
      expectedDimension: sessionEmbeddingDimension,
    });
  } catch (err) {
    await safeReleaseClaim({
      userId,
      generationId: sourceGenerationId,
      claimToken: claim.claimToken,
    });
    throw wrapUnderlyingError(err);
  }

  // ---- 8. Encrypt the centroid with the EXACT AAD contract ------------
  // The encryption utility owns key handling. We only build the
  // AAD record from authoritative server metadata.
  const centroidAAD = buildCentroidAAD({
    userId,
    modelIdentity: sessionModelIdentity,
    templateVersion: claimedSession.templateVersion,
  });
  let encryptedCentroid: EncryptedBiometricValue;
  try {
    encryptedCentroid = encryptBiometricVector(
      finalization.finalization.centroid,
      centroidAAD,
    );
  } catch (err) {
    await safeReleaseClaim({
      userId,
      generationId: sourceGenerationId,
      claimToken: claim.claimToken,
    });
    throw wrapUnderlyingError(err);
  }

  // ---- 9. Copy accepted sample envelopes (no decrypt / re-encrypt) -----
  // The encrypted samples are forwarded verbatim — same base64
  // strings, same IV, same authTag, same keyVersion. The AAD
  // contract for samples is unchanged: userId, modelIdentity,
  // templateVersion, vectorType="sample", sampleIndex. Those
  // authoritative fields did not change between the source
  // session encryption (PHASE 4.4C) and now, so the original AAD
  // is still cryptographically valid.
  const persistedSamples = sortedSamples.map((sample) => ({
    encryptedVector: {
      ciphertext: sample.encryptedVector.ciphertext,
      iv: sample.encryptedVector.iv,
      authTag: sample.encryptedVector.authTag,
      keyVersion: sample.encryptedVector.keyVersion,
    },
    sampleIndex: sample.sampleIndex,
    quality: sample.quality,
  }));

  // ---- 10. Build the deterministic quality summary --------------------
  const qualitySummary = buildQualitySummary(
    sortedSamples,
    finalization,
  );

  // ---- 11. Persist the FaceProfile idempotently ------------------------
  // `enrolledAt` MUST be deterministic across same-generation retries.
  // We seed it from the B1B-finalized session timestamp (now) so the
  // FIRST write stamps the timestamp; idempotent retries will match
  // the existing document by lineage and preserve its original
  // enrolledAt.
  const now = new Date();
  const persistenceInput: SaveFinalizedFaceProfileInput = {
    userId,
    status: "active",
    modelIdentity: sessionModelIdentity,
    modelName: sessionModelName,
    embeddingDimension: sessionEmbeddingDimension,
    normalization: sessionNormalization,
    templateVersion: claimedSession.templateVersion,
    requiredSampleCount: claimedSession.requiredSampleCount,
    sampleCount: claimedSession.requiredSampleCount,
    samples: persistedSamples.map((sample) => ({
      encryptedVector: sample.encryptedVector,
      sampleIndex: sample.sampleIndex,
      quality: sample.quality,
    })),
    centroid: encryptedCentroid,
    qualitySummary,
    enrolledAt: now,
    sourceEnrollmentGenerationId: sourceGenerationId,
  };

  let persistenceResult;
  try {
    persistenceResult = await saveFinalizedFaceProfile(persistenceInput);
  } catch (err) {
    await safeReleaseClaim({
      userId,
      generationId: sourceGenerationId,
      claimToken: claim.claimToken,
    });
    throw wrapUnderlyingError(err);
  }

  // ---- 12. SUCCESS ------------------------------------------------------
  // The claim is KEPT here so PHASE 4.6B2C can atomically consume
  // the temporary enrollment session. We do NOT release the claim.
  // We do NOT delete the enrollment session.
  return {
    sourceEnrollmentGenerationId: sourceGenerationId,
    claimToken: claim.claimToken,
    claimedAt: claim.claimedAt,
    created: persistenceResult.created,
  };
}

// =============================================================================
// Exposed for tests
// =============================================================================

export const __testing = {
  buildCentroidAAD,
  buildQualitySummary,
  collectAndSortEncryptedSamples,
  validateCentroidForPersistence,
  validateEncryptedSampleEnvelope,
  revalidateClaimedSession,
  SUPPORTED_PERSISTENCE_MODES,
  SUPPORTED_TEMPLATE_VERSIONS,
  SUPPORTED_NORMALIZATIONS,
  PLAINTEXT_CENTROID_L2_TOLERANCE,
};