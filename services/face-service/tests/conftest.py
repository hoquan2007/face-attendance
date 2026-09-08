"""Shared pytest fixtures for the Face Service."""

from __future__ import annotations

from pathlib import Path

import pytest


class _TestSentinelEngine:
    """Marker engine — tells the lifespan to skip real model load.

    Lifecycle: installed by conftest on setup, restored to StubFaceEngine
    on teardown. Tests that need specific behaviour explicitly replace via
    ``set_engine``.
    """

    name = "test-sentinel"
    model = None
    provider = None

    def load(self):
        return None

    def status(self):
        from app.engine.types import EngineStatus

        return EngineStatus(
            state="unloaded",
            engine_name=None,
            model_name=None,
            model_identity=None,
            provider=None,
            embedding_dimension=None,
        )

    def metadata(self):
        raise NotImplementedError("sentinel")

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


@pytest.fixture(autouse=True)
def _clean_settings_cache():
    from app.core.config import get_settings

    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture(autouse=True)
def _reset_engine():
    # Install a *non-default* StubFaceEngine instance as a sentinel so the
    # lifespan detects it is "injected by test" and skips real model load.
    from app.engine.runtime import StubFaceEngine, set_active_engine

    set_active_engine(StubFaceEngine())
    yield
    set_active_engine(StubFaceEngine())


@pytest.fixture()
def no_face_png() -> bytes:
    from benchmarks.synthetic_fixtures import gradient_png_bytes

    return gradient_png_bytes(width=320, height=240)


@pytest.fixture()
def no_face_solid_png() -> bytes:
    from benchmarks.synthetic_fixtures import solid_color_png_bytes

    return solid_color_png_bytes(width=320, height=240)


@pytest.fixture()
def tmp_face_service_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "benchmarks" / "fixtures-local").mkdir(parents=True, exist_ok=True)
    return tmp_path
