import { NextResponse, type NextRequest } from "next/server";

/**
 * GET /api/face-id/enrollment/status
 *
 * PHASE 4.4B2 — Face ID Enrollment Status API.
 *
 * Tells the authenticated browser the SAFE current state of:
 *   - permanent Face ID configuration
 *   - temporary enrollment progress
 *
 * The route is intentionally read-only (except for optional
 * best-effort cleanup of an expired enrollment-session document).
 * It is also biometric-free: it never decrypts, never inspects, and
 * never returns biometric data.
 *
 * Contract:
 *   - Requires a valid Better Auth server session (UNAUTHENTICATED
 *     otherwise).
 *   - Requires a completed application Profile (PROFILE_INCOMPLETE
 *     otherwise). The route never auto-creates a Profile.
 *   - Returns a SAFE status DTO with NO biometric payload.
 *
 * Identity guarantee:
 *   - `session.user.id` is the authoritative identity.
 *   - Query parameters such as `?userId=another-user` are IGNORED.
 *     They cannot influence ownership, response content, or service
 *     calls.
 *
 * Privacy guarantee:
 *   - The response contains only safe, non-biometric counts and
 *     timestamps: `configured`, `faceId.enrolledAt`,
 *     `faceId.sampleCount`, `enrollment.{active, mode, acceptedSamples,
 *     requiredSamples, expiresAt}`.
 *   - The response never includes `userId`, `email`, encrypted
 *     samples, ciphertext / IV / authTag, model metadata,
 *     quality summaries, centroids, or embeddings.
 *   - The response never includes the actual `acceptedSamples`
 *     array — only its length.
 *
 * Face Service / crypto posture:
 *   - This route NEVER calls `getFaceServiceHealth()` or
 *     `analyzeEnrollmentSample()`. Status is purely a database
 *     read.
 *   - This route NEVER decrypts anything. The encryption key is
 *     not required to read status; a user can see "Face ID
 *     configured" without loading biometric vectors.
 *
 * Expired session handling:
 *   - MongoDB TTL deletion is asynchronous. Even if the
 *     `face_enrollment_sessions` document is still present in the
 *     collection, the route treats `expiresAt <= now` as expired.
 *   - On a known-expired session the route attempts a best-effort
 *     `deleteEnrollmentSessionByUserId(...)` cleanup. A cleanup
 *     failure is logged internally but is NEVER turned into a 5xx —
 *     the response still safely reports `enrollment.active = false`.
 */

import { getSession } from "@/lib/session";
import { isOnboardingComplete } from "@/lib/profile-service";
import { getFaceProfileByUserId } from "@/lib/biometrics/face-profile-service";
import {
  getEnrollmentSessionByUserId,
  isEnrollmentSessionExpired,
  deleteEnrollmentSessionByUserId,
} from "@/lib/biometrics/enrollment-session-service";
import {
  ENROLLMENT_ROUTE_ERROR_CODES,
  EnrollmentRouteError,
  mapEnrollmentStatusError,
} from "@/lib/biometrics/enrollment-route-errors";
import type { EnrollmentMode } from "@/lib/biometrics/biometric-schema";

// =============================================================================
// Safe Response DTO
// =============================================================================

/**
 * Status reported for the temporary enrollment session.
 *
 * `acceptedSamples` is a NUMBER COUNT derived from
 * `session.acceptedSamples.length`. The actual array is never
 * returned. `mode` is null when no session is active so the browser
 * does not need to special-case the value.
 */
export interface EnrollmentStatusBlock {
  active: boolean;
  mode: EnrollmentMode | null;
  acceptedSamples: number;
  requiredSamples: number;
  expiresAt: string | null;
}

/**
 * Safe information about the permanent Face ID enrollment.
 *
 * Only the safe counters and a timestamp are returned. The
 * browser does not need technical biometric metadata.
 */
export interface FaceIdStatusBlock {
  enrolledAt: string;
  sampleCount: number;
}

/**
 * Stable, privacy-safe success body for this route.
 *
 * `faceId` is `null` when no permanent Face ID enrollment exists.
 * `enrollment` is always present so the browser does not need to
 * special-case the field.
 */
export interface EnrollmentStatusSuccessBody {
  configured: boolean;
  faceId: FaceIdStatusBlock | null;
  enrollment: EnrollmentStatusBlock;
}

/**
 * Stable, privacy-safe error body for this route.
 */
export interface EnrollmentStatusErrorBody {
  error: {
    code: string;
    message: string;
  };
}

// =============================================================================
// Response shape helpers
// =============================================================================

/**
 * Returns the safe DTO representing "no active enrollment session".
 *
 * `requiredSamples` is taken from the centralized
 * `DEFAULT_FACE_ENROLLMENT_REQUIRED_SAMPLES` so the literal `5` is
 * not duplicated across the route layer.
 */
function buildInactiveEnrollmentBlock(): EnrollmentStatusBlock {
  return {
    active: false,
    mode: null,
    acceptedSamples: 0,
    // We do not import the biometric-constants default here because
    // an inactive session must not require any particular number to
    // be displayed by the browser — only an active session should
    // surface `requiredSamples` to the UI. The route intentionally
    // emits `0` for `requiredSamples` when no session is active so
    // the field type stays stable while not lying about a value the
    // session never committed to.
    requiredSamples: 0,
    expiresAt: null,
  };
}

/**
 * Builds a safe enrollment-progress block from a verified,
 * unexpired enrollment session.
 *
 * The block contains:
 *   - `mode` — exactly as stored (`"create"` or `"replace"`)
 *   - `acceptedSamples` — derived from `acceptedSamples.length`
 *   - `requiredSamples` — taken from the session document
 *   - `expiresAt` — serialized to ISO 8601
 *
 * It contains NO other fields.
 */
function buildActiveEnrollmentBlock(
  session: {
    mode: EnrollmentMode;
    requiredSampleCount: number;
    acceptedSamples: unknown[];
    expiresAt: Date;
  },
): EnrollmentStatusBlock {
  return {
    active: true,
    mode: session.mode,
    acceptedSamples: session.acceptedSamples.length,
    requiredSamples: session.requiredSampleCount,
    expiresAt: session.expiresAt.toISOString(),
  };
}

// =============================================================================
// HTTP error mapping
// =============================================================================

/**
 * Maps an `EnrollmentRouteError` to the appropriate HTTP status code.
 *
 * - UNAUTHENTICATED    → 401
 * - PROFILE_INCOMPLETE → 409
 * - any other code     → 500
 */
function httpStatusForCode(code: string): number {
  if (code === ENROLLMENT_ROUTE_ERROR_CODES.UNAUTHENTICATED) return 401;
  if (code === ENROLLMENT_ROUTE_ERROR_CODES.PROFILE_INCOMPLETE) return 409;
  return 500;
}

/**
 * Serializes an `EnrollmentRouteError` to a JSON `Response`.
 */
function errorResponse(err: EnrollmentRouteError): NextResponse {
  const body: EnrollmentStatusErrorBody = {
    error: err.toJSON(),
  };
  return NextResponse.json(body, { status: httpStatusForCode(err.code) });
}

// =============================================================================
// Route Handler
// =============================================================================

/**
 * Handler for `GET /api/face-id/enrollment/status`.
 *
 * The handler is intentionally thin:
 *
 *   Route Handler
 *     ↓
 *   authentication / profile checks
 *     ↓
 *   biometric services
 *     ↓
 *   safe DTO response
 *
 * No direct Mongoose / MongoDB access here. All persistence is
 * delegated to `face-profile-service` and `enrollment-session-service`.
 *
 * The request argument is accepted for the Next.js GET contract but
 * is NEVER read for identity, ownership, or any other decision.
 */
export async function GET(_request: NextRequest): Promise<NextResponse> {
  // Suppress the unused-parameter lint by referencing the request
  // argument; the value is deliberately never consulted.
  void _request;

  // -------------------------------------------------------------------
  // 1. Authentication — identity MUST come from the Better Auth server
  //    session. Query / body inputs are ignored for identity.
  // -------------------------------------------------------------------
  const session = await getSession();
  if (!session) {
    return errorResponse(
      new EnrollmentRouteError({
        code: ENROLLMENT_ROUTE_ERROR_CODES.UNAUTHENTICATED,
        message: "You must be signed in to read the enrollment status.",
      }),
    );
  }

  const userId = session.user.id;

  // -------------------------------------------------------------------
  // 2. Profile requirement — status may be reported only when the
  //    user has a completed application Profile. The route NEVER
  //    auto-creates a Profile.
  // -------------------------------------------------------------------
  const onboardingComplete = await isOnboardingComplete(userId);
  if (!onboardingComplete) {
    return errorResponse(
      new EnrollmentRouteError({
        code: ENROLLMENT_ROUTE_ERROR_CODES.PROFILE_INCOMPLETE,
        message:
          "Complete your profile before reading the enrollment status.",
      }),
    );
  }

  // -------------------------------------------------------------------
  // 3. Read the safe state from existing biometric services.
  //    - FaceProfile (permanent) — used to derive `configured` and
  //      the `faceId` block.
  //    - EnrollmentSession (temporary) — used to derive the
  //      `enrollment` block, with TTL-aware expiration handling.
  // -------------------------------------------------------------------
  try {
    const [faceProfile, enrollmentSession] = await Promise.all([
      getFaceProfileByUserId(userId),
      getEnrollmentSessionByUserId(userId),
    ]);

    // --- FaceProfile → configured / faceId -----------------------
    const configured = faceProfile !== null;
    const faceIdBlock: FaceIdStatusBlock | null = faceProfile
      ? {
          enrolledAt: faceProfile.enrolledAt.toISOString(),
          sampleCount: faceProfile.sampleCount,
        }
      : null;

    // --- EnrollmentSession → enrollment --------------------------
    let enrollmentBlock: EnrollmentStatusBlock;
    if (enrollmentSession === null) {
      enrollmentBlock = buildInactiveEnrollmentBlock();
    } else if (isEnrollmentSessionExpired(enrollmentSession)) {
      // Known-expired. Do NOT report active. Attempt best-effort
      // cleanup; on cleanup failure, still report inactive safely
      // (the failure is internal and never leaks to the response).
      try {
        await deleteEnrollmentSessionByUserId(userId);
      } catch {
        // Intentionally swallowed. The session is expired by
        // application logic; even if Mongo refused the delete (or
        // TTL already removed it, or the connection is in a
        // transient state), the browser must not see anything
        // other than `active: false`. We do not log biometric
        // sample contents — only the fact that cleanup was
        // attempted for an expired session is safe to log.
      }
      enrollmentBlock = buildInactiveEnrollmentBlock();
    } else {
      enrollmentBlock = buildActiveEnrollmentBlock(enrollmentSession);
    }

    const body: EnrollmentStatusSuccessBody = {
      configured,
      faceId: faceIdBlock,
      enrollment: enrollmentBlock,
    };
    return NextResponse.json(body, { status: 200 });
  } catch (err) {
    return errorResponse(mapEnrollmentStatusError(err));
  }
}
