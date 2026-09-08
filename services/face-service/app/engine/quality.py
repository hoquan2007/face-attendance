"""Quality heuristics used to annotate detected faces.

These heuristics are intentionally **modular** and **informational** in PHASE 3.
Hard-rejection policies belong to PHASE 4 enrollment; for now the values are
returned to clients so that future calibration work has real measurements to
reason about.

All metrics are resolution-dependent (blur) or exposure-dependent (brightness),
so any threshold that gates recognition must be calibrated with the actual
deployment hardware.
"""

from __future__ import annotations

from typing import Final

import numpy as np

from app.engine.types import BoundingBox, FaceQuality


_EDGE_TOLERANCE_PX: Final[int] = 2


def variance_of_laplacian(gray: np.ndarray) -> float:
    """Compute the variance of the Laplacian — common sharpness proxy.

    Higher values mean sharper images. The absolute scale depends on the image
    resolution, so any threshold must be calibrated per deployment.
    """

    import cv2  # type: ignore[import-not-found]

    lap = cv2.Laplacian(gray, cv2.CV_64F)
    return float(lap.var())


def mean_brightness(gray: np.ndarray) -> float:
    """Normalised mean luminance in [0, 1].

    Uses the standard ITU-R BT.601 weights on BGR. This is a pure image
    property — it does not encode any demographic information about the
    subject.
    """

    bgr = gray.astype(np.float64) if gray.dtype != np.float64 else gray
    if bgr.ndim == 3:
        b, g, r = bgr[..., 0], bgr[..., 1], bgr[..., 2]
        luma = 0.114 * b + 0.587 * g + 0.299 * r
    else:
        luma = bgr
    return float(np.clip(luma.mean() / 255.0, 0.0, 1.0))


def crop_gray(bgr: np.ndarray, bbox: BoundingBox) -> np.ndarray:
    """Crop the bbox region as grayscale, clamped to image bounds."""

    import cv2  # type: ignore[import-not-found]

    h, w = bgr.shape[:2]
    x1 = max(0, min(int(round(bbox.x)), w - 1))
    y1 = max(0, min(int(round(bbox.y)), h - 1))
    x2 = max(0, min(int(round(bbox.x + bbox.width)), w))
    y2 = max(0, min(int(round(bbox.y + bbox.height)), h))
    if x2 <= x1 or y2 <= y1:
        # Degenerate crop — return a single-pixel image to keep math defined.
        return np.zeros((1, 1), dtype=np.uint8)
    crop = bgr[y1:y2, x1:x2]
    return cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)


def compute_quality(
    bgr: np.ndarray,
    bbox: BoundingBox,
    detection_score: float,
) -> FaceQuality:
    """Compute modular quality metadata for one face crop.

    Operates on a decoded BGR image plus the bbox. Clamps bbox coordinates to
    the image bounds so degenerate inputs do not produce negative dims.
    """

    h, w = bgr.shape[:2]
    face_width = max(0.0, min(float(bbox.width), float(w)))
    face_height = max(0.0, min(float(bbox.height), float(h)))
    area = max(face_width * face_height, 0.0)
    total = float(max(w, 1)) * float(max(h, 1))
    relative = float(area / total) if total > 0 else 0.0

    gray = crop_gray(bgr, bbox)
    blur = variance_of_laplacian(gray)
    bright = mean_brightness(gray)

    near_edge = bool(
        bbox.x <= _EDGE_TOLERANCE_PX
        or bbox.y <= _EDGE_TOLERANCE_PX
        or (bbox.x + bbox.width) >= (w - _EDGE_TOLERANCE_PX)
        or (bbox.y + bbox.height) >= (h - _EDGE_TOLERANCE_PX)
    )

    return FaceQuality(
        detection_score=float(detection_score),
        face_width=face_width,
        face_height=face_height,
        relative_face_area=relative,
        blur_score=blur,
        brightness=bright,
        near_edge=near_edge,
    )


__all__ = [
    "compute_quality",
    "mean_brightness",
    "variance_of_laplacian",
    "crop_gray",
]
