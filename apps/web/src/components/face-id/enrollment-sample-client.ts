/**
 * Client-safe helper for submitting one enrollment sample image to
 * the Next.js server-side sample endpoint.
 *
 * PHASE 4.5B3 — Capture + Submit + Quality Feedback.
 *
 * This module lives entirely under `apps/web/src/components/face-id/`
 * so it follows the existing PHASE 4.5A / 4.5B2 client-boundary
 * rules:
 *
 *   - "use client" — safe to import from a Client Component.
 *   - Imports NEITHER server-only modules NOR any environment secret
 *     (no FACE_SERVICE_URL, no X-Service-Token, no
 *     BIOMETRIC_ENCRYPTION_KEY, no MONGODB_URI, no face-service-client,
 *     no encryption module).
 *   - Imports `zod` (already a project dependency) for runtime-safe
 *     parsing of the server response — no field is blindly trusted.
 *   - Hard-codes the browser-only endpoint path
 *     `/api/face-id/enrollment/sample`; the absolute base URL is
 *     always derived from the document/window so the helper works
 *     on any deployment (localhost, Vercel preview, prod).
 *
 * Out of scope:
 *   - Reading the userId / sampleIndex (the server determines them).
 *   - Setting a manual `Content-Type: multipart/form-data` header.
 *     The browser generates the multipart boundary automatically.
 *   - Any kind of retry. One Capture click → at most one POST.
 *   - Touching the Face Service directly.
 *
 * Privacy posture:
 *   - The captured JPEG `Blob` lives only in local variables here.
 *     It is NEVER placed into React state, persistent storage,
 *     URL.createObjectURL, or an `<img>` element.
 *   - The parsed response NEVER contains embedding / ciphertext /
 *     authTag / keyVersion / modelIdentity / userId.
 */
"use client";

import { z } from "zod";

/**
 * Stable server error codes that this client helper preserves
 * verbatim from the route response. The list is the closed subset
 * of `ENROLLMENT_ROUTE_ERROR_CODES` that the route actually emits
 * for the sample endpoint. See:
 *   apps/web/src/lib/biometrics/enrollment-route-errors.ts
 *   docs/api.md → `POST /api/face-id/enrollment/sample`
 *
 * We intentionally do NOT import from the server-only
 * `enrollment-route-errors` module — that would break the
 * client/server boundary. The helper has its own closed enum
 * matching the route's contract.
 *
 * Error codes that trigger server reconciliation:
 *   - ENROLLMENT_SAMPLE_CONFLICT
 *   - ENROLLMENT_SAMPLE_LIMIT_REACHED
 *   - ENROLLMENT_EXPIRED
 *   - ENROLLMENT_NOT_STARTED
 *   - MODEL_MISMATCH
 *   - NETWORK_ERROR
 */
export const SAMPLE_CLIENT_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
  ENROLLMENT_NOT_STARTED: "ENROLLMENT_NOT_STARTED",
  ENROLLMENT_EXPIRED: "ENROLLMENT_EXPIRED",
  INVALID_IMAGE: "INVALID_IMAGE",
  IMAGE_TOO_LARGE: "IMAGE_TOO_LARGE",
  NO_FACE: "NO_FACE",
  MULTIPLE_FACES: "MULTIPLE_FACES",
  FACE_SERVICE_UNAVAILABLE: "FACE_SERVICE_UNAVAILABLE",
  FACE_SERVICE_TIMEOUT: "FACE_SERVICE_TIMEOUT",
  FACE_SERVICE_UNAUTHORIZED: "FACE_SERVICE_UNAUTHORIZED",
  FACE_SERVICE_INVALID_RESPONSE: "FACE_SERVICE_INVALID_RESPONSE",
  FACE_SERVICE_NOT_CONFIGURED: "FACE_SERVICE_NOT_CONFIGURED",
  MODEL_MISMATCH: "MODEL_MISMATCH",
  ENROLLMENT_SAMPLE_LIMIT_REACHED: "ENROLLMENT_SAMPLE_LIMIT_REACHED",
  ENROLLMENT_SAMPLE_CONFLICT: "ENROLLMENT_SAMPLE_CONFLICT",
  BIOMETRIC_ENCRYPTION_UNAVAILABLE: "BIOMETRIC_ENCRYPTION_UNAVAILABLE",
  ENROLLMENT_SAMPLE_FAILED: "ENROLLMENT_SAMPLE_FAILED",
} as const;

/**
 * Error codes that indicate the browser state may be stale and require
 * server reconciliation via router.refresh().
 *
 * When any of these errors occur:
 *   - The browser must NOT locally increment progress
 *   - The browser should trigger a server-state refresh
 *   - Camera remains available for recoverable states (conflict, limit)
 *   - Camera should be stopped for session-invalid states (expired, not started, mismatch)
 */
export const RECONCILE_ERROR_CODES = {
  ENROLLMENT_SAMPLE_CONFLICT: "ENROLLMENT_SAMPLE_CONFLICT",
  ENROLLMENT_SAMPLE_LIMIT_REACHED: "ENROLLMENT_SAMPLE_LIMIT_REACHED",
  ENROLLMENT_EXPIRED: "ENROLLMENT_EXPIRED",
  ENROLLMENT_NOT_STARTED: "ENROLLMENT_NOT_STARTED",
  MODEL_MISMATCH: "MODEL_MISMATCH",
  NETWORK_ERROR: "NETWORK_ERROR",
} as const;

export type ReconcileErrorCode =
  (typeof RECONCILE_ERROR_CODES)[keyof typeof RECONCILE_ERROR_CODES];

/**
 * Checks if an error code requires server-side reconciliation.
 * These errors mean the browser cannot safely assume the current state.
 */
export function requiresReconciliation(code: string): code is ReconcileErrorCode {
  return code in RECONCILE_ERROR_CODES;
}

export type SampleClientErrorCode =
  (typeof SAMPLE_CLIENT_ERROR_CODES)[keyof typeof SAMPLE_CLIENT_ERROR_CODES];

/**
 * Quality rejection codes the Face Service may surface through the
 * safe route response. The order here is the canonical deterministic
 * display order used by the UI layer.
 */
export const QUALITY_REJECTION_CODES = {
  LOW_DETECTION_CONFIDENCE: "LOW_DETECTION_CONFIDENCE",
  FACE_TOO_SMALL: "FACE_TOO_SMALL",
  FACE_TOO_LARGE: "FACE_TOO_LARGE",
  TOO_BLURRY: "TOO_BLURRY",
  TOO_DARK: "TOO_DARK",
  TOO_BRIGHT: "TOO_BRIGHT",
  FACE_NEAR_EDGE: "FACE_NEAR_EDGE",
} as const;

export type QualityRejectionCode =
  (typeof QUALITY_REJECTION_CODES)[keyof typeof QUALITY_REJECTION_CODES];

/**
 * Canonical deterministic ordering of quality rejection reasons. The
 * route returns reasons in its own order; the UI re-orders them
 * through this list so displays are stable across runs.
 */
export const QUALITY_REJECTION_ORDER: readonly QualityRejectionCode[] =
  Object.freeze([
    QUALITY_REJECTION_CODES.LOW_DETECTION_CONFIDENCE,
    QUALITY_REJECTION_CODES.FACE_TOO_SMALL,
    QUALITY_REJECTION_CODES.FACE_TOO_LARGE,
    QUALITY_REJECTION_CODES.TOO_BLURRY,
    QUALITY_REJECTION_CODES.TOO_DARK,
    QUALITY_REJECTION_CODES.TOO_BRIGHT,
    QUALITY_REJECTION_CODES.FACE_NEAR_EDGE,
  ]);

/**
 * Safe progress block mirrored from the route contract.
 */
export interface SampleProgress {
  acceptedSamples: number;
  requiredSamples: number;
  complete: boolean;
}

/**
 * Successful response — the only safe accepted/rejected shape
 * returned by the route. Browsers never receive embeddings,
 * ciphertext, or model identity.
 */
export interface SampleSubmissionOk {
  ok: true;
  accepted: boolean;
  rejectionReasons: readonly QualityRejectionCode[];
  progress: SampleProgress;
}

/**
 * Server-side rejection shape. The `code` is a stable application
 * error code (see `SAMPLE_CLIENT_ERROR_CODES`). The raw `message`
 * from the server is intentionally NOT exposed here — the UI layer
 * maps the code to friendly copy; the server's raw `message` may
 * include implementation phrasing not meant for end users.
 */
export interface SampleSubmissionError {
  ok: false;
  code: SampleClientErrorCode | "NETWORK_ERROR" | "MALFORMED_RESPONSE";
  /**
   * HTTP status code returned by the route. `null` if the request
   * never reached the server (network failure).
   */
  httpStatus: number | null;
}

/**
 * Discriminated union covering every documented outcome of
 * `submitFaceEnrollmentSample()`. The UI branches on this exact shape.
 */
export type SampleSubmissionResult =
  | SampleSubmissionOk
  | SampleSubmissionError;

// =============================================================================
// Zod schemas — runtime-safe parsing of the server response
// =============================================================================

const ProgressBlockSchema = z.object({
  acceptedSamples: z.number().int().nonnegative(),
  requiredSamples: z.number().int().positive(),
  complete: z.boolean(),
});

const OkResponseSchema = z.object({
  accepted: z.boolean(),
  rejectionReasons: z.array(z.string()),
  progress: ProgressBlockSchema,
});

const ErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().min(1).max(200),
    message: z.string().max(2000).optional(),
  }),
});

/**
 * The browser path to the server-side sample endpoint. Kept in one
 * place so it cannot drift from the route handler.
 */
export const ENROLLMENT_SAMPLE_ENDPOINT_PATH =
  "/api/face-id/enrollment/sample" as const;

/**
 * The filename used in the multipart form data. Harmless — the
 * server validates by MIME sniffing, not by filename.
 */
const SAMPLE_FORM_FILENAME = "face-sample.jpg" as const;

/**
 * Tests inject a custom fetch + endpoint to keep the module
 * hermetic. Production callers must not pass these.
 */
export interface SubmitFaceEnrollmentSampleOptions {
  /** Override the endpoint path (used only in tests). */
  endpointPath?: string;
  /** Override the global fetch (used only in tests). */
  fetchImpl?: typeof fetch;
  /**
   * Abort signal, used to keep tests deterministic. Production
   * callers should leave this unset.
   */
  signal?: AbortSignal;
}

// =============================================================================
// Subset guards
// =============================================================================

/**
 * Narrows an arbitrary rejection reason from the server to the
 * closed `QualityRejectionCode` enum. Unknown reasons are dropped
 * silently so the UI never renders an undefined message.
 */
function toQualityRejectionCode(
  raw: string,
): QualityRejectionCode | null {
  switch (raw) {
    case QUALITY_REJECTION_CODES.LOW_DETECTION_CONFIDENCE:
    case QUALITY_REJECTION_CODES.FACE_TOO_SMALL:
    case QUALITY_REJECTION_CODES.FACE_TOO_LARGE:
    case QUALITY_REJECTION_CODES.TOO_BLURRY:
    case QUALITY_REJECTION_CODES.TOO_DARK:
    case QUALITY_REJECTION_CODES.TOO_BRIGHT:
    case QUALITY_REJECTION_CODES.FACE_NEAR_EDGE:
      return raw;
    default:
      return null;
  }
}

/**
 * Re-orders rejection reasons into the canonical UI order. Unknown
 * reasons are dropped before ordering so the UI never renders
 * undefined values.
 */
function orderRejectionReasons(
  raw: readonly string[],
): QualityRejectionCode[] {
  const filtered = raw
    .map(toQualityRejectionCode)
    .filter((r): r is QualityRejectionCode => r !== null);
  const orderIndex = (code: QualityRejectionCode): number =>
    QUALITY_REJECTION_ORDER.indexOf(code);
  return [...filtered].sort((a, b) => orderIndex(a) - orderIndex(b));
}

/**
 * Coerces a route `code` string into the closed `SampleClientErrorCode`
 * enum. Unknown codes map to a generic `ENROLLMENT_SAMPLE_FAILED` so
 * downstream UI can always render a sane error message.
 */
function toSampleClientErrorCode(raw: string): SampleClientErrorCode {
  switch (raw) {
    case SAMPLE_CLIENT_ERROR_CODES.UNAUTHENTICATED:
      return SAMPLE_CLIENT_ERROR_CODES.UNAUTHENTICATED;
    case SAMPLE_CLIENT_ERROR_CODES.PROFILE_INCOMPLETE:
      return SAMPLE_CLIENT_ERROR_CODES.PROFILE_INCOMPLETE;
    case SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_NOT_STARTED:
      return SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_NOT_STARTED;
    case SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_EXPIRED:
      return SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_EXPIRED;
    case SAMPLE_CLIENT_ERROR_CODES.INVALID_IMAGE:
      return SAMPLE_CLIENT_ERROR_CODES.INVALID_IMAGE;
    case SAMPLE_CLIENT_ERROR_CODES.IMAGE_TOO_LARGE:
      return SAMPLE_CLIENT_ERROR_CODES.IMAGE_TOO_LARGE;
    case SAMPLE_CLIENT_ERROR_CODES.NO_FACE:
      return SAMPLE_CLIENT_ERROR_CODES.NO_FACE;
    case SAMPLE_CLIENT_ERROR_CODES.MULTIPLE_FACES:
      return SAMPLE_CLIENT_ERROR_CODES.MULTIPLE_FACES;
    case SAMPLE_CLIENT_ERROR_CODES.FACE_SERVICE_UNAVAILABLE:
      return SAMPLE_CLIENT_ERROR_CODES.FACE_SERVICE_UNAVAILABLE;
    case SAMPLE_CLIENT_ERROR_CODES.FACE_SERVICE_TIMEOUT:
      return SAMPLE_CLIENT_ERROR_CODES.FACE_SERVICE_TIMEOUT;
    case SAMPLE_CLIENT_ERROR_CODES.FACE_SERVICE_UNAUTHORIZED:
      return SAMPLE_CLIENT_ERROR_CODES.FACE_SERVICE_UNAUTHORIZED;
    case SAMPLE_CLIENT_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE:
      return SAMPLE_CLIENT_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE;
    case SAMPLE_CLIENT_ERROR_CODES.FACE_SERVICE_NOT_CONFIGURED:
      return SAMPLE_CLIENT_ERROR_CODES.FACE_SERVICE_NOT_CONFIGURED;
    case SAMPLE_CLIENT_ERROR_CODES.MODEL_MISMATCH:
      return SAMPLE_CLIENT_ERROR_CODES.MODEL_MISMATCH;
    case SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_LIMIT_REACHED:
      return SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_LIMIT_REACHED;
    case SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_CONFLICT:
      return SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_CONFLICT;
    case SAMPLE_CLIENT_ERROR_CODES.BIOMETRIC_ENCRYPTION_UNAVAILABLE:
      return SAMPLE_CLIENT_ERROR_CODES.BIOMETRIC_ENCRYPTION_UNAVAILABLE;
    case SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_FAILED:
      return SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_FAILED;
    default:
      return SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_FAILED;
  }
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Submits ONE captured enrollment sample image to the Next.js sample
 * endpoint.
 *
 * The browser never includes identity / metadata fields — the server
 * derives them from the Better Auth session. The `Content-Type`
 * header is left unset on purpose so the browser generates the
 * multipart boundary automatically.
 *
 * This function performs exactly ONE fetch. It does NOT retry on
 * failure. Callers SHOULD debounce concurrent calls at the call site.
 *
 * @param blob  Captured JPEG `Blob` (from `captureVideoFrame`).
 *              The helper does NOT place the blob into persistent
 *              storage, React state, or an object URL — the variable
 *              goes out of scope at the end of the call.
 * @param options Optional test seam. Production callers leave this
 *                empty.
 *
 * @returns A promise resolving to a discriminated `SampleSubmissionResult`.
 *          The promise NEVER rejects — every failure mode is mapped to
 *          a safe `{ ok: false, code, httpStatus }` shape so UI
 *          handlers never need a `try`/`catch` for the submission.
 */
export async function submitFaceEnrollmentSample(
  blob: Blob,
  options: SubmitFaceEnrollmentSampleOptions = {},
): Promise<SampleSubmissionResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpointPath =
    options.endpointPath ?? ENROLLMENT_SAMPLE_ENDPOINT_PATH;

  // Build the FormData locally. We do NOT attach userId / sampleIndex /
  // modelIdentity — the server determines all trusted metadata.
  const formData = new FormData();
  formData.append("image", blob, SAMPLE_FORM_FILENAME);

  // Resolve the request against the current document base so the
  // helper works on any deployment (localhost, preview, prod) without
  // a hard-coded service URL.
  const endpoint = resolveEndpoint(endpointPath);

  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      body: formData,
      // The browser sets the multipart boundary automatically.
      // Setting `Content-Type` manually here would break parsing.
      credentials: "same-origin",
      signal: options.signal ?? null,
    });
  } catch {
    // Network failure: DNS, offline, abort, CORS, etc. Map to a safe
    // catch-all so the UI never receives a raw exception.
    return {
      ok: false,
      code: "NETWORK_ERROR",
      httpStatus: null,
    };
  }

  // Parse the body once. The route may return either:
  //   - the safe accepted/rejected shape (200 OK)
  //   - the standard `{ error: { code, message } }` shape
  // Any other shape is treated as a malformed response so the browser
  // does not blindly trust arbitrary JSON.
  const rawJson = await parseJsonSafely(response);
  if (!rawJson.ok) {
    return {
      ok: false,
      code: "MALFORMED_RESPONSE",
      httpStatus: response.status,
    };
  }

  // 2xx + accepted/rejected body → parse via Zod.
  if (response.ok) {
    const parsed = OkResponseSchema.safeParse(rawJson.value);
    if (parsed.success) {
      const rejectionReasons = orderRejectionReasons(
        parsed.data.rejectionReasons,
      );
      return {
        ok: true,
        accepted: parsed.data.accepted,
        rejectionReasons,
        progress: parsed.data.progress,
      };
    }
    // 200 OK with an unexpected JSON shape is treated as a malformed
    // response — never invent progress numbers or a fake accepted.
    return {
      ok: false,
      code: "MALFORMED_RESPONSE",
      httpStatus: response.status,
    };
  }

  // Non-2xx → expect the standard error envelope.
  const errorParsed = ErrorResponseSchema.safeParse(rawJson.value);
  if (errorParsed.success) {
    return {
      ok: false,
      code: toSampleClientErrorCode(errorParsed.data.error.code),
      httpStatus: response.status,
    };
  }

  // Non-2xx without a recognizable error envelope.
  return {
    ok: false,
    code: "MALFORMED_RESPONSE",
    httpStatus: response.status,
  };
}

/**
 * Resolves the absolute endpoint URL from the given path and the
 * current document base. In SSR the document is undefined, in which
 * case the path is returned unchanged — production callers always
 * call this in the browser.
 */
function resolveEndpoint(path: string): string {
  if (typeof window === "undefined") {
    return path;
  }
  // Always use the same origin so a malicious absolute URL is never
  // followed. `window.location.origin` is the canonical browser signal.
  const origin = window.location.origin;
  return `${origin}${path}`;
}

/**
 * Parses a fetch response body as JSON without throwing. Any failure
 * (network buffer error, malformed JSON) is reported via the
 * `{ ok: false }` branch.
 */
async function parseJsonSafely(
  response: Response,
): Promise<
  { ok: true; value: unknown } | { ok: false }
> {
  try {
    const text = await response.text();
    if (text.length === 0) {
      return { ok: false };
    }
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}
