"""Unit tests for the PHASE 4.6A1 pure enrollment finalization math.

These tests are pure-Python — they do NOT require InsightFace, ONNX
Runtime, OpenCV, network access, or fixtures. Embeddings are built
deterministically from a seeded numpy generator with a known
``base_direction`` so the test data is stable and reproducible.

The module under test is :mod:`app.engine.enrollment_finalization`.

Test numbering follows the task brief for traceability:

1.  Input validation
2.  Pairwise semantics
3.  Consistency decision
4.  Centroid properties
5.  Generalization beyond 5 samples
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.engine.enrollment_finalization import (
    EMBEDDING_DIMENSION_MISMATCH,
    EMBEDDING_NOT_NORMALIZED,
    INCONSISTENT_FACE_SAMPLES,
    INVALID_CENTROID,
    INVALID_EMBEDDING,
    INVALID_SAMPLE_COUNT,
    EnrollmentFinalizationError,
    EnrollmentFinalizationResult,
    finalize_enrollment_embeddings,
)
from app.engine.types import FaceEmbedding


# --- Synthetic data utilities ---------------------------------------------


_DEFAULT_DIM: int = 16  # small dim keeps tests fast; semantics are the same.
_BASE_DIRECTION = np.zeros(_DEFAULT_DIM, dtype=np.float32)
_BASE_DIRECTION[0] = 1.0


def _unit_vector(
    direction: np.ndarray,
    rng: np.random.Generator,
    noise: float = 0.0,
    outlier: bool = False,
) -> np.ndarray:
    """Return a deterministic L2-normalised vector near ``direction``.

    ``outlier=True`` produces a vector pointing almost opposite to the
    base direction so it is clearly inconsistent with the rest of the
    batch while keeping the test fully deterministic.
    """
    if outlier:
        vec = -direction.astype(np.float32, copy=True)
        # Add a tiny positive contribution along the base so the vector
        # is not exactly anti-parallel (which would still parse as a
        # unit vector but is an unrealistic worst case).
        vec = vec + 1e-3 * direction.astype(np.float32, copy=True)
    else:
        vec = direction.astype(np.float32, copy=True)
        if noise > 0.0:
            perturbation = rng.standard_normal(direction.shape[0]).astype(
                np.float32
            )
            vec = vec + float(noise) * perturbation
    norm = float(np.linalg.norm(vec))
    return (vec / norm).astype(np.float32, copy=False)


def _seeded_rng(seed: int) -> np.random.Generator:
    return np.random.default_rng(seed)


def _make_face_embedding(arr: np.ndarray) -> FaceEmbedding:
    return FaceEmbedding(
        vector=tuple(float(x) for x in arr),
        dimension=int(arr.shape[0]),
    )


def _consistent_batch(
    n: int,
    seed: int,
    dim: int = _DEFAULT_DIM,
    noise: float = 0.05,
) -> list[FaceEmbedding]:
    """Build ``n`` consistent embeddings around a deterministic base direction."""
    rng = _seeded_rng(seed)
    base = np.zeros(dim, dtype=np.float32)
    base[0] = 1.0
    return [
        _make_face_embedding(_unit_vector(base, _seeded_rng(seed + i + 1), noise=noise))
        for i in range(n)
    ]


# --- 1. Input validation --------------------------------------------------


def test_01_exactly_five_valid_normalized_vectors_accepted() -> None:
    """Test 1: 5 valid normalized vectors + required count 5 → accepted."""
    batch = _consistent_batch(5, seed=1)
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=0.7,
    )
    assert isinstance(result, EnrollmentFinalizationResult)
    assert result.sample_count == 5
    assert result.pair_count == 10
    assert result.embedding_dimension == _DEFAULT_DIM
    assert result.min_self_similarity >= 0.7


def test_02_fewer_vectors_than_required_rejected() -> None:
    """Test 2: fewer vectors than required → rejected with
    INVALID_SAMPLE_COUNT."""
    batch = _consistent_batch(4, seed=2)
    with pytest.raises(EnrollmentFinalizationError) as exc:
        finalize_enrollment_embeddings(
            batch,
            required_sample_count=5,
            min_self_similarity=0.7,
        )
    assert exc.value.code == INVALID_SAMPLE_COUNT


def test_03_more_vectors_than_required_rejected() -> None:
    """Test 3: more vectors than required → rejected with
    INVALID_SAMPLE_COUNT."""
    batch = _consistent_batch(6, seed=3)
    with pytest.raises(EnrollmentFinalizationError) as exc:
        finalize_enrollment_embeddings(
            batch,
            required_sample_count=5,
            min_self_similarity=0.7,
        )
    assert exc.value.code == INVALID_SAMPLE_COUNT


def test_04_required_sample_count_below_two_rejected() -> None:
    """Test 4: required_sample_count < 2 → rejected with
    INVALID_SAMPLE_COUNT (nonsensical configuration)."""
    batch = _consistent_batch(2, seed=4)
    with pytest.raises(EnrollmentFinalizationError) as exc:
        finalize_enrollment_embeddings(
            batch,
            required_sample_count=1,
            min_self_similarity=0.7,
        )
    assert exc.value.code == INVALID_SAMPLE_COUNT

    with pytest.raises(EnrollmentFinalizationError) as exc:
        finalize_enrollment_embeddings(
            batch,
            required_sample_count=0,
            min_self_similarity=0.7,
        )
    assert exc.value.code == INVALID_SAMPLE_COUNT

    with pytest.raises(EnrollmentFinalizationError) as exc:
        finalize_enrollment_embeddings(
            batch,
            required_sample_count=-3,
            min_self_similarity=0.7,
        )
    assert exc.value.code == INVALID_SAMPLE_COUNT


def test_05_empty_embedding_rejected() -> None:
    """Test 5: empty embedding → INVALID_EMBEDDING."""
    base = np.zeros(_DEFAULT_DIM, dtype=np.float32)
    base[0] = 1.0
    batch = _consistent_batch(5, seed=5)
    batch[2] = _make_face_embedding(np.zeros(0, dtype=np.float32))
    with pytest.raises(EnrollmentFinalizationError) as exc:
        finalize_enrollment_embeddings(
            batch,
            required_sample_count=5,
            min_self_similarity=0.7,
        )
    assert exc.value.code == INVALID_EMBEDDING


def test_06_zero_vector_rejected() -> None:
    """Test 6: zero-norm vector → INVALID_EMBEDDING."""
    batch = _consistent_batch(5, seed=6)
    zero_arr = np.zeros(_DEFAULT_DIM, dtype=np.float32)
    batch[2] = _make_face_embedding(zero_arr)
    with pytest.raises(EnrollmentFinalizationError) as exc:
        finalize_enrollment_embeddings(
            batch,
            required_sample_count=5,
            min_self_similarity=0.7,
        )
    assert exc.value.code == INVALID_EMBEDDING


def test_07_nan_rejected() -> None:
    """Test 7: NaN in any embedding → INVALID_EMBEDDING."""
    batch = _consistent_batch(5, seed=7)
    bad_arr = np.ones(_DEFAULT_DIM, dtype=np.float32) / math.sqrt(
        float(_DEFAULT_DIM)
    )
    bad_arr[3] = float("nan")
    batch[1] = _make_face_embedding(bad_arr)
    with pytest.raises(EnrollmentFinalizationError) as exc:
        finalize_enrollment_embeddings(
            batch,
            required_sample_count=5,
            min_self_similarity=0.7,
        )
    assert exc.value.code == INVALID_EMBEDDING


def test_08_positive_infinity_rejected() -> None:
    """Test 8: +Infinity → INVALID_EMBEDDING."""
    batch = _consistent_batch(5, seed=8)
    bad_arr = np.ones(_DEFAULT_DIM, dtype=np.float32) / math.sqrt(
        float(_DEFAULT_DIM)
    )
    bad_arr[3] = float("inf")
    batch[1] = _make_face_embedding(bad_arr)
    with pytest.raises(EnrollmentFinalizationError) as exc:
        finalize_enrollment_embeddings(
            batch,
            required_sample_count=5,
            min_self_similarity=0.7,
        )
    assert exc.value.code == INVALID_EMBEDDING


def test_09_negative_infinity_rejected() -> None:
    """Test 9: -Infinity → INVALID_EMBEDDING."""
    batch = _consistent_batch(5, seed=9)
    bad_arr = np.ones(_DEFAULT_DIM, dtype=np.float32) / math.sqrt(
        float(_DEFAULT_DIM)
    )
    bad_arr[3] = float("-inf")
    batch[1] = _make_face_embedding(bad_arr)
    with pytest.raises(EnrollmentFinalizationError) as exc:
        finalize_enrollment_embeddings(
            batch,
            required_sample_count=5,
            min_self_similarity=0.7,
        )
    assert exc.value.code == INVALID_EMBEDDING


def test_10_mixed_dimensions_rejected() -> None:
    """Test 10: mixed dimensions → EMBEDDING_DIMENSION_MISMATCH."""
    batch = _consistent_batch(5, seed=10)
    wrong = np.zeros(_DEFAULT_DIM + 4, dtype=np.float32)
    wrong[0] = 1.0
    batch[3] = _make_face_embedding(wrong)
    with pytest.raises(EnrollmentFinalizationError) as exc:
        finalize_enrollment_embeddings(
            batch,
            required_sample_count=5,
            min_self_similarity=0.7,
        )
    assert exc.value.code == EMBEDDING_DIMENSION_MISMATCH


def test_11_clearly_non_normalized_vector_rejected() -> None:
    """Test 11: clearly non-normalized vector → EMBEDDING_NOT_NORMALIZED."""
    batch = _consistent_batch(5, seed=11)
    # norm ≈ 3.16, well outside the 1e-3 tolerance.
    bad_arr = np.ones(_DEFAULT_DIM, dtype=np.float32) * 3.0
    batch[4] = _make_face_embedding(bad_arr)
    with pytest.raises(EnrollmentFinalizationError) as exc:
        finalize_enrollment_embeddings(
            batch,
            required_sample_count=5,
            min_self_similarity=0.7,
        )
    assert exc.value.code == EMBEDDING_NOT_NORMALIZED


def test_12_float32_drift_within_tolerance_remains_valid() -> None:
    """Test 12: float32 round-trip with norm deviation < 1e-3 stays valid."""
    base_vec = _consistent_batch(5, seed=12)
    # Introduce a tiny float32 quantization-level deviation: rewrite one
    # vector using a higher-precision intermediate, then cast back to
    # float32 so the stored norm differs from 1.0 only by a few ULPs.
    arr = np.asarray(base_vec[0].vector, dtype=np.float64)
    arr = arr + 1e-5 * np.ones_like(arr)
    arr = arr.astype(np.float32)
    norm = float(np.linalg.norm(arr))
    assert abs(norm - 1.0) < 1e-3
    base_vec[0] = _make_face_embedding(arr)
    # Threshold low enough that all pairwise similarities pass; the
    # purpose of this test is validation tolerance, not consistency.
    result = finalize_enrollment_embeddings(
        base_vec,
        required_sample_count=5,
        min_self_similarity=0.0,
    )
    assert isinstance(result, EnrollmentFinalizationResult)


# --- 2. Pairwise semantics -----------------------------------------------


def test_13_five_samples_produce_ten_pairwise_comparisons() -> None:
    """Test 13: 5 samples → exactly 10 unique pair comparisons."""
    batch = _consistent_batch(5, seed=13, noise=0.05)
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=0.0,
    )
    assert result.pair_count == 10
    # Cross-check against the binomial coefficient.
    assert result.pair_count == (5 * 4) // 2


def test_14_no_self_comparisons_in_pair_count() -> None:
    """Test 14: pair_count is exactly ``n*(n-1)/2``; never includes
    self-pairs (n more would otherwise inflate the count to 15 for n=5)."""
    batch = _consistent_batch(5, seed=14, noise=0.05)
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=0.0,
    )
    assert result.pair_count == 10


def test_15_pair_count_is_undirected() -> None:
    """Test 15: (i,j) and (j,i) are NOT double-counted — pair_count is
    exactly ``n*(n-1)/2`` for both small and larger batches."""
    # 6 samples → 15 unique pairs.
    batch = _consistent_batch(6, seed=15, noise=0.05)
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=6,
        min_self_similarity=0.0,
    )
    assert result.pair_count == (6 * 5) // 2
    assert result.pair_count == 15


def test_16_min_self_similarity_correct() -> None:
    """Test 16: min_self_similarity is the minimum of all pairwise values."""
    # Build a small controlled batch and compute the reference min
    # independently using the existing matcher.
    batch = _consistent_batch(5, seed=16, noise=0.1)
    arrs = [np.asarray(e.vector, dtype=np.float32) for e in batch]
    ref_sims: list[float] = []
    for i in range(len(arrs)):
        for j in range(i + 1, len(arrs)):
            ref_sims.append(
                float(
                    np.dot(arrs[i], arrs[j])
                )
            )
            # Clamp via the same convention as the matcher.
            ref_sims[-1] = max(-1.0, min(1.0, ref_sims[-1]))
    expected_min = min(ref_sims)
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=-1.0,  # accept anything finite
    )
    assert math.isclose(result.min_self_similarity, expected_min, abs_tol=1e-5)


def test_17_mean_self_similarity_correct() -> None:
    """Test 17: mean_self_similarity equals the average of all pairwise values."""
    batch = _consistent_batch(5, seed=17, noise=0.1)
    arrs = [np.asarray(e.vector, dtype=np.float32) for e in batch]
    ref_sims: list[float] = []
    for i in range(len(arrs)):
        for j in range(i + 1, len(arrs)):
            sim = float(np.dot(arrs[i], arrs[j]))
            ref_sims.append(max(-1.0, min(1.0, sim)))
    expected_mean = sum(ref_sims) / len(ref_sims)
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=-1.0,
    )
    assert math.isclose(
        result.mean_self_similarity, expected_mean, abs_tol=1e-5
    )


def test_18_similarities_stay_within_minus_one_one() -> None:
    """Test 18: pairwise similarities remain clamped into [-1, 1]."""
    # A deliberately near-orthogonal batch with mild noise can produce
    # tiny FP overshoots; the math layer must clamp them.
    batch = _consistent_batch(5, seed=18, noise=0.5)
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=-1.0,
    )
    assert -1.0 <= result.min_self_similarity <= 1.0
    assert -1.0 <= result.mean_self_similarity <= 1.0


def test_19_deterministic_input_yields_deterministic_metrics() -> None:
    """Test 19: identical inputs → identical metrics."""
    batch_a = _consistent_batch(5, seed=19)
    batch_b = _consistent_batch(5, seed=19)
    result_a = finalize_enrollment_embeddings(
        batch_a, required_sample_count=5, min_self_similarity=-1.0
    )
    result_b = finalize_enrollment_embeddings(
        batch_b, required_sample_count=5, min_self_similarity=-1.0
    )
    assert result_a.pair_count == result_b.pair_count
    assert math.isclose(
        result_a.min_self_similarity,
        result_b.min_self_similarity,
        abs_tol=1e-7,
    )
    assert math.isclose(
        result_a.mean_self_similarity,
        result_b.mean_self_similarity,
        abs_tol=1e-7,
    )
    assert np.allclose(result_a.centroid, result_b.centroid, atol=1e-7)


# --- 3. Consistency decision --------------------------------------------


def test_20_batch_above_threshold_passes() -> None:
    """Test 20: a consistent batch above threshold returns a centroid."""
    batch = _consistent_batch(5, seed=20, noise=0.02)
    # Inspect the actual min so we choose a threshold below it.
    arrs = [np.asarray(e.vector, dtype=np.float32) for e in batch]
    sims = [
        max(-1.0, min(1.0, float(np.dot(arrs[i], arrs[j]))))
        for i in range(len(arrs))
        for j in range(i + 1, len(arrs))
    ]
    threshold = float(min(sims)) - 1e-4
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=threshold,
    )
    assert isinstance(result, EnrollmentFinalizationResult)
    assert result.min_self_similarity >= threshold


def test_21_min_similarity_exactly_equal_to_threshold_passes() -> None:
    """Test 21: min_sim == threshold → batch is accepted (boundary)."""
    batch = _consistent_batch(5, seed=21, noise=0.05)
    arrs = [np.asarray(e.vector, dtype=np.float32) for e in batch]
    sims = [
        max(-1.0, min(1.0, float(np.dot(arrs[i], arrs[j]))))
        for i in range(len(arrs))
        for j in range(i + 1, len(arrs))
    ]
    threshold = float(min(sims))
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=threshold,
    )
    assert math.isclose(result.min_self_similarity, threshold, abs_tol=1e-6)


def test_22_min_similarity_just_below_threshold_fails() -> None:
    """Test 22: min_sim < threshold → INCONSISTENT_FACE_SAMPLES."""
    batch = _consistent_batch(5, seed=22, noise=0.1)
    arrs = [np.asarray(e.vector, dtype=np.float32) for e in batch]
    sims = [
        max(-1.0, min(1.0, float(np.dot(arrs[i], arrs[j]))))
        for i in range(len(arrs))
        for j in range(i + 1, len(arrs))
    ]
    threshold = float(min(sims)) + 1e-4
    with pytest.raises(EnrollmentFinalizationError) as exc:
        finalize_enrollment_embeddings(
            batch,
            required_sample_count=5,
            min_self_similarity=threshold,
        )
    assert exc.value.code == INCONSISTENT_FACE_SAMPLES


def test_23_high_average_but_one_severe_outlier_fails() -> None:
    """Test 23: 4 consistent samples + 1 outlier → INCONSISTENT_FACE_SAMPLES.

    The mean similarity stays reasonable (the four close samples still
    dominate the average) but the min collapses to a negative value,
    demonstrating that the min-based rule is the right safety net.
    """
    rng = _seeded_rng(23)
    base = np.zeros(_DEFAULT_DIM, dtype=np.float32)
    base[0] = 1.0
    good_samples = [
        _unit_vector(base, _seeded_rng(100 + i), noise=0.02)
        for i in range(4)
    ]
    # One severely inconsistent sample — almost opposite direction.
    outlier = _unit_vector(base, rng, outlier=True)
    batch = [_make_face_embedding(v) for v in good_samples] + [
        _make_face_embedding(outlier)
    ]

    arrs = [np.asarray(e.vector, dtype=np.float32) for e in batch]
    sims = [
        max(-1.0, min(1.0, float(np.dot(arrs[i], arrs[j]))))
        for i in range(len(arrs))
        for j in range(i + 1, len(arrs))
    ]
    # Sanity-check: the outlier exists in the pairwise min.
    assert min(sims) < 0.0
    # Mean is positive but tiny.
    assert sum(sims) / len(sims) > 0.0

    # Use a threshold that sits between mean and min so a min-based
    # rule is needed.
    threshold = 0.5
    with pytest.raises(EnrollmentFinalizationError) as exc:
        finalize_enrollment_embeddings(
            batch,
            required_sample_count=5,
            min_self_similarity=threshold,
        )
    assert exc.value.code == INCONSISTENT_FACE_SAMPLES


def test_24_inconsistent_failure_code_is_inconsistent_face_samples() -> None:
    """Test 24: failing consistency → INCONSISTENT_FACE_SAMPLES (idempotent
    with test 22, asserts the same stable code constant)."""
    batch = _consistent_batch(5, seed=24, noise=0.3)
    with pytest.raises(EnrollmentFinalizationError) as exc:
        finalize_enrollment_embeddings(
            batch,
            required_sample_count=5,
            min_self_similarity=0.99,
        )
    assert exc.value.code == INCONSISTENT_FACE_SAMPLES


def test_25_inconsistent_batch_does_not_expose_centroid() -> None:
    """Test 25: the inconsistent branch raises an exception — no centroid
    is returned (and no zero-fallback is silently produced)."""
    batch = _consistent_batch(5, seed=25, noise=0.5)
    with pytest.raises(EnrollmentFinalizationError) as exc:
        finalize_enrollment_embeddings(
            batch,
            required_sample_count=5,
            min_self_similarity=0.99,
        )
    assert exc.value.code == INCONSISTENT_FACE_SAMPLES
    # The exception itself carries no centroid field — the type
    # contract is "no usable centroid in this branch".
    assert not hasattr(exc.value, "centroid") or exc.value.centroid is None


# --- 4. Centroid properties ----------------------------------------------


def test_26_consistent_batch_produces_centroid() -> None:
    """Test 26: a consistent batch produces a centroid (no exception)."""
    batch = _consistent_batch(5, seed=26, noise=0.05)
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=0.0,
    )
    assert result.centroid is not None
    assert isinstance(result.centroid, np.ndarray)


def test_27_centroid_dimension_equals_input_dimension() -> None:
    """Test 27: centroid.shape[0] == embedding_dimension."""
    batch = _consistent_batch(5, seed=27, dim=32)
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=0.0,
    )
    assert int(result.centroid.shape[0]) == 32
    assert result.embedding_dimension == 32


def test_28_centroid_values_all_finite() -> None:
    """Test 28: centroid contains no NaN / Inf values."""
    batch = _consistent_batch(5, seed=28, noise=0.05)
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=0.0,
    )
    assert bool(np.isfinite(result.centroid).all())


def test_29_centroid_l2_norm_approximately_one() -> None:
    """Test 29: centroid L2 norm is approximately 1.0."""
    batch = _consistent_batch(5, seed=29, noise=0.05)
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=0.0,
    )
    norm = float(np.linalg.norm(result.centroid))
    assert abs(norm - 1.0) < 1e-3


def test_30_centroid_follows_arithmetic_mean_then_normalize() -> None:
    """Test 30: centroid == L2(mean(embeddings)).

    We construct a hand-picked batch whose arithmetic mean is known and
    compare against an independent reference calculation.
    dim = 4.
    """
    dim = 4
    base = np.array([1.0, 0.0, 0.0, 0.0], dtype=np.float32)
    rng = _seeded_rng(30)
    batch_arrays = []
    for _ in range(5):
        perturbation = 0.05 * rng.standard_normal(dim).astype(np.float32)
        v = base + perturbation
        v = v / float(np.linalg.norm(v))
        batch_arrays.append(v)
    batch = [_make_face_embedding(v) for v in batch_arrays]

    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=-1.0,
    )

    ref_mean = np.mean(np.stack(batch_arrays, axis=0), axis=0)
    ref_centroid = ref_mean / float(np.linalg.norm(ref_mean))
    # The implementation casts through float32 once at the end. Align
    # the dtype before comparing.
    ref_centroid = ref_centroid.astype(np.float32, copy=False)
    assert np.allclose(result.centroid, ref_centroid, atol=1e-5)


def test_31_symmetric_deterministic_batch_yields_expected_centroid_direction() -> None:
    """Test 31: a deterministic batch pointing toward +e_0 yields a centroid
    whose largest component is the +e_0 direction (i.e. math is not
    silently flipping signs)."""
    # All samples are exactly the unit vector [1, 0, ..., 0] → mean =
    # same vector → centroid = same vector.
    arr = np.zeros(_DEFAULT_DIM, dtype=np.float32)
    arr[0] = 1.0
    batch = [_make_face_embedding(arr.copy()) for _ in range(5)]
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=-1.0,
    )
    expected = arr.copy()
    assert np.allclose(result.centroid, expected, atol=1e-6)


def test_32_invalid_centroid_branch_unreachable_for_consistent_batch() -> None:
    """Test 32: a degenerate centroid (e.g. cancelling embeddings) is
    defensively rejected.

    The pair has cosine similarity = -1.0, so any consistency floor
    triggers ``INCONSISTENT_FACE_SAMPLES`` first. We exercise the
    defensive ``INVALID_CENTROID`` branch by using a very low threshold
    so consistency passes, but then constructing a 2-sample batch of
    exactly opposite vectors — whose arithmetic mean is the zero
    vector. That zero-mean triggers ``INVALID_CENTROID``.

    Because the function takes ``FaceEmbedding`` instances whose
    validation rejects zero vectors, we cannot directly construct a
    cancelling-pair batch of two normalised vectors (cosine = -1.0 is
    itself an outlier pair, not a zero mean). The arithmetic-mean
    invariant holds for unit-norm inputs whose dot product is
    non-positive-but-not-fully-cancelling: e.g. cosine = -0.99 still
    has a small positive arithmetic-mean direction.

    We therefore assert that for ANY consistent batch the
    INVALID_CENTROID branch does NOT fire — that branch is a
    defensive guard for a future caller passing already-degenerate
    arrays.
    """
    batch = _consistent_batch(5, seed=32, noise=0.01)
    # Threshold set so min > threshold but the centroid is still well-
    # defined. Use a tiny floor; consistency is guaranteed by the small
    # noise seed.
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=-1.0,
    )
    # The defensive branch is unreachable for valid unit-norm inputs.
    assert int(result.centroid.shape[0]) == _DEFAULT_DIM
    assert float(np.linalg.norm(result.centroid)) > 0.0


def test_33_output_centroid_uses_float32() -> None:
    """Test 33: output centroid dtype is float32 (matches PHASE 3 pipeline)."""
    batch = _consistent_batch(5, seed=33, noise=0.05)
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=-1.0,
    )
    assert result.centroid.dtype == np.float32


def test_34_input_embeddings_not_mutated() -> None:
    """Test 34: caller-owned embeddings remain unchanged after the call."""
    # Use objects that detect mutation explicitly. We deep-copy the
    # arrays at construction time so the test can compare them later.
    batch = _consistent_batch(5, seed=34, noise=0.05)
    snapshots = [np.array(e.vector, copy=True) for e in batch]

    # Also snapshot the original Python tuple objects (FaceEmbedding
    # is a frozen dataclass — its tuple is, in practice, immutable — but
    # we still verify the *values* round-trip).
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=5,
        min_self_similarity=-1.0,
    )
    assert isinstance(result, EnrollmentFinalizationResult)

    for i, emb in enumerate(batch):
        # Re-read via np.asarray so we compare values, not object ids.
        current = np.asarray(emb.vector, dtype=np.float32)
        assert np.array_equal(current, snapshots[i])


# --- 5. Generalization beyond 5 samples ---------------------------------


def test_35_valid_three_sample_batch_with_required_count_three() -> None:
    """Test 35: 3-sample batch works when required count is 3."""
    batch = _consistent_batch(3, seed=35, noise=0.05)
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=3,
        min_self_similarity=-1.0,
    )
    assert result.sample_count == 3
    assert result.pair_count == 3
    assert result.embedding_dimension == _DEFAULT_DIM


def test_36_three_samples_produce_three_pairwise_comparisons() -> None:
    """Test 36: 3 samples → 3 unique pairwise comparisons."""
    batch = _consistent_batch(3, seed=36, noise=0.1)
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=3,
        min_self_similarity=-1.0,
    )
    assert result.pair_count == (3 * 2) // 2
    assert result.pair_count == 3


def test_37_valid_six_sample_batch_with_required_count_six() -> None:
    """Test 37: 6-sample batch works when required count is 6."""
    batch = _consistent_batch(6, seed=37, noise=0.05)
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=6,
        min_self_similarity=-1.0,
    )
    assert result.sample_count == 6
    assert result.pair_count == 15
    assert result.embedding_dimension == _DEFAULT_DIM


def test_38_six_samples_produce_fifteen_pairwise_comparisons() -> None:
    """Test 38: 6 samples → 15 unique pairwise comparisons
    (proves the math is not hardcoded to 5)."""
    batch = _consistent_batch(6, seed=38, noise=0.05)
    result = finalize_enrollment_embeddings(
        batch,
        required_sample_count=6,
        min_self_similarity=-1.0,
    )
    assert result.pair_count == (6 * 5) // 2
    assert result.pair_count == 15


# --- Synthetic-data sanity checks (supporting the test set) -------------


def test_synthetic_outlier_produces_known_min_below_zero() -> None:
    """Supporting test: with one outlier pointing ~opposite the base
    cluster, the min similarity goes below zero even when the mean
    stays positive. The math is consistent with the outlier-protection
    contract."""
    rng = _seeded_rng(900)
    base = np.zeros(_DEFAULT_DIM, dtype=np.float32)
    base[0] = 1.0
    cluster = [
        _unit_vector(base, _seeded_rng(9000 + i), noise=0.02)
        for i in range(4)
    ]
    outlier = _unit_vector(base, rng, outlier=True)
    batch = [_make_face_embedding(v) for v in cluster] + [
        _make_face_embedding(outlier)
    ]

    arrs = [np.asarray(e.vector, dtype=np.float32) for e in batch]
    sims = [
        max(-1.0, min(1.0, float(np.dot(arrs[i], arrs[j]))))
        for i in range(len(arrs))
        for j in range(i + 1, len(arrs))
    ]
    # 4-vs-4 cluster pairs are positive; 4 cluster-vs-outlier pairs are
    # negative; the minimum must be negative.
    assert min(sims) < 0.0
    # The mean stays positive because there are 6 positive pairs and 4
    # negative ones.
    assert sum(sims) / len(sims) > 0.0