"""Synthetic image generation for unit tests + offline benchmarks.

Generates simple, non-biometric placeholder images — gradient patches and a
solid colour — that the engine can safely reject or accept for ordering tests.

These are intentionally **not** face images. They exist so that the engine
pipeline can be exercised in CI environments without downloading any real
biometric data.
"""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

import numpy as np


def gradient_png_bytes(width: int = 320, height: int = 240) -> bytes:
    """Return a PNG-encoded gradient (no face) used as a no-face fixture."""

    import cv2  # type: ignore[import-not-found]

    grad = np.tile(np.linspace(0, 255, width, dtype=np.uint8), (height, 1))
    bgr = cv2.cvtColor(grad, cv2.COLOR_GRAY2BGR)
    ok, buf = cv2.imencode(".png", bgr)
    if not ok:
        raise RuntimeError("Failed to encode gradient fixture.")
    return bytes(buf.tobytes())


def solid_color_png_bytes(width: int = 320, height: int = 240) -> bytes:
    """Return a PNG-encoded solid colour (no face) used as a no-face fixture."""

    import cv2  # type: ignore[import-not-found]

    img = np.zeros((height, width, 3), dtype=np.uint8)
    img[:] = (96, 128, 160)  # muted blue/grey — clearly not a face
    ok, buf = cv2.imencode(".png", img)
    if not ok:
        raise RuntimeError("Failed to encode solid colour fixture.")
    return bytes(buf.tobytes())


def save_bytes(path: Path, payload: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return path


__all__ = ["gradient_png_bytes", "solid_color_png_bytes", "save_bytes"]
