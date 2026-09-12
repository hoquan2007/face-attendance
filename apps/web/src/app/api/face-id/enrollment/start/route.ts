import { NextResponse } from "next/server";

/**
 * POST /api/face-id/enrollment/start
 *
 * PHASE 4.4B1 — Face ID Enrollment Start API.
 *
 * Safely starts a temporary biometric enrollment session for the
 * currently authenticated user. The route does NOT process biometric
 * data, does NOT call the Face Service, and does NOT create or
 * modify a FaceProfile.
 *
 * Contract:
 *   - Requires a valid Better Auth server session (UNAUTHENTICATED
 *     otherwise).
 *   - Requires a completed application Profile (PROFILE_INCOMPLETE
 *     otherwise). The route never auto-creates a Profile.
 *   - Requires that no active FaceProfile already exists
 *     (FACE_PROFILE_ALREADY_EXISTS otherwise). Explicit
 *     re-enrollment is implemented in a later mini-phase.
 *
 * On a happy path, the route delegates to
 * `createOrResetEnrollmentSession(...)`, which uses an upsert keyed
 * on `userId` so a repeated `start` for the same user resets the
 * existing CREATE session in place (clears `acceptedSamples`,
 * refreshes `expiresAt`, resets model metadata to `undefined`). This
 * means repeated requests cannot create duplicate enrollment-session
 * documents.
 *
 * Identity guarantee:
 *   - `session.user.id` is the authoritative identity.
 *   - The request body is ignored. A malicious body containing
 *     `{ "userId": "another-user" }` cannot affect ownership.
 *
 * Privacy guarantee:
 *   - No biometric payload (image / embedding / encrypted vector)
 *     is read from the request.
 *   - The response contains only safe, non-biometric counts and the
 *     server-generated expiry timestamp.
 *   - The response never includes `userId`, `email`, encrypted
 *     samples, model metadata, or embeddings.
 */

import { getSession } from "@/lib/session";
import { isOnboardingComplete } from "@/lib/profile-service";
import { hasFaceProfile } from "@/lib/biometrics/face-profile-service";
import { createOrResetEnrollmentSession } from "@/lib/biometrics/enrollment-session-service";
import {
  DEFAULT_FACE_ENROLLMENT_REQUIRED_SAMPLES,
} from "@/lib/biometrics/biometric-constants";
import {
  ENROLLMENT_ROUTE_ERROR_CODES,
  EnrollmentRouteError,
  mapEnrollmentStartError,
} from "@/lib/biometrics/enrollment-route-errors";

/**
 * Number of accepted samples required for enrollment finalization.
 *
 * Imported from the centralized biometric constants module so the
 * literal does not have to be repeated across the application.
 */
const REQUIRED_SAMPLE_COUNT = DEFAULT_FACE_ENROLLMENT_REQUIRED_SAMPLES;

/**
 * The current template version for the enrollment-session /
 * face-profile schema. Centralized in `biometric-constants.ts`.
 */
const TEMPLATE_VERSION = 1;

/**
 * Stable JSON shape returned by this route on success.
 */
interface EnrollmentStartSuccessBody {
  status: "started";
  mode: "create";
  acceptedSamples: 0;
  requiredSamples: number;
  expiresAt: string;
}

/**
 * Stable JSON shape returned by this route on failure.
 */
interface EnrollmentStartErrorBody {
  error: {
    code: string;
    message: string;
  };
}

/**
 * Maps an `EnrollmentRouteError` to the appropriate HTTP status code.
 *
 * - UNAUTHENTICATED            → 401
 * - PROFILE_INCOMPLETE         → 409 (resource-state conflict — user
 *                                must complete it before this route
 *                                can do anything useful)
 * - FACE_PROFILE_ALREADY_EXISTS → 409 (resource-state conflict — the
 *                                server refuses to start a new
 *                                enrollment while one is active)
 * - ENROLLMENT_FINALIZATION_IN_PROGRESS → 409 (resource-state
 *                                conflict — PHASE 4.6B2A atomic
 *                                claim protection; the browser
 *                                should retry shortly)
 * - any other code             → 500
 */
function httpStatusForCode(code: string): number {
  if (code === ENROLLMENT_ROUTE_ERROR_CODES.UNAUTHENTICATED) return 401;
  if (code === ENROLLMENT_ROUTE_ERROR_CODES.PROFILE_INCOMPLETE) return 409;
  if (code === ENROLLMENT_ROUTE_ERROR_CODES.FACE_PROFILE_ALREADY_EXISTS) {
    return 409;
  }
  if (
    code ===
    ENROLLMENT_ROUTE_ERROR_CODES.ENROLLMENT_FINALIZATION_IN_PROGRESS
  ) {
    return 409;
  }
  return 500;
}

/**
 * Serializes an `EnrollmentRouteError` to a JSON `Response`.
 */
function errorResponse(err: EnrollmentRouteError): NextResponse {
  const body: EnrollmentStartErrorBody = {
    error: err.toJSON(),
  };
  return NextResponse.json(body, { status: httpStatusForCode(err.code) });
}

/**
 * Handler for `POST /api/face-id/enrollment/start`.
 *
 * The handler is intentionally thin:
 *
 *   Route Handler
 *     ↓
 *   authentication / profile checks
 *     ↓
 *   existing biometric services
 *
 * No direct Mongoose / MongoDB access here. All persistence is
 * delegated to `face-profile-service` and `enrollment-session-service`.
 */
export async function POST(): Promise<NextResponse> {
  // -------------------------------------------------------------------
  // 1. Authentication — identity MUST come from the Better Auth server
  //    session. The request body is ignored for identity.
  // -------------------------------------------------------------------
  const session = await getSession();
  if (!session) {
    return errorResponse(
      new EnrollmentRouteError({
        code: ENROLLMENT_ROUTE_ERROR_CODES.UNAUTHENTICATED,
        message: "You must be signed in to start face enrollment.",
      }),
    );
  }

  const userId = session.user.id;

  // -------------------------------------------------------------------
  // 2. Profile requirement — enrollment may begin only when the user
  //    has a completed application Profile. The route NEVER
  //    auto-creates a Profile.
  // -------------------------------------------------------------------
  const onboardingComplete = await isOnboardingComplete(userId);
  if (!onboardingComplete) {
    return errorResponse(
      new EnrollmentRouteError({
        code: ENROLLMENT_ROUTE_ERROR_CODES.PROFILE_INCOMPLETE,
        message:
          "Complete your profile before starting face enrollment.",
      }),
    );
  }

  // -------------------------------------------------------------------
  // 3. Existing FaceProfile check — PHASE 4.4B1 deliberately blocks
  //    a new CREATE enrollment while an active FaceProfile already
  //    exists. The existing profile is left untouched.
  //    Explicit re-enrollment arrives in a later mini-phase.
  // -------------------------------------------------------------------
  const hasProfile = await hasFaceProfile(userId);
  if (hasProfile) {
    return errorResponse(
      new EnrollmentRouteError({
        code: ENROLLMENT_ROUTE_ERROR_CODES.FACE_PROFILE_ALREADY_EXISTS,
        message:
          "A face profile already exists for this account. Re-enrollment is not supported yet.",
      }),
    );
  }

  // -------------------------------------------------------------------
  // 4. Create-or-reset the temporary enrollment session.
  //
  //    The service uses an upsert keyed on `userId`, so:
  //      - a first start creates a fresh CREATE session;
  //      - a subsequent start resets the existing CREATE session in
  //        place (clears `acceptedSamples`, refreshes `expiresAt`,
  //        resets model metadata to `undefined`);
  //      - at most one enrollment-session document per user exists at
  //        any time, enforced by the unique index on `userId`.
  // -------------------------------------------------------------------
  try {
    const sessionDoc = await createOrResetEnrollmentSession({
      userId,
      mode: "create",
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      templateVersion: TEMPLATE_VERSION,
      // expiresAt is generated server-side by the service from
      // `now + DEFAULT_ENROLLMENT_SESSION_TTL_MS` (15 minutes). The
      // browser cannot choose it.
    });

    const body: EnrollmentStartSuccessBody = {
      status: "started",
      mode: "create",
      acceptedSamples: 0,
      requiredSamples: sessionDoc.requiredSampleCount,
      expiresAt: sessionDoc.expiresAt.toISOString(),
    };

    return NextResponse.json(body, { status: 200 });
  } catch (err) {
    return errorResponse(mapEnrollmentStartError(err));
  }
}