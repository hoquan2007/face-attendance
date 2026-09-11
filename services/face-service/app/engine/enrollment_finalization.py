"""Pure enrollment finalization math (PHASE 4.6A1).

This module turns a batch of *already validated, L2-normalised* face
embeddings into a single L2-normalised centroid *iff* the batch is
mutually consistent enough to form one enrollment template.

DESIGN
======

1. **Pure math only.** The module never reads environment variables,
   performs I/O, persists anything, calls the engine, decodes images,
   or touches network / database. Configuration is supplied as
   arguments by the caller.

2. **Reuses the PHASE 3 matcher primitives.** Embedding validation,
   pairwise cosine similarity, and L2 normalisation delegate to
   :mod:`app.engine.matcher` so similarity semantics stay identical
   to the existing 1:1 / 1:N code paths.

3. **No silent repair.** NaN, Infinity, zero vectors, mismatched
   dimensions, and clearly-not-normalised inputs are rejected with a
   stable domain error. The function never auto-renormalises.

4. **No mutation.** Caller-owned embedding arrays are never mutated;
   callers may safely reuse them after the call returns.

5. **Stable domain errors.** All failure modes raise
   :class:`EnrollmentFinalizationError` with a stable ``code``
   attribute that the future PHASE 4.6A2 endpoint layer can map
   directly onto HTTP error envelopes.

NON-GOALS
=========

- HTTP / FastAPI routing
- Database persistence (``FaceProfile`` / ``FaceEnrollmentSession``)
- Biometric encryption / decryption
- Camera, raw images, JPEG bytes
- InsightFace engine access
- Re-enrollment
- Authentication / authorization
- Attendance / liveness / anti-spoofing

The pure math foundation is intentionally decoupled from those
concerns so the future finalization endpoint can wire configuration
without touching this module.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Final, Sequence

import numpy as np

from app.engine.matcher import MatcherError, cosine_similarity
from app.engine.types import FaceEmbedding


# --- Stable error codes ---------------------------------------------------

#: Stable machine-readable identifier for ``required_sample_count < 2``
#: or any other nonsensical sample-count configuration.
INVALID_SAMPLE_COUNT: Final[str] = "INVALID_SAMPLE_COUNT"

#: Stable identifier for any individual embedding that fails structural
#: validation (empty, non-finite, wrong dimension).
INVALID_EMBEDDING: Final[str] = "INVALID_EMBEDDING"

#: Stable identifier for two embeddings whose dimensions do not agree.
EMBEDDING_DIMENSION_MISMATCH: Final[str] = "EMBEDDING_DIMENSION_MISMATCH"

#: Stable identifier for an embedding whose L2 norm is not (approximately)
#: equal to 1.0. The pure math layer does not renormalise — it rejects.
EMBEDDING_NOT_NORMALIZED: Final[str] = "EMBEDDING_NOT_NORMALIZED"

#: Stable identifier for a batch whose minimum pairwise cosine similarity
#: is below the configured consistency floor. The math layer does NOT
#: produce a usable centroid in this branch.
INCONSISTENT_FACE_SAMPLES: Final[str] = "INCONSISTENT_FACE_SAMPLES"

#: Stable identifier for a degenerate centroid (non-finite or zero norm).
#: Defensive only — should never occur for a consistent batch.
INVALID_CENTROID: Final[str] = "INVALID_CENTROID"


#: Tolerance used to validate that an input embedding is L2-normalised.
#: Matches the production validator in
#: :func:`app.services.enrollment_sample_service._validate_accepted_embedding`,
#: which uses ``abs(norm - 1.0) > 1e-3`` to absorb float32 round-trip drift.
_NORMAL_TOLERANCE: Final[float] = 1e-3

#: Default float dtype used throughout the module. Kept consistent with
#: the PHASE 3 / 4.3 engine pipeline (numpy ``float32``).
_DTYPE: Final[np.dtype] = np.float32


class EnrollmentFinalizationError(ValueError):
    """Raised when an enrollment batch violates the finalization policy.

    ``code`` is a stable machine-readable identifier — one of the
    ``*_FINALIZATION*`` constants above. The future PHASE 4.6A2
    endpoint layer maps these codes onto HTTP error envelopes.

    Numerical NumPy / float errors NEVER escape this class: the pure
    math layer catches and rewraps them as
    ``INVALID_EMBEDDING`` / ``INVALID_CENTROID``.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


# --- Result type ----------------------------------------------------------


@dataclass(frozen=True)
class EnrollmentFinalizationResult:
    """Outcome of a successful enrollment finalization.

    The shape is deliberately internal to the Face Service. No HTTP /
    Pydantic schema is created at this layer — the future endpoint
    layer is responsible for translating this DTO into wire formats.
    """

    centroid: np.ndarray  # float32, L2-normalised, same dim as inputs
    embedding_dimension: int
    sample_count: int
    pair_count: int
    min_self_similarity: float
    mean_self_similarity: float


# --- Public entry point ---------------------------------------------------


def finalize_enrollment_embeddings(
    embeddings: Sequence[FaceEmbedding],
    required_sample_count: int,
    min_self_similarity: float,
) -> EnrollmentFinalizationResult:
    """Return an L2-normalised centroid iff the batch is mutually consistent.

    Parameters
    ----------
    embeddings:
        Sequence of :class:`FaceEmbedding` instances. All must be
        L2-normalised, finite, non-empty, and share the same
        dimension.
    required_sample_count:
        Positive integer ``>= 2``. ``len(embeddings)`` must equal
        this value.
    min_self_similarity:
        Development consistency floor. The batch passes only when
        ``min_self_similarity >= threshold``. A non-finite or
        out-of-range threshold raises
        :class:`EnrollmentFinalizationError` with
        :data:`INVALID_SAMPLE_COUNT` (configuration errors are
        treated as configuration errors, not batch errors).

    Returns
    -------
    :class:`EnrollmentFinalizationResult`
        Centroid plus consistency metrics.

    Raises
    ------
    EnrollmentFinalizationError
        ``INVALID_SAMPLE_COUNT``           — nonsensical configuration.
        ``INVALID_EMBEDDING``              — any individual embedding
                                            fails structural validation.
        ``EMBEDDING_DIMENSION_MISMATCH``   — embeddings disagree on dim.
        ``EMBEDDING_NOT_NORMALIZED``       — any input fails the L2 check.
        ``INCONSISTENT_FACE_SAMPLES``      — minimum pairwise similarity
                                            is below the configured
                                            threshold; no centroid is
                                            produced.
        ``INVALID_CENTROID``               — defensive: arithmetic mean
                                            is non-finite or zero-norm.
    """
    # ---- 1. Configuration validation ------------------------------------
    if (
        not isinstance(required_sample_count, int)
        or isinstance(required_sample_count, bool)
        or required_sample_count < 2
    ):
        raise EnrollmentFinalizationError(
            INVALID_SAMPLE_COUNT,
            (
                f"required_sample_count must be an integer >= 2; "
                f"got {required_sample_count!r}."
            ),
        )
    try:
        threshold = float(min_self_similarity)
    except (TypeError, ValueError):
        raise EnrollmentFinalizationError(
            INVALID_SAMPLE_COUNT,
            (
                "min_self_similarity must be a real number; "
                f"got {min_self_similarity!r}."
            ),
        )
    if not math.isfinite(threshold):
        raise EnrollmentFinalizationError(
            INVALID_SAMPLE_COUNT,
            (
                "min_self_similarity must be a finite real number; "
                f"got {min_self_similarity!r}."
            ),
        )

    # ---- 2. Sample-count validation -------------------------------------
    if len(embeddings) != required_sample_count:
        raise EnrollmentFinalizationError(
            INVALID_SAMPLE_COUNT,
            (
                f"Expected exactly {required_sample_count} embeddings; "
                f"got {len(embeddings)}."
            ),
        )

    # ---- 3. Structural embedding validation -----------------------------
    validated: list[np.ndarray] = []
    dimension: int | None = None
    for idx, emb in enumerate(embeddings):
        arr = _validate_single_embedding(emb, idx, expected_dim=dimension)
        if dimension is None:
            dimension = int(arr.shape[0])
        validated.append(arr)

    assert dimension is not None  # guarded by len(embeddings) >= 2

    # ---- 4. All pairwise cosine similarities (upper triangle) ----------
    similarities: list[float] = []
    for i in range(len(validated)):
        for j in range(i + 1, len(validated)):
            try:
                sim = cosine_similarity(
                    FaceEmbedding(
                        vector=tuple(float(x) for x in validated[i]),
                        dimension=dimension,
                    ),
                    FaceEmbedding(
                        vector=tuple(float(x) for x in validated[j]),
                        dimension=dimension,
                    ),
                )
            except MatcherError as exc:
                raise EnrollmentFinalizationError(
                    exc.code,
                    f"Pairwise comparison failed: {exc.message}",
                ) from exc
            similarities.append(sim)

    pair_count = len(similarities)
    min_sim = float(min(similarities))
    mean_sim = float(sum(similarities) / float(pair_count))

    # ---- 5. Consistency decision ----------------------------------------
    # The minimum protects against a single outlier. Mean alone could not
    # catch a sharp regression masked by other, mutually consistent
    # samples.
    if min_sim < threshold:
        raise EnrollmentFinalizationError(
            INCONSISTENT_FACE_SAMPLES,
            (
                f"Enrollment batch is internally inconsistent: "
                f"min_self_similarity={min_sim:.6f} "
                f"is below the configured floor {threshold:.6f}."
            ),
        )

    # ---- 6. Centroid (arithmetic mean -> L2-normalised) -----------------
    centroid = _compute_centroid(validated)

    return EnrollmentFinalizationResult(
        centroid=centroid,
        embedding_dimension=int(dimension),
        sample_count=int(len(validated)),
        pair_count=int(pair_count),
        min_self_similarity=float(min_sim),
        mean_self_similarity=float(mean_sim),
    )


# --- Internals ------------------------------------------------------------


def _validate_single_embedding(
    embedding: FaceEmbedding,
    index: int,
    expected_dim: int | None,
) -> np.ndarray:
    """Return a validated, *unmodified* float32 array for one embedding.

    The function never normalises a malformed vector — it rejects.
    """
    if not isinstance(embedding, FaceEmbedding):
        raise EnrollmentFinalizationError(
            INVALID_EMBEDDING,
            (
                f"Embedding #{index} must be a FaceEmbedding; "
                f"got {type(embedding).__name__}."
            ),
        )

    arr = np.asarray(embedding.vector, dtype=_DTYPE)
    if arr.ndim != 1:
        raise EnrollmentFinalizationError(
            INVALID_EMBEDDING,
            f"Embedding #{index} is not one-dimensional.",
        )
    if arr.shape[0] == 0:
        raise EnrollmentFinalizationError(
            INVALID_EMBEDDING, f"Embedding #{index} is empty."
        )
    if not int(arr.shape[0]) == int(embedding.dimension):
        raise EnrollmentFinalizationError(
            INVALID_EMBEDDING,
            (
                f"Embedding #{index} declared dimension "
                f"{embedding.dimension} but vector length is "
                f"{int(arr.shape[0])}."
            ),
        )

    if expected_dim is not None and int(arr.shape[0]) != int(expected_dim):
        raise EnrollmentFinalizationError(
            EMBEDDING_DIMENSION_MISMATCH,
            (
                f"Embedding #{index} has dimension {int(arr.shape[0])}; "
                f"expected {int(expected_dim)}."
            ),
        )

    if not bool(np.isfinite(arr).all()):
        raise EnrollmentFinalizationError(
            INVALID_EMBEDDING,
            f"Embedding #{index} contains non-finite values.",
        )

    norm = float(np.linalg.norm(arr))
    if not math.isfinite(norm) or norm <= 0.0:
        raise EnrollmentFinalizationError(
            INVALID_EMBEDDING,
            f"Embedding #{index} has non-positive or non-finite norm.",
        )
    if abs(norm - 1.0) > _NORMAL_TOLERANCE:
        raise EnrollmentFinalizationError(
            EMBEDDING_NOT_NORMALIZED,
            (
                f"Embedding #{index} is not L2-normalised "
                f"(|v|={norm:.6f}, tolerance={_NORMAL_TOLERANCE})."
            ),
        )

    return arr


def _compute_centroid(arrays: Sequence[np.ndarray]) -> np.ndarray:
    """Arithmetic mean across the batch, then L2-normalised.

    The mean-norm check guards against a pathological case where every
    input embedding cancels another (degenerate mean). For real,
    consistent enrollment samples this never fires.
    """
    if not arrays:
        raise EnrollmentFinalizationError(
            INVALID_CENTROID, "Cannot form a centroid from zero embeddings."
        )
    stacked = np.stack(arrays, axis=0).astype(_DTYPE, copy=False)
    if not bool(np.isfinite(stacked).all()):
        raise EnrollmentFinalizationError(
            INVALID_CENTROID,
            "Arithmetic mean of the batch contains non-finite values.",
        )
    mean_vec = stacked.mean(axis=0)
    if not bool(np.isfinite(mean_vec).all()):
        raise EnrollmentFinalizationError(
            INVALID_CENTROID,
            "Arithmetic mean of the batch is not finite.",
        )
    mean_norm = float(np.linalg.norm(mean_vec))
    if not math.isfinite(mean_norm) or mean_norm <= 0.0:
        raise EnrollmentFinalizationError(
            INVALID_CENTROID,
            (
                "Arithmetic mean of the batch has zero or non-finite "
                "norm; cannot form a centroid."
            ),
        )
    centroid = mean_vec / mean_norm
    centroid = centroid.astype(_DTYPE, copy=False)
    if not bool(np.isfinite(centroid).all()):
        raise EnrollmentFinalizationError(
            INVALID_CENTROID,
            "Centroid contains non-finite values after normalisation.",
        )
    centroid_norm = float(np.linalg.norm(centroid))
    if not math.isclose(centroid_norm, 1.0, abs_tol=_NORMAL_TOLERANCE):
        raise EnrollmentFinalizationError(
            INVALID_CENTROID,
            (
                "Centroid is not L2-normalised "
                f"(|v|={centroid_norm:.6f})."
            ),
        )
    return centroid


__all__ = [
    "EnrollmentFinalizationError",
    "EnrollmentFinalizationResult",
    "finalize_enrollment_embeddings",
    "INVALID_SAMPLE_COUNT",
    "INVALID_EMBEDDING",
    "EMBEDDING_DIMENSION_MISMATCH",
    "EMBEDDING_NOT_NORMALIZED",
    "INCONSISTENT_FACE_SAMPLES",
    "INVALID_CENTROID",
]