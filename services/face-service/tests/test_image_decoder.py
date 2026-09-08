"""Image decoder tests — covers accept / reject / size / dim policies."""

from __future__ import annotations

import io

import pytest

from app.utils.image import (
    ImageError,
    ImageLimits,
    decode_image,
    order_faces_by_x,
)
from app.engine.base import BoundingBox
from app.engine.types import DetectedFace


def _png_bytes(width: int, height: int) -> bytes:
    import cv2  # type: ignore[import-not-found]
    import numpy as np

    img = np.zeros((height, width, 3), dtype=np.uint8)
    img[:] = (96, 128, 160)
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return bytes(buf.tobytes())


def _jpeg_bytes(width: int, height: int) -> bytes:
    import cv2  # type: ignore[import-not-found]
    import numpy as np

    img = np.zeros((height, width, 3), dtype=np.uint8)
    img[:] = (96, 128, 160)
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return bytes(buf.tobytes())


def _limits(max_bytes: int = 1024 * 1024, w: int = 4096, h: int = 4096) -> ImageLimits:
    return ImageLimits(max_bytes=max_bytes, max_width=w, max_height=h)


def test_decode_accepts_valid_png() -> None:
    decoded = decode_image(_png_bytes(64, 48), limits=_limits())
    assert decoded.width == 64
    assert decoded.height == 48
    assert decoded.channels == 3


def test_decode_accepts_valid_jpeg() -> None:
    decoded = decode_image(_jpeg_bytes(64, 48), limits=_limits())
    assert decoded.width == 64
    assert decoded.height == 48
    assert decoded.channels == 3


def test_decode_rejects_empty() -> None:
    with pytest.raises(ImageError) as exc:
        decode_image(b"", limits=_limits())
    assert exc.value.code == "INVALID_IMAGE"


def test_decode_rejects_non_bytes() -> None:
    with pytest.raises(ImageError) as exc:
        decode_image("not-bytes", limits=_limits())  # type: ignore[arg-type]
    assert exc.value.code == "INVALID_IMAGE"


def test_decode_rejects_unknown_signature() -> None:
    with pytest.raises(ImageError) as exc:
        decode_image(b"GIF89a-not-really-a-gif", limits=_limits())
    assert exc.value.code == "INVALID_IMAGE"


def test_decode_rejects_oversized_bytes() -> None:
    # 1 MB cap, payload slightly over it.
    payload = _png_bytes(2048, 1024) + b"\x00" * (1024 * 1024 + 1)
    with pytest.raises(ImageError) as exc:
        decode_image(payload, limits=_limits(max_bytes=1024 * 1024))
    assert exc.value.code == "IMAGE_TOO_LARGE"


def test_decode_rejects_oversized_dimensions() -> None:
    with pytest.raises(ImageError) as exc:
        decode_image(_png_bytes(8000, 100), limits=_limits(w=4096, h=4096))
    assert exc.value.code == "IMAGE_TOO_LARGE"


def test_decode_ignores_filename_extension() -> None:
    # Filename is irrelevant: a payload that claims to be a JPEG but lacks
    # the SOI marker must be rejected.
    with pytest.raises(ImageError):
        decode_image(b"PNG\r\n\x1a\n-but-not-a-real-png", limits=_limits())


def test_order_faces_by_x_is_left_to_right_with_stable_tiebreak() -> None:
    rightmost = DetectedFace(
        bbox=BoundingBox(x=200.0, y=10.0, width=40.0, height=40.0),
        detection_score=0.9,
    )
    leftmost = DetectedFace(
        bbox=BoundingBox(x=10.0, y=10.0, width=40.0, height=40.0),
        detection_score=0.8,
    )
    middle = DetectedFace(
        bbox=BoundingBox(x=100.0, y=10.0, width=40.0, height=40.0),
        detection_score=0.7,
    )
    ordered = order_faces_by_x([rightmost, middle, leftmost])
    assert [ordered[0].bbox.x, ordered[1].bbox.x, ordered[2].bbox.x] == [10.0, 100.0, 200.0]


def test_order_faces_by_x_tiebreak_by_y_then_score() -> None:
    a = DetectedFace(
        bbox=BoundingBox(x=10.0, y=5.0, width=10.0, height=10.0),
        detection_score=0.6,
    )
    b = DetectedFace(
        bbox=BoundingBox(x=10.0, y=20.0, width=10.0, height=10.0),
        detection_score=0.9,
    )
    c = DetectedFace(
        bbox=BoundingBox(x=10.0, y=5.0, width=10.0, height=10.0),
        detection_score=0.9,
    )
    ordered = order_faces_by_x([b, a, c])
    # First tie-break: y → a (y=5) before c (y=5) → tie.
    # Second tie-break by higher score → c (0.9) before a (0.6).
    assert ordered[0] is c
    assert ordered[1] is a
    assert ordered[2] is b


def test_order_faces_by_x_is_stable() -> None:
    faces = [
        DetectedFace(
            bbox=BoundingBox(x=10.0, y=10.0, width=10.0, height=10.0),
            detection_score=0.5,
        ),
        DetectedFace(
            bbox=BoundingBox(x=20.0, y=10.0, width=10.0, height=10.0),
            detection_score=0.5,
        ),
    ]
    first = order_faces_by_x(faces)
    second = order_faces_by_x(list(reversed(faces)))
    assert [id(f) for f in first] == [id(f) for f in second]
