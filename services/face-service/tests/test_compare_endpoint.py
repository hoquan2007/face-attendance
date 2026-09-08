"""Compare-endpoint tests using a fake engine — covers domain error contract."""

from __future__ import annotations

import io
from typing import Sequence

import pytest
from fastapi.testclient import TestClient

from app.engine.base import FaceEngine, set_engine
from app.engine.matcher import compare_embeddings, l2_normalize
from app.engine.types import (
    BoundingBox,
    DetectedFace,
    ENGINE_STATE_READY,
    EngineMetadata,
    EngineStatus,
    FaceEmbedding,
    Landmark,
)
from app.main import app


class _FakeCompareEngine(FaceEngine):
    """Engine stub that returns a configured sequence of detections per call."""

    name = "fake-compare"
    model = "fake"
    provider = "CPUExecutionProvider"

    def __init__(
        self,
        detection_sequence: list[Sequence[DetectedFace]],
        embeddings: Sequence[FaceEmbedding],
    ) -> None:
        self._detection_sequence = list(detection_sequence)
        self._embeddings = list(embeddings)
        self._analyze_calls = 0

    def load(self) -> None:
        return None

    def status(self) -> EngineStatus:
        return EngineStatus(
            state=ENGINE_STATE_READY,
            engine_name="fake-compare",
            model_name="fake",
            model_identity="fake-id",
            provider="CPUExecutionProvider",
            embedding_dimension=512,
        )

    def metadata(self) -> EngineMetadata:
        return EngineMetadata(
            engine_name="fake-compare",
            library_version="0.0.0",
            model_name="fake",
            model_identity="fake-id",
            provider="CPUExecutionProvider",
            embedding_dimension=512,
            normalization="l2",
            detection_module="scrfd",
            recognition_module="arcface",
        )

    def detect_faces(self, image):  # pragma: no cover — unused
        return list(self.analyze(image))

    def extract_embeddings(self, image, faces):  # pragma: no cover — unused
        if not faces:
            return []
        return [self._embeddings[0]]

    def build_index(self, candidates):  # pragma: no cover — unused
        return []

    def recognize_faces(self, image, index):  # pragma: no cover — unused
        return []

    def analyze(self, image):
        idx = min(self._analyze_calls, len(self._detection_sequence) - 1)
        self._analyze_calls += 1
        return list(self._detection_sequence[idx])


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
    return DetectedFace(
        bbox=__import__("app.engine.base", fromlist=["BoundingBox"]).BoundingBox(
            x=x, y=10.0, width=40.0, height=40.0
        ),
        detection_score=score,
        landmarks=[],
        quality=None,
    )


def test_compare_rejects_when_first_image_has_no_face(
    _secret: str,
    no_face_png: bytes,
) -> None:
    a = _png(64, 48)
    emb = l2_normalize(
        FaceEmbedding(vector=tuple([1.0, 0.0]), dimension=2)
    )
    engine = _FakeCompareEngine(
        detection_sequence=[[], [_face()]],
        embeddings=[emb],
    )
    set_engine(engine)
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/compare",
            headers={"X-Service-Token": _secret},
            files={
                "image_a": ("a.png", a, "image/png"),
                "image_b": ("b.png", no_face_png, "image/png"),
            },
        )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "NO_FACE"


def test_compare_rejects_when_second_image_has_no_face(
    _secret: str,
    no_face_png: bytes,
) -> None:
    b = _png(64, 48)
    emb = l2_normalize(FaceEmbedding(vector=tuple([1.0, 0.0]), dimension=2))
    engine = _FakeCompareEngine(
        detection_sequence=[[_face()], []],
        embeddings=[emb],
    )
    set_engine(engine)
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/compare",
            headers={"X-Service-Token": _secret},
            files={
                "image_a": ("a.png", b, "image/png"),
                "image_b": ("b.png", no_face_png, "image/png"),
            },
        )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "NO_FACE"


def test_compare_rejects_when_first_image_has_multiple_faces(
    _secret: str,
    no_face_png: bytes,
) -> None:
    emb = l2_normalize(FaceEmbedding(vector=tuple([1.0, 0.0]), dimension=2))
    engine = _FakeCompareEngine(
        detection_sequence=[[_face(), _face(x=80.0)], [_face()]],
        embeddings=[emb],
    )
    set_engine(engine)
    a = _png(200, 200)
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/compare",
            headers={"X-Service-Token": _secret},
            files={
                "image_a": ("a.png", a, "image/png"),
                "image_b": ("b.png", no_face_png, "image/png"),
            },
        )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "MULTIPLE_FACES"


def test_compare_rejects_when_second_image_has_multiple_faces(
    _secret: str,
    no_face_png: bytes,
) -> None:
    emb = l2_normalize(FaceEmbedding(vector=tuple([1.0, 0.0]), dimension=2))
    engine = _FakeCompareEngine(
        detection_sequence=[[_face()], [_face(), _face(x=80.0)]],
        embeddings=[emb],
    )
    set_engine(engine)
    a = _png(200, 200)
    b = _png(200, 200)
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/compare",
            headers={"X-Service-Token": _secret},
            files={
                "image_a": ("a.png", a, "image/png"),
                "image_b": ("b.png", b, "image/png"),
            },
        )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "MULTIPLE_FACES"


def test_compare_returns_match_for_identical_embeddings(_secret: str) -> None:
    emb = l2_normalize(FaceEmbedding(vector=tuple([1.0, 1.0, 1.0]), dimension=3))
    engine = _FakeCompareEngine(
        detection_sequence=[[_face()], [_face()]],
        embeddings=[emb],
    )
    set_engine(engine)
    a = _png(64, 48)
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/compare",
            headers={"X-Service-Token": _secret},
            files={
                "image_a": ("a.png", a, "image/png"),
                "image_b": ("b.png", a, "image/png"),
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["match"] is True
    assert body["similarity"] > 0.99
    assert "processing_ms" in body


def test_compare_returns_no_match_for_orthogonal_embeddings(_secret: str) -> None:
    emb_a = l2_normalize(FaceEmbedding(vector=tuple([1.0, 0.0]), dimension=2))
    emb_b = l2_normalize(FaceEmbedding(vector=tuple([0.0, 1.0]), dimension=2))
    # The fake engine returns emb_a for first call, emb_b for second — but
    # extract_embeddings is wired to return [emb_a]. Use two engines to
    # exercise the orthogonal path instead.
    class _SplitEngine(_FakeCompareEngine):
        def __init__(self, ea: FaceEmbedding, eb: FaceEmbedding) -> None:
            super().__init__(
                detection_sequence=[[_face()], [_face()]],
                embeddings=[ea, eb],
            )
            self._i = 0

        def extract_embeddings(self, image, faces):
            out = [self._embeddings[self._i]]
            self._i += 1
            return out

    engine = _SplitEngine(emb_a, emb_b)
    set_engine(engine)
    a = _png(64, 48)
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/compare",
            headers={"X-Service-Token": _secret},
            files={
                "image_a": ("a.png", a, "image/png"),
                "image_b": ("b.png", a, "image/png"),
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["match"] is False
    assert body["similarity"] < 0.01


def test_compare_returns_engine_not_ready_when_no_engine(
    _secret: str,
    no_face_png: bytes,
) -> None:
    set_engine(None)
    a = _png(64, 48)
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/compare",
            headers={"X-Service-Token": _secret},
            files={
                "image_a": ("a.png", a, "image/png"),
                "image_b": ("b.png", a, "image/png"),
            },
        )
    assert r.status_code == 503
    assert r.json()["error"]["code"] == "ENGINE_NOT_READY"
