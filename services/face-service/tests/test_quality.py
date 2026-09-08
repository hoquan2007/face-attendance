"""Quality heuristics tests — pure math on synthetic numpy images."""

from __future__ import annotations

import numpy as np

from app.engine.base import BoundingBox
from app.engine.quality import (
    compute_quality,
    crop_gray,
    mean_brightness,
    variance_of_laplacian,
)


def _solid_bgr(value: int = 128, w: int = 200, h: int = 200) -> np.ndarray:
    img = np.zeros((h, w, 3), dtype=np.uint8)
    img[:] = (value, value, value)
    return img


def test_variance_of_laplacian_high_for_sharp_image() -> None:
    import cv2  # type: ignore[import-not-found]

    sharp = cv2.cvtColor(
        cv2.imread(  # type: ignore[unused-ignore, unused-ignore]
            "__nonexistent__", 0
        )
        if False
        else np.random.randint(0, 255, (100, 100), dtype=np.uint8),
        cv2.COLOR_GRAY2BGR,
    )
    value = variance_of_laplacian(sharp)
    assert value > 0.0


def test_variance_of_laplacian_zero_for_constant_image() -> None:
    import cv2  # type: ignore[import-not-found]

    gray = np.full((50, 50), 128, dtype=np.uint8)
    value = variance_of_laplacian(gray)
    assert value == 0.0


def test_mean_brightness_normalised() -> None:
    gray = np.full((10, 10), 255, dtype=np.uint8)
    assert mean_brightness(gray) == 1.0
    gray_zero = np.zeros((10, 10), dtype=np.uint8)
    assert mean_brightness(gray_zero) == 0.0


def test_crop_gray_handles_degenerate_bbox() -> None:
    bgr = _solid_bgr(120, 200, 200)
    degenerate = BoundingBox(x=1000.0, y=1000.0, width=10.0, height=10.0)
    gray = crop_gray(bgr, degenerate)
    assert gray.shape[0] >= 1 and gray.shape[1] >= 1


def test_compute_quality_returns_required_fields() -> None:
    bgr = _solid_bgr(180, 300, 300)
    bbox = BoundingBox(x=50.0, y=50.0, width=120.0, height=120.0)
    q = compute_quality(bgr, bbox, detection_score=0.95)
    payload = q.as_dict()
    for key in (
        "detection_score",
        "face_width",
        "face_height",
        "relative_face_area",
        "blur_score",
        "brightness",
        "near_edge",
    ):
        assert key in payload


def test_compute_quality_marks_near_edge_correctly() -> None:
    bgr = _solid_bgr(180, 300, 300)
    edge_bbox = BoundingBox(x=1.0, y=1.0, width=40.0, height=40.0)
    far_bbox = BoundingBox(x=130.0, y=130.0, width=40.0, height=40.0)
    assert compute_quality(bgr, edge_bbox, 0.9).near_edge is True
    assert compute_quality(bgr, far_bbox, 0.9).near_edge is False


def test_compute_quality_relative_face_area_is_in_unit_range() -> None:
    bgr = _solid_bgr(128, 200, 200)
    bbox = BoundingBox(x=0.0, y=0.0, width=200.0, height=200.0)
    q = compute_quality(bgr, bbox, 0.9)
    assert 0.0 <= q.relative_face_area <= 1.0
