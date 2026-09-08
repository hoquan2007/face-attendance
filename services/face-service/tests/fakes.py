"""Synthetic ``InsightFace`` face objects for unit tests.

Mirrors the small subset of attributes the real ``insightface.app.common.Face``
exposes that our engine uses: ``bbox``, ``det_score``, ``kps``, ``normed_embedding``.
"""

from __future__ import annotations

import numpy as np


class FakeFace:
    """Minimal stand-in for an InsightFace detection result."""

    def __init__(
        self,
        bbox: tuple[float, float, float, float],
        det_score: float,
        kps: np.ndarray | None = None,
        embedding: np.ndarray | None = None,
    ) -> None:
        self.bbox = np.array(bbox, dtype=np.float32)
        self.det_score = float(det_score)
        self.kps = kps if kps is not None else np.zeros((5, 2), dtype=np.float32)
        if embedding is None:
            self.normed_embedding = np.zeros(512, dtype=np.float32)
        else:
            arr = np.asarray(embedding, dtype=np.float32)
            norm = float(np.linalg.norm(arr))
            if norm <= 0:
                self.normed_embedding = arr
            else:
                self.normed_embedding = arr / norm


__all__ = ["FakeFace"]
