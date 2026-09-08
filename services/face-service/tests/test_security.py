"""Security dependency tests — service token enforcement."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.core.security import verify_service_token
from app.main import app


@pytest.fixture()
def _secret(monkeypatch: pytest.MonkeyPatch) -> str:
    secret = "test-secret-value-long-enough"
    monkeypatch.setenv("FACE_SERVICE_SECRET", secret)
    from app.core.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield secret
    get_settings.cache_clear()  # type: ignore[attr-defined]


def test_dependency_rejects_when_no_secret_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("FACE_SERVICE_SECRET", raising=False)
    from app.core.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    with pytest.raises(Exception) as exc:
        verify_service_token(x_service_token=None)
    # The dependency raises HTTPException(401) — verify code via detail dict.
    detail = exc.value.detail
    assert detail["error"]["code"] == "FACE_SERVICE_UNAUTHORIZED"


def test_dependency_rejects_wrong_token(_secret: str) -> None:
    with pytest.raises(Exception) as exc:
        verify_service_token(x_service_token="nope")
    assert exc.value.detail["error"]["code"] == "FACE_SERVICE_UNAUTHORIZED"


def test_dependency_rejects_missing_token(_secret: str) -> None:
    with pytest.raises(Exception) as exc:
        verify_service_token(x_service_token=None)
    assert exc.value.detail["error"]["code"] == "FACE_SERVICE_UNAUTHORIZED"


def test_dependency_accepts_correct_token(_secret: str) -> None:
    # Should not raise.
    verify_service_token(x_service_token=_secret)


def test_health_endpoint_does_not_require_token(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "test-secret"
    monkeypatch.setenv("FACE_SERVICE_SECRET", secret)
    from app.core.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    with TestClient(app) as client:
        r = client.get("/health")
    assert r.status_code == 200


def test_analyze_endpoint_rejects_without_token(
    _secret: str,
    no_face_png: bytes,
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/analyze",
            files={"file": ("x.png", no_face_png, "image/png")},
        )
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "FACE_SERVICE_UNAUTHORIZED"


def test_analyze_endpoint_rejects_wrong_token(
    _secret: str,
    no_face_png: bytes,
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/analyze",
            headers={"X-Service-Token": "wrong"},
            files={"file": ("x.png", no_face_png, "image/png")},
        )
    assert r.status_code == 401
