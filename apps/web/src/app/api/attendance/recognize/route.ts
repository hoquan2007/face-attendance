/**
 * POST /api/attendance/recognize
 *
 * PHASE 6.3 — LIVE FACE RECOGNITION PREVIEW.
 *
 * Authenticated Next.js Route Handler for teacher camera frame recognition.
 *
 * Security contract:
 *   - Requires valid Better Auth session (UNAUTHENTICATED otherwise).
 *   - Requires completed Teacher Profile (PROFILE_INCOMPLETE otherwise).
 *   - Requires class ownership (NON_OWNER otherwise).
 *   - Requires ACTIVE attendance session (SESSION_NOT_ACTIVE otherwise).
 *   - Requires session belongs to the specified classId (SESSION_CLASS_MISMATCH otherwise).
 *
 * Privacy contract:
 *   - Camera frame is NEVER persisted (not logged, not stored in MongoDB).
 *   - FaceService receives ONLY ephemeral candidate keys + embeddings.
 *   - Real student identities (studentUserId, fullName, identificationCode) are NEVER sent.
 *   - Browser receives ONLY safe display data: fullNameSnapshot, identificationCode.
 *   - NO attendance marks are created (preview only).
 *
 * Request (multipart/form-data):
 *   - classId: string (required)
 *   - sessionId: string (required)
 *   - image: binary JPEG image (required)
 *
 * Response:
 *   - facesDetected: number
 *   - unmatchedCount: number
 *   - matches: Array<{ fullName: string, identificationCode: string }>
 *
 * This route does NOT create attendance marks. It is preview-only.
 */

import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getProfileByUserId } from "@/lib/profile-service";
import { getClassDetailForCurrentUser } from "@/lib/classes/class-read-service";
import { findActiveAttendanceSessionByClassId } from "@/lib/attendance/attendance-session-service";
import {
  buildAttendanceRecognitionGallery,
  ATTENDANCE_RECOGNITION_ERROR_CODES,
  AttendanceRecognitionError,
} from "@/lib/attendance/attendance-recognition-gallery-service";
import {
  identifyFaces,
  FACE_SERVICE_ERROR_CODES,
  FaceServiceClientError,
} from "@/lib/biometrics/face-service-client";

// =============================================================================
// Stable error codes
// =============================================================================

export const ATTENDANCE_RECOGNIZE_ERROR_CODES = {
  UNAUTHENTICATED: "UNAUTHENTICATED",
  PROFILE_INCOMPLETE: "PROFILE_INCOMPLETE",
  NON_OWNER: "NON_OWNER",
  CLASS_NOT_ACCESSIBLE: "CLASS_NOT_ACCESSIBLE",
  SESSION_NOT_ACTIVE: "SESSION_NOT_ACTIVE",
  SESSION_CLASS_MISMATCH: "SESSION_CLASS_MISMATCH",
  NO_RECOGNITION_CANDIDATES: "NO_RECOGNITION_CANDIDATES",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  INVALID_IMAGE: "INVALID_IMAGE",
  IMAGE_TOO_LARGE: "IMAGE_TOO_LARGE",
  FACE_SERVICE_ERROR: "FACE_SERVICE_ERROR",
  ATTENDANCE_RECOGNIZE_FAILED: "ATTENDANCE_RECOGNIZE_FAILED",
} as const;

export type AttendanceRecognizeErrorCode =
  (typeof ATTENDANCE_RECOGNIZE_ERROR_CODES)[keyof typeof ATTENDANCE_RECOGNIZE_ERROR_CODES];

// =============================================================================
// Safe error response helper
// =============================================================================

function errorResponse(
  code: AttendanceRecognizeErrorCode,
  message: string,
  status: number = 400,
): NextResponse {
  return NextResponse.json(
    { error: { code, message } },
    { status },
  );
}

// =============================================================================
// Image validation
// =============================================================================

const MAX_IMAGE_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB
const ALLOWED_MIME_TYPES = new Set(["image/jpeg", "image/png"]);

/**
 * Validates the uploaded image for size and type.
 * Does NOT inspect image content (that happens at the Face Service).
 */
function validateImage(
  image: Blob | null,
): { valid: false; code: AttendanceRecognizeErrorCode; message: string } | { valid: true } {
  if (!image) {
    return {
      valid: false,
      code: ATTENDANCE_RECOGNIZE_ERROR_CODES.INVALID_IMAGE,
      message: "Image is required.",
    };
  }

  if (!ALLOWED_MIME_TYPES.has(image.type)) {
    return {
      valid: false,
      code: ATTENDANCE_RECOGNIZE_ERROR_CODES.INVALID_IMAGE,
      message: `Unsupported image type: ${image.type}. Only JPEG and PNG are accepted.`,
    };
  }

  if (image.size > MAX_IMAGE_SIZE_BYTES) {
    return {
      valid: false,
      code: ATTENDANCE_RECOGNIZE_ERROR_CODES.IMAGE_TOO_LARGE,
      message: `Image exceeds maximum size of ${MAX_IMAGE_SIZE_BYTES / (1024 * 1024)} MB.`,
    };
  }

  return { valid: true };
}

// =============================================================================
// Handler
// =============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ---- 1. Authenticate teacher ----
  const session = await getSession();
  if (!session) {
    return errorResponse(
      ATTENDANCE_RECOGNIZE_ERROR_CODES.UNAUTHENTICATED,
      "Sign in to use face recognition.",
      401,
    );
  }

  // ---- 2. Profile gating ----
  const profile = await getProfileByUserId(session.user.id);
  if (!profile || !profile.onboardingCompleted) {
    return errorResponse(
      ATTENDANCE_RECOGNIZE_ERROR_CODES.PROFILE_INCOMPLETE,
      "Complete your profile to use face recognition.",
      403,
    );
  }

  // ---- 3. Parse form data ----
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return errorResponse(
      ATTENDANCE_RECOGNIZE_ERROR_CODES.INVALID_IMAGE,
      "Invalid form data.",
      400,
    );
  }

  const classId = formData.get("classId");
  const sessionId = formData.get("sessionId");
  const image = formData.get("image");

  if (typeof classId !== "string" || classId.length === 0) {
    return errorResponse(
      ATTENDANCE_RECOGNIZE_ERROR_CODES.INVALID_IMAGE,
      "classId is required.",
      400,
    );
  }

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    return errorResponse(
      ATTENDANCE_RECOGNIZE_ERROR_CODES.INVALID_IMAGE,
      "sessionId is required.",
      400,
    );
  }

  // ---- 4. Validate image ----
  const imageValidation = validateImage(image instanceof Blob ? image : null);
  if (!imageValidation.valid) {
    return errorResponse(imageValidation.code, imageValidation.message, 400);
  }

  // ---- 5. Authorize class ownership ----
  const classResult = await getClassDetailForCurrentUser(classId);
  if (!classResult.ok) {
    const code = classResult.code;
    if (
      code === "UNAUTHENTICATED" ||
      code === "PROFILE_INCOMPLETE" ||
      code === "CLASS_NOT_ACCESSIBLE"
    ) {
      return errorResponse(
        ATTENDANCE_RECOGNIZE_ERROR_CODES.CLASS_NOT_ACCESSIBLE,
        "You do not have access to this class.",
        403,
      );
    }
    return errorResponse(
      ATTENDANCE_RECOGNIZE_ERROR_CODES.ATTENDANCE_RECOGNIZE_FAILED,
      "Failed to verify class access.",
      500,
    );
  }

  if (classResult.result.role !== "teacher") {
    return errorResponse(
      ATTENDANCE_RECOGNIZE_ERROR_CODES.NON_OWNER,
      "Only teachers can use face recognition.",
      403,
    );
  }

  // ---- 6. Validate ACTIVE attendance session ----
  let sessionDoc;
  try {
    const mongoose = await import("mongoose");
    const classObjectId = new mongoose.Types.ObjectId(classId);
    sessionDoc = await findActiveAttendanceSessionByClassId(classObjectId);
  } catch {
    return errorResponse(
      ATTENDANCE_RECOGNIZE_ERROR_CODES.SESSION_NOT_FOUND,
      "Failed to check attendance session.",
      500,
    );
  }

  if (!sessionDoc) {
    return errorResponse(
      ATTENDANCE_RECOGNIZE_ERROR_CODES.SESSION_NOT_ACTIVE,
      "Attendance session is no longer active.",
      400,
    );
  }

  // Verify sessionId matches.
  const sessionIdStr = String((sessionDoc as unknown as { _id: { toString: () => string } })._id?.toString() ?? "");
  if (sessionIdStr !== sessionId) {
    return errorResponse(
      ATTENDANCE_RECOGNIZE_ERROR_CODES.SESSION_CLASS_MISMATCH,
      "Session does not belong to this class.",
      400,
    );
  }

  // ---- 7. Build recognition gallery from session's roster snapshot ----
  let galleryResult;
  try {
    galleryResult = await buildAttendanceRecognitionGallery(sessionId);
  } catch (err) {
    if (err instanceof AttendanceRecognitionError) {
      if (err.code === ATTENDANCE_RECOGNITION_ERROR_CODES.NO_RECOGNITION_CANDIDATES) {
        return errorResponse(
          ATTENDANCE_RECOGNIZE_ERROR_CODES.NO_RECOGNITION_CANDIDATES,
          "No enrolled faces are available for recognition in this session.",
          400,
        );
      }
      if (err.code === ATTENDANCE_RECOGNITION_ERROR_CODES.ATTENDANCE_SESSION_NOT_FOUND) {
        return errorResponse(
          ATTENDANCE_RECOGNIZE_ERROR_CODES.SESSION_NOT_FOUND,
          "Attendance session not found.",
          404,
        );
      }
      if (err.code === ATTENDANCE_RECOGNITION_ERROR_CODES.ATTENDANCE_SESSION_NOT_ACTIVE) {
        return errorResponse(
          ATTENDANCE_RECOGNIZE_ERROR_CODES.SESSION_NOT_ACTIVE,
          "Attendance session is no longer active.",
          400,
        );
      }
    }
    return errorResponse(
      ATTENDANCE_RECOGNIZE_ERROR_CODES.ATTENDANCE_RECOGNIZE_FAILED,
      "Failed to build recognition gallery.",
      500,
    );
  }

  // ---- 8. Call Face Service for identification ----
  let identifyResult;
  try {
    const imageBlob = image as Blob;
    const imageBuffer = await imageBlob.arrayBuffer();
    identifyResult = await identifyFaces(imageBuffer, galleryResult.gallery.candidates, 5);
  } catch (err) {
    if (err instanceof FaceServiceClientError) {
      const domainCode = err.domainError?.code;

      // Map Face Service domain errors to safe HTTP responses.
      if (domainCode === "NO_FACE") {
        return NextResponse.json(
          {
            facesDetected: 0,
            unmatchedCount: 0,
            matches: [],
          },
          { status: 200 },
        );
      }
      if (domainCode === "TOO_MANY_FACES") {
        return errorResponse(
          ATTENDANCE_RECOGNIZE_ERROR_CODES.FACE_SERVICE_ERROR,
          "Too many faces detected in the image. Please ensure only 2–3 people are in frame.",
          400,
        );
      }
      if (domainCode === "EMPTY_GALLERY") {
        return errorResponse(
          ATTENDANCE_RECOGNIZE_ERROR_CODES.NO_RECOGNITION_CANDIDATES,
          "No enrolled faces are available for recognition.",
          400,
        );
      }
      if (domainCode === "SESSION_NOT_ACTIVE") {
        return errorResponse(
          ATTENDANCE_RECOGNIZE_ERROR_CODES.SESSION_NOT_ACTIVE,
          "Attendance session is no longer active.",
          400,
        );
      }
      if (err.code === FACE_SERVICE_ERROR_CODES.FACE_SERVICE_UNAVAILABLE) {
        return errorResponse(
          ATTENDANCE_RECOGNIZE_ERROR_CODES.FACE_SERVICE_ERROR,
          "Face recognition service is unavailable. Please try again.",
          503,
        );
      }
      if (err.code === FACE_SERVICE_ERROR_CODES.FACE_SERVICE_TIMEOUT) {
        return errorResponse(
          ATTENDANCE_RECOGNIZE_ERROR_CODES.FACE_SERVICE_ERROR,
          "Face recognition timed out. Please try again.",
          504,
        );
      }
    }
    return errorResponse(
      ATTENDANCE_RECOGNIZE_ERROR_CODES.FACE_SERVICE_ERROR,
      "Face recognition failed. Please try again.",
      500,
    );
  }

  // ---- 9. Map ephemeral candidate keys back to safe snapshot identity ----
  const matches = identifyResult.matches.map((match) => {
    const keyMapping = galleryResult!.candidateKeyMapping[match.candidate_key];
    if (!keyMapping) {
      // Safety: if the key isn't in our mapping, skip this match.
      return null;
    }
    return {
      fullName: keyMapping.fullNameSnapshot,
      identificationCode: keyMapping.identificationCodeSnapshot,
    };
  }).filter((m): m is { fullName: string; identificationCode: string } => m !== null);

  // ---- 10. Return safe browser DTO ----
  // NEVER expose: studentUserId, candidateKey, embedding, centroid,
  // FaceProfile id, membershipId, or rosterSnapshot.
  return NextResponse.json({
    facesDetected: identifyResult.faces_detected,
    unmatchedCount: identifyResult.unmatched_count,
    matches,
  });
}
