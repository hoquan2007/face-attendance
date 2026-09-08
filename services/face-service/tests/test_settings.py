"""Settings / config tests — ensure every documented knob is wired."""

from __future__ import annotations

import pytest

from app.core.config import Settings


def _settings(monkeypatch: pytest.MonkeyPatch, **overrides: object) -> Settings:
    for key, value in overrides.items():
        if value is None:
            monkeypatch.delenv(key, raising=False)
        else:
            monkeypatch.setenv(key, str(value))
    from app.core.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    return get_settings()


def test_default_settings_have_documented_values(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    s = _settings(
        monkeypatch,
        FACE_SERVICE_SECRET=None,
        FACE_MODEL_NAME=None,
        FACE_EXECUTION_PROVIDER=None,
        FACE_DET_THRESHOLD=None,
        FACE_DET_SIZE=None,
        FACE_MATCH_THRESHOLD=None,
        FACE_MAX_UPLOAD_MB=None,
        FACE_MAX_IMAGE_WIDTH=None,
        FACE_MAX_IMAGE_HEIGHT=None,
    )
    assert s.face_model_name == "buffalo_l"
    assert s.face_execution_provider == "cpu"
    assert s.face_det_threshold == 0.5
    assert s.face_det_size == "640x640"
    assert s.face_match_threshold == 0.4
    assert s.face_max_upload_mb == 8
    assert s.face_max_image_width == 4096
    assert s.face_max_image_height == 4096


def test_settings_override_via_env(monkeypatch: pytest.MonkeyPatch) -> None:
    s = _settings(
        monkeypatch,
        FACE_SERVICE_SECRET="abc",
        FACE_MODEL_NAME="buffalo_l",
        FACE_EXECUTION_PROVIDER="cpu",
        FACE_DET_THRESHOLD="0.7",
        FACE_MATCH_THRESHOLD="0.5",
        FACE_MAX_UPLOAD_MB="16",
        FACE_MAX_IMAGE_WIDTH="2048",
    )
    assert s.face_service_secret == "abc"
    assert s.face_det_threshold == 0.7
    assert s.face_match_threshold == 0.5
    assert s.face_max_upload_mb == 16
    assert s.face_max_image_width == 2048


def test_settings_cache_is_cleared_between_calls() -> None:
    from app.core.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    a = get_settings()
    b = get_settings()
    assert a is b
    get_settings.cache_clear()  # type: ignore[attr-defined]
    c = get_settings()
    assert c is not a
