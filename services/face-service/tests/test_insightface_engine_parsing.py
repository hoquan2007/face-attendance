"""InsightFaceEngine parsing helpers — no real model required."""

from __future__ import annotations

import pytest

from app.engine.insightface_engine import _parse_det_size, _resolve_providers


def test_resolve_providers_cpu() -> None:
    assert _resolve_providers("cpu") == ["CPUExecutionProvider"]


def test_resolve_providers_cuda_not_supported_in_phase3() -> None:
    with pytest.raises(RuntimeError) as exc:
        _resolve_providers("cuda")
    assert "PHASE 3" in str(exc.value)


def test_resolve_providers_unknown_value_rejected() -> None:
    with pytest.raises(RuntimeError):
        _resolve_providers("tpu")


def test_parse_det_size_auto() -> None:
    # InsightFace 1.0 SCRFD does not accept the literal "auto" string; the
    # helper transparently maps it to (640, 640) so the user-facing default
    # still works out of the box.
    assert _parse_det_size("auto") == (640, 640)
    assert _parse_det_size("AUTO") == (640, 640)
    assert _parse_det_size("default") == (640, 640)
    assert _parse_det_size("") == (640, 640)


def test_parse_det_size_explicit_wxh() -> None:
    assert _parse_det_size("640x480") == (640, 480)


def test_parse_det_size_invalid_raises() -> None:
    with pytest.raises(RuntimeError):
        _parse_det_size("0x0")
    with pytest.raises(RuntimeError):
        _parse_det_size("640-480")
    with pytest.raises(RuntimeError):
        _parse_det_size("not-a-size")
