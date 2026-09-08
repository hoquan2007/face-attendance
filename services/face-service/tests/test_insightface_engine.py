"""Engine pipeline tests using a fake ``FaceAnalysis``.

These tests bypass the real InsightFace package by injecting a stand-in
``FaceAnalysis`` that returns pre-canned ``FakeFace`` objects. This lets us
exercise the engine pipeline — bbox clamping, ordering, embedding extraction,
metadata persistence — without downloading model weights in CI.
"""

from __future__ import annotations

import io

import numpy as np
import pytest

from app.engine.base import (
    BoundingBox,
    DetectedFace as LegacyDetectedFace,
    FaceEmbedding,
    set_engine,
)
from app.engine.insightface_engine import (
    ENGINE_STATE_READY,
    InsightFaceEngine,
    _to_detected_face,
)
from app.engine.types import (
    EngineMetadata,
    ENGINE_STATE_UNLOADED,
)
from tests.fakes import FakeFace


class _FakeFaceAnalysis:
    """Minimal stand-in for ``insightface.app.FaceAnalysis``."""

    def __init__(self, faces_to_return: list[FakeFace]) -> None:
        self._faces = faces_to_return
        self.det_model = self
        self.models = {"detection": self}

    def prepare(self, *_args, **_kwargs):
        return None

    def detect(self, img, max_num=0, metric="default"):
        boxes = np.stack([f.bbox for f in self._faces], axis=0)
        scores = np.array([f.det_score for f in self._faces], dtype=np.float32).reshape(-1, 1)
        bboxes = np.concatenate([boxes, scores], axis=1)
        kpss = (
            np.stack([f.kps for f in self._faces], axis=0)
            if self._faces
            else None
        )
        return bboxes, kpss

    def get(self, img):
        return list(self._faces)


@pytest.fixture()
def _engine_singleton(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FACE_MODEL_NAME", "buffalo_l")
    monkeypatch.setenv("FACE_EXECUTION_PROVIDER", "cpu")
    from app.core.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    set_engine(None)


def _bgr_image(width: int, height: int) -> np.ndarray:
    img = np.zeros((height, width, 3), dtype=np.uint8)
    img[:] = (128, 128, 128)
    return img


def test_engine_load_with_fake_app_succeeds(_engine_singleton, monkeypatch) -> None:
    import insightface  # type: ignore[import-not-found]

    monkeypatch.setattr(
        insightface.app,
        "FaceAnalysis",
        lambda *args, **kwargs: _FakeFaceAnalysis([]),
    )
    engine = InsightFaceEngine()
    engine.load()
    assert engine.metadata().engine_name == "insightface"
    assert engine.metadata().provider == "CPUExecutionProvider"


def test_engine_metadata_returns_immutable_identification(
    _engine_singleton, monkeypatch
) -> None:
    import insightface  # type: ignore[import-not-found]

    monkeypatch.setattr(
        insightface.app,
        "FaceAnalysis",
        lambda *args, **kwargs: _FakeFaceAnalysis([]),
    )
    engine = InsightFaceEngine()
    engine.load()
    meta = engine.metadata()
    assert isinstance(meta, EngineMetadata)
    assert meta.normalization == "l2"
    assert meta.detection_module == "scrfd"
    assert meta.recognition_module == "arcface"


def test_engine_analyze_returns_clamped_bboxes(
    _engine_singleton, monkeypatch
) -> None:
    import insightface  # type: ignore[import-not-found]

    face = FakeFace(
        bbox=(-50.0, -50.0, 9999.0, 9999.0),
        det_score=0.9,
    )
    monkeypatch.setattr(
        insightface.app,
        "FaceAnalysis",
        lambda *args, **kwargs: _FakeFaceAnalysis([face]),
    )
    engine = InsightFaceEngine()
    engine.load()

    bgr = _bgr_image(640, 480)
    # Encode to PNG bytes for the engine contract.
    import cv2  # type: ignore[import-not-found]

    ok, buf = cv2.imencode(".png", bgr)
    assert ok
    payload = bytes(buf.tobytes())

    faces = engine.analyze(payload)
    assert len(faces) == 1
    f = faces[0]
    assert f.bbox.x >= 0.0
    assert f.bbox.y >= 0.0
    assert f.bbox.x + f.bbox.width <= 640.0
    assert f.bbox.y + f.bbox.height <= 480.0


def test_engine_orders_multi_face_left_to_right(
    _engine_singleton, monkeypatch
) -> None:
    import insightface  # type: ignore[import-not-found]

    right = FakeFace(bbox=(300.0, 10.0, 350.0, 60.0), det_score=0.9)
    left = FakeFace(bbox=(10.0, 10.0, 60.0, 60.0), det_score=0.9)
    mid = FakeFace(bbox=(150.0, 10.0, 200.0, 60.0), det_score=0.9)
    monkeypatch.setattr(
        insightface.app,
        "FaceAnalysis",
        lambda *args, **kwargs: _FakeFaceAnalysis([right, left, mid]),
    )
    engine = InsightFaceEngine()
    engine.load()

    import cv2  # type: ignore[import-not-found]

    ok, buf = cv2.imencode(".png", _bgr_image(400, 100))
    payload = bytes(buf.tobytes())

    faces = engine.analyze(payload)
    xs = [f.bbox.x for f in faces]
    assert xs == sorted(xs)


def test_engine_extract_embeddings_validates_dimension(
    _engine_singleton, monkeypatch
) -> None:
    import insightface  # type: ignore[import-not-found]

    face = FakeFace(
        bbox=(10.0, 10.0, 60.0, 60.0),
        det_score=0.9,
        embedding=np.random.RandomState(0).randn(512),
    )
    monkeypatch.setattr(
        insightface.app,
        "FaceAnalysis",
        lambda *args, **kwargs: _FakeFaceAnalysis([face]),
    )
    engine = InsightFaceEngine()
    engine.load()

    import cv2  # type: ignore[import-not-found]

    ok, buf = cv2.imencode(".png", _bgr_image(200, 200))
    payload = bytes(buf.tobytes())

    faces = engine.analyze(payload)
    embs = engine.extract_embeddings(payload, faces)
    assert len(embs) == 1
    assert embs[0].dimension == 512


def test_engine_status_is_unloaded_before_load(_engine_singleton) -> None:
    engine = InsightFaceEngine()
    status = engine.status()
    assert status.state == ENGINE_STATE_UNLOADED
    assert status.engine_name is None


def test_engine_status_is_ready_after_load(_engine_singleton, monkeypatch) -> None:
    import insightface  # type: ignore[import-not-found]

    monkeypatch.setattr(
        insightface.app,
        "FaceAnalysis",
        lambda *args, **kwargs: _FakeFaceAnalysis([]),
    )
    engine = InsightFaceEngine()
    engine.load()
    status = engine.status()
    assert status.state == ENGINE_STATE_READY
    assert status.engine_name == "insightface"


def test_engine_load_failure_reported_via_status(
    _engine_singleton, monkeypatch
) -> None:
    import insightface  # type: ignore[import-not-found]

    def _boom(*_args, **_kwargs):
        raise RuntimeError("simulated model init failure")

    monkeypatch.setattr(insightface.app, "FaceAnalysis", _boom)
    engine = InsightFaceEngine()
    with pytest.raises(RuntimeError):
        engine.load()
    status = engine.status()
    assert status.state == "error"
    assert status.error_code == "MODEL_LOAD_FAILED"
    assert status.error_message is not None
