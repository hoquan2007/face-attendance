"""Cosine similarity and matcher primitives.

The matcher is intentionally decoupled from InsightFace and from HTTP. It
operates on normalised ``FaceEmbedding`` objects and returns plain Python
floats. Thresholding lives here so that future calibration can change a single
configuration value without touching route handlers.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Sequence

import numpy as np

from app.core.config import get_settings
from app.engine.types import FaceEmbedding


class MatcherError(ValueError):
    """Raised when an embedding is rejected by the matcher.

    ``code`` is a stable machine-readable identifier.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _to_unit_vector(embedding: FaceEmbedding) -> np.ndarray:
    if not isinstance(embedding, FaceEmbedding):
        raise MatcherError(
            "INVALID_EMBEDDING",
            f"Expected FaceEmbedding, got {type(embedding).__name__}.",
        )
    if not embedding.vector:
        raise MatcherError("INVALID_EMBEDDING", "Embedding vector is empty.")

    arr = np.asarray(embedding.vector, dtype=np.float32)
    if arr.ndim != 1:
        raise MatcherError(
            "INVALID_EMBEDDING", "Embedding vector must be one-dimensional."
        )
    if arr.shape[0] != embedding.dimension:
        raise MatcherError(
            "INVALID_EMBEDDING",
            (
                f"Embedding declared dimension {embedding.dimension} "
                f"but vector length is {arr.shape[0]}."
            ),
        )
    if not np.isfinite(arr).all():
        raise MatcherError(
            "INVALID_EMBEDDING", "Embedding contains non-finite values."
        )

    norm = float(np.linalg.norm(arr))
    if norm <= 0.0 or not math.isfinite(norm):
        raise MatcherError(
            "INVALID_EMBEDDING",
            "Embedding has zero norm and cannot be normalised.",
        )

    return arr / norm


def l2_normalize(embedding: FaceEmbedding) -> FaceEmbedding:
    """Return a unit-norm copy of ``embedding``."""

    unit = _to_unit_vector(embedding)
    return FaceEmbedding(vector=tuple(float(x) for x in unit), dimension=unit.shape[0])


def cosine_similarity(a: FaceEmbedding, b: FaceEmbedding) -> float:
    """Return the cosine similarity of two unit-norm embeddings.

    For properly normalised embeddings this collapses to a simple dot product,
    but we keep the explicit L2 step so callers may pass raw embeddings.
    """

    va = _to_unit_vector(a)
    vb = _to_unit_vector(b)
    if va.shape[0] != vb.shape[0]:
        raise MatcherError(
            "INVALID_EMBEDDING",
            f"Embedding dimension mismatch: {va.shape[0]} vs {vb.shape[0]}.",
        )
    sim = float(np.dot(va, vb))
    # Clamp to the mathematically valid range to absorb floating-point noise.
    return max(-1.0, min(1.0, sim))


def assert_compatible_dimensions(*embeddings: FaceEmbedding) -> int:
    """All embeddings must share the same dimension. Returns the dimension."""

    if not embeddings:
        raise MatcherError("INVALID_EMBEDDING", "No embeddings provided.")
    dim = embeddings[0].dimension
    for idx, e in enumerate(embeddings[1:], start=1):
        if e.dimension != dim:
            raise MatcherError(
                "INVALID_EMBEDDING",
                f"Embedding {idx} has dimension {e.dimension}, expected {dim}.",
            )
    return dim


@dataclass(frozen=True)
class ComparisonResult:
    """Outcome of comparing two face images."""

    similarity: float
    threshold: float
    match: bool


def compare_embeddings(
    a: FaceEmbedding,
    b: FaceEmbedding,
    threshold: float | None = None,
) -> ComparisonResult:
    """Compute cosine similarity + threshold decision for two embeddings.

    The threshold defaults to the value configured by ``FACE_MATCH_THRESHOLD``.
    This is a development baseline — see ``docs/model-license.md``.
    """

    if threshold is None:
        threshold = float(get_settings().face_match_threshold)
    sim = cosine_similarity(a, b)
    return ComparisonResult(
        similarity=sim,
        threshold=float(threshold),
        match=bool(sim >= threshold),
    )


def best_candidate_match(
    query: FaceEmbedding,
    candidates: Sequence[FaceEmbedding],
    threshold: float | None = None,
) -> tuple[int, float]:
    """Return (index, similarity) of the best candidate above the threshold.

    Returns (-1, sim) when no candidate clears the threshold, where ``sim`` is
    the best similarity observed (still useful for diagnostics).
    """

    if not candidates:
        raise MatcherError("INVALID_EMBEDDING", "Candidate list is empty.")
    q = _to_unit_vector(query)
    best_idx = -1
    best_sim = -1.0
    for idx, cand in enumerate(candidates):
        try:
            c = _to_unit_vector(cand)
        except MatcherError:
            # Silently skip invalid candidates rather than failing the whole
            # recognition request. The caller may inspect similarity directly.
            continue
        sim = float(np.dot(q, c))
        sim = max(-1.0, min(1.0, sim))
        if sim > best_sim:
            best_sim = sim
            best_idx = idx
    if threshold is None:
        threshold = float(get_settings().face_match_threshold)
    if best_sim < float(threshold):
        return -1, best_sim
    return best_idx, best_sim


__all__ = [
    "MatcherError",
    "l2_normalize",
    "cosine_similarity",
    "assert_compatible_dimensions",
    "compare_embeddings",
    "best_candidate_match",
    "ComparisonResult",
]
