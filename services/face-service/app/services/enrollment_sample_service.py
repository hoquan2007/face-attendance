"""Enrollment sample service (PHASE 4.3).

Pure server-side pipeline that turns one uploaded image into either:

- an accepted enrollment sample (engine metadata + L2-normalised embedding);
- a rejected enrollment sample (zero or more quality rejection codes);

…or a domain error when the face count is wrong (``NO_FACE`` /
``MULTIPLE_FACES``). The service is the single source of truth for the
end-to-end enrollment-sample logic so the route handler stays thin.

DESIGN
======

1. Reuse PHASE 3 ``decode_image`` — no second image pipeline.
2. Reuse PHASE 3 ``engine.analyze`` and ``engine.extract_embeddings`` —
   the engine already produces unit-norm embeddings.
3. Reuse PHASE 3 ``compute_quality`` — quality metrics are unchanged.
4. Apply the PHASE 4.3 ``evaluate_enrollment_quality`` policy.
5. Validate the returned embedding (finite values, dimension matches
   ``engine.metadata().embedding_dimension``, L2 norm ≈ 1.0).
6. NEVER persist anything. Everything lives in the request lifecycle.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass

import numpy as np

from app.engine.base import get_engine
from app.engine.enrollment_quality import (
    EnrollmentQualityResult,
    evaluate_enrollment_quality,
)
from app.engine.matcher import MatcherError, _to_unit_vector
from app.engine.types import DecodedImage, EngineMetadata, FaceEmbedding, FaceQuality
from app.schemas.enrollment import (
    EnrollmentModelMetadataOut,
    EnrollmentQualityOut,
    EnrollmentSampleResponse,
)
from app.utils.image import ImageError, decode_image


class EnrollmentDomainError(ValueError):
    """Raised when an enrollment input violates the face-count policy.

    ``code`` is a stable machine-readable identifier from
    :class:`app.schemas.common.FaceErrorCode` — currently ``NO_FACE`` or
    ``MULTIPLE_FACES``. The route maps this to a 422 response with the
    standard error envelope, identical to PHASE 3 ``/v1/faces/compare``.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class _AcceptedSample:
    """Internal carrier for the accepted-sample branch."""

    embedding: FaceEmbedding
    metadata: EngineMetadata
    quality: FaceQuality
    processing_ms: float


@dataclass(frozen=True)
class _RejectedSample:
    """Internal carrier for the rejected-quality branch."""

    quality: FaceQuality
    rejection_reasons: tuple[str, ...]
    processing_ms: float


def analyze_enrollment_sample(image: bytes) -> EnrollmentSampleResponse:
    """Run the full enrollment-sample pipeline on one uploaded image.

    Returns a :class:`EnrollmentSampleResponse` shaped for the wire.

    Raises:
        ImageError: malformed payload (mapped to 400/413 by the route).
        EnrollmentDomainError: face-count policy violation
            (``NO_FACE`` / ``MULTIPLE_FACES`` — mapped to 422).
        RuntimeError: engine not ready, embedding validation failure.
    """

    engine = get_engine()
    if engine.status().state != "ready":
        raise RuntimeError("ENGINE_NOT_READY")

    t0 = time.perf_counter()

    decoded: DecodedImage = decode_image(image)
    faces = list(engine.analyze(image))
    elapsed_ms = (time.perf_counter() - t0) * 1000.0

    if len(faces) == 0:
        raise EnrollmentDomainError(
            "NO_FACE", "Enrollment sample contains no detectable face."
        )
    if len(faces) > 1:
        raise EnrollmentDomainError(
            "MULTIPLE_FACES",
            f"Enrollment sample contains {len(faces)} faces; expected exactly 1.",
        )

    face = faces[0]
    quality = face.quality
    if quality is None:
        # The PHASE 3 contract says quality is best-effort; for enrollment
        # we refuse to score a sample without quality metadata.
        raise RuntimeError("Engine produced no quality metadata for the face.")

    policy: EnrollmentQualityResult = evaluate_enrollment_quality(quality)

    if policy.accepted:
        embeddings = engine.extract_embeddings(image, [face])
        if not embeddings:
            raise RuntimeError(
                "Engine produced no embedding for an accepted enrollment sample."
            )
        emb = embeddings[0]
        metadata = engine.metadata()
        validated = _validate_accepted_embedding(emb, metadata)
        result = _AcceptedSample(
            embedding=validated,
            metadata=metadata,
            quality=quality,
            processing_ms=elapsed_ms,
        )
        return _to_accepted_response(result)
    result = _RejectedSample(
        quality=quality,
        rejection_reasons=policy.rejection_reasons,
        processing_ms=elapsed_ms,
    )
    return _to_rejected_response(result)


# --- internals -------------------------------------------------------------


def _validate_accepted_embedding(
    embedding: FaceEmbedding, metadata: EngineMetadata
) -> FaceEmbedding:
    """Sanity-check the engine-produced embedding against the engine's metadata.

    Validations:

    - dimension matches ``metadata.embedding_dimension``;
    - vector is non-empty;
    - all values are finite;
    - L2 norm is within a tight band around 1.0 (the engine promises L2).

    The embedding is returned unchanged — we do not renormalize, because
    that would silently differ from the value that produced any
    downstream comparison.
    """

    if metadata.embedding_dimension <= 0:
        raise MatcherError(
            "INVALID_EMBEDDING",
            f"Engine reported non-positive embedding dimension "
            f"{metadata.embedding_dimension}.",
        )
    if embedding.dimension != metadata.embedding_dimension:
        raise MatcherError(
            "INVALID_EMBEDDING",
            (
                f"Embedding dimension {embedding.dimension} does not match "
                f"engine metadata {metadata.embedding_dimension}."
            ),
        )

    arr = np.asarray(embedding.vector, dtype=np.float32)
    if arr.ndim != 1 or arr.shape[0] == 0:
        raise MatcherError(
            "INVALID_EMBEDDING", "Embedding is empty or not one-dimensional."
        )
    if not np.isfinite(arr).all():
        raise MatcherError(
            "INVALID_EMBEDDING", "Embedding contains non-finite values."
        )

    # Reuse the matcher's unit-vector conversion — it raises
    # INVALID_EMBEDDING when the norm is degenerate. We do NOT keep the
    # rescaled vector; we only want to confirm that the input is a real
    # unit vector.
    _to_unit_vector(embedding)
    norm = float(np.linalg.norm(arr))
    if not math.isfinite(norm) or abs(norm - 1.0) > 1e-3:
        raise MatcherError(
            "INVALID_EMBEDDING",
            f"Embedding is not L2-normalised (|v|={norm:.6f}).",
        )
    return embedding


def _to_accepted_response(sample: _AcceptedSample) -> EnrollmentSampleResponse:
    return EnrollmentSampleResponse(
        accepted=True,
        quality=EnrollmentQualityOut(
            detection_score=sample.quality.detection_score,
            face_width=sample.quality.face_width,
            face_height=sample.quality.face_height,
            relative_face_area=sample.quality.relative_face_area,
            blur_score=sample.quality.blur_score,
            brightness=sample.quality.brightness,
            near_edge=sample.quality.near_edge,
        ),
        embedding=list(sample.embedding.vector),
        rejection_reasons=[],
        model=EnrollmentModelMetadataOut(
            identity=sample.metadata.model_identity,
            name=sample.metadata.model_name,
            embedding_dimension=int(sample.metadata.embedding_dimension),
            normalization=sample.metadata.normalization,
        ),
        processing_ms=round(sample.processing_ms, 3),
    )


def _to_rejected_response(sample: _RejectedSample) -> EnrollmentSampleResponse:
    return EnrollmentSampleResponse(
        accepted=False,
        quality=EnrollmentQualityOut(
            detection_score=sample.quality.detection_score,
            face_width=sample.quality.face_width,
            face_height=sample.quality.face_height,
            relative_face_area=sample.quality.relative_face_area,
            blur_score=sample.quality.blur_score,
            brightness=sample.quality.brightness,
            near_edge=sample.quality.near_edge,
        ),
        embedding=None,
        rejection_reasons=list(sample.rejection_reasons),
        model=None,
        processing_ms=round(sample.processing_ms, 3),
    )


__all__ = [
    "EnrollmentDomainError",
    "analyze_enrollment_sample",
]