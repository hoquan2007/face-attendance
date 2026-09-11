/**
 * Server-side enrollment decryption + finalization orchestration.
 *
 * PHASE 4.6B1B — Server-only Next.js orchestration.
 *
 * This module is the SERVER-ONLY orchestration layer that sits
 * between the temporary `FaceEnrollmentSession` (PHASE 4.2 / 4.5B4)
 * and the PHASE 4.6B1A server-only finalization client. It is the
 * next step up the stack from `finalizeFaceEnrollment(...)`.
 *
 * Responsibilities (this phase only):
 *   1. Accept an AUTHORITATIVE userId supplied by a future
 *      authenticated server caller (PHASE 4.6B3 will obtain it from
 *      `auth.api.getSession()`). The userId is NEVER derived from the
 *      browser request body or query string.
 *   2. Load the current `FaceEnrollmentSession` through the existing
 *      PHASE 4.5B4.3 lazy-backfill read service — preserving the
 *      legacy `generationId` backfill path.
 *   3. Validate that the session is active, unexpired and complete.
 *   4. Reconstruct the exact AES-GCM AAD used by PHASE 4.4C for each
 *      encrypted sample (no new AAD format is introduced here).
 *   5. Decrypt every accepted sample using the existing PHASE 4.1
 *      AES-256-GCM utility. The encryption key is owned by the
 *      utility, never read directly here.
 *   6. Validate every decrypted plaintext vector (dimension match,
 *      finite values, |v| ≈ 1 within the existing 1e-3 tolerance).
 *   7. Call the PHASE 4.6B1A `finalizeFaceEnrollment(...)` exactly
 *      once, forwarding ONLY the authoritative session metadata
 *      (model identity/name/dimension/normalization + required
 *      sample count + decrypted vectors). userId / generationId /
 *      templateVersion are NEVER sent to the Face Service.
 *   8. Re-check the enrollment generation AFTER the Face Service
 *      response. If the generation changed while Face Service was
 *      processing, the successful centroid is DISCARDED and a
 *      stable `ENROLLMENT_GENERATION_CHANGED` error is thrown. No
 *      persistence happens (that is PHASE 4.6B2).
 *
 * What this module deliberately does NOT do (future phases):
 *   - It does NOT persist a `FaceProfile`.
 *   - It does NOT delete the temporary enrollment session.
 *   - It does NOT add a Next.js route, Server Action, or UI.
 *   - It does NOT call `fetch` directly — it reuses
 *     `finalizeFaceEnrollment(...)` from PHASE 4.6B1A.
 *   - It does NOT authenticate the caller. `finalizeEnrollmentSessionForUser`
 *     takes a server-authoritative userId; producing that userId is
 *     a precondition handled by a future phase (PHASE 4.6B3).
 *
 * Privacy posture:
 *   - All plaintext embeddings live in local server memory only for
 *     the lifetime of the call. Best-effort clearing happens in a
 *     `finally` block.
 *   - Plaintext samples, ciphertext, IV, authTag, AAD bytes, or
 *     Face Service keys never appear in error messages.
 *   - Face Service finalization domain errors (INCONSISTENT_FACE_SAMPLES,
 *     MODEL_MISMATCH, INVALID_SAMPLE_COUNT, INVALID_EMBEDDING,
 *     EMBEDDING_DIMENSION_MISMATCH, EMBEDDING_NOT_NORMALIZED,
 *     INVALID_CENTROID) are preserved verbatim on
 *     `EnrollmentFinalizationError.domainError.code`.
 */

import "server-only";

import {
  DEFAULT_FACE_ENROLLMENT_TEMPLATE_VERSION,
  DEFAULT_FACE_ENROLLMENT_REQUIRED_SAMPLES,
} from "@/lib/biometrics/biometric-constants";
import type {
  EnrollmentMode,
  Normalization,
} from "@/lib/biometrics/biometric-schema";
import {
  BIOMETRIC_ERROR_CODES,
  BiometricError,
  decryptBiometricVector,
  type BiometricAAD,
} from "@/lib/biometrics/encryption";
import {
  FINALIZATION_ERROR_CODES,
  FaceServiceClientError,
  finalizeFaceEnrollment,
  type FinalizeFaceEnrollmentResult,
} from "@/lib/biometrics/face-service-client";
import {
  getEnrollmentSessionByUserId,
  isEnrollmentSessionExpired,
} from "@/lib/biometrics/enrollment-session-service";
import type {
  FaceEnrollmentAcceptedSampleDoc,
  FaceEnrollmentSessionAttrs,
} from "@/lib/biometrics/enrollment-session-model";

// =============================================================================
// Finalization orchestration error codes
// =============================================================================

/**
 * Stable orchestration error codes. These are the ORCHESTRATION layer
 * surface. They are distinct from, and coexist with:
 *   - `FaceServiceClientError` transport codes (FACE_SERVICE_*),
 *   - Face Service finalization domain codes preserved on
 *     `domainError.code` (INCONSISTENT_FACE_SAMPLES etc.),
 *   - `BiometricError` codes emitted by the AES-GCM utility.
 *
 * Codes are safe to expose to future API/orchestration callers — they
 * never embed keys, ciphertext, embeddings, or stack traces.
 */
export const ENROLLMENT_FINALIZATION_ERROR_CODES = {
  ENROLLMENT_SESSION_NOT_FOUND: "ENROLLMENT_SESSION_NOT_FOUND",
  ENROLLMENT_SESSION_EXPIRED: "ENROLLMENT_SESSION_EXPIRED",
  ENROLLMENT_INCOMPLETE: "ENROLLMENT_INCOMPLETE",
  ENROLLMENT_SESSION_INVALID: "ENROLLMENT_SESSION_INVALID",
  UNSUPPORTED_ENROLLMENT_MODE: "UNSUPPORTED_ENROLLMENT_MODE",
  UNSUPPORTED_TEMPLATE_VERSION: "UNSUPPORTED_TEMPLATE_VERSION",
  ENROLLMENT_SAMPLE_INDEX_INVALID: "ENROLLMENT_SAMPLE_INDEX_INVALID",
  ENROLLMENT_SAMPLE_DECRYPTION_FAILED:
    "ENROLLMENT_SAMPLE_DECRYPTION_FAILED",
  ENROLLMENT_SAMPLE_VECTOR_INVALID: "ENROLLMENT_SAMPLE_VECTOR_INVALID",
  ENROLLMENT_GENERATION_CHANGED: "ENROLLMENT_GENERATION_CHANGED",
  ENROLLMENT_FINALIZATION_FAILED: "ENROLLMENT_FINALIZATION_FAILED",
} as const;

export type EnrollmentFinalizationErrorCode =
  (typeof ENROLLMENT_FINALIZATION_ERROR_CODES)[keyof typeof ENROLLMENT_FINALIZATION_ERROR_CODES];

export interface EnrollmentFinalizationErrorShape {
  code: EnrollmentFinalizationErrorCode | string;
  message: string;
  /**
   * Domain error detail, when the failure originated from a typed
   * underlying error (AES-GCM utility or Face Service client). The
   * shape mirrors the underlying error JSON without exposing any
   * secret material.
   */
  domainError?: { code: string; message: string };
}

/**
 * Application-level error for `finalizeEnrollmentSessionForUser`.
 *
 * Stable surface across the orchestration layer. Carries only:
 *   - `code`: orchestration code (or `domainError.code` for nested errors),
 *   - `message`: safe human-readable message,
 *   - `domainError`: optional preserved upstream domain error code
 *     + message (e.g. INCONSISTENT_FACE_SAMPLES).
 *
 * Never contains raw ciphertext, IV, authTag, key material, raw
 * embeddings, centroid values, AAD bytes, stack traces, or secret
 * configuration.
 */
export class EnrollmentFinalizationError extends Error {
  public readonly code: EnrollmentFinalizationErrorCode | string;
  public readonly domainError?: { code: string; message: string };

  constructor({
    code,
    message,
    domainError,
  }: {
    code: EnrollmentFinalizationErrorCode | string;
    message: string;
    domainError?: { code: string; message: string };
  }) {
    super(message);
    this.name = "EnrollmentFinalizationError";
    this.code = code;
    this.domainError = domainError;
  }

  toJSON(): EnrollmentFinalizationErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.domainError
        ? { domainError: this.domainError }
        : {}),
    };
  }
}

// =============================================================================
// Result type
// =============================================================================

/**
 * Coordinates of a single, fully-finalized enrollment generation.
 *
 * `finalization.centroid` is the SERVER-ONLY outcome the future
 * PHASE 4.6B2 persistence layer will encrypt and store on a
 * `FaceProfile`. It must not be exposed to a browser/route
 * response in PHASE 4.6B1B.
 */
export interface EnrollmentFinalizationModel {
  identity: string;
  name: string;
  embeddingDimension: number;
  normalization: string;
}

export interface EnrollmentFinalizationMetrics {
  sampleCount: number;
  pairCount: number;
  minSelfSimilarity: number;
  meanSelfSimilarity: number;
  threshold: number;
  /** The final L2-normalised centroid. SERVER-ONLY. */
  centroid: number[];
}

export interface EnrollmentFinalizationResult {
  /** Stable generation identity captured BEFORE Face Service call. */
  sourceGenerationId: string;
  /** Enrollment mode that produced this finalization. */
  mode: EnrollmentMode;
  /** Schema template version used during encryption. */
  templateVersion: number;
  /** Required sample count validated against the persisted session. */
  requiredSampleCount: number;
  /** Model metadata forwarded to / returned by the Face Service. */
  model: EnrollmentFinalizationModel;
  /** Finalization metrics (centroid included but server-only). */
  finalization: EnrollmentFinalizationMetrics;
}

// =============================================================================
// Internal constants
// =============================================================================

/**
 * AES-GCM plaintext-vector L2-norm tolerance. Mirrors the existing
 * PHASE 4.6A1 backend tolerance (1e-3) and the PHASE 4.6B1A client
 * centroid tolerance. We do NOT silently repair non-normalized
 * vectors here.
 */
const PLAINTEXT_VECTOR_L2_NORM_TOLERANCE = 1e-3;

/**
 * Supported enrollment modes for THIS mini-phase. Currently only
 * `create`. The `replace` flow will be wired in a later phase
 * (re-enrollment). Finalizing a `replace`-mode session in B1B is a
 * precondition violation.
 */
const SUPPORTED_FINALIZATION_MODES: ReadonlySet<EnrollmentMode> = new Set([
  "create",
]);

/**
 * Supported template versions. Only the default declared in
 * `biometric-constants.ts` is currently accepted. Older versions are
 * rejected with a stable error so the future caller can decide
 * whether to start a fresh enrollment.
 */
const SUPPORTED_TEMPLATE_VERSIONS: ReadonlySet<number> = new Set([
  DEFAULT_FACE_ENROLLMENT_TEMPLATE_VERSION,
]);

/**
 * Supported normalization strategies for the persisted session.
 * Mirrors `NORMALIZATIONS = ["l2"]`. Sessions with other values are
 * rejected because the Face Service only accepts L2-normalized
 * embeddings.
 */
const SUPPORTED_NORMALIZATIONS: ReadonlySet<Normalization> = new Set([
  "l2",
]);

/**
 * Maximum acceptable absolute deviation of a decrypted plaintext
 * vector's L2 norm from 1.0. Mirrors the existing client tolerance
 * (1e-3). We refuse to silently normalize malformed stored vectors.
 */
const PLAINTEXT_DIMENSION_MIN = 1;

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

function float32ArrayToNumberArray(values: Float32Array): number[] {
  const out: number[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    out[i] = values[i]!;
  }
  return out;
}

/**
 * Builds the AAD record for ONE accepted enrollment sample. The
 * construction mirrors the PHASE 4.4C route handler byte-for-byte:
 *
 *   {
 *     userId,                            // server-authoritative input
 *     modelIdentity,                     // session.modelIdentity
 *     templateVersion,                   // session.templateVersion
 *     vectorType: "sample",              // constant literal
 *     sampleIndex,                       // persisted sample.sampleIndex
 *   }
 *
 * The exact field set and order in the underlying JSON serializer is
 * governed by the PHASE 4.1 encryption module, which serializes via
 * JSON.stringify with sorted keys. We never invent new AAD fields.
 */
function buildSampleAAD(params: {
  userId: string;
  modelIdentity: string;
  templateVersion: number;
  sampleIndex: number;
}): BiometricAAD {
  return {
    userId: params.userId,
    modelIdentity: params.modelIdentity,
    templateVersion: params.templateVersion,
    vectorType: "sample",
    sampleIndex: params.sampleIndex,
  };
}

/**
 * Validates the persisted `FaceEnrollmentSession` is suitable for
 * finalization.
 *
 * Throws `EnrollmentFinalizationError` with a stable code on any
 * precondition violation. Never silently repairs a malformed session.
 */
function validateSessionForFinalization(
  session: FaceEnrollmentSessionAttrs | null,
): asserts session is FaceEnrollmentSessionAttrs {
  if (!session) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_SESSION_NOT_FOUND,
      message: "No active enrollment session for this user.",
    });
  }

  if (isEnrollmentSessionExpired(session)) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_SESSION_EXPIRED,
      message: "Enrollment session is expired.",
    });
  }

  if (!isNonEmptyString(session.generationId)) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_SESSION_INVALID,
      message: "Enrollment session is missing a stable generationId.",
    });
  }

  if (!SUPPORTED_FINALIZATION_MODES.has(session.mode)) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES.UNSUPPORTED_ENROLLMENT_MODE,
      message: `Enrollment mode "${session.mode}" is not supported by finalization.`,
    });
  }

  const required =
    session.requiredSampleCount ?? DEFAULT_FACE_ENROLLMENT_REQUIRED_SAMPLES;
  if (!isPositiveInteger(required) || required < 2) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_INCOMPLETE,
      message: "Enrollment session has an invalid required sample count.",
    });
  }

  if (session.acceptedSamples.length !== required) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_INCOMPLETE,
      message: "Enrollment session is not complete.",
    });
  }

  if (
    !isNonEmptyString(session.modelIdentity) ||
    !isNonEmptyString(session.modelName)
  ) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_SESSION_INVALID,
      message:
        "Enrollment session is missing authoritative model identity metadata.",
    });
  }

  if (
    session.embeddingDimension === undefined ||
    session.embeddingDimension === null ||
    !isPositiveInteger(session.embeddingDimension) ||
    session.embeddingDimension < PLAINTEXT_DIMENSION_MIN
  ) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_SESSION_INVALID,
      message:
        "Enrollment session has an invalid embedding dimension.",
    });
  }

  const normalization = session.normalization;
  if (!normalization || !SUPPORTED_NORMALIZATIONS.has(normalization)) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_SESSION_INVALID,
      message: `Enrollment session has an unsupported normalization: ${normalization ?? "<missing>"}.`,
    });
  }

  if (
    !isPositiveInteger(session.templateVersion) ||
    !SUPPORTED_TEMPLATE_VERSIONS.has(session.templateVersion)
  ) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES
        .UNSUPPORTED_TEMPLATE_VERSION,
      message: `Enrollment session uses unsupported templateVersion ${session.templateVersion}.`,
    });
  }
}

/**
 * Validates `acceptedSamples[i].sampleIndex` is exactly
 * `0..requiredSampleCount - 1`, exactly once each.
 *
 * Persisted order is not relied on — samples are sorted by
 * `sampleIndex` before decryption and forwarding.
 */
function validateAndSortSamples(
  acceptedSamples: ReadonlyArray<FaceEnrollmentAcceptedSampleDoc>,
  requiredSampleCount: number,
): FaceEnrollmentAcceptedSampleDoc[] {
  const seen = new Set<number>();
  for (const sample of acceptedSamples) {
    const idx = sample.sampleIndex;
    if (
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= requiredSampleCount
    ) {
      throw new EnrollmentFinalizationError({
        code: ENROLLMENT_FINALIZATION_ERROR_CODES
          .ENROLLMENT_SAMPLE_INDEX_INVALID,
        message:
          "Enrollment sample index is outside the valid 0..N-1 range.",
      });
    }
    if (seen.has(idx)) {
      throw new EnrollmentFinalizationError({
        code: ENROLLMENT_FINALIZATION_ERROR_CODES
          .ENROLLMENT_SAMPLE_INDEX_INVALID,
        message:
          "Enrollment sample index appears more than once in accepted samples.",
      });
    }
    seen.add(idx);
  }
  if (seen.size !== requiredSampleCount) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES
        .ENROLLMENT_SAMPLE_INDEX_INVALID,
      message:
        "Enrollment sample indexes are missing or contain gaps.",
    });
  }

  return [...acceptedSamples].sort(
    (a, b) => a.sampleIndex - b.sampleIndex,
  );
}

/**
 * Validates one decrypted plaintext vector:
 *   - dimension equals the expected embedding dimension,
 *   - vector is non-empty,
 *   - every value is finite,
 *   - L2 norm is approximately 1.0 within the existing tolerance.
 *
 * A persisted malformed plaintext vector is treated as a
 * server/data-integrity failure. We do NOT silently re-normalize.
 */
function validateDecryptedVector(
  vector: Float32Array,
  expectedDimension: number,
): void {
  if (!vector || vector.length === 0) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES
        .ENROLLMENT_SAMPLE_VECTOR_INVALID,
      message: "Decrypted plaintext vector is empty.",
    });
  }
  if (vector.length !== expectedDimension) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES
        .ENROLLMENT_SAMPLE_VECTOR_INVALID,
      message: "Decrypted plaintext vector has the wrong dimension.",
    });
  }
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i]!)) {
      throw new EnrollmentFinalizationError({
        code: ENROLLMENT_FINALIZATION_ERROR_CODES
          .ENROLLMENT_SAMPLE_VECTOR_INVALID,
        message:
          "Decrypted plaintext vector contains a non-finite value.",
      });
    }
  }
  const norm = l2Norm(Array.from(vector));
  if (
    !Number.isFinite(norm) ||
    Math.abs(norm - 1) > PLAINTEXT_VECTOR_L2_NORM_TOLERANCE
  ) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES
        .ENROLLMENT_SAMPLE_VECTOR_INVALID,
      message: "Decrypted plaintext vector is not L2-normalised.",
    });
  }
}

/**
 * Re-checks the session identity (existence + expiration +
 * completeness + generationId) AFTER the Face Service call. Throws
 * `ENROLLMENT_GENERATION_CHANGED` (or the appropriate stable code)
 * if anything has drifted.
 *
 * IMPORTANT (for future phases): this is a single-document, non-atomic
 * check. PHASE 4.6B2 MUST still atomically verify
 * `generationId === sourceGenerationId` when persisting the
 * `FaceProfile` and consuming the temporary session. B1B reduces
 * stale-result risk but does NOT close the persistence race.
 */
async function recheckSessionIdentity(params: {
  userId: string;
  sourceGenerationId: string;
  requiredSampleCount: number;
  now: Date;
}): Promise<void> {
  const reread = await getEnrollmentSessionByUserId(params.userId);
  if (!reread) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_GENERATION_CHANGED,
      message: "Enrollment session disappeared during finalization.",
    });
  }
  if (isEnrollmentSessionExpired(reread, params.now)) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_SESSION_EXPIRED,
      message:
        "Enrollment session expired during finalization.",
    });
  }
  if (
    !isNonEmptyString(reread.generationId) ||
    reread.generationId !== params.sourceGenerationId
  ) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_GENERATION_CHANGED,
      message:
        "Enrollment generation changed during finalization.",
    });
  }
  if (reread.acceptedSamples.length !== params.requiredSampleCount) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_GENERATION_CHANGED,
      message:
        "Enrollment session is no longer complete after finalization.",
    });
  }
}

/**
 * Maps a typed underlying error into a stable
 * `EnrollmentFinalizationError` with a `domainError` field. The
 * mapping never includes ciphertext, IV, authTag, key material,
 * plaintext vectors, centroid values, or stack traces.
 */
function toFinalizationError(err: unknown): EnrollmentFinalizationError {
  if (err instanceof EnrollmentFinalizationError) {
    return err;
  }
  if (err instanceof FaceServiceClientError) {
    return new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_FINALIZATION_FAILED,
      message: "Face Service rejected the finalization request.",
      domainError: err.domainError ?? {
        code: err.code,
        message: err.message,
      },
    });
  }
  if (err instanceof BiometricError) {
    // AES-GCM utility — decryption / key / vector / unsupported
    // version errors all collapse to a safe
    // ENROLLMENT_SAMPLE_DECRYPTION_FAILED surface so the caller
    // never sees the underlying crypto detail.
    void BIOMETRIC_ERROR_CODES; // referenced for future-proofing
    return new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES
        .ENROLLMENT_SAMPLE_DECRYPTION_FAILED,
      message: "Failed to decrypt an enrollment sample.",
      domainError: { code: err.code, message: err.message },
    });
  }
  return new EnrollmentFinalizationError({
    code: ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_FINALIZATION_FAILED,
    message: "Enrollment finalization failed.",
  });
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Orchestrates decryption of the current temporary enrollment session
 * and forwards the decrypted, L2-normalized embeddings to the PHASE
 * 4.6B1A client for finalization.
 *
 * This function is **SERVER-ONLY** (the module opens with
 * `import "server-only"`).
 *
 * Input contract:
 *   - `userId` MUST be obtained from a future authenticated server
 *     caller (`auth.api.getSession()` in PHASE 4.6B3). The browser
 *     must never choose the userId. B1B documents this as a
 *     precondition; B1B does not authenticate.
 *
 * Output contract:
 *   - Returns a server-only `EnrollmentFinalizationResult`.
 *   - The centroid is included in the returned
 *     `finalization.centroid` because PHASE 4.6B2 needs it for
 *     encryption and persistence.
 *   - Plaintext sample embeddings, ciphertext, IV, authTag, AAD, and
 *     the userId are NEVER returned to the caller.
 *
 * Failure modes (all stable codes):
 *   - `ENROLLMENT_SESSION_NOT_FOUND`
 *   - `ENROLLMENT_SESSION_EXPIRED`
 *   - `ENROLLMENT_INCOMPLETE`
 *   - `ENROLLMENT_SESSION_INVALID`
 *   - `UNSUPPORTED_ENROLLMENT_MODE`
 *   - `UNSUPPORTED_TEMPLATE_VERSION`
 *   - `ENROLLMENT_SAMPLE_INDEX_INVALID`
 *   - `ENROLLMENT_SAMPLE_DECRYPTION_FAILED`
 *     (mapped from underlying `BiometricError`)
 *   - `ENROLLMENT_SAMPLE_VECTOR_INVALID`
 *   - `ENROLLMENT_GENERATION_CHANGED`
 *   - `ENROLLMENT_FINALIZATION_FAILED`
 *     (mapped from underlying `FaceServiceClientError` while
 *     preserving domain codes such as INCONSISTENT_FACE_SAMPLES on
 *     `domainError.code`)
 */
export async function finalizeEnrollmentSessionForUser(
  userId: string,
): Promise<EnrollmentFinalizationResult> {
  if (!isNonEmptyString(userId)) {
    throw new EnrollmentFinalizationError({
      code: ENROLLMENT_FINALIZATION_ERROR_CODES.ENROLLMENT_SESSION_INVALID,
      message: "finalizeEnrollmentSessionForUser requires a non-empty userId.",
    });
  }

  const now = new Date();

  // ---- 1. Load session (preserves legacy generationId backfill) ----
  const session = await getEnrollmentSessionByUserId(userId);

  // ---- 2. Validate session preconditions ----
  validateSessionForFinalization(session);

  const sessionModelIdentity: string = session.modelIdentity as string;
  const sessionModelName: string = session.modelName as string;
  const sessionEmbeddingDimension: number = session.embeddingDimension as number;
  const sessionNormalization: Normalization =
    session.normalization as Normalization;
  const sessionTemplateVersion: number = session.templateVersion;
  const sourceGenerationId: string = session.generationId;

  // ---- 3. Validate and sort sample indexes ----
  const orderedSamples = validateAndSortSamples(
    session.acceptedSamples,
    session.requiredSampleCount,
  );

  // ---- 4. Decrypt all samples server-side with reconstructed AAD ----
  // The decrypted plaintext vectors MUST outlive the call to
  // `finalizeFaceEnrollment(...)` because they are passed by
  // reference. Best-effort clearing happens AFTER the call (and
  // inside its own try/finally so an early throw still wipes the
  // local buffers).
  const decryptedVectors: number[][] = [];
  try {
    for (const sample of orderedSamples) {
      const aad = buildSampleAAD({
        userId,
        modelIdentity: sessionModelIdentity,
        templateVersion: sessionTemplateVersion,
        sampleIndex: sample.sampleIndex,
      });
      let plaintext: Float32Array;
      try {
        plaintext = decryptBiometricVector(sample.encryptedVector, aad);
      } catch (err) {
        throw toFinalizationError(err);
      }
      validateDecryptedVector(plaintext, sessionEmbeddingDimension);
      const copy = float32ArrayToNumberArray(plaintext);
      decryptedVectors.push(copy);
      // Best-effort clearing of the per-sample local Float32Array.
      // The numeric `copy` is wiped below after B1A returns.
      plaintext.fill(0);
    }
  } catch (err) {
    // Wipe anything we already accumulated before the failure
    // (e.g. decryption aborts on sample 3 after samples 0..2
    // succeeded).
    for (const v of decryptedVectors) {
      for (let i = 0; i < v.length; i++) {
        v[i] = 0;
      }
    }
    throw err;
  }

  // ---- 5. Call the PHASE 4.6B1A client exactly once ----
  let result: FinalizeFaceEnrollmentResult;
  try {
    result = await finalizeFaceEnrollment({
      model: {
        identity: sessionModelIdentity,
        name: sessionModelName,
        embeddingDimension: sessionEmbeddingDimension,
        normalization: sessionNormalization,
      },
      requiredSampleCount: session.requiredSampleCount,
      embeddings: decryptedVectors,
    });
  } catch (err) {
    throw toFinalizationError(err);
  } finally {
    // Wipe the local plaintext vectors as soon as the Face Service
    // call is resolved. JavaScript does not guarantee memory
    // zeroization, but this best-effort scrub keeps the residual
    // window small.
    for (const v of decryptedVectors) {
      for (let i = 0; i < v.length; i++) {
        v[i] = 0;
      }
    }
  }

  // ---- 6. Re-check the enrollment generation AFTER finalize ----
  await recheckSessionIdentity({
    userId,
    sourceGenerationId,
    requiredSampleCount: session.requiredSampleCount,
    now,
  });

  // ---- 7. Build the server-only result ----
  return {
    sourceGenerationId,
    mode: session.mode,
    templateVersion: sessionTemplateVersion,
    requiredSampleCount: session.requiredSampleCount,
    model: {
      identity: result.model.identity,
      name: result.model.name,
      embeddingDimension: result.model.embeddingDimension,
      normalization: result.model.normalization,
    },
    finalization: {
      sampleCount: result.sampleCount,
      pairCount: result.pairCount,
      minSelfSimilarity: result.minSelfSimilarity,
      meanSelfSimilarity: result.meanSelfSimilarity,
      threshold: result.threshold,
      centroid: result.centroid,
    },
  };
}

// =============================================================================
// Exposed for tests
// =============================================================================

/**
 * Stable error code constants and helper functions are re-exported so
 * unit tests can assert on them without reaching into private state.
 *
 * NOT exported through any barrel/index module → browser cannot
 * accidentally import this server-only module.
 */
export const __testing = {
  PLAINTEXT_VECTOR_L2_NORM_TOLERANCE,
  SUPPORTED_FINALIZATION_MODES,
  SUPPORTED_TEMPLATE_VERSIONS,
  SUPPORTED_NORMALIZATIONS,
  buildSampleAAD,
  validateAndSortSamples,
  validateDecryptedVector,
};

void FINALIZATION_ERROR_CODES; // referenced for future-proofing
