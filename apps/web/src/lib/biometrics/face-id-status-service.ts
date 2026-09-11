/**
 * Safe Face ID status service for server-side consumers.
 *
 * PHASE 4.5B1 — Face ID Page Shell.
 *
 * Provides a clean server-side data path for reading Face ID enrollment
 * status without:
 *   - calling the application's own HTTP endpoint from a Server Component
 *   - duplicating status logic between the status route and pages
 *   - exposing any biometric fields (embeddings, ciphertext, model metadata)
 *
 * This module is server-only. It must NOT be imported by Client Components.
 *
 * Identity comes exclusively from `session.user.id`. The caller is
 * responsible for ensuring the session was validated before calling.
 */

import { getSession } from "@/lib/session";
import { isOnboardingComplete } from "@/lib/profile-service";
import { getFaceProfileByUserId } from "@/lib/biometrics/face-profile-service";
import {
  getEnrollmentSessionByUserId,
  isEnrollmentSessionExpired,
  deleteEnrollmentSessionByUserId,
} from "@/lib/biometrics/enrollment-session-service";
import type { EnrollmentMode } from "@/lib/biometrics/biometric-schema";
import { DEFAULT_FACE_ENROLLMENT_REQUIRED_SAMPLES } from "@/lib/biometrics/biometric-constants";

// =============================================================================
// Safe DTOs
// =============================================================================

/**
 * Status reported for the temporary enrollment session.
 *
 * `acceptedSamples` is a NUMBER COUNT derived from
 * `session.acceptedSamples.length`. The actual array is never returned.
 *
 * `generationId` is the stable, server-generated identity of this
 * enrollment generation. It is the multi-tab / reload-resilience
 * primary discriminator (NOT `expiresAt`). For an INACTIVE
 * enrollment session (`active=false`), `generationId` is `null`
 * because no session exists; the status service NEVER invents an
 * ephemeral UUID on its own. Generation creation / backfill
 * belongs in the persistence service.
 */
export interface EnrollmentStatusBlock {
  active: boolean;
  mode: EnrollmentMode | null;
  acceptedSamples: number;
  requiredSamples: number;
  expiresAt: string | null;
  generationId: string | null;
}

/**
 * Safe information about the permanent Face ID enrollment.
 *
 * Only the safe counters and a timestamp are returned.
 */
export interface FaceIdStatusBlock {
  enrolledAt: string;
  sampleCount: number;
}

/**
 * Stable, privacy-safe Face ID enrollment status for server-side consumers.
 *
 * `faceId` is `null` when no permanent Face ID enrollment exists.
 * `enrollment` is always present so callers do not need to special-case.
 */
export interface FaceIdStatus {
  configured: boolean;
  faceId: FaceIdStatusBlock | null;
  enrollment: EnrollmentStatusBlock;
}

/**
 * Result of a face-id status check from a Server Component context.
 * Includes auth/profile state so callers can redirect appropriately.
 */
export interface FaceIdStatusResult {
  /** True if the user is authenticated. */
  isAuthenticated: boolean;
  /** True if the user's profile is complete (onboarding finished). */
  isOnboardingComplete: boolean;
  /** The Face ID status, or null if auth/profile check failed. */
  status: FaceIdStatus | null;
}

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Returns the safe DTO representing "no active enrollment session".
 */
function buildInactiveEnrollmentBlock(): EnrollmentStatusBlock {
  return {
    active: false,
    mode: null,
    acceptedSamples: 0,
    requiredSamples: 0,
    expiresAt: null,
    generationId: null,
  };
}

/**
 * Builds a safe enrollment-progress block from a verified,
 * unexpired enrollment session.
 *
 * The `generationId` returned here is the server-generated UUID
 * established by the persistence service when the session was
 * created (or lazily backfilled for legacy documents). It is the
 * stable identity used by the browser for multi-tab / reload
 * reconciliation; the status service does NOT invent an ID.
 */
function buildActiveEnrollmentBlock(
  session: {
    mode: EnrollmentMode;
    requiredSampleCount: number;
    acceptedSamples: unknown[];
    expiresAt: Date;
    generationId: string;
  },
): EnrollmentStatusBlock {
  return {
    active: true,
    mode: session.mode,
    acceptedSamples: session.acceptedSamples.length,
    requiredSamples: session.requiredSampleCount,
    expiresAt: session.expiresAt.toISOString(),
    generationId: session.generationId,
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Returns the current Face ID enrollment status for the authenticated user.
 *
 * This is the preferred server-side API for reading Face ID status.
 * It uses the same logic as the status API route but returns typed
 * objects instead of JSON responses.
 *
 * Auth check:
 *   - If no session → returns `{ isAuthenticated: false, ... }`
 *   - Caller should redirect to /login
 *
 * Profile check:
 *   - If profile incomplete → returns `{ isOnboardingComplete: false, ... }`
 *   - Caller should redirect to /onboarding
 *
 * Expired session handling:
 *   - Attempts best-effort cleanup of expired sessions
 *   - Still returns safe status with `enrollment.active = false`
 */
export async function getFaceIdStatus(): Promise<FaceIdStatusResult> {
  const session = await getSession();
  if (!session) {
    return {
      isAuthenticated: false,
      isOnboardingComplete: false,
      status: null,
    };
  }

  const userId = session.user.id;

  const onboardingComplete = await isOnboardingComplete(userId);
  if (!onboardingComplete) {
    return {
      isAuthenticated: true,
      isOnboardingComplete: false,
      status: null,
    };
  }

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
      // Known-expired. Attempt best-effort cleanup.
      try {
        await deleteEnrollmentSessionByUserId(userId);
      } catch {
        // Intentionally swallowed. The session is expired by
        // application logic. Still report inactive safely.
      }
      enrollmentBlock = buildInactiveEnrollmentBlock();
    } else {
      enrollmentBlock = buildActiveEnrollmentBlock(enrollmentSession);
    }

    const status: FaceIdStatus = {
      configured,
      faceId: faceIdBlock,
      enrollment: enrollmentBlock,
    };

    return {
      isAuthenticated: true,
      isOnboardingComplete: true,
      status,
    };
  } catch {
    // On any persistence error, return a safe inactive state.
    // The caller should handle this gracefully.
    return {
      isAuthenticated: true,
      isOnboardingComplete: true,
      status: {
        configured: false,
        faceId: null,
        enrollment: buildInactiveEnrollmentBlock(),
      },
    };
  }
}

/**
 * Returns the required sample count from the centralized constant.
 * Exported for use by page components that need to display progress.
 */
export const REQUIRED_SAMPLES = DEFAULT_FACE_ENROLLMENT_REQUIRED_SAMPLES;
