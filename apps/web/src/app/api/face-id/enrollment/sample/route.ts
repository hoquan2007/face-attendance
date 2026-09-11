import { NextResponse, type NextRequest } from "next/server";

/**
 * POST /api/face-id/enrollment/sample
 *
 * PHASE 4.4C — Face ID Enrollment Sample API.
 *
 * Accepts ONE image from the authenticated web client, forwards it to
 * the trusted Face Service for quality analysis, encrypts accepted
 * embeddings, and stores only encrypted sample data in the current
 * temporary enrollment session.
 *
 * Contract:
 *   - Requires a valid Better Auth server session (UNAUTHENTICATED
 *     otherwise).
 *   - Requires a completed application Profile (PROFILE_INCOMPLETE
 *     otherwise).
 *   - Requires an active, unexpired enrollment session
 *     (ENROLLMENT_NOT_STARTED or ENROLLMENT_EXPIRED otherwise).
 *   - Accepts multipart/form-data with exactly one "image" field.
 *   - Validates image size and MIME type at the API boundary.
 *   - Forwards the image to the Face Service for analysis.
 *   - Quality rejections are returned safely without storage.
 *   - Accepted embeddings are encrypted with AES-256-GCM before
 *     MongoDB persistence.
 *   - The browser NEVER receives embedding, ciphertext, IV, authTag,
 *     keyVersion, or userId.
 *
 * Identity guarantee:
 *   - `session.user.id` is the authoritative identity.
 *   - The request body (including any client-supplied userId field)
 *     is IGNORED for identity decisions.
 *
 * Privacy guarantee:
 *   - No plaintext embedding is ever persisted.
 *   - No raw image is persisted.
 *   - The Face Service response is never spread directly into JSON.
 *   - Quality rejection reasons are returned only for UI feedback.
 */

import { getSession } from "@/lib/session";
import { isOnboardingComplete } from "@/lib/profile-service";
import {
  getEnrollmentSessionByUserId,
  isEnrollmentSessionExpired,
  appendAcceptedEnrollmentSample,
} from "@/lib/biometrics/enrollment-session-service";
import { encryptBiometricVector, BiometricError } from "@/lib/biometrics/encryption";
import { analyzeEnrollmentSample } from "@/lib/biometrics/face-service-client";
import {
  FACE_ENROLLMENT_MAX_SAMPLE_BYTES,
} from "@/lib/biometrics/biometric-constants";
import {
  ENROLLMENT_ROUTE_ERROR_CODES,
  EnrollmentRouteError,
  mapEnrollmentSampleError,
} from "@/lib/biometrics/enrollment-route-errors";
import type { EnrollmentSampleResult } from "@/lib/biometrics/face-service-client";
import type { EnrollmentMode } from "@/lib/biometrics/biometric-schema";
import type { Normalization } from "@/lib/biometrics/biometric-schema";

// =============================================================================
// Constants
// =============================================================================

/** Allowed MIME types for enrollment sample images. */
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

/** Centralized upload size limit. */
const MAX_SAMPLE_BYTES = FACE_ENROLLMENT_MAX_SAMPLE_BYTES;

// =============================================================================
// Safe Response DTOs
// =============================================================================

/**
 * Progress block returned in both accepted and rejected responses.
 *
 * Contains only non-biometric counts derived from the database.
 */
interface ProgressBlock {
  acceptedSamples: number;
  requiredSamples: number;
  complete: boolean;
}

/**
 * Safe success body for an accepted sample.
 */
interface AcceptedSampleBody {
  accepted: boolean;
  rejectionReasons: [];
  progress: ProgressBlock;
}

/**
 * Safe response body for a rejected quality sample.
 */
interface RejectedSampleBody {
  accepted: boolean;
  rejectionReasons: string[];
  progress: ProgressBlock;
}

/**
 * Stable error body for this route.
 */
interface ErrorBody {
  error: {
    code: string;
    message: string;
  };
}

// =============================================================================
// HTTP Error Mapping
// =============================================================================

/**
 * Maps an `EnrollmentRouteError` to the appropriate HTTP status code.
 *
 * - UNAUTHENTICATED               → 401
 * - PROFILE_INCOMPLETE           → 409
 * - ENROLLMENT_NOT_STARTED       → 409
 * - ENROLLMENT_EXPIRED           → 409
 * - INVALID_IMAGE / IMAGE_TOO_LARGE → 400
 * - NO_FACE / MULTIPLE_FACES     → 422 (unprocessable entity)
 * - FACE_SERVICE_* / MODEL_*     → 502 (bad gateway)
 * - BIOMETRIC_ENCRYPTION_*       → 503 (service unavailable)
 * - any other code               → 500
 */
function httpStatusForCode(code: string): number {
  switch (code) {
    case ENROLLMENT_ROUTE_ERROR_CODES.UNAUTHENTICATED:
      return 401;
    case ENROLLMENT_ROUTE_ERROR_CODES.PROFILE_INCOMPLETE:
    case ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_NOT_STARTED:
    case ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_EXPIRED:
    case ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_SAMPLE_CONFLICT:
      return 409;
    case ENROLLMENT_ROUTE_ERROR_CODES.INVALID_IMAGE:
      return 400;
    case ENROLLMENT_ROUTE_ERROR_CODES.IMAGE_TOO_LARGE:
      return 400;
    case ENROLLMENT_ROUTE_ERROR_CODES.NO_FACE:
    case ENROLLMENT_ROUTE_ERROR_CODES.MULTIPLE_FACES:
      return 422;
    case ENROLLMENT_ROUTE_ERROR_CODES.FACE_SERVICE_UNAVAILABLE:
    case ENROLLMENT_ROUTE_ERROR_CODES.FACE_SERVICE_TIMEOUT:
    case ENROLLMENT_ROUTE_ERROR_CODES.FACE_SERVICE_UNAUTHORIZED:
    case ENROLLMENT_ROUTE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE:
    case ENROLLMENT_ROUTE_ERROR_CODES.FACE_SERVICE_NOT_CONFIGURED:
    case ENROLLMENT_ROUTE_ERROR_CODES.MODEL_MISMATCH:
    case ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_SAMPLE_LIMIT_REACHED:
      return 502;
    case ENROLLMENT_ROUTE_ERROR_CODES.BIOMETRIC_ENCRYPTION_UNAVAILABLE:
      return 503;
    default:
      return 500;
  }
}

/**
 * Serializes an `EnrollmentRouteError` to a JSON `Response`.
 */
function errorResponse(err: EnrollmentRouteError): NextResponse {
  const body: ErrorBody = {
    error: err.toJSON(),
  };
  return NextResponse.json(body, { status: httpStatusForCode(err.code) });
}

// =============================================================================
// Image Validation
// =============================================================================

/**
 * Validates an uploaded file meets basic requirements.
 *
 * @param file - The uploaded file
 * @returns Error message string if invalid, null if valid
 */
function validateImageFile(file: {
  size: number;
  type: string;
} | null): string | null {
  // Check file exists
  if (!file) {
    return "No image file provided.";
  }

  // Check file size > 0
  if (file.size <= 0) {
    return "Image file is empty.";
  }

  // Check file size <= max
  if (file.size > MAX_SAMPLE_BYTES) {
    return `Image exceeds maximum size of ${MAX_SAMPLE_BYTES} bytes.`;
  }

  // Check MIME type
  if (!ALLOWED_MIME_TYPES.includes(file.type as typeof ALLOWED_MIME_TYPES[number])) {
    return `Invalid image type: ${file.type}. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}.`;
  }

  return null;
}

/**
 * Validates the format and type of the uploaded image.
 *
 * @returns Object with error code + message if invalid, null if valid
 */
function checkImageFormat(
  file: { size: number; type: string } | null,
): {
  isMissing: boolean;
  isOversized: boolean;
  isInvalidType: boolean;
} {
  if (!file) {
    return { isMissing: true, isOversized: false, isInvalidType: false };
  }
  if (file.size <= 0) {
    return { isMissing: false, isOversized: false, isInvalidType: true };
  }
  if (file.size > MAX_SAMPLE_BYTES) {
    return { isMissing: false, isOversized: true, isInvalidType: false };
  }
  if (!ALLOWED_MIME_TYPES.includes(file.type as typeof ALLOWED_MIME_TYPES[number])) {
    return { isMissing: false, isOversized: false, isInvalidType: true };
  }
  return { isMissing: false, isOversized: false, isInvalidType: false };
}

// =============================================================================
// Session Validation
// =============================================================================

/**
 * Validates the enrollment session and returns it, or throws an error.
 */
async function validateEnrollmentSession(
  userId: string,
): Promise<{
  session: {
    userId: string;
    mode: EnrollmentMode;
    templateVersion: number;
    requiredSampleCount: number;
    acceptedSamples: unknown[];
    expiresAt: Date;
    modelIdentity?: string;
    modelName?: string;
    embeddingDimension?: number;
    normalization?: Normalization;
  };
}> {
  const session = await getEnrollmentSessionByUserId(userId);

  if (!session) {
    throw new EnrollmentRouteError({
      code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_NOT_STARTED,
      message: "No active enrollment session. Please start enrollment first.",
    });
  }

  if (isEnrollmentSessionExpired(session)) {
    throw new EnrollmentRouteError({
      code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_EXPIRED,
      message: "Enrollment session has expired. Please start enrollment again.",
    });
  }

  // Validate mode is "create" (replace not implemented yet)
  if (session.mode !== "create") {
    // For now, reject replace sessions as unsupported
    throw new EnrollmentRouteError({
      code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_SAMPLE_FAILED,
      message: "Re-enrollment is not supported in this phase.",
    });
  }

  return { session };
}

// =============================================================================
// Build Progress Block
// =============================================================================

/**
 * Builds a safe progress block from current session state.
 */
function buildProgressBlock(
  acceptedSamples: number,
  requiredSampleCount: number,
): ProgressBlock {
  return {
    acceptedSamples,
    requiredSamples: requiredSampleCount,
    complete: acceptedSamples >= requiredSampleCount,
  };
}

// =============================================================================
// Main Handler
// =============================================================================

/**
 * Handler for `POST /api/face-id/enrollment/sample`.
 *
 * Process flow:
 *   1. Authenticate (Better Auth session)
 *   2. Check Profile completion
 *   3. Validate enrollment session exists and is unexpired
 *   4. Check sample limit not reached
 *   5. Parse and validate uploaded image
 *   6. Forward image to Face Service
 *   7. Handle result:
 *      - If rejected: return rejection reasons + progress
 *      - If accepted:
 *        a. Validate session still active
 *        b. Encrypt embedding with AES-256-GCM
 *        c. Atomically append encrypted sample to session
 *        d. Return progress
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  // -------------------------------------------------------------------
  // 1. Authentication
  // -------------------------------------------------------------------
  const session = await getSession();
  if (!session) {
    return errorResponse(
      new EnrollmentRouteError({
        code: ENROLLMENT_ROUTE_ERROR_CODES.UNAUTHENTICATED,
        message: "You must be signed in to submit an enrollment sample.",
      }),
    );
  }

  const userId = session.user.id;

  // -------------------------------------------------------------------
  // 2. Profile requirement
  // -------------------------------------------------------------------
  const onboardingComplete = await isOnboardingComplete(userId);
  if (!onboardingComplete) {
    return errorResponse(
      new EnrollmentRouteError({
        code: ENROLLMENT_ROUTE_ERROR_CODES.PROFILE_INCOMPLETE,
        message: "Complete your profile before submitting enrollment samples.",
      }),
    );
  }

  // -------------------------------------------------------------------
  // 3. Validate enrollment session
  // -------------------------------------------------------------------
  let enrollmentSession: Awaited<ReturnType<typeof validateEnrollmentSession>>["session"];
  try {
    const result = await validateEnrollmentSession(userId);
    enrollmentSession = result.session;
  } catch (err) {
    if (err instanceof EnrollmentRouteError) {
      return errorResponse(err);
    }
    throw err;
  }

  // -------------------------------------------------------------------
  // 4. Check sample limit not reached
  // -------------------------------------------------------------------
  const currentCount = enrollmentSession.acceptedSamples.length;
  if (currentCount >= enrollmentSession.requiredSampleCount) {
    return NextResponse.json(
      {
        error: {
          code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_SAMPLE_LIMIT_REACHED,
          message: "Maximum number of samples already collected.",
        },
      } satisfies ErrorBody,
      { status: 502 },
    );
  }

  // -------------------------------------------------------------------
  // 5. Parse and validate uploaded image
  // -------------------------------------------------------------------
  let imageBuffer: ArrayBuffer | null = null;
  let imageMimeType: string | null = null;

  try {
    const formData = await request.formData();
    const file = formData.get("image");

    // Validate the file
    const validationError = validateImageFile(
      file instanceof File
        ? { size: file.size, type: file.type }
        : null,
    );

    if (validationError) {
      // Determine specific error code
      const { isMissing, isOversized, isInvalidType } = checkImageFormat(
        file instanceof File
          ? { size: file.size, type: file.type }
          : null,
      );

      if (isMissing || isInvalidType) {
        const message = isMissing
          ? "No image file provided."
          : `Invalid image type: ${file instanceof File ? file.type : "unknown"}. Allowed: ${ALLOWED_MIME_TYPES.join(", ")}.`;
        return errorResponse(
          new EnrollmentRouteError({
            code: ENROLLMENT_ROUTE_ERROR_CODES.INVALID_IMAGE,
            message,
          }),
        );
      }

      if (isOversized) {
        return errorResponse(
          new EnrollmentRouteError({
            code: ENROLLMENT_ROUTE_ERROR_CODES.IMAGE_TOO_LARGE,
            message: `Image exceeds maximum size of ${MAX_SAMPLE_BYTES} bytes.`,
          }),
        );
      }

      // Generic invalid image fallback
      return errorResponse(
        new EnrollmentRouteError({
          code: ENROLLMENT_ROUTE_ERROR_CODES.INVALID_IMAGE,
          message: validationError,
        }),
      );
    }

    // Convert file to buffer
    const fileBuffer = await (file as File).arrayBuffer();
    imageBuffer = fileBuffer;
    imageMimeType = (file as File).type;
  } catch (_err) {
    // Handle malformed multipart form data
    void _err;
    return errorResponse(
      new EnrollmentRouteError({
        code: ENROLLMENT_ROUTE_ERROR_CODES.INVALID_IMAGE,
        message: "Could not parse the uploaded image.",
      }),
    );
  }

  // -------------------------------------------------------------------
  // 6. Forward image to Face Service
  // -------------------------------------------------------------------
  let faceServiceResult: EnrollmentSampleResult;
  try {
    faceServiceResult = await analyzeEnrollmentSample(
      imageBuffer!,
      imageMimeType!,
    );
  } catch (err) {
    return errorResponse(mapEnrollmentSampleError(err));
  }

  // -------------------------------------------------------------------
  // 7. Handle Face Service result
  // -------------------------------------------------------------------
  if (!faceServiceResult.accepted) {
    // Quality rejection — return reasons without storage
    return NextResponse.json(
      {
        accepted: false,
        rejectionReasons: faceServiceResult.rejection_reasons,
        progress: buildProgressBlock(
          currentCount,
          enrollmentSession.requiredSampleCount,
        ),
      } satisfies RejectedSampleBody,
      { status: 200 },
    );
  }

  // -------------------------------------------------------------------
  // 7b. Accepted sample — use the session we already validated
  // -------------------------------------------------------------------
  const { embedding, model, quality } = faceServiceResult;

  // Use the validated session for sample index and template version.
  // The atomic append service does its own defense-in-depth check on
  // expiration, sample limit, and model compatibility.

  // Determine expected sample index (0-based).
  // The caller already validated that acceptedSamples.length < requiredSampleCount,
  // so expectedSampleIndex is guaranteed to be within bounds at this point.
  // The atomic append in the service verifies the index is still available.
  const expectedSampleIndex = enrollmentSession.acceptedSamples.length;

  // Check model compatibility for samples after the first
  const isFirstSample = enrollmentSession.acceptedSamples.length === 0;
  if (!isFirstSample) {
    if (
      enrollmentSession.modelIdentity !== model.identity ||
      enrollmentSession.modelName !== model.name ||
      enrollmentSession.embeddingDimension !== model.embedding_dimension ||
      enrollmentSession.normalization !== model.normalization
    ) {
      return errorResponse(
        new EnrollmentRouteError({
          code: ENROLLMENT_ROUTE_ERROR_CODES.MODEL_MISMATCH,
          message: "Face recognition model mismatch. Please retake all photos.",
        }),
      );
    }
  }

  // Encrypt the embedding using PHASE 4.1 AES-256-GCM
  let encryptedVector: {
    ciphertext: string;
    iv: string;
    authTag: string;
    keyVersion: number;
  };

  try {
    encryptedVector = encryptBiometricVector(embedding!, {
      userId,
      modelIdentity: model.identity,
      templateVersion: enrollmentSession.templateVersion,
      vectorType: "sample",
      sampleIndex: expectedSampleIndex,
    });
  } catch (err) {
    // Handle encryption key missing/invalid
    if (
      err instanceof BiometricError &&
      err.code === "BIOMETRIC_KEY_MISSING"
    ) {
      return errorResponse(
        new EnrollmentRouteError({
          code: ENROLLMENT_ROUTE_ERROR_CODES.BIOMETRIC_ENCRYPTION_UNAVAILABLE,
          message: "Biometric encryption is not available. Please contact support.",
        }),
      );
    }
    return errorResponse(mapEnrollmentSampleError(err));
  }

  // -------------------------------------------------------------------
  // 7c. Atomically append encrypted sample to session
  // -------------------------------------------------------------------
  const appendResult = await appendAcceptedEnrollmentSample({
    userId,
    encryptedVector,
    expectedSampleIndex,
    quality: quality
      ? {
          detectionScore: quality.detection_score,
          blurScore: quality.blur_score,
          brightness: quality.brightness,
          relativeFaceArea: quality.relative_face_area,
        }
      : undefined,
    // For the first sample, establish model metadata
    ...(isFirstSample
      ? {
          modelIdentity: model.identity,
          modelName: model.name,
          embeddingDimension: model.embedding_dimension,
          normalization: model.normalization as Normalization,
        }
      : {}),
  });

  if (!appendResult.success) {
    // Map service-layer failure reasons to safe application error codes.
    switch (appendResult.reason) {
      // Stale request: another concurrent submission won the race.
      // The browser/client must submit a fresh image — we do NOT
      // retry automatically (would call Face Service twice for the same
      // accepted embedding, violating the project's one-biometric-operation
      // rule).
      case "CONFLICT":
        return errorResponse(
          new EnrollmentRouteError({
            code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_SAMPLE_CONFLICT,
            message: "A concurrent sample was submitted. Please submit a new photo.",
          }),
        );

      case "SESSION_NOT_FOUND":
      case "SESSION_EXPIRED":
      case "SAMPLE_LIMIT_REACHED":
      case "MODEL_MISMATCH":
        // These cases are already handled by earlier guards in the route,
        // but the service can return them too after the atomic operation.
        // Map to the same route-level codes for consistency.
        return errorResponse(
          new EnrollmentRouteError({
            code:
              appendResult.reason === "SESSION_EXPIRED"
                ? ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_EXPIRED
                : appendResult.reason === "SAMPLE_LIMIT_REACHED"
                  ? ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_SAMPLE_LIMIT_REACHED
                  : appendResult.reason === "MODEL_MISMATCH"
                    ? ENROLLMENT_ROUTE_ERROR_CODES.MODEL_MISMATCH
                    : ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_SAMPLE_FAILED,
            message:
              appendResult.reason === "SESSION_EXPIRED"
                ? "Enrollment session has expired. Please start enrollment again."
                : appendResult.reason === "SAMPLE_LIMIT_REACHED"
                  ? "Maximum number of samples already collected."
                  : appendResult.reason === "MODEL_MISMATCH"
                    ? "Face recognition model mismatch. Please retake all photos."
                    : "Could not save the sample. Please try again.",
          }),
        );

      default:
        return errorResponse(
          new EnrollmentRouteError({
            code: ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_SAMPLE_FAILED,
            message: "Could not save the sample. Please try again.",
          }),
        );
    }
  }

  // -------------------------------------------------------------------
  // 8. Return safe progress response
  // -------------------------------------------------------------------
  return NextResponse.json(
    {
      accepted: true,
      rejectionReasons: [],
      progress: buildProgressBlock(
        appendResult.newAcceptedCount,
        appendResult.requiredSampleCount,
      ),
    } satisfies AcceptedSampleBody,
    { status: 200 },
  );
}
