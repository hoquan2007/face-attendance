"""Analyze-endpoint tests using a fake engine — covers success / invalid input."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.engine.types import (
    BoundingBox,
    Candidate,
    DetectedFace,
    ENGINE_STATE_READY,
    EngineMetadata,
    EngineStatus,
    FaceEmbedding,
    FaceQuality,
    Landmark,
    RecognitionResult,
)

# set_engine is re-exported from base.py.
from app.engine.base import FaceEngine, set_engine
from app.engine.runtime import set_active_engine
from app.main import app


class _FakeAnalyzeEngine(FaceEngine):
    name = "fake-analyze"
    model = "fake"
    provider = "CPUExecutionProvider"

    def __init__(self, faces_to_return: list[DetectedFace]) -> None:
        self._faces = faces_to_return

    def load(self) -> None:
        return None

    def status(self) -> EngineStatus:
        return EngineStatus(
            state=ENGINE_STATE_READY,
            engine_name="fake-analyze",
            model_name="fake",
            model_identity="fake-id",
            provider="CPUExecutionProvider",
            embedding_dimension=512,
        )

    def metadata(self) -> EngineMetadata:
        return EngineMetadata(
            engine_name="fake-analyze",
            library_version="0.0.0",
            model_name="fake",
            model_identity="fake-id",
            provider="CPUExecutionProvider",
            embedding_dimension=512,
            normalization="l2",
            detection_module="scrfd",
            recognition_module="arcface",
        )

    def detect_faces(self, image):
        return list(self._faces)

    def extract_embeddings(self, image, faces):
        return []

    def build_index(self, candidates):
        return []

    def recognize_faces(self, image, index):
        return []

    def analyze(self, image):
        return list(self._faces)


@pytest.fixture()
def _secret(monkeypatch: pytest.MonkeyPatch) -> str:
    secret = "test-secret-value-long-enough"
    monkeypatch.setenv("FACE_SERVICE_SECRET", secret)
    from app.core.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield secret
    get_settings.cache_clear()  # type: ignore[attr-defined]


def _png(width: int, height: int) -> bytes:
    import cv2  # type: ignore[import-not-found]
    import numpy as np

    img = np.zeros((height, width, 3), dtype=np.uint8)
    img[:] = (96, 128, 160)
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return bytes(buf.tobytes())


def _face(score: float = 0.9, x: float = 10.0) -> DetectedFace:
    from app.engine.base import BoundingBox

    return DetectedFace(
        bbox=BoundingBox(x=x, y=10.0, width=40.0, height=40.0),
        detection_score=score,
        landmarks=[
            Landmark(x=20.0, y=20.0),
            Landmark(x=40.0, y=20.0),
            Landmark(x=30.0, y=40.0),
            Landmark(x=20.0, y=50.0),
            Landmark(x=40.0, y=50.0),
        ],
        quality=FaceQuality(
            detection_score=score,
            face_width=40.0,
            face_height=40.0,
            relative_face_area=0.05,
            blur_score=120.0,
            brightness=0.55,
            near_edge=False,
        ),
    )


def test_analyze_no_face_returns_empty_faces(_secret: str) -> None:
    set_engine(_FakeAnalyzeEngine([]))
    payload = _png(64, 48)
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/analyze",
            headers={"X-Service-Token": _secret},
            files={"file": ("x.png", payload, "image/png")},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["face_count"] == 0
    assert body["faces"] == []


def test_analyze_one_face_returns_face_index_zero(_secret: str) -> None:
    set_engine(_FakeAnalyzeEngine([_face()]))
    payload = _png(64, 48)
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/analyze",
            headers={"X-Service-Token": _secret},
            files={"file": ("x.png", payload, "image/png")},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["face_count"] == 1
    assert body["faces"][0]["face_index"] == 0
    assert body["faces"][0]["landmarks"]  # five points when available


def test_analyze_multi_face_orders_left_to_right(_secret: str) -> None:
    set_engine(
        _FakeAnalyzeEngine([_face(x=120.0), _face(x=10.0), _face(x=60.0)])
    )
    payload = _png(200, 200)
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/analyze",
            headers={"X-Service-Token": _secret},
            files={"file": ("x.png", payload, "image/png")},
        )
    assert r.status_code == 200
    body = r.json()
    xs = [f["bbox"]["x"] for f in body["faces"]]
    assert xs == sorted(xs)
    assert [f["face_index"] for f in body["faces"]] == [0, 1, 2]


def test_analyze_rejects_invalid_image(_secret: str) -> None:
    set_engine(_FakeAnalyzeEngine([]))
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/analyze",
            headers={"X-Service-Token": _secret},
            files={"file": ("x.png", b"not-an-image", "image/png")},
        )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "INVALID_IMAGE"


def test_analyze_rejects_empty_upload(_secret: str) -> None:
    set_engine(_FakeAnalyzeEngine([]))
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/analyze",
            headers={"X-Service-Token": _secret},
            files={"file": ("x.png", b"", "image/png")},
        )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "INVALID_IMAGE"


def test_analyze_engine_not_ready(_secret: str) -> None:
    set_engine(None)
    payload = _png(64, 48)
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/analyze",
            headers={"X-Service-Token": _secret},
            files={"file": ("x.png", payload, "image/png")},
        )
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "ENGINE_NOT_READY"


def test_analyze_does_not_return_embeddings(_secret: str) -> None:
    set_engine(_FakeAnalyzeEngine([_face()]))
    payload = _png(64, 48)
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/analyze",
            headers={"X-Service-Token": _secret},
            files={"file": ("x.png", payload, "image/png")},
        )
    body = r.json()
    text = r.text.lower()
    for forbidden in ("embedding", "normed_embedding", "vector"):
        assert forbidden not in text or forbidden == "vector"
