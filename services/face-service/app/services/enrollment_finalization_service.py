"""Enrollment finalization service (PHASE 4.6A2).

Server-side pipeline that turns a batch of already-decrypted,
already-L2-normalised embeddings into a consistency result and, iff
consistent, a normalized centroid.

ARCHITECTURE BOUNDARY
=====================

The Face Service remains **stateless** in this phase. It must NOT know about:

- ``FaceEnrollmentSession``
- ``FaceProfile``
- MongoDB
- AES-GCM
- ``BIOMETRIC_ENCRYPTION_KEY``
- userId
- Better Auth

This service receives plaintext vectors from the trusted Next.js server
(whose responsibility is to decrypt MongoDB data). The Face Service does
NOT perform any decryption.

DESIGN
======

1. **Model compatibility is checked first.** The endpoint validates the
   request metadata against the ACTIVE engine metadata at runtime. No
   values are hardcoded (no buffalo_l, no 512) — the engine provides
   the ground truth.

2. **Pure math is reused.** The PHASE 4.6A1 pure function
   ``finalize_enrollment_embeddings`` is the source of truth for all
   pairwise consistency and centroid computation. No math is duplicated.

3. **Embeddings are converted and re-validated.** The request carries
   plain Python lists; these are converted to ``FaceEmbedding`` instances
   with a second structural check before the pure math runs.

4. **Centroid is validated before serialization.** Defensive checks:
   finite values, correct dimension, L2 norm ≈ 1.0.

5. **No persistence, no logging of biometrics.** The service computes
   in-memory and returns. Embeddings, centroid values, and request bodies
   are never logged.

The service does NOT:
- access MongoDB or any database
- decrypt biometric data
- perform face detection or embedding extraction
- persist the centroid or any other result
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from app.core.config import get_settings
from app.engine.base import get_engine
from app.engine.enrollment_finalization import (
    EMBEDDING_DIMENSION_MISMATCH as A1_DIM_MISMATCH,
)
from app.engine.enrollment_finalization import (
    EMBEDDING_NOT_NORMALIZED as A1_NOT_NORMALIZED,
)
from app.engine.enrollment_finalization import (
    INCONSISTENT_FACE_SAMPLES as A1_INCONSISTENT,
)
from app.engine.enrollment_finalization import (
    INVALID_CENTROID as A1_INVALID_CENTROID,
)
from app.engine.enrollment_finalization import (
    INVALID_EMBEDDING as A1_INVALID_EMBEDDING,
)
from app.engine.enrollment_finalization import (
    INVALID_SAMPLE_COUNT as A1_INVALID_SAMPLE_COUNT,
)
from app.engine.enrollment_finalization import (
    EnrollmentFinalizationError,
    finalize_enrollment_embeddings,
)
from app.engine.types import FaceEmbedding
from app.schemas.common import FinalizationErrorCode


log = logging.getLogger("face_service.services.enrollment_finalization")


# --- Domain errors -----------------------------------------------------------


class FinalizationServiceError(ValueError):
    """Raised when an enrollment finalization request fails.

    ``code`` is a stable :class:`FinalizationErrorCode` value.
    """

    def __init__(self, code: FinalizationErrorCode, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# --- Result types -----------------------------------------------------------


@dataclass(frozen=True)
class FinalizationResult:
    """Internal result of a successful finalization — centroid + metrics."""

    centroid: list[float]  # plain list for JSON serialization
    embedding_dimension: int
    sample_count: int
    pair_count: int
    min_self_similarity: float
    mean_self_similarity: float


@dataclass(frozen=True)
class InconsistentResult:
    """Returned when the embedding batch fails the consistency check."""

    code: FinalizationErrorCode
    message: str


# --- Public entry point -----------------------------------------------------


def finalize_enrollment(
    embeddings: list[list[float]],
    required_sample_count: int,
    request_model_identity: str,
    request_model_name: str,
    request_embedding_dimension: int,
    request_normalization: str,
) -> FinalizationResult | InconsistentResult:
    """Run the enrollment finalization pipeline on a pre-processed embedding batch.

    Parameters
    ----------
    embeddings:
        Already-decrypted, already-L2-normalised embedding vectors.
        Each is a plain Python list of floats.
    required_sample_count:
        Expected number of embeddings (must be >= 2).
    request_model_identity:
        Model identity string from the request metadata.
    request_model_name:
        Model name from the request metadata.
    request_embedding_dimension:
        Embedding dimension from the request metadata.
    request_normalization:
        Normalization basis from the request metadata.

    Returns
    -------
    FinalizationResult
        On a consistent batch: centroid + metrics.
    InconsistentResult
        On an inconsistent batch: error code + message.

    Raises
    ------
    FinalizationServiceError
        Model mismatch, invalid embedding, invalid sample count,
        or invalid centroid. These are mapped to HTTP 422 by the route.
    """

    # ---- 1. Runtime engine metadata -----------------------------------
    engine = get_engine()
    engine_status = engine.status()
    if engine_status.state != "ready":
        # Engine is not ready — this is a service-level failure, not
        # a domain error. The route maps this to HTTP 503.
        raise RuntimeError("ENGINE_NOT_READY")

    engine_meta = engine.metadata()

    # ---- 2. Model compatibility check ---------------------------------
    # Validate ALL fields of the request metadata against runtime engine.
    # Fail fast — do not call pure math if the model is incompatible.
    _check_model_compatibility(
        request_model_identity=request_model_identity,
        request_model_name=request_model_name,
        request_embedding_dimension=request_embedding_dimension,
        request_normalization=request_normalization,
        engine_meta=engine_meta,
    )

    # ---- 3. Convert request embeddings to FaceEmbedding ---------------
    # Validate using the ENGINE's dimension (the ground truth), not the
    # request's declared dimension (which was already validated above).
    validated: list[FaceEmbedding] = _convert_embeddings(
        embeddings,
        engine_dimension=engine_meta.embedding_dimension,
    )

    # ---- 4. Sample count validation (early) -------------------------
    if required_sample_count < 2:
        raise FinalizationServiceError(
            FinalizationErrorCode.INVALID_SAMPLE_COUNT,
            f"required_sample_count must be >= 2; got {required_sample_count}.",
        )
    if len(embeddings) != required_sample_count:
        raise FinalizationServiceError(
            FinalizationErrorCode.INVALID_SAMPLE_COUNT,
            (
                f"Expected exactly {required_sample_count} embeddings; "
                f"got {len(embeddings)}."
            ),
        )

    # ---- 5. Call PHASE 4.6A1 pure math ------------------------------
    settings = get_settings()
    threshold = float(settings.face_enrollment_min_self_similarity)

    try:
        math_result = finalize_enrollment_embeddings(
            embeddings=validated,
            required_sample_count=required_sample_count,
            min_self_similarity=threshold,
        )
    except EnrollmentFinalizationError as exc:
        # Map PHASE 4.6A1 error codes to FinalizationErrorCode values.
        code = _map_math_error(exc.code)
        raise FinalizationServiceError(code, exc.message) from exc

    # ---- 6. Defensive centroid validation ----------------------------
    centroid = _validate_centroid(math_result.centroid, engine_meta.embedding_dimension)

    # Safe log: no embeddings, no centroid values, no userId.
    log.info(
        "enrollment_finalize consistent=true sample_count=%d "
        "min_self_similarity=%.6f mean_self_similarity=%.6f "
        "model_identity=%s",
        math_result.sample_count,
        math_result.min_self_similarity,
        math_result.mean_self_similarity,
        engine_meta.model_identity,
    )

    return FinalizationResult(
        centroid=centroid,
        embedding_dimension=int(math_result.embedding_dimension),
        sample_count=int(math_result.sample_count),
        pair_count=int(math_result.pair_count),
        min_self_similarity=float(math_result.min_self_similarity),
        mean_self_similarity=float(math_result.mean_self_similarity),
    )


# --- Internals -------------------------------------------------------------


def _check_model_compatibility(
    request_model_identity: str,
    request_model_name: str,
    request_embedding_dimension: int,
    request_normalization: str,
    engine_meta,  # EngineMetadata
) -> None:
    """Validate request metadata against the runtime engine.

    Raises FinalizationServiceError(MODEL_MISMATCH) on any mismatch.
    The pure math layer is NOT called when model is incompatible.
    """

    mismatches: list[str] = []

    if request_model_identity != engine_meta.model_identity:
        mismatches.append(
            f"model identity: request '{request_model_identity}' "
            f"!= engine '{engine_meta.model_identity}'"
        )

    if request_model_name != engine_meta.model_name:
        mismatches.append(
            f"model name: request '{request_model_name}' "
            f"!= engine '{engine_meta.model_name}'"
        )

    if request_embedding_dimension != engine_meta.embedding_dimension:
        mismatches.append(
            f"embedding dimension: request {request_embedding_dimension} "
            f"!= engine {engine_meta.embedding_dimension}"
        )

    if request_normalization != engine_meta.normalization:
        mismatches.append(
            f"normalization: request '{request_normalization}' "
            f"!= engine '{engine_meta.normalization}'"
        )

    if mismatches:
        msg = (
            "Request model metadata is incompatible with the active face engine: "
            + "; ".join(mismatches)
        )
        log.info(
            "enrollment_finalize model_mismatch reason='%s'",
            "; ".join(mismatches),
        )
        raise FinalizationServiceError(
            FinalizationErrorCode.MODEL_MISMATCH,
            msg,
        )


def _convert_embeddings(
    raw: list[list[float]],
    *,
    engine_dimension: int,
) -> list[FaceEmbedding]:
    """Convert request lists to FaceEmbedding instances with structural validation.

    This is a second layer of validation on top of the pure math's own
    checks. We validate before the pure math call so that we can map
    errors to FinalizationErrorCode before they reach the math layer.

    The ``engine_dimension`` is the ACTIVE engine's embedding dimension
    (the ground truth). The request metadata's declared dimension was
    already validated against it in the model compatibility check.
    """

    import math

    result: list[FaceEmbedding] = []
    for idx, vec in enumerate(raw):
        # Type check
        if not isinstance(vec, list):
            raise FinalizationServiceError(
                FinalizationErrorCode.INVALID_EMBEDDING,
                f"Embedding #{idx} must be a list of floats.",
            )

        # Empty check
        if len(vec) == 0:
            raise FinalizationServiceError(
                FinalizationErrorCode.INVALID_EMBEDDING,
                f"Embedding #{idx} is empty.",
            )

        # Length check against ENGINE dimension (the ground truth)
        if len(vec) != engine_dimension:
            raise FinalizationServiceError(
                FinalizationErrorCode.EMBEDDING_DIMENSION_MISMATCH,
                (
                    f"Embedding #{idx} has dimension {len(vec)}; "
                    f"expected {engine_dimension} (engine dimension)."
                ),
            )

        # Finite check
        for val_idx, val in enumerate(vec):
            if not isinstance(val, (int, float)):
                raise FinalizationServiceError(
                    FinalizationErrorCode.INVALID_EMBEDDING,
                    f"Embedding #{idx}[{val_idx}] is not a number: {type(val).__name__}.",
                )
            if not math.isfinite(val):
                raise FinalizationServiceError(
                    FinalizationErrorCode.INVALID_EMBEDDING,
                    f"Embedding #{idx}[{val_idx}] is not finite: {val}.",
                )

        # Build FaceEmbedding
        result.append(
            FaceEmbedding(
                vector=tuple(float(v) for v in vec),
                dimension=engine_dimension,
            )
        )

    return result


def _validate_centroid(
    centroid: "numpy.ndarray",  # type: ignore[name-defined]
    expected_dimension: int,
) -> list[float]:
    """Validate the centroid from the pure math layer before serialization.

    Defensive checks:
    - dimension matches engine runtime dimension
    - all values are finite
    - L2 norm ≈ 1.0

    Raises FinalizationServiceError(INVALID_CENTROID) on any failure.
    """

    import math

    import numpy as np

    arr = np.asarray(centroid, dtype=np.float32)

    # Dimension check
    if arr.shape[0] != expected_dimension:
        raise FinalizationServiceError(
            FinalizationErrorCode.INVALID_CENTROID,
            (
                f"Centroid dimension {arr.shape[0]} does not match "
                f"engine dimension {expected_dimension}."
            ),
        )

    # Finite check
    if not bool(np.isfinite(arr).all()):
        raise FinalizationServiceError(
            FinalizationErrorCode.INVALID_CENTROID,
            "Centroid contains non-finite values.",
        )

    # L2 norm check
    norm = float(np.linalg.norm(arr))
    if not math.isfinite(norm) or not math.isclose(norm, 1.0, abs_tol=1e-3):
        raise FinalizationServiceError(
            FinalizationErrorCode.INVALID_CENTROID,
            f"Centroid is not L2-normalised (|v|={norm:.6f}).",
        )

    return [float(x) for x in arr]


def _map_math_error(math_code: str) -> FinalizationErrorCode:
    """Map PHASE 4.6A1 error codes to FinalizationErrorCode values."""

    mapping = {
        A1_INVALID_SAMPLE_COUNT: FinalizationErrorCode.INVALID_SAMPLE_COUNT,
        A1_INVALID_EMBEDDING: FinalizationErrorCode.INVALID_EMBEDDING,
        A1_DIM_MISMATCH: FinalizationErrorCode.EMBEDDING_DIMENSION_MISMATCH,
        A1_NOT_NORMALIZED: FinalizationErrorCode.EMBEDDING_NOT_NORMALIZED,
        A1_INCONSISTENT: FinalizationErrorCode.INCONSISTENT_FACE_SAMPLES,
        A1_INVALID_CENTROID: FinalizationErrorCode.INVALID_CENTROID,
    }

    return mapping.get(
        math_code,
        FinalizationErrorCode.INVALID_SAMPLE_COUNT,
    )


__all__ = [
    "FinalizationServiceError",
    "FinalizationResult",
    "InconsistentResult",
    "finalize_enrollment",
]
