"""Matcher tests — pure math, no engine required."""

from __future__ import annotations

import math

import pytest

from app.engine.matcher import (
    MatcherError,
    best_candidate_match,
    compare_embeddings,
    cosine_similarity,
    l2_normalize,
)
from app.engine.types import FaceEmbedding


def _emb(values: list[float]) -> FaceEmbedding:
    return FaceEmbedding(vector=tuple(values), dimension=len(values))


def test_l2_normalize_unit_norm() -> None:
    e = _emb([3.0, 4.0])
    unit = l2_normalize(e)
    assert math.isclose(math.sqrt(sum(v * v for v in unit.vector)), 1.0, rel_tol=1e-5)
    assert unit.dimension == 2


def test_l2_normalize_rejects_zero_norm() -> None:
    with pytest.raises(MatcherError) as exc:
        l2_normalize(_emb([0.0, 0.0, 0.0]))
    assert exc.value.code == "INVALID_EMBEDDING"


def test_l2_normalize_rejects_non_finite() -> None:
    with pytest.raises(MatcherError) as exc:
        l2_normalize(_emb([1.0, float("nan"), 2.0]))
    assert exc.value.code == "INVALID_EMBEDDING"


def test_cosine_similarity_identical_equals_one() -> None:
    v = [1.0, 2.0, 3.0]
    sim = cosine_similarity(_emb(v), _emb(v))
    assert math.isclose(sim, 1.0, rel_tol=1e-5)


def test_cosine_similarity_orthogonal_equals_zero() -> None:
    sim = cosine_similarity(_emb([1.0, 0.0, 0.0]), _emb([0.0, 1.0, 0.0]))
    assert math.isclose(sim, 0.0, abs_tol=1e-6)


def test_cosine_similarity_clamped_to_valid_range() -> None:
    # Use a vector that, after re-normalisation, produces a tiny FP overshoot.
    v = [1.0, 1e-10]
    a = _emb(v)
    b = _emb([v[0] * 1.0000001, v[1]])
    sim = cosine_similarity(a, b)
    assert -1.0 <= sim <= 1.0


def test_cosine_similarity_rejects_mismatched_dimensions() -> None:
    with pytest.raises(MatcherError) as exc:
        cosine_similarity(_emb([1.0, 2.0]), _emb([1.0, 2.0, 3.0]))
    assert exc.value.code == "INVALID_EMBEDDING"


def test_compare_embeddings_match_above_threshold() -> None:
    a = l2_normalize(_emb([1.0, 1.0, 1.0]))
    b = l2_normalize(_emb([1.0, 1.0, 1.0]))
    cmp = compare_embeddings(a, b, threshold=0.5)
    assert cmp.match is True
    assert cmp.similarity > 0.5


def test_compare_embeddings_no_match_below_threshold() -> None:
    a = l2_normalize(_emb([1.0, 0.0, 0.0]))
    b = l2_normalize(_emb([0.0, 1.0, 0.0]))
    cmp = compare_embeddings(a, b, threshold=0.5)
    assert cmp.match is False
    assert cmp.similarity < 0.5


def test_best_candidate_match_returns_top_index() -> None:
    query = l2_normalize(_emb([1.0, 1.0]))
    cands = [
        l2_normalize(_emb([0.0, 1.0])),
        l2_normalize(_emb([1.0, 1.0])),
        l2_normalize(_emb([1.0, 0.0])),
    ]
    idx, sim = best_candidate_match(query, cands, threshold=0.5)
    assert idx == 1
    assert sim > 0.5


def test_best_candidate_match_returns_negative_when_below_threshold() -> None:
    query = l2_normalize(_emb([1.0, 1.0]))
    cands = [
        l2_normalize(_emb([0.0, 1.0])),
        l2_normalize(_emb([1.0, 0.0])),
    ]
    idx, sim = best_candidate_match(query, cands, threshold=0.99)
    assert idx == -1
    assert sim < 0.99


def test_best_candidate_match_uses_configured_threshold_by_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FACE_MATCH_THRESHOLD", "0.9")
    from app.core.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    query = l2_normalize(_emb([1.0, 1.0]))
    cands = [l2_normalize(_emb([1.0, 1.0]))]
    idx, sim = best_candidate_match(query, cands)
    assert idx == 0
    assert sim >= 0.9
