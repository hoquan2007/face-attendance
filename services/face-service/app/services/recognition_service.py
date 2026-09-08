"""Recognition service — the route-layer entry point.

Centralizes the ``decode → detect → embed/compare → order → return DTOs``
pipeline so that route handlers stay thin and so that future enrollment /
recognition flows share the same primitives.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.core.config import get_settings
from app.engine.base import BoundingBox
from app.engine.matcher import (
    MatcherError,
    compare_embeddings,
    cosine_similarity,
)
from app.engine.types import (
    Candidate,
    DecodedImage,
    DetectedFace,
    FaceEmbedding,
    Landmark,
)
from app.utils.image import ImageError, decode_image, order_faces_by_x


@dataclass(frozen=True)
class AnalysisResult:
    """Public-facing shape returned by the /v1/faces/analyze endpoint."""

    image_width: int
    image_height: int
    faces: list[DetectedFace]
    processing_ms: float


@dataclass(frozen=True)
class CompareResult:
    """Public-facing shape returned by the /v1/faces/compare endpoint."""

    similarity: float
    threshold: float
    match: bool
    processing_ms: float


class CompareDomainError(ValueError):
    """Raised when an input violates the /v1/faces/compare face-count policy."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


from app.engine.base import get_engine


def _engine_required() -> None:
    """Raise ``ENGINE_NOT_READY`` if the active engine is not ready.

    The check uses the engine's own ``status().state`` rather than
    ``isinstance(engine, InsightFaceEngine)``. This lets tests substitute
    a fake engine with ``state == "ready"`` while still allowing the
    routes to refuse calls when the (real) engine failed to load.
    """

    engine = get_engine()
    if engine.status().state != "ready":
        raise RuntimeError("ENGINE_NOT_READY")


def analyze_image(image: bytes) -> AnalysisResult:
    """Run detection on one image and return ordered face list + timing."""

    import time

    _engine_required()
    t0 = time.perf_counter()
    try:
        decoded = decode_image(image)
    except ImageError:
        raise
    faces = _detect_from_decoded(decoded)
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    return AnalysisResult(
        image_width=decoded.width,
        image_height=decoded.height,
        faces=faces,
        processing_ms=round(elapsed_ms, 3),
    )


def _detect_from_decoded(decoded: DecodedImage) -> list[DetectedFace]:
    from app.engine.base import get_engine

    engine = get_engine()
    faces = engine.analyze(_to_bytes(decoded))
    return order_faces_by_x(faces)


def _to_bytes(decoded: DecodedImage) -> bytes:
    """Re-encode the decoded image for engine callers that expect bytes.

    Done *in memory* — we never write the bytes to disk. This avoids a
    second decode step inside InsightFace.
    """

    import cv2  # type: ignore[import-not-found]

    ok, buf = cv2.imencode(".png", decoded.bgr)
    if not ok:
        raise RuntimeError("Failed to re-encode image for engine input.")
    return bytes(buf.tobytes())


def compare_images(image_a: bytes, image_b: bytes) -> CompareResult:
    """Run 1:1 comparison between two single-face images."""

    import time

    _engine_required()
    t0 = time.perf_counter()
    decoded_a = decode_image(image_a)
    decoded_b = decode_image(image_b)
    faces_a = _detect_from_decoded(decoded_a)
    faces_b = _detect_from_decoded(decoded_b)

    if len(faces_a) == 0:
        raise CompareDomainError(
            "NO_FACE", "First image contains no detectable face."
        )
    if len(faces_b) == 0:
        raise CompareDomainError(
            "NO_FACE", "Second image contains no detectable face."
        )
    if len(faces_a) > 1:
        raise CompareDomainError(
            "MULTIPLE_FACES",
            f"First image contains {len(faces_a)} faces; expected exactly 1.",
        )
    if len(faces_b) > 1:
        raise CompareDomainError(
            "MULTIPLE_FACES",
            f"Second image contains {len(faces_b)} faces; expected exactly 1.",
        )

    emb_a = _embedding_from_face(decoded_a, faces_a[0])
    emb_b = _embedding_from_face(decoded_b, faces_b[0])
    try:
        cmp = compare_embeddings(emb_a, emb_b)
    except MatcherError:
        raise
    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    return CompareResult(
        similarity=round(cmp.similarity, 6),
        threshold=cmp.threshold,
        match=cmp.match,
        processing_ms=round(elapsed_ms, 3),
    )


def _embedding_from_face(decoded: DecodedImage, face: DetectedFace) -> FaceEmbedding:
    from app.engine.base import get_engine

    engine = get_engine()
    raw_bytes = _to_bytes(decoded)
    embeddings = engine.extract_embeddings(raw_bytes, [face])
    if not embeddings:
        raise RuntimeError("Engine produced no embedding for the detected face.")
    return embeddings[0]


def embedding_from_face_legacy(
    decoded: DecodedImage, face: DetectedFace
) -> FaceEmbedding:
    """Legacy-shaped alias kept for any external callers; delegates to the engine."""

    return _embedding_from_face(decoded, face)


__all__ = [
    "AnalysisResult",
    "CompareResult",
    "CompareDomainError",
    "analyze_image",
    "compare_images",
    "embedding_from_face_legacy",
]
