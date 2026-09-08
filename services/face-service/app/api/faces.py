"""``POST /v1/faces/analyze`` — detect zero/one/many faces + quality metadata."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status

from app.core.security import verify_service_token
from app.engine.base import get_engine
from app.engine.insightface_engine import InsightFaceEngine
from app.schemas.common import FaceErrorCode
from app.schemas.face import (
    AnalyzeResponse,
    BoundingBoxOut,
    FaceOut,
    FaceQualityOut,
    ImageDimensionsOut,
    LandmarkOut,
)
from app.services.recognition_service import analyze_image
from app.utils.image import ImageError, decode_image


router = APIRouter(tags=["faces"])
log = logging.getLogger("face_service.api.faces")


def _engine_or_error() -> None:
    engine = get_engine()
    # Accept any engine whose ``status().state`` reports "ready". The concrete
    # class is not enforced — tests can substitute a fake engine without
    # importing the heavyweight InsightFace implementation. Production
    # deployments should only see ``InsightFaceEngine``.
    status_obj = engine.status()
    if status_obj.state != "ready":
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
    "/v1/faces/analyze",
    response_model=AnalyzeResponse,
    dependencies=[Depends(verify_service_token)],
    responses={
        400: {"description": "Invalid image or unsupported format."},
        401: {"description": "Service token missing or wrong."},
        413: {"description": "Image too large."},
        503: {"description": "Engine not ready."},
    },
)
async def analyze(
    file: UploadFile = File(..., description="JPEG/PNG/WebP image, single file."),
) -> AnalyzeResponse:
    """Detect faces in one image.

    Returns a deterministic ordering of detected faces with quality
    metadata. **Raw embeddings are NEVER returned** by this endpoint.
    """

    _engine_or_error()
    raw = await file.read()
    if not raw:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": {
                    "code": FaceErrorCode.INVALID_IMAGE.value,
                    "message": "Empty upload.",
                }
            },
        )

    try:
        decoded = decode_image(raw)
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

    result = analyze_image(raw)

    face_outs: list[FaceOut] = []
    for idx, face in enumerate(result.faces):
        bbox = BoundingBoxOut(
            x=face.bbox.x,
            y=face.bbox.y,
            width=face.bbox.width,
            height=face.bbox.height,
        )
        landmarks = [LandmarkOut(x=lm.x, y=lm.y) for lm in face.landmarks]
        quality = (
            FaceQualityOut(
                detection_score=face.quality.detection_score,
                face_width=face.quality.face_width,
                face_height=face.quality.face_height,
                relative_face_area=face.quality.relative_face_area,
                blur_score=face.quality.blur_score,
                brightness=face.quality.brightness,
                near_edge=face.quality.near_edge,
            )
            if face.quality is not None
            else None
        )
        face_outs.append(
            FaceOut(
                face_index=idx,
                bbox=bbox,
                detection_score=face.detection_score,
                landmarks=landmarks,
                quality=quality,
            )
        )

    log.info(
        "analyze face_count=%d image=%dx%d processing_ms=%.1f",
        len(face_outs),
        decoded.width,
        decoded.height,
        result.processing_ms,
    )

    return AnalyzeResponse(
        image=ImageDimensionsOut(width=decoded.width, height=decoded.height),
        face_count=len(face_outs),
        faces=face_outs,
        processing_ms=result.processing_ms,
    )


__all__ = ["analyze", "router"]
