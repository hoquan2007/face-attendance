"""Unit tests for the PHASE 4.3 enrollment quality policy.

These tests are pure math on synthetic ``FaceQuality`` objects — they do
NOT require InsightFace / OpenCV / network access. The thresholds are
exercised at boundaries plus the typical "good" example reported in the
PHASE 3 real-model measurements.
"""

from __future__ import annotations

import pytest

from app.core.config import get_settings
from app.engine.enrollment_quality import (
    FACE_NEAR_EDGE,
    FACE_TOO_LARGE,
    FACE_TOO_SMALL,
    LOW_DETECTION_CONFIDENCE,
    TOO_BLURRY,
    TOO_BRIGHT,
    TOO_DARK,
    EnrollmentQualityThresholds,
    evaluate_enrollment_quality,
)
from app.engine.types import FaceQuality


def _quality(
    detection_score: float = 0.9,
    face_width: float = 120.0,
    face_height: float = 120.0,
    relative_face_area: float = 0.06,
    blur_score: float = 250.0,
    brightness: float = 0.5,
    near_edge: bool = False,
) -> FaceQuality:
    return FaceQuality(
        detection_score=detection_score,
        face_width=face_width,
        face_height=face_height,
        relative_face_area=relative_face_area,
        blur_score=blur_score,
        brightness=brightness,
        near_edge=near_edge,
    )


def _thresholds(**overrides: float) -> EnrollmentQualityThresholds:
    base = dict(
        min_detection_score=0.7,
        min_face_area=0.03,
        max_face_area=0.6,
        min_blur_score=80.0,
        min_brightness=0.18,
        max_brightness=0.85,
    )
    base.update(overrides)
    return EnrollmentQualityThresholds(**base)


# --- 1. good quality accepted ----------------------------------------------


def test_good_quality_accepted() -> None:
    q = _quality()
    result = evaluate_enrollment_quality(q, _thresholds())
    assert result.accepted is True
    assert result.rejection_reasons == ()


def test_phase3_real_measurement_accepted() -> None:
    """The PHASE 3 reported measurement (detection ≈ 0.873, area ≈ 0.0186,
    blur ≈ 480, brightness ≈ 0.426) is borderline: with the current
    DEVELOPMENT baseline the area is below the configured minimum
    ``FACE_ENROLLMENT_MIN_FACE_AREA`` of 0.03, so it would be rejected.

    The exact defaults documented in the spec allow calibration to be
    tighter — the test enforces the documented contract without
    pretending the chosen threshold is universal.
    """
    q = _quality(
        detection_score=0.873,
        face_width=80.0,
        face_height=120.0,
        relative_face_area=0.0186,
        blur_score=480.0,
        brightness=0.426,
    )
    result = evaluate_enrollment_quality(q, _thresholds())
    assert LOW_DETECTION_CONFIDENCE not in result.rejection_reasons
    assert TOO_BLURRY not in result.rejection_reasons
    assert TOO_DARK not in result.rejection_reasons
    assert TOO_BRIGHT not in result.rejection_reasons
    assert FACE_NEAR_EDGE not in result.rejection_reasons


# --- 2. low detection rejected ---------------------------------------------


def test_low_detection_rejected() -> None:
    q = _quality(detection_score=0.5)
    result = evaluate_enrollment_quality(q, _thresholds(min_detection_score=0.7))
    assert result.accepted is False
    assert LOW_DETECTION_CONFIDENCE in result.rejection_reasons


# --- 3. too-small face rejected -------------------------------------------


def test_face_too_small_rejected() -> None:
    q = _quality(relative_face_area=0.01)
    result = evaluate_enrollment_quality(q, _thresholds(min_face_area=0.03))
    assert result.accepted is False
    assert FACE_TOO_SMALL in result.rejection_reasons


# --- 4. too-large face rejected -------------------------------------------


def test_face_too_large_rejected() -> None:
    q = _quality(relative_face_area=0.9)
    result = evaluate_enrollment_quality(q, _thresholds(max_face_area=0.6))
    assert result.accepted is False
    assert FACE_TOO_LARGE in result.rejection_reasons


# --- 5. too blurry rejected -----------------------------------------------


def test_too_blurry_rejected() -> None:
    q = _quality(blur_score=20.0)
    result = evaluate_enrollment_quality(q, _thresholds(min_blur_score=80.0))
    assert result.accepted is False
    assert TOO_BLURRY in result.rejection_reasons


# --- 6. too dark rejected -------------------------------------------------


def test_too_dark_rejected() -> None:
    q = _quality(brightness=0.05)
    result = evaluate_enrollment_quality(q, _thresholds(min_brightness=0.18))
    assert result.accepted is False
    assert TOO_DARK in result.rejection_reasons


# --- 7. too bright rejected -----------------------------------------------


def test_too_bright_rejected() -> None:
    q = _quality(brightness=0.95)
    result = evaluate_enrollment_quality(q, _thresholds(max_brightness=0.85))
    assert result.accepted is False
    assert TOO_BRIGHT in result.rejection_reasons


# --- 8. near edge rejected ------------------------------------------------


def test_near_edge_rejected() -> None:
    q = _quality(near_edge=True)
    result = evaluate_enrollment_quality(q, _thresholds())
    assert result.accepted is False
    assert FACE_NEAR_EDGE in result.rejection_reasons


# --- 9. multiple reasons returned deterministically -------------------------


def test_multiple_reasons_are_deterministic_in_order() -> None:
    q = _quality(
        detection_score=0.3,
        relative_face_area=0.01,
        blur_score=5.0,
        brightness=0.05,
        near_edge=True,
    )
    result = evaluate_enrollment_quality(
        q,
        _thresholds(
            min_detection_score=0.7,
            min_face_area=0.03,
            max_face_area=0.6,
            min_blur_score=80.0,
            min_brightness=0.18,
            max_brightness=0.85,
        ),
    )
    assert result.accepted is False
    assert result.rejection_reasons == (
        LOW_DETECTION_CONFIDENCE,
        FACE_TOO_SMALL,
        TOO_BLURRY,
        TOO_DARK,
        FACE_NEAR_EDGE,
    )


# --- 10. boundary values behave consistently ------------------------------


def test_boundary_detection_score_at_threshold_accepted() -> None:
    q = _quality(detection_score=0.7)
    result = evaluate_enrollment_quality(q, _thresholds(min_detection_score=0.7))
    assert result.accepted is True
    assert result.rejection_reasons == ()


def test_boundary_detection_score_just_below_threshold_rejected() -> None:
    q = _quality(detection_score=0.6999)
    result = evaluate_enrollment_quality(q, _thresholds(min_detection_score=0.7))
    assert LOW_DETECTION_CONFIDENCE in result.rejection_reasons


def test_boundary_face_area_at_min_accepted() -> None:
    q = _quality(relative_face_area=0.03)
    result = evaluate_enrollment_quality(q, _thresholds(min_face_area=0.03))
    assert FACE_TOO_SMALL not in result.rejection_reasons
    assert result.accepted is True


def test_boundary_face_area_just_below_min_rejected() -> None:
    q = _quality(relative_face_area=0.0299)
    result = evaluate_enrollment_quality(q, _thresholds(min_face_area=0.03))
    assert FACE_TOO_SMALL in result.rejection_reasons


def test_boundary_face_area_at_max_accepted() -> None:
    q = _quality(relative_face_area=0.6)
    result = evaluate_enrollment_quality(q, _thresholds(max_face_area=0.6))
    assert FACE_TOO_LARGE not in result.rejection_reasons


def test_boundary_blur_at_threshold_accepted() -> None:
    q = _quality(blur_score=80.0)
    result = evaluate_enrollment_quality(q, _thresholds(min_blur_score=80.0))
    assert TOO_BLURRY not in result.rejection_reasons


def test_boundary_blur_just_below_threshold_rejected() -> None:
    q = _quality(blur_score=79.9)
    result = evaluate_enrollment_quality(q, _thresholds(min_blur_score=80.0))
    assert TOO_BLURRY in result.rejection_reasons


def test_boundary_brightness_at_min_accepted() -> None:
    q = _quality(brightness=0.18)
    result = evaluate_enrollment_quality(q, _thresholds(min_brightness=0.18))
    assert TOO_DARK not in result.rejection_reasons


def test_boundary_brightness_at_max_accepted() -> None:
    q = _quality(brightness=0.85)
    result = evaluate_enrollment_quality(q, _thresholds(max_brightness=0.85))
    assert TOO_BRIGHT not in result.rejection_reasons


def test_boundary_brightness_just_below_min_rejected() -> None:
    q = _quality(brightness=0.1799)
    result = evaluate_enrollment_quality(q, _thresholds(min_brightness=0.18))
    assert TOO_DARK in result.rejection_reasons


def test_boundary_brightness_just_above_max_rejected() -> None:
    q = _quality(brightness=0.8501)
    result = evaluate_enrollment_quality(q, _thresholds(max_brightness=0.85))
    assert TOO_BRIGHT in result.rejection_reasons


# --- from_settings() reflects the typed settings ---------------------------


def test_thresholds_from_settings_picks_up_typed_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FACE_ENROLLMENT_MIN_DETECTION_SCORE", "0.55")
    monkeypatch.setenv("FACE_ENROLLMENT_MIN_FACE_AREA", "0.04")
    monkeypatch.setenv("FACE_ENROLLMENT_MAX_FACE_AREA", "0.5")
    monkeypatch.setenv("FACE_ENROLLMENT_MIN_BLUR_SCORE", "120")
    monkeypatch.setenv("FACE_ENROLLMENT_MIN_BRIGHTNESS", "0.25")
    monkeypatch.setenv("FACE_ENROLLMENT_MAX_BRIGHTNESS", "0.7")
    get_settings.cache_clear()  # type: ignore[attr-defined]
    t = EnrollmentQualityThresholds.from_settings()
    assert t.min_detection_score == 0.55
    assert t.min_face_area == 0.04
    assert t.max_face_area == 0.5
    assert t.min_blur_score == 120.0
    assert t.min_brightness == 0.25
    assert t.max_brightness == 0.7
    get_settings.cache_clear()  # type: ignore[attr-defined]