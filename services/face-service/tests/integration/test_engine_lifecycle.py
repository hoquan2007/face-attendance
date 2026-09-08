"""Integration tests — require the real InsightFace model on disk.

These tests are NOT run by ordinary ``pytest -q``. Execute them explicitly
with::

    pytest -q -m integration

A local fixture must exist for ``test_real_engine_analyzes_local_fixture``.
The test skips gracefully when no fixture is present.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.engine.base import set_engine
from app.engine.insightface_engine import (
    ENGINE_STATE_READY,
    InsightFaceEngine,
)
from app.engine.types import ENGINE_STATE_UNLOADED


pytestmark = pytest.mark.integration


@pytest.fixture()
def engine(monkeypatch: pytest.MonkeyPatch) -> InsightFaceEngine:
    monkeypatch.setenv("FACE_MODEL_NAME", "buffalo_l")
    monkeypatch.setenv("FACE_EXECUTION_PROVIDER", "cpu")
    from app.core.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    set_engine(None)
    eng = InsightFaceEngine()
    eng.load()
    if eng.status().state != ENGINE_STATE_READY:
        pytest.skip(
            f"InsightFace engine unavailable: {eng.status().error_code} "
            f"{eng.status().error_message}"
        )
    yield eng
    set_engine(None)


def test_real_engine_loads_and_reports_cpu_provider(engine: InsightFaceEngine) -> None:
    status = engine.status()
    assert status.state == ENGINE_STATE_READY
    assert status.provider == "CPUExecutionProvider"


def test_real_engine_metadata_matches_loaded_model(engine: InsightFaceEngine) -> None:
    meta = engine.metadata()
    assert meta.engine_name == "insightface"
    assert meta.provider == "CPUExecutionProvider"
    assert meta.embedding_dimension > 0
    assert meta.normalization == "l2"


def test_real_engine_analyzes_local_fixture(engine: InsightFaceEngine) -> None:
    fixtures_root = Path(__file__).resolve().parents[1] / "benchmarks" / "fixtures-local"
    candidates: list[Path] = []
    if fixtures_root.exists():
        for suffix in (".jpg", ".jpeg", ".png"):
            candidates.extend(fixtures_root.rglob(f"*{suffix}"))
    if not candidates:
        pytest.skip("no local face fixture under benchmarks/fixtures-local/")

    target = candidates[0]
    faces = engine.analyze(target.read_bytes())
    assert isinstance(faces, list)
