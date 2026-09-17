/**
 * Face Service HTTP Client
 *
 * PHASE 4.4A — Server-only client for communicating with the FastAPI Face Service.
 *
 * ⚠️  SERVER-ONLY MODULE ⚠️
 *
 * The very first line of this file is an actual Next.js server-only guard
 * (`import "server-only"`). If a Client Component ever imports this module,
 * the build will fail with:
 *   "This module cannot be imported from a Client Component module."
 *
 * Allowed import sites:
 * - Server Components
 * - Server Actions
 * - Route Handlers (API routes)
 * - Other server-only modules (e.g. `@/lib/biometrics/encryption`)
 *
 * NEVER import this from:
 * - Client Components
 * - Browser code
 * - Client-side hooks or utilities
 *
 * The `server-only` package's `default` export throws when imported from
 * a Client Component. Next.js resolves the `react-server` export
 * condition to an empty no-op in Server Components, Route Handlers,
 * and Server Actions, so the guard is a no-op in legitimate server
 * contexts and a build-time error in client contexts.
 *
 * Tests stub `server-only` via a Vitest alias (see `vitest.config.ts`)
 * to a tiny no-op module so unit tests can still import and exercise
 * this module without weakening the production guard.
 *
 * Usage:
 * ```typescript
 * import { getFaceServiceHealth, analyzeEnrollmentSample } from "@/lib/biometrics/face-service-client";
 *
 * // Health check
 * const health = await getFaceServiceHealth();
 * console.log(health.ready);
 *
 * // Analyze enrollment sample
 * const result = await analyzeEnrollmentSample(imageBuffer, "image/jpeg");
 * if (result.accepted) {
 *   console.log("Embedding dimension:", result.embedding?.length);
 * }
 * ```
 */
import "server-only";

import { z } from "zod";

import { env } from "@/lib/env";
import {
  FACE_SERVICE_ERROR_CODES,
  FaceServiceClientError,
} from "./face-service-errors";

// Re-export for external consumption
export {
  FACE_SERVICE_ERROR_CODES,
  FINALIZATION_ERROR_CODES,
  FaceServiceClientError,
} from "./face-service-errors";
export type {
  FaceServiceErrorCode,
  FinalizationErrorCode,
  FaceServiceErrorShape,
} from "./face-service-errors";

// =============================================================================
// Configuration
// =============================================================================

/** Centralized timeout for Face Service requests (10 seconds). */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Gets the normalized Face Service base URL.
 *
 * Ensures no double slashes or trailing slashes that could cause
 * malformed URLs like `http://127.0.0.1:8001//health`.
 *
 * @returns The normalized base URL without trailing slash.
 * @throws {FaceServiceClientError} If FACE_SERVICE_URL is not configured.
 */
function getFaceServiceUrl(): string {
  const url = env.FACE_SERVICE_URL;

  if (!url) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_NOT_CONFIGURED,
      message: "FACE_SERVICE_URL is not configured.",
    });
  }

  // Normalize: strip trailing slash only.
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/**
 * Gets the Face Service secret token.
 *
 * @throws {FaceServiceClientError} If FACE_SERVICE_SECRET is not configured.
 */
function getFaceServiceSecret(): string {
  const secret = env.FACE_SERVICE_SECRET;

  if (!secret) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_NOT_CONFIGURED,
      message: "FACE_SERVICE_SECRET is not configured.",
    });
  }

  return secret;
}

// =============================================================================
// HTTP Client
// =============================================================================

/**
 * Makes a request to the Face Service with timeout and error handling.
 *
 * @param path - The API path (e.g., "/health")
 * @param options - Request options
 * @returns Parsed JSON response
 * @throws {FaceServiceClientError} On various failure conditions
 */
async function faceServiceRequest<T>(
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: BodyInit | null;
    requireAuth?: boolean;
    schema: z.ZodSchema<T>;
  },
): Promise<T> {
  const { method = "GET", headers = {}, body = null, requireAuth = false, schema } = options;

  // Ensure URL is configured before making any request.
  const baseUrl = getFaceServiceUrl();

  // Build URL - ensure single slash between base and path.
  const url = path.startsWith("/")
    ? `${baseUrl}${path}`
    : `${baseUrl}/${path}`;

  // Build headers.
  const requestHeaders: Record<string, string> = { ...headers };

  // Add auth token if required.
  if (requireAuth) {
    const secret = getFaceServiceSecret();
    requestHeaders["X-Service-Token"] = secret;
  }

  // Create abort controller for timeout.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method,
      headers: requestHeaders,
      body,
      signal: controller.signal,
    });

    // Clear timeout since request completed.
    clearTimeout(timeoutId);

    // Handle HTTP errors.
    if (!response.ok) {
      // Attempt to parse error envelope from Face Service.
      let domainError: { code: string; message: string } | undefined;

      try {
        const errorBody = await response.json();
        if (errorBody?.error?.code && errorBody?.error?.message) {
          domainError = {
            code: String(errorBody.error.code),
            message: String(errorBody.error.message),
          };
        }
      } catch {
        // Error body is not JSON or couldn't be parsed.
      }

      // Map HTTP status to error code.
      if (response.status === 401) {
        throw new FaceServiceClientError({
          code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_UNAUTHORIZED,
          message: "Face Service authorization failed.",
          domainError,
        });
      }

      throw new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_REJECTED_REQUEST,
        message: `Face Service rejected the request: HTTP ${response.status}`,
        domainError,
      });
    }

    // Parse JSON response.
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        message: "Face Service returned invalid JSON.",
      });
    }

    // Validate response shape with Zod.
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        message: "Face Service returned an unexpected response shape.",
      });
    }

    return parsed.data;
  } catch (error) {
    // Clear timeout on any error path.
    clearTimeout(timeoutId);

    // Re-throw if already a FaceServiceClientError.
    if (error instanceof FaceServiceClientError) {
      throw error;
    }

    // Handle abort (timeout).
    if (error instanceof Error && error.name === "AbortError") {
      throw new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_TIMEOUT,
        message: `Face Service request timed out after ${REQUEST_TIMEOUT_MS}ms.`,
      });
    }

    // Handle network failures (no Face Service running, DNS error, etc.).
    if (error instanceof TypeError && error.message.includes("fetch")) {
      throw new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_UNAVAILABLE,
        message: "Face Service is unavailable.",
      });
    }

    // Unknown error - wrap safely.
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_UNAVAILABLE,
      message: "An unexpected error occurred while calling Face Service.",
    });
  }
}

// =============================================================================
// Response Schemas (Zod)
// =============================================================================

/** Quality metrics returned with enrollment sample responses. */
const EnrollmentQualitySchema = z.object({
  detection_score: z.number(),
  face_width: z.number(),
  face_height: z.number(),
  relative_face_area: z.number(),
  blur_score: z.number(),
  brightness: z.number(),
  near_edge: z.boolean(),
});

export type EnrollmentQuality = z.infer<typeof EnrollmentQualitySchema>;

/** Model metadata returned with accepted enrollment samples. */
const EnrollmentModelMetadataSchema = z.object({
  identity: z.string(),
  name: z.string(),
  embedding_dimension: z.number().int().positive(),
  normalization: z.string(),
});

export type EnrollmentModelMetadata = z.infer<
  typeof EnrollmentModelMetadataSchema
>;

/** Response schema for accepted enrollment sample. */
const AcceptedEnrollmentSampleSchema = z.object({
  accepted: z.literal(true),
  quality: EnrollmentQualitySchema,
  embedding: z
    .array(z.number())
    .min(1, "Embedding must be non-empty"),
  rejection_reasons: z.array(z.string()),
  model: EnrollmentModelMetadataSchema,
  processing_ms: z.number().nonnegative(),
});

/** Response schema for rejected enrollment sample. */
const RejectedEnrollmentSampleSchema = z.object({
  accepted: z.literal(false),
  quality: EnrollmentQualitySchema,
  embedding: z.null(),
  rejection_reasons: z.array(z.string()).min(1, "Rejection reasons must be present"),
  model: z.null(),
  processing_ms: z.number().nonnegative(),
});

/** Union schema for enrollment sample responses. */
const EnrollmentSampleResponseSchema = z.discriminatedUnion("accepted", [
  AcceptedEnrollmentSampleSchema,
  RejectedEnrollmentSampleSchema,
]);

export type EnrollmentSampleResponse = z.infer<
  typeof EnrollmentSampleResponseSchema
>;

/** Health check response schema. */
const HealthResponseSchema = z.object({
  status: z.string(),
  engine: z.string().nullable(),
  model: z.string().nullable(),
  provider: z.string().nullable(),
  ready: z.boolean(),
  embedding_dimension: z.number().int().positive().nullable(),
  error_code: z.string().nullable().optional(),
  error_message: z.string().nullable().optional(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// =============================================================================
// Embedding Validation
// =============================================================================

/**
 * Validates an embedding vector from an accepted enrollment sample.
 *
 * Checks:
 * - Embedding exists and is non-empty.
 * - All values are finite numbers.
 * - Dimension matches the expected model dimension.
 * - Normalization is "l2".
 *
 * @param embedding - The embedding vector to validate.
 * @param expectedDimension - The expected embedding dimension.
 * @param normalization - The expected normalization.
 * @throws {FaceServiceClientError} If validation fails.
 */
function validateEmbedding(
  embedding: number[],
  expectedDimension: number,
  normalization: string,
): void {
  // Check non-empty.
  if (!embedding || embedding.length === 0) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: "Embedding is empty.",
    });
  }

  // Check all values are finite.
  for (let i = 0; i < embedding.length; i++) {
    if (!Number.isFinite(embedding[i]!)) {
      throw new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        message: `Embedding contains non-finite value at index ${i}.`,
      });
    }
  }

  // Check dimension matches model metadata.
  if (embedding.length !== expectedDimension) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: `Embedding dimension mismatch: expected ${expectedDimension}, got ${embedding.length}.`,
    });
  }

  // Check normalization is l2.
  if (normalization !== "l2") {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: `Unsupported normalization: ${normalization}. Expected "l2".`,
    });
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Checks the health status of the Face Service.
 *
 * @returns The health status response.
 * @throws {FaceServiceClientError} On configuration or network failure.
 *
 * @example
 * ```typescript
 * const health = await getFaceServiceHealth();
 * if (!health.ready) {
 *   console.log("Face Service not ready:", health.error_message);
 * }
 * ```
 */
export async function getFaceServiceHealth(): Promise<HealthResponse> {
  return faceServiceRequest("/health", {
    requireAuth: false,
    schema: HealthResponseSchema,
  });
}

/**
 * Result type for enrollment sample analysis.
 *
 * Represents either an accepted or rejected enrollment sample.
 */
export type EnrollmentSampleResult = EnrollmentSampleResponse;

/**
 * Analyzes a single image as an enrollment sample.
 *
 * Sends the image to the Face Service for quality validation.
 * Returns the embedding only if the sample is accepted.
 *
 * NOTE: This method does NOT automatically retry on failure.
 * Future callers should treat each image as one deliberate biometric
 * operation and handle retries at their discretion.
 *
 * @param image - The image data (Blob, Buffer, ArrayBuffer, etc.).
 * @param mimeType - The MIME type of the image (e.g., "image/jpeg").
 * @returns The enrollment sample result (accepted or rejected).
 * @throws {FaceServiceClientError} On configuration, network, or validation failure.
 *
 * @example
 * ```typescript
 * // From a File in a route handler
 * const file = await request.file();
 * const buffer = await file.arrayBuffer();
 * const result = await analyzeEnrollmentSample(buffer, file.type);
 *
 * if (result.accepted) {
 *   // Embedding is available for encryption and storage
 *   console.log("Dimension:", result.embedding?.length);
 *   console.log("Model:", result.model?.identity);
 * } else {
 *   // Show rejection reasons to user
 *   console.log("Rejected:", result.rejection_reasons);
 * }
 * ```
 */
export async function analyzeEnrollmentSample(
  image: BodyInit,
  mimeType: string,
): Promise<EnrollmentSampleResult> {
  const result = await faceServiceRequest<EnrollmentSampleResponse>(
    "/v1/faces/enrollment/sample",
    {
      method: "POST",
      headers: {
        // Note: Content-Type is set automatically by fetch for FormData.
        // Setting it manually for Blob/ArrayBuffer to ensure proper typing.
        ...(!(image instanceof FormData)
          ? { "Content-Type": mimeType }
          : {}),
      },
      body: image,
      requireAuth: true,
      schema: EnrollmentSampleResponseSchema,
    },
  );

  // Additional validation for accepted samples.
  if (result.accepted) {
    if (!result.embedding || result.model === null) {
      // Should be caught by Zod schema, but defensive check.
      throw new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        message: "Accepted sample missing embedding or model metadata.",
      });
    }

    // Validate embedding against model metadata.
    validateEmbedding(
      result.embedding,
      result.model.embedding_dimension,
      result.model.normalization,
    );
  } else {
    // Rejected samples must have rejection reasons and no embedding.
    if (result.embedding !== null) {
      throw new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        message: "Rejected sample should not contain an embedding.",
      });
    }
    if (result.model !== null) {
      throw new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        message: "Rejected sample should not contain model metadata.",
      });
    }
  }

  return result;
}

// =============================================================================
// Enrollment Finalization (PHASE 4.6B1A)
// =============================================================================

/**
 * Tolerance for L2-norm validation of returned centroids.
 *
 * Mirrors the existing PHASE 4.6A1 backend tolerance (1e-3) so
 * that future Next.js orchestration rejects the same vectors the
 * Face Service would reject. We do NOT silently repair invalid
 * centroids here.
 */
const CENTROID_L2_NORM_TOLERANCE = 1e-3;

/** Runtime model metadata — request-side contract. */
const FinalizeRequestModelMetadataSchema = z.object({
  identity: z.string(),
  name: z.string(),
  embeddingDimension: z.number().int().positive(),
  normalization: z.string(),
});

/** Finalization input — server-internal only. */
const FinalizeFaceEnrollmentInputSchema = z.object({
  model: FinalizeRequestModelMetadataSchema,
  requiredSampleCount: z.number().int().min(2),
  embeddings: z
    .array(z.array(z.number()))
    .min(1, "Embeddings must be non-empty"),
});

export type FinalizeFaceEnrollmentInput = z.infer<
  typeof FinalizeFaceEnrollmentInputSchema
>;

/** Successful response model metadata (runtime engine). */
const FinalizeResponseModelMetadataSchema = z.object({
  identity: z.string(),
  name: z.string(),
  embedding_dimension: z.number().int().positive(),
  normalization: z.string(),
});

/** Successful finalization response schema. */
const FinalizeFaceEnrollmentResponseSchema = z.object({
  consistent: z.literal(true),
  sample_count: z.number().int().nonnegative(),
  pair_count: z.number().int().nonnegative(),
  min_self_similarity: z.number(),
  mean_self_similarity: z.number(),
  threshold: z.number(),
  centroid: z.array(z.number()),
  model: FinalizeResponseModelMetadataSchema,
});

export type FinalizeFaceEnrollmentResult = {
  consistent: true;
  sampleCount: number;
  pairCount: number;
  minSelfSimilarity: number;
  meanSelfSimilarity: number;
  threshold: number;
  centroid: number[];
  model: {
    identity: string;
    name: string;
    embeddingDimension: number;
    normalization: string;
  };
};

/**
 * Validates a single embedding vector (length only, finiteness only,
 * and dimension match against the supplied metadata).
 *
 * The Face Service remains authoritative for normalization, zero-norm,
 * and arithmetic validation. We do NOT silently re-normalize here.
 */
function validateFinalizationEmbedding(
  embedding: number[],
  expectedDimension: number,
): void {
  if (!embedding || embedding.length === 0) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: "Finalization embedding is empty.",
    });
  }

  if (embedding.length !== expectedDimension) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: `Finalization embedding dimension mismatch: expected ${expectedDimension}, got ${embedding.length}.`,
    });
  }

  for (let i = 0; i < embedding.length; i++) {
    if (!Number.isFinite(embedding[i]!)) {
      throw new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        message: `Finalization embedding contains non-finite value at index ${i}.`,
      });
    }
  }
}

/**
 * Validates the centroid returned by the Face Service before we hand
 * it to future Next.js orchestration.
 *
 * - array is non-empty,
 * - all values finite,
 * - dimension equals returned model embedding dimension,
 * - dimension equals expected request model dimension,
 * - L2 norm is approximately 1.
 *
 * Does NOT silently repair invalid centroids.
 */
function validateCentroid(
  centroid: number[],
  responseEmbeddingDimension: number,
  requestEmbeddingDimension: number,
): void {
  if (!centroid || centroid.length === 0) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: "Finalization centroid is empty.",
    });
  }

  if (centroid.length !== responseEmbeddingDimension) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: `Finalization centroid dimension mismatch with response model: expected ${responseEmbeddingDimension}, got ${centroid.length}.`,
    });
  }

  if (centroid.length !== requestEmbeddingDimension) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: `Finalization centroid dimension mismatch with request model: expected ${requestEmbeddingDimension}, got ${centroid.length}.`,
    });
  }

  for (let i = 0; i < centroid.length; i++) {
    if (!Number.isFinite(centroid[i]!)) {
      throw new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        message: `Finalization centroid contains non-finite value at index ${i}.`,
      });
    }
  }

  let sumSquares = 0;
  for (let i = 0; i < centroid.length; i++) {
    sumSquares += centroid[i]! * centroid[i]!;
  }
  const norm = Math.sqrt(sumSquares);

  if (!Number.isFinite(norm)) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: "Finalization centroid L2 norm is not finite.",
    });
  }

  if (Math.abs(norm - 1) > CENTROID_L2_NORM_TOLERANCE) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: `Finalization centroid is not L2-normalised (|v|=${norm}).`,
    });
  }
}

/**
 * Finalizes an enrollment batch by sending already-decrypted,
 * already-L2-normalised embeddings to the trusted Face Service
 * (`POST /v1/faces/enrollment/finalize`).
 *
 * PHASE 4.6B1A — server-only Next.js client. The caller is expected
 * to be trusted Next.js orchestration code (a Route Handler or
 * Server Action) running outside any Client Component tree.
 *
 * Server-internal contract:
 * - The request never carries `userId`, `email`, generationId, or
 *   any MongoDB identifier.
 * - Embeddings must already be L2-normalised — the client validates
 *   shape and finite-ness only. Mathematical validation remains the
 *   responsibility of the Face Service.
 *
 * Behaviour:
 * - One POST. No automatic retry.
 * - Uses `X-Service-Token` for server-to-server auth.
 * - Reuses the existing `AbortController` + 10-second timeout.
 * - On `INCONSISTENT_FACE_SAMPLES`, throws a
 *   `FaceServiceClientError` with `code = FACE_SERVICE_REJECTED_REQUEST`
 *   and `domainError.code = INCONSISTENT_FACE_SAMPLES`. The centroid
 *   is NEVER exposed on this path.
 * - Preserves upstream domain codes (MODEL_MISMATCH,
 *   INVALID_SAMPLE_COUNT, INVALID_EMBEDDING,
 *   EMBEDDING_DIMENSION_MISMATCH, EMBEDDING_NOT_NORMALIZED,
 *   INVALID_CENTROID) on `domainError.code`.
 * - Response model metadata must EXACTLY match the requested model —
 *   mismatches are treated as `FACE_SERVICE_INVALID_RESPONSE` so that
 *   future persistence under mismatched metadata is impossible.
 *
 * @throws {FaceServiceClientError} On configuration, network,
 *   validation, or domain failure. The error never includes raw
 *   embeddings, centroid values, or secrets.
 */
export async function finalizeFaceEnrollment(
  input: FinalizeFaceEnrollmentInput,
): Promise<FinalizeFaceEnrollmentResult> {
  // ---- 1. Input validation (server-side boundary) ---------------------
  const parsed = FinalizeFaceEnrollmentInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: "Invalid finalization input.",
    });
  }
  const validInput = parsed.data;

  // Sample count >= 2.
  if (validInput.requiredSampleCount < 2) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: `requiredSampleCount must be >= 2; got ${validInput.requiredSampleCount}.`,
    });
  }

  // Embeddings non-empty.
  if (validInput.embeddings.length === 0) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: "Embeddings list is empty.",
    });
  }

  // Embedding count must match required sample count.
  if (validInput.embeddings.length !== validInput.requiredSampleCount) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: `Embeddings count (${validInput.embeddings.length}) must equal requiredSampleCount (${validInput.requiredSampleCount}).`,
    });
  }

  // Normalization metadata must be supported.
  if (validInput.model.normalization !== "l2") {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: `Unsupported normalization: ${validInput.model.normalization}. Expected "l2".`,
    });
  }

  // Per-vector validation: dimension match + finite values.
  for (let i = 0; i < validInput.embeddings.length; i++) {
    validateFinalizationEmbedding(
      validInput.embeddings[i]!,
      validInput.model.embeddingDimension,
    );
  }

  // ---- 2. Build the request body (NO userId / generationId / etc.) ---
  const requestBody = {
    model: {
      identity: validInput.model.identity,
      name: validInput.model.name,
      embedding_dimension: validInput.model.embeddingDimension,
      normalization: validInput.model.normalization,
    },
    required_sample_count: validInput.requiredSampleCount,
    embeddings: validInput.embeddings,
  };

  // ---- 3. Single POST, no automatic retry ----------------------------
  // We deliberately do NOT inspect a "consistent:false" success
  // envelope as success: PHASE 4.6A2 currently maps every domain
  // failure (including INCONSISTENT_FACE_SAMPLES) to an HTTP 422
  // error envelope, which the lower-level `faceServiceRequest`
  // already classifies as `FACE_SERVICE_REJECTED_REQUEST` with
  // `domainError` populated. We only need to ensure the
  // INCONSISTENT_FACE_SAMPLES code is preserved verbatim — which
  // the lower-level path already does — and we must NOT expose
  // any centroid value on that path. The success schema below
  // refuses anything other than `consistent: true` at the Zod
  // level, so a stale or incorrectly-classified inconsistent
  // response can never be returned as a centroid-carrying result.
  const response = await faceServiceRequest<{
    consistent: true;
    sample_count: number;
    pair_count: number;
    min_self_similarity: number;
    mean_self_similarity: number;
    threshold: number;
    centroid: number[];
    model: {
      identity: string;
      name: string;
      embedding_dimension: number;
      normalization: string;
    };
  }>("/v1/faces/enrollment/finalize", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
    requireAuth: true,
    schema: FinalizeFaceEnrollmentResponseSchema,
  });

  // ---- 4. Response model metadata must exactly match request ---------
  if (response.model.identity !== validInput.model.identity) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: "Finalization response model identity does not match request.",
    });
  }
  if (response.model.name !== validInput.model.name) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: "Finalization response model name does not match request.",
    });
  }
  if (
    response.model.embedding_dimension !==
    validInput.model.embeddingDimension
  ) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: "Finalization response model embedding dimension does not match request.",
    });
  }
  if (response.model.normalization !== validInput.model.normalization) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: "Finalization response model normalization does not match request.",
    });
  }

  // ---- 5. Centroid validation ---------------------------------------
  validateCentroid(
    response.centroid,
    response.model.embedding_dimension,
    validInput.model.embeddingDimension,
  );

  // ---- 6. Build strongly typed server-only result --------------------
  return {
    consistent: true,
    sampleCount: response.sample_count,
    pairCount: response.pair_count,
    minSelfSimilarity: response.min_self_similarity,
    meanSelfSimilarity: response.mean_self_similarity,
    threshold: response.threshold,
    centroid: response.centroid,
    model: {
      identity: response.model.identity,
      name: response.model.name,
      embeddingDimension: response.model.embedding_dimension,
      normalization: response.model.normalization,
    },
  };
}

// =============================================================================
// Attendance Recognition — PHASE 6.3
// =============================================================================

/** Gallery candidate for attendance recognition. Uses ephemeral candidate keys. */
export interface IdentifyGalleryCandidate {
  candidateKey: string;
  embedding: Float32Array;
  embeddingDimension: number;
  normalization: "l2";
}

/** Response schema for identify endpoint. */
const IdentifyMatchResponseSchema = z.object({
  face_index: z.number().int().nonnegative(),
  candidate_key: z.string().min(1),
});

const IdentifyResponseSchema = z.object({
  faces_detected: z.number().int().nonnegative(),
  matches: z.array(IdentifyMatchResponseSchema),
  unmatched_count: z.number().int().nonnegative(),
  processing_ms: z.number().nonnegative(),
});

export type IdentifyMatchResult = z.infer<typeof IdentifyMatchResponseSchema>;
export type IdentifyResult = z.infer<typeof IdentifyResponseSchema>;

/**
 * Identifies multiple faces in one camera frame against a session-scoped gallery.
 *
 * Sends binary image + gallery JSON to the Face Service's `POST /attendance/identify`.
 * The gallery uses ephemeral candidate keys — no real student identities are sent.
 *
 * @param image - Binary JPEG/PNG image data.
 * @param gallery - Session-scoped recognition gallery with ephemeral candidate keys.
 * @param maxFaces - Maximum faces to process (default 5, max 10).
 * @returns Face Service identification result with ephemeral candidate keys.
 * @throws {FaceServiceClientError} On network, validation, or domain failure.
 *
 * @example
 * ```typescript
 * const result = await identifyFaces(imageBuffer, gallery.candidates, 5);
 * console.log(result.faces_detected);
 * for (const match of result.matches) {
 *   const student = galleryMapping[match.candidate_key];
 *   console.log("Recognized:", student.fullNameSnapshot);
 * }
 * ```
 */
export async function identifyFaces(
  image: BodyInit,
  gallery: IdentifyGalleryCandidate[],
  maxFaces: number = 5,
): Promise<IdentifyResult> {
  if (gallery.length === 0) {
    throw new FaceServiceClientError({
      code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      message: "Gallery must contain at least one candidate.",
    });
  }

  // Validate embeddings locally before sending.
  for (const candidate of gallery) {
    if (!candidate.embedding || candidate.embedding.length === 0) {
      throw new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        message: `Candidate ${candidate.candidateKey} has empty embedding.`,
      });
    }
    if (candidate.embedding.length !== candidate.embeddingDimension) {
      throw new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        message: `Candidate ${candidate.candidateKey} embedding dimension mismatch.`,
      });
    }
    if (candidate.normalization !== "l2") {
      throw new FaceServiceClientError({
        code: FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        message: `Candidate ${candidate.candidateKey} uses unsupported normalization.`,
      });
    }
  }

  // Build gallery JSON payload — ephemeral keys only, no real identities.
  const galleryPayload = gallery.map((c) => ({
    candidate_key: c.candidateKey,
    embedding: Array.from(c.embedding),
    embedding_dimension: c.embeddingDimension,
    normalization: c.normalization,
  }));

  // Build multipart form: binary image + JSON gallery.
  const formData = new FormData();

  // Normalize the image input to a Blob.
  // Accept: ArrayBuffer, Blob, Uint8Array, etc.
  let imageBlob: Blob;
  if (image instanceof Blob) {
    imageBlob = image;
  } else if (image instanceof ArrayBuffer) {
    imageBlob = new Blob([image], { type: "image/jpeg" });
  } else {
    // Treat as Uint8Array / typed array view.
    const view = image as ArrayBufferView;
    imageBlob = new Blob([view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)], {
      type: "image/jpeg",
    });
  }

  formData.append("image", imageBlob, "frame.jpg");
  formData.append(
    "gallery_json",
    JSON.stringify({ gallery: galleryPayload, max_faces: maxFaces }),
  );

  const response = await faceServiceRequest<{
    faces_detected: number;
    matches: { face_index: number; candidate_key: string }[];
    unmatched_count: number;
    processing_ms: number;
  }>("/attendance/identify", {
    method: "POST",
    body: formData,
    requireAuth: true,
    schema: IdentifyResponseSchema,
  });

  return response;
}
