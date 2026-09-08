"""``POST /v1/faces/compare`` — 1:1 verification between two single-face images."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

from app.core.security import verify_service_token
from app.engine.base import get_engine
from app.engine.insightface_engine import InsightFaceEngine
from app.schemas.common import FaceErrorCode
from app.schemas.compare import CompareResponse
from app.services.recognition_service import CompareDomainError, compare_images
from app.utils.image import ImageError, decode_image


router = APIRouter(tags=["faces"])
log = logging.getLogger("face_service.api.faces_compare")


def _engine_or_error() -> None:
    engine = get_engine()
    if engine.status().state != "ready":
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={
                "error": {
                    "code": FaceErrorCode.ENGINE_NOT_READY.value,
                    "message": "Face Service engine is not ready.",
                }
            },
        )


@router.post(
    "/v1/faces/compare",
    response_model=CompareResponse,
    dependencies=[Depends(verify_service_token)],
    responses={
        400: {"description": "Invalid image or unsupported format."},
        401: {"description": "Service token missing or wrong."},
        413: {"description": "Image too large."},
        422: {"description": "Domain validation (NO_FACE / MULTIPLE_FACES)."},
        503: {"description": "Engine not ready."},
    },
)
async def compare(
    image_a: UploadFile = File(..., description="First image — exactly one face."),
    image_b: UploadFile = File(..., description="Second image — exactly one face."),
) -> CompareResponse:
    """Verify whether two images contain the same person.

    The threshold is the configured ``FACE_MATCH_THRESHOLD`` (a development
    baseline) — see ``docs/model-license.md``. Each image must contain
    exactly one face; multi-face inputs are rejected so the caller does not
    silently get a partial result.
    """

    _engine_or_error()

    raw_a = await image_a.read()
    raw_b = await image_b.read()
    if not raw_a or not raw_b:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": {
                    "code": FaceErrorCode.INVALID_IMAGE.value,
                    "message": "Both uploads are required.",
                }
            },
        )

    for raw in (raw_a, raw_b):
        try:
            decode_image(raw)
        except ImageError as exc:
            http_status = (
                status.HTTP_413_REQUEST_ENTITY_TOO_LARGE
                if exc.code == FaceErrorCode.IMAGE_TOO_LARGE.value
                else status.HTTP_400_BAD_REQUEST
            )
            raise HTTPException(
                status_code=http_status,
                detail={"error": {"code": exc.code, "message": exc.message}},
            )

    try:
        result = compare_images(raw_a, raw_b)
    except CompareDomainError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"error": {"code": exc.code, "message": exc.message}},
        )

    log.info(
        "compare similarity=%.4f match=%s threshold=%.4f processing_ms=%.1f",
        result.similarity,
        result.match,
        result.threshold,
        result.processing_ms,
    )

    return CompareResponse(
        similarity=result.similarity,
        threshold=result.threshold,
        match=result.match,
        processing_ms=result.processing_ms,
    )


__all__ = ["compare", "router"]
