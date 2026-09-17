"""``POST /attendance/identify`` — multi-face gallery identification."""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from pydantic import ValidationError

from app.core.security import verify_service_token
from app.engine.base import get_engine
from app.schemas.common import FaceErrorCode
from app.schemas.identify import IdentifyRequest, IdentifyResponse
from app.services.identify_service import (
    IdentifyResult,
    MatcherError,
    identify_faces,
)
from app.utils.image import ImageError, decode_image


router = APIRouter(tags=["attendance"])
log = logging.getLogger("face_service.api.identify")


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
    "/attendance/identify",
    response_model=IdentifyResponse,
    dependencies=[Depends(verify_service_token)],
    responses={
        400: {"description": "Invalid image or unsupported format."},
        401: {"description": "Service token missing or wrong."},
        413: {"description": "Image too large."},
        422: {"description": "Domain validation (NO_FACE / TOO_MANY_FACES / EMPTY_GALLERY)."},
        503: {"description": "Engine not ready."},
    },
)
async def identify(
    image: UploadFile = File(..., description="Camera frame image."),
    gallery_json: UploadFile = File(..., description="JSON-encoded IdentifyRequest gallery."),
) -> IdentifyResponse:
    """Identify multiple faces in one camera frame against a session-scoped gallery.

    Privacy contract:
        - Gallery contains ONLY ephemeral candidate keys (e.g. 'c0', 'c1') and embeddings.
        - Real student identities (userId, fullName, identificationCode) are NEVER accepted.
        - Embeddings received in the gallery are NEVER returned in the response.
        - The gallery is always session-scoped and built by the web server.

    Algorithm:
        - Decode image once.
        - Detect up to `max_faces` faces (default 5, max 10).
        - Extract one embedding per detected face.
        - Compute vectorized cosine similarity against every gallery candidate.
        - Apply greedy deterministic one-to-one matching above threshold.
        - Return matched ephemeral candidate keys and unmatched count.

    Quality gates:
        - Empty gallery → 422.
        - No face detected → 422.
        - Too many faces (> max_faces) → 422.
        - Bad image → 400/413.
        - Invalid gallery embeddings → 422.
    """

    _engine_or_error()

    # ---- Read image ----
    raw_image = await image.read()
    if not raw_image:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": {
                    "code": FaceErrorCode.INVALID_IMAGE.value,
                    "message": "Image upload is required.",
                }
            },
        )

    # Validate image early.
    try:
        decode_image(raw_image)
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

    # ---- Read and parse gallery JSON ----
    raw_gallery = await gallery_json.read()
    if not raw_gallery:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": {
                    "code": "INVALID_GALLERY",
                    "message": "Gallery JSON upload is required.",
                }
            },
        )

    import json

    try:
        gallery_data = json.loads(raw_gallery.decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail={
                "error": {
                    "code": "INVALID_GALLERY",
                    "message": "Gallery JSON is malformed.",
                }
            },
        )

    # Parse request body.
    try:
        parsed = IdentifyRequest.model_validate(gallery_data)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": {
                    "code": "INVALID_GALLERY",
                    "message": "Gallery payload failed schema validation.",
                    "errors": [
                        {
                            "loc": list(e.get("loc", [])),
                            "msg": e.get("msg", ""),
                            "type": e.get("type", ""),
                        }
                        for e in exc.errors()
                    ],
                }
            },
        )

    if not parsed.gallery:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": {
                    "code": "EMPTY_GALLERY",
                    "message": "Gallery must contain at least one candidate.",
                }
            },
        )

    # ---- Run identify pipeline ----
    try:
        result: IdentifyResult = identify_faces(
            image=raw_image,
            gallery=parsed.gallery,
            max_faces=parsed.max_faces,
        )
    except ValueError as exc:
        code = str(exc.args[0]) if exc.args else "UNKNOWN"
        if code == "NO_FACE":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "error": {
                        "code": FaceErrorCode.NO_FACE.value,
                        "message": "No face detected in the image.",
                    }
                },
            )
        if code.startswith("TOO_MANY_FACES"):
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "error": {
                        "code": "TOO_MANY_FACES",
                        "message": str(exc.args[1]) if len(exc.args) > 1 else code,
                    }
                },
            )
        if code == "EMPTY_GALLERY":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail={
                    "error": {
                        "code": "EMPTY_GALLERY",
                        "message": "Gallery must contain at least one candidate.",
                    }
                },
            )
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": {
                    "code": "IDENTIFY_ERROR",
                    "message": str(exc),
                }
            },
        )
    except MatcherError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={
                "error": {
                    "code": exc.code,
                    "message": exc.message,
                }
            },
        )

    log.info(
        "identify faces_detected=%d matches=%d unmatched=%d processing_ms=%.1f",
        result.faces_detected,
        len(result.matches),
        result.unmatched_count,
        result.processing_ms,
    )

    return IdentifyResponse(
        faces_detected=result.faces_detected,
        matches=result.matches,
        unmatched_count=result.unmatched_count,
        processing_ms=result.processing_ms,
    )


__all__ = ["router"]
