"""``POST /v1/faces/enrollment/sample`` — protected enrollment sample endpoint.

INTERNAL ONLY
=============

The route exists exclusively for the trusted Next.js server. It is NOT
suitable for direct browser calls:

- It requires the shared ``X-Service-Token`` header (``FACE_SERVICE_SECRET``).
- The browser MUST NOT call this endpoint directly because it returns the
  L2-normalised embedding — a piece of biometric data that the Face
  Service otherwise never exposes. CORS is intentionally not configured
  for arbitrary browser origins.

Face-count errors (``NO_FACE`` / ``MULTIPLE_FACES``) are returned as the
standard PHASE 3 error envelope (HTTP 422) to preserve the stable
contract. Quality rejections (``TOO_BLURRY`` etc.) are returned in the
domain-shaped 200 response — they are NOT infrastructure errors.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

from app.core.security import verify_service_token
from app.schemas.enrollment import EnrollmentSampleResponse
from app.services.enrollment_sample_service import (
    EnrollmentDomainError,
    analyze_enrollment_sample,
)
from app.utils.image import ImageError, decode_image


router = APIRouter(tags=["enrollment"])
log = logging.getLogger("face_service.api.enrollment")


@router.post(
    "/v1/faces/enrollment/sample",
    response_model=EnrollmentSampleResponse,
    dependencies=[Depends(verify_service_token)],
    responses={
        400: {"description": "Invalid image or unsupported format."},
        401: {"description": "Service token missing or wrong."},
        413: {"description": "Image too large."},
        422: {
            "description": (
                "Domain validation failed (NO_FACE / MULTIPLE_FACES)."
            ),
        },
        503: {"description": "Engine not ready."},
    },
)
async def enrollment_sample(
    image: UploadFile = File(..., description="One image (JPEG/PNG/WebP/BMP)."),
) -> EnrollmentSampleResponse:
    """Validate one uploaded image as an enrollment sample.

    Returns:

    - HTTP 200 with ``accepted=true`` and the L2-normalised embedding +
      engine metadata when the sample passes the quality gate.
    - HTTP 200 with ``accepted=false`` and a list of rejection codes when
      exactly one face was detected but the sample is unsuitable for
      enrollment (user should retake the photo).
    - HTTP 422 with the standard error envelope when 0 or 2+ faces are
      detected (infrastructure-stable contract, identical to PHASE 3).
    """

    raw = await image.read()
    if not raw:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": {
                    "code": "INVALID_IMAGE",
                    "message": "Empty upload.",
                }
            },
        )

    # Reuse the existing image-decoding pipeline (size + format + dims).
    # We decode up front so the route returns the standard error envelope
    # for malformed payloads — the service layer re-decodes via the same
    # function and would otherwise raise the same ImageError.
    try:
        decode_image(raw)
    except ImageError as exc:
        http_status = (
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
            if exc.code == "IMAGE_TOO_LARGE"
            else status.HTTP_400_BAD_REQUEST
        )
        raise HTTPException(
            status_code=http_status,
            detail={"error": {"code": exc.code, "message": exc.message}},
        )

    try:
        result = analyze_enrollment_sample(raw)
    except EnrollmentDomainError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": {"code": exc.code, "message": exc.message}},
        )
    except RuntimeError as exc:
        # ENGINE_NOT_READY is the only contract-stable RuntimeError raised
        # by the service layer today; everything else is logged and
        # surfaced as a generic 503 so callers do not see internals.
        msg = str(exc)
        if "ENGINE_NOT_READY" in msg:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail={
                    "error": {
                        "code": "ENGINE_NOT_READY",
                        "message": "Face Service engine is not ready.",
                    }
                },
            )
        log.exception("enrollment_sample_internal_error")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "Enrollment sample processing failed.",
                }
            },
        )

    log.info(
        "enrollment_sample accepted=%s face_count=1 rejection_count=%d "
        "processing_ms=%.1f",
        result.accepted,
        len(result.rejection_reasons),
        result.processing_ms,
    )

    return result


__all__ = ["enrollment_sample", "router"]