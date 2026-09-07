"""Smoke tests for the Face Service skeleton."""

from fastapi.testclient import TestClient

from app.main import app


def test_root_returns_phase_metadata() -> None:
    client = TestClient(app)
    r = client.get("/")
    assert r.status_code == 200
    body = r.json()
    assert body["service"] == "face-service"
    assert body["phase"] == "0"


def test_health_returns_ok() -> None:
    client = TestClient(app)
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["engine"] == "stub"
    assert body["model"] is None
    assert body["provider"] is None


def test_stub_engine_methods_raise_not_implemented() -> None:
    from app.engine.base import StubFaceEngine

    engine = StubFaceEngine()
    try:
        engine.detect_faces(b"fake-bytes")
    except NotImplementedError:
        pass
    else:
        raise AssertionError("StubFaceEngine.detect_faces should raise NotImplementedError.")