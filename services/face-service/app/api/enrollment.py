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
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import BaseModel

from app.core.security import verify_service_token
from app.schemas.common import FinalizationErrorCode
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


# --- PHASE 4.6A2: Enrollment finalization endpoint -----------------------


class _ConsistentResponseEnvelope(BaseModel):
    """Union-compatible envelope for a consistent finalize response."""

    consistent: bool
    sample_count: int
    pair_count: int
    min_self_similarity: float
    mean_self_similarity: float
    threshold: float
    centroid: list[float]
    model: dict[str, Any]


class _InconsistentResponseEnvelope(BaseModel):
    """Union-compatible envelope for an inconsistent finalize response."""

    consistent: bool
    error: dict[str, str]


@router.post(
    "/v1/faces/enrollment/finalize",
    response_model=_ConsistentResponseEnvelope | _InconsistentResponseEnvelope,
    dependencies=[Depends(verify_service_token)],
    responses={
        401: {"description": "Service token missing or wrong."},
        422: {
            "description": (
                "Domain validation failed (model mismatch, invalid embedding, "
                "or inconsistent face samples)."
            )
        },
        503: {"description": "Engine not ready."},
    },
)
async def enrollment_finalize(
    request: dict[str, Any],
) -> _ConsistentResponseEnvelope | _InconsistentResponseEnvelope:
    """Finalize an enrollment batch and return a normalized centroid.

    SERVER-TO-SERVER ONLY. The trusted Next.js server sends already-decrypted,
    already-L2-normalised embeddings obtained from ``POST /v1/faces/enrollment/sample``.
    The Face Service does NOT read MongoDB, does NOT decrypt data, and does NOT
    persist the centroid.

    Returns:

    - HTTP 200 with ``consistent=true`` and the normalized centroid when the
      embedding batch passes the pairwise consistency check.
    - HTTP 422 with ``consistent=false`` and a domain error code when the
      batch fails the consistency check (e.g. INCONSISTENT_FACE_SAMPLES).
    - HTTP 422 with MODEL_MISMATCH when request metadata is incompatible
      with the active face engine.
    - HTTP 422 for invalid embedding structure or sample count errors.
    - HTTP 503 when the engine is not ready.

    The browser MUST NOT call this endpoint directly.
    """

    # Import schemas and service locally to avoid circular imports.
    from app.engine.base import get_engine
    from app.schemas.enrollment_finalization import (
        FinalizationConsistentResponse,
        FinalizationInconsistentResponse,
    )
    from app.services.enrollment_finalization_service import (
        FinalizationServiceError,
        InconsistentResult,
        finalize_enrollment,
    )

    # Extract top-level fields from the raw JSON body.
    model_in = request.get("model")
    raw_required_sample_count = request.get("required_sample_count")
    embeddings = request.get("embeddings")

    # Basic shape validation before passing to the service.
    if model_in is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": {
                    "code": "INVALID_REQUEST",
                    "message": "Missing required field: model.",
                }
            },
        )
    if raw_required_sample_count is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": {
                    "code": "INVALID_REQUEST",
                    "message": "Missing required field: required_sample_count.",
                }
            },
        )

    # Coerce to int; invalid types will be caught as malformed JSON by FastAPI.
    try:
        required_sample_count = int(raw_required_sample_count)
    except (TypeError, ValueError):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": {
                    "code": "INVALID_REQUEST",
                    "message": "required_sample_count must be an integer.",
                }
            },
        )

    if embeddings is None:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": {
                    "code": "INVALID_REQUEST",
                    "message": "Missing required field: embeddings.",
                }
            },
        )

    model_identity = model_in.get("identity") if model_in else None
    model_name = model_in.get("name") if model_in else None
    model_dimension = model_in.get("embedding_dimension") if model_in else None
    model_normalization = model_in.get("normalization") if model_in else None

    engine = get_engine()
    engine_status = engine.status()
    if engine_status.state != "ready":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": {
                    "code": "ENGINE_NOT_READY",
                    "message": "Face Service engine is not ready.",
                }
            },
        )

    try:
        math_result = finalize_enrollment(
            embeddings=embeddings,
            required_sample_count=required_sample_count,
            request_model_identity=model_identity or "",
            request_model_name=model_name or "",
            request_embedding_dimension=model_dimension or 0,
            request_normalization=model_normalization or "",
        )
    except FinalizationServiceError as exc:
        code_str = exc.code.value if isinstance(exc.code, FinalizationErrorCode) else str(exc.code)
        # INCONSISTENT_FACE_SAMPLES is returned as a consistent=false response
        # (HTTP 200 body shape), not as an error envelope.
        # All other domain errors return a standard error envelope.
        if code_str == FinalizationErrorCode.INCONSISTENT_FACE_SAMPLES.value:
            log.info(
                "enrollment_finalize consistent=false error_code=%s",
                code_str,
            )
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "error": {
                        "code": code_str,
                        "message": exc.message,
                    }
                },
            )
        log.info(
            "enrollment_finalize consistent=false error_code=%s",
            code_str,
        )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": {
                    "code": code_str,
                    "message": exc.message,
                }
            },
        )
    except RuntimeError as exc:
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
        log.exception("enrollment_finalize_internal_error")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "Enrollment finalization failed.",
                }
            },
        )

    # Map FinalizationResult vs InconsistentResult to the correct response.
    if isinstance(math_result, InconsistentResult):
        return _InconsistentResponseEnvelope(
            consistent=False,
            error={"code": math_result.code.value, "message": math_result.message},
        )

    # Consistent case: build response with runtime engine metadata.
    engine_meta = engine.metadata()
    return _ConsistentResponseEnvelope(
        consistent=True,
        sample_count=math_result.sample_count,
        pair_count=math_result.pair_count,
        min_self_similarity=math_result.min_self_similarity,
        mean_self_similarity=math_result.mean_self_similarity,
        threshold=float(
            __import__("app.core.config", fromlist=["get_settings"]).get_settings().face_enrollment_min_self_similarity
        ),
        centroid=math_result.centroid,
        model={
            "identity": engine_meta.model_identity,
            "name": engine_meta.model_name,
            "embedding_dimension": engine_meta.embedding_dimension,
            "normalization": engine_meta.normalization,
        },
    )


__all__ = ["enrollment_sample", "enrollment_finalize", "router"]