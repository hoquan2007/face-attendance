/**
 * Error types for Face Service client operations.
 *
 * PHASE 4.4A — Server-only client for FastAPI Face Service communication.
 *
 * This module provides stable error codes and safe error shapes that
 * can be exposed to callers without leaking internal details.
 */

/**
 * Stable error codes for Face Service client operations.
 *
 * These codes are safe to expose to callers and log without
 * leaking secrets, embeddings, or internal error details.
 */
export const FACE_SERVICE_ERROR_CODES = {
  /** Face Service URL is not configured. */
  FACE_SERVICE_NOT_CONFIGURED: "FACE_SERVICE_NOT_CONFIGURED",
  /** Face Service is unreachable or returned an unexpected error. */
  FACE_SERVICE_UNAVAILABLE: "FACE_SERVICE_UNAVAILABLE",
  /** Request timed out waiting for Face Service response. */
  FACE_SERVICE_TIMEOUT: "FACE_SERVICE_TIMEOUT",
  /** Service token is missing or invalid. */
  FACE_SERVICE_UNAUTHORIZED: "FACE_SERVICE_UNAUTHORIZED",
  /** Face Service returned malformed or unexpected JSON. */
  FACE_SERVICE_INVALID_RESPONSE: "FACE_SERVICE_INVALID_RESPONSE",
  /** Face Service rejected the request with a domain error. */
  FACE_SERVICE_REJECTED_REQUEST: "FACE_SERVICE_REJECTED_REQUEST",
} as const;

export type FaceServiceErrorCode =
  (typeof FACE_SERVICE_ERROR_CODES)[keyof typeof FACE_SERVICE_ERROR_CODES];

/**
 * Shape of a safe Face Service error (exposed to callers).
 *
 * Does NOT contain raw fetch stack traces, secrets, or embedding values.
 */
export interface FaceServiceErrorShape {
  code: FaceServiceErrorCode;
  message: string;
  /** Domain error details when FACE_SERVICE_REJECTED_REQUEST. */
  domainError?: {
    code: string;
    message: string;
  };
}

/**
 * Application-level error for Face Service operations.
 *
 * Does NOT expose raw fetch stack traces, secrets, or embedding values.
 */
export class FaceServiceClientError extends Error {
  public readonly code: FaceServiceErrorCode;
  public readonly domainError?: { code: string; message: string };

  constructor({
    code,
    message,
    domainError,
  }: {
    code: FaceServiceErrorCode;
    message: string;
    domainError?: { code: string; message: string };
  }) {
    super(message);
    this.name = "FaceServiceClientError";
    this.code = code;
    this.domainError = domainError;
  }

  toJSON(): FaceServiceErrorShape {
    return {
      code: this.code,
      message: this.message,
      ...(this.domainError ? { domainError: this.domainError } : {}),
    };
  }
}

/**
 * Stable Face Service domain error codes for the enrollment
 * finalization endpoint (`POST /v1/faces/enrollment/finalize`).
 *
 * These are the upstream codes that PHASE 4.6A2 may return in its
 * `{ "error": { "code", "message" } }` envelope. They are preserved
 * verbatim inside `FaceServiceClientError.domainError.code` so
 * future orchestration layers can map them to user-facing codes
 * without leaking raw fetch internals.
 *
 * NOTE: these are NOT `FaceServiceErrorCode` values — they live on
 * `domainError.code` only. The top-level `FaceServiceClientError.code`
 * stays one of the transport-level `FACE_SERVICE_ERROR_CODES`.
 */
export const FINALIZATION_ERROR_CODES = {
  MODEL_MISMATCH: "MODEL_MISMATCH",
  INVALID_SAMPLE_COUNT: "INVALID_SAMPLE_COUNT",
  INVALID_EMBEDDING: "INVALID_EMBEDDING",
  EMBEDDING_DIMENSION_MISMATCH: "EMBEDDING_DIMENSION_MISMATCH",
  EMBEDDING_NOT_NORMALIZED: "EMBEDDING_NOT_NORMALIZED",
  INCONSISTENT_FACE_SAMPLES: "INCONSISTENT_FACE_SAMPLES",
  INVALID_CENTROID: "INVALID_CENTROID",
} as const;

export type FinalizationErrorCode =
  (typeof FINALIZATION_ERROR_CODES)[keyof typeof FINALIZATION_ERROR_CODES];
