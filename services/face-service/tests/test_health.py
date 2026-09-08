"""Smoke tests for the Face Service skeleton + Phase 3 readiness contract."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.engine.types import (
    ENGINE_STATE_READY,
    EngineMetadata,
    EngineStatus,
)
from app.main import app


def test_root_returns_phase_3_metadata() -> None:
    client = TestClient(app)
    r = client.get("/")
    assert r.status_code == 200
    body = r.json()
    assert body["service"] == "face-service"
    assert body["phase"] == "3"
    assert body["version"] == "0.3.0"


def test_health_reports_not_ready_when_stub_engine_installed() -> None:
    # The conftest installs StubFaceEngine; lifespan skips real load.
    with TestClient(app) as client:
        r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ready"] is False
    assert body["status"] == "degraded"


def test_health_reports_ready_when_fake_engine_installed() -> None:
    """Inject a fake engine that reports READY to verify the contract."""

    from app.engine.base import FaceEngine
    from app.engine.runtime import set_active_engine

    class _ReadyFake(FaceEngine):
        name = "fake"
        model = "fake-model"
        provider = "CPUExecutionProvider"

        def load(self):
            return None

        def status(self) -> EngineStatus:
            return EngineStatus(
                state=ENGINE_STATE_READY,
                engine_name="fake",
                model_name="fake-model",
                model_identity="fake-id",
                provider="CPUExecutionProvider",
                embedding_dimension=512,
            )

        def metadata(self) -> EngineMetadata:
            return EngineMetadata(
                engine_name="fake",
                library_version="0.0.0",
                model_name="fake-model",
                model_identity="fake-id",
                provider="CPUExecutionProvider",
                embedding_dimension=512,
                normalization="l2",
                detection_module="scrfd",
                recognition_module="arcface",
            )

        def detect_faces(self, image):
            return []

        def extract_embeddings(self, image, faces):
            return []

        def build_index(self, candidates):
            return []

        def recognize_faces(self, image, index):
            return []

        def analyze(self, image):
            return []

    set_active_engine(_ReadyFake())
    try:
        with TestClient(app) as client:
            r = client.get("/health")
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "ok"
        assert body["ready"] is True
        assert body["engine"] == "fake"
        assert body["model"] == "fake-model"
        assert body["provider"] == "CPUExecutionProvider"
        assert body["embedding_dimension"] == 512
    finally:
        set_active_engine(None)
