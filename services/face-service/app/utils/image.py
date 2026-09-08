"""Image decoding and validation utilities.

The Face Service decodes uploaded image bytes *in memory* and never persists
them. Inputs are validated against a configurable set of limits before being
handed to the recognition engine so that:

- Malformed uploads are rejected with safe machine-readable error codes.
- Oversized images cannot exhaust process memory.
- Format confusion attacks (filename spoofing, mime spoofing) are rejected.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

import numpy as np

from app.core.config import get_settings
from app.engine.types import DecodedImage


# Magic-byte signatures for the formats we accept. These are sniffed directly
# from the bytes so the filename/MIME header is irrelevant.
_JPEG_SOI: Final[bytes] = b"\xff\xd8\xff"
_PNG_SIG: Final[bytes] = b"\x89PNG\r\n\x1a\n"
_WEBP_RIFF: Final[bytes] = b"RIFF"
_WEBP_WEBP: Final[bytes] = b"WEBP"
_BMP_SIG: Final[bytes] = b"BM"


class ImageError(ValueError):
    """Raised when an uploaded image cannot be decoded safely.

    The ``code`` attribute is a stable machine-readable identifier used by the
    HTTP layer to map the error to a ``FaceErrorCode`` enum value.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ImageLimits:
    """Runtime limits applied by :func:`decode_image`."""

    max_bytes: int
    max_width: int
    max_height: int

    @classmethod
    def from_settings(cls) -> "ImageLimits":
        s = get_settings()
        return cls(
            max_bytes=int(s.face_max_upload_mb) * 1024 * 1024,
            max_width=int(s.face_max_image_width),
            max_height=int(s.face_max_image_height),
        )


def _sniff_format(raw: bytes) -> str:
    """Return the sniffed image format, or raise ``ImageError``."""
    if raw.startswith(_JPEG_SOI):
        return "jpeg"
    if raw.startswith(_PNG_SIG):
        return "png"
    if raw.startswith(_WEBP_RIFF) and len(raw) >= 12 and raw[8:12] == _WEBP_WEBP:
        return "webp"
    if raw.startswith(_BMP_SIG):
        return "bmp"
    raise ImageError("INVALID_IMAGE", "Unsupported or unrecognised image format.")


def decode_image(raw: bytes, limits: ImageLimits | None = None) -> DecodedImage:
    """Decode uploaded bytes into an in-memory ``DecodedImage``.

    Imports OpenCV lazily so that pure-unit-test environments do not need the
    heavyweight native dependency.
    """

    if not isinstance(raw, (bytes, bytearray)):
        raise ImageError("INVALID_IMAGE", "Image payload must be raw bytes.")
    if len(raw) == 0:
        raise ImageError("INVALID_IMAGE", "Empty image payload.")

    active_limits = limits or ImageLimits.from_settings()

    if len(raw) > active_limits.max_bytes:
        raise ImageError(
            "IMAGE_TOO_LARGE",
            f"Image exceeds the {active_limits.max_bytes} byte limit.",
        )

    format_name = _sniff_format(raw)

    # Lazy import — keeps unit-test collection fast and lets the engine module
    # be importable without opencv in tests that don't need it.
    import cv2  # type: ignore[import-not-found]

    arr = np.frombuffer(raw, dtype=np.uint8)
    bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if bgr is None:
        raise ImageError(
            "INVALID_IMAGE", f"OpenCV could not decode {format_name.upper()} payload."
        )

    if bgr.ndim != 3 or bgr.shape[2] != 3:
        raise ImageError("INVALID_IMAGE", "Image must have 3 colour channels.")

    height, width = int(bgr.shape[0]), int(bgr.shape[1])
    if width <= 0 or height <= 0:
        raise ImageError("INVALID_IMAGE", "Image has zero width or height.")

    if width > active_limits.max_width or height > active_limits.max_height:
        raise ImageError(
            "IMAGE_TOO_LARGE",
            (
                f"Image dimensions {width}x{height} exceed the "
                f"{active_limits.max_width}x{active_limits.max_height} limit."
            ),
        )

    return DecodedImage(bgr=bgr, width=width, height=height, channels=3)


def order_faces_by_x(faces: list) -> list:
    """Stable ordering: left-to-right by bbox centre X, tie-break by bbox Y.

    Deterministic ordering is critical — multi-person attendance overlays in
    later phases rely on stable indices across frames.
    """

    return sorted(
        faces,
        key=lambda f: (
            round((f.bbox.x + f.bbox.width / 2.0), 3),
            round((f.bbox.y + f.bbox.height / 2.0), 3),
            -f.detection_score,
        ),
    )


__all__ = ["ImageError", "ImageLimits", "decode_image", "order_faces_by_x"]
