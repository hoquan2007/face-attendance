/**
 * Server Action for starting Face ID enrollment.
 *
 * PHASE 4.5B1 — Face ID Page Shell.
 *
 * Provides an explicit server-side action for starting Face ID enrollment
 * from a client component. The action calls the enrollment start service
 * directly rather than making an internal HTTP call.
 *
 * This module is server-only. It must NOT be imported by Client Components.
 */

"use server";

import { getSession } from "@/lib/session";
import { isOnboardingComplete } from "@/lib/profile-service";
import { hasFaceProfile } from "@/lib/biometrics/face-profile-service";
import { createOrResetEnrollmentSession } from "@/lib/biometrics/enrollment-session-service";
import {
  DEFAULT_FACE_ENROLLMENT_REQUIRED_SAMPLES,
} from "@/lib/biometrics/biometric-constants";
import {
  ENROLLMENT_ROUTE_ERROR_CODES,
  mapEnrollmentStartError,
} from "@/lib/biometrics/enrollment-route-errors";

const REQUIRED_SAMPLE_COUNT = DEFAULT_FACE_ENROLLMENT_REQUIRED_SAMPLES;
const TEMPLATE_VERSION = 1;

/**
 * Result of starting Face ID enrollment.
 */
export interface StartEnrollmentResult {
  ok: true;
  status: "started";
  mode: "create";
  acceptedSamples: number;
  requiredSamples: number;
  expiresAt: string;
  /**
   * Stable server-generated UUID for this enrollment generation.
   * The browser uses it as the primary multi-tab / reload-resilience
   * discriminator. Always present on a successful start.
   */
  generationId: string;
}

export interface StartEnrollmentError {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type StartEnrollmentResponse = StartEnrollmentResult | StartEnrollmentError;

/**
 * Starts a Face ID enrollment session for the authenticated user.
 *
 * This is an explicit action triggered by user interaction. Enrollment does
 * NOT start merely because a user visits the setup page.
 *
 * Error codes:
 *   - UNAUTHENTICATED: No valid session
 *   - PROFILE_INCOMPLETE: Profile not completed
 *   - FACE_PROFILE_ALREADY_EXISTS: User already has Face ID configured
 *   - ENROLLMENT_START_FAILED: Persistence failure
 */
export async function startFaceEnrollment(): Promise<StartEnrollmentResponse> {
  // 1. Authentication
  const session = await getSession();
  if (!session) {
    return {
      ok: false,
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.UNAUTHENTICATED,
        message: "You must be signed in to start face enrollment.",
      },
    };
  }

  const userId = session.user.id;

  // 2. Profile requirement
  const onboardingComplete = await isOnboardingComplete(userId);
  if (!onboardingComplete) {
    return {
      ok: false,
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.PROFILE_INCOMPLETE,
        message: "Complete your profile before starting face enrollment.",
      },
    };
  }

  // 3. Existing FaceProfile check
  const hasProfile = await hasFaceProfile(userId);
  if (hasProfile) {
    return {
      ok: false,
      error: {
        code: ENROLLMENT_ROUTE_ERROR_CODES.FACE_PROFILE_ALREADY_EXISTS,
        message: "A face profile already exists for this account. Re-enrollment is not supported yet.",
      },
    };
  }

  // 4. Create-or-reset enrollment session
  try {
    const sessionDoc = await createOrResetEnrollmentSession({
      userId,
      mode: "create",
      requiredSampleCount: REQUIRED_SAMPLE_COUNT,
      templateVersion: TEMPLATE_VERSION,
    });

    return {
      ok: true,
      status: "started",
      mode: "create",
      acceptedSamples: 0,
      requiredSamples: sessionDoc.requiredSampleCount,
      expiresAt: sessionDoc.expiresAt.toISOString(),
      generationId: sessionDoc.generationId,
    };
  } catch (err) {
    const mapped = mapEnrollmentStartError(err);
    return {
      ok: false,
      error: {
        code: mapped.code,
        message: mapped.message,
      },
    };
  }
}
