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
  FaceServiceClientError,
} from "./face-service-errors";
export type {
  FaceServiceErrorCode,
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
