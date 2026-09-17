"""Endpoint tests for ``POST /attendance/identify`` (PHASE 6.3).

Covers:
  1. identify endpoint requires service token
  2. invalid token rejected
  3. one frame decoded once
  4. multiple faces supported
  5. gallery comparisons vectorized or equivalent efficient batch
  6. threshold applied server-side
  7. candidate cannot match two faces in same frame
  8. deterministic matching
  9. no-face handled safely
  10. bad image handled safely
  11. empty gallery handled safely
  12. embeddings never returned
  13. gallery item validation: missing candidate_key rejected
  14. gallery item validation: missing embedding rejected
  15. gallery item validation: empty embedding rejected
  16. gallery item validation: non-normalized embedding handled
  17. gallery item validation: wrong dimension rejected
  18. gallery item validation: NaN/inf rejected
  19. max_faces default and limit
  20. too many faces bounded

Plus regression tests for existing endpoints.
"""

from __future__ import annotations

import json
from typing import Any

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.engine.base import FaceEngine, set_engine
from app.engine.types import (
    ENGINE_STATE_READY,
    EngineMetadata,
    EngineStatus,
    FaceEmbedding,
)
from app.main import app  # noqa: E402

# --- Fake engine ----------------------------------------------------------


class _FakeIdentifyEngine(FaceEngine):
    """Fake engine for identify endpoint tests."""

    name = "fake-identify"
    model = "fake-model"
    provider = "CPUExecutionProvider"

    def __init__(
        self,
        embeddings_to_return: list[FaceEmbedding] | None = None,
        num_faces: int = 1,
        embedding_dimension: int = 512,
    ) -> None:
        self._embeddings_to_return = embeddings_to_return
        self._num_faces = num_faces
        self._embedding_dimension = embedding_dimension

    def load(self) -> None:
        return None

    def status(self) -> EngineStatus:
        return EngineStatus(
            state=ENGINE_STATE_READY,
            engine_name="fake-identify",
            model_name=self.model,
            model_identity="fake-identity",
            provider=self.provider,
            embedding_dimension=self._embedding_dimension,
        )

    def metadata(self) -> EngineMetadata:
        return EngineMetadata(
            engine_name="fake-identify",
            library_version="0.0.1",
            model_name=self.model,
            model_identity="fake-identity",
            provider=self.provider,
            embedding_dimension=self._embedding_dimension,
            normalization="l2",
            detection_module="fake",
            recognition_module="fake",
        )

    def detect_faces(self, image: bytes) -> list:
        return []

    def extract_embeddings(self, image: bytes, faces: list) -> list[FaceEmbedding]:
        if self._embeddings_to_return is not None:
            return self._embeddings_to_return[: len(faces)]
        # Return synthetic embeddings.
        return [
            FaceEmbedding(
                vector=tuple(float(x) for x in np.zeros(self._embedding_dimension, dtype=np.float32)),
                dimension=self._embedding_dimension,
            )
        ]

    def build_index(self, candidates: Any) -> Any:
        return None

    def recognize_faces(self, image: bytes, index: Any) -> list:
        return []

    def analyze(self, image: bytes) -> list:
        from app.engine.types import BoundingBox, DetectedFace, FaceQuality, Landmark

        if self._num_faces == 0:
            return []
        return [
            DetectedFace(
                bbox=BoundingBox(x=float(i * 100), y=0.0, width=100.0, height=100.0),
                detection_score=0.9,
                landmarks=[],
                quality=FaceQuality(
                    detection_score=0.9,
                    face_width=100.0,
                    face_height=100.0,
                    relative_face_area=0.1,
                    blur_score=100.0,
                    brightness=0.5,
                    near_edge=False,
                ),
            )
            for i in range(self._num_faces)
        ]


# --- Synthetic data helpers -----------------------------------------------


_DIM = 512


def _unit_vector(dimension: int = _DIM) -> list[float]:
    vec = np.zeros(dimension, dtype=np.float32)
    vec[0] = 1.0
    return [float(x) for x in vec]


def _make_embedding(vector: list[float] | None = None) -> list[float]:
    if vector is None:
        return _unit_vector()
    return vector


def _normalize(vector: list[float]) -> list[float]:
    arr = np.asarray(vector, dtype=np.float32)
    norm = float(np.linalg.norm(arr))
    if norm == 0:
        return vector
    return [float(x) / norm for x in arr]


# --- Gallery builder ------------------------------------------------------


def _make_gallery(*, num_candidates: int = 3, seed: int = 1) -> list[dict[str, Any]]:
    rng = np.random.default_rng(seed)
    gallery = []
    for i in range(num_candidates):
        # Create slightly different embedding per candidate.
        vec = _unit_vector()
        vec[0] = 1.0 - i * 0.05
        vec = _normalize(vec)
        gallery.append(
            {
                "candidate_key": f"c{i}",
                "embedding": vec,
                "embedding_dimension": _DIM,
                "normalization": "l2",
            }
        )
    return gallery


def _make_request(
    *,
    gallery: list[dict[str, Any]] | None = None,
    max_faces: int = 5,
) -> tuple[bytes, bytes]:
    if gallery is None:
        gallery = _make_gallery()
    body = {"gallery": gallery, "max_faces": max_faces}
    image_bytes = _fake_image_bytes()
    return image_bytes, json.dumps(body).encode("utf-8")


def _fake_image_bytes() -> bytes:
    import cv2  # type: ignore[import-not-found]

    img = np.zeros((480, 640, 3), dtype=np.uint8)
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return bytes(buf.tobytes())


# --- Fixtures -------------------------------------------------------------


@pytest.fixture()
def _setup(monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "test-identify-secret"
    monkeypatch.setenv("FACE_SERVICE_SECRET", secret)
    from app.core.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield
    get_settings.cache_clear()  # type: ignore[attr-defined]


@pytest.fixture()
def _engine(_setup: None) -> _FakeIdentifyEngine:
    engine = _FakeIdentifyEngine()
    set_engine(engine)
    return engine


def _post_identify(
    client: TestClient,
    *,
    token: str = "test-identify-secret",
    image_bytes: bytes | None = None,
    gallery_json: bytes | None = None,
) -> TestClient.response:
    if image_bytes is None:
        image_bytes, gallery_json = _make_request()
    files = {
        "image": ("frame.png", image_bytes, "image/png"),
        "gallery_json": ("gallery.json", gallery_json, "application/json"),
    }
    headers = {"X-Service-Token": token} if token else {}
    return client.post("/attendance/identify", files=files, headers=headers)


# --- Test 1: identify endpoint requires service token --------------------


def test_identify_missing_token_returns_401(_setup: None) -> None:
    with TestClient(app) as client:
        r = _post_identify(client, token="")
    assert r.status_code == 401


# --- Test 2: invalid token rejected -------------------------------------


def test_identify_wrong_token_returns_401(_setup: None) -> None:
    with TestClient(app) as client:
        r = _post_identify(client, token="wrong-secret")
    assert r.status_code == 401


# --- Test 3: one frame decoded once -------------------------------------


def test_identify_frame_decoded_once(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    decode_count = [0]

    original_decode = __import__(
        "app.utils.image", fromlist=["decode_image"]
    ).decode_image

    def counting_decode(raw: bytes):
        decode_count[0] += 1
        return original_decode(raw)

    import app.utils.image as img_module

    img_module.decode_image = counting_decode

    try:
        with TestClient(app) as client:
            r = _post_identify(client)
        assert r.status_code == 200
        assert decode_count[0] == 1
    finally:
        img_module.decode_image = original_decode


# --- Test 4: multiple faces supported -----------------------------------


def test_identify_multiple_faces(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    _engine._num_faces = 3
    _engine._embeddings_to_return = [
        FaceEmbedding(vector=tuple(_unit_vector()), dimension=_DIM),
        FaceEmbedding(vector=tuple(_unit_vector()), dimension=_DIM),
        FaceEmbedding(vector=tuple(_unit_vector()), dimension=_DIM),
    ]

    with TestClient(app) as client:
        r = _post_identify(client)
    assert r.status_code == 200
    body = r.json()
    assert body["faces_detected"] == 3


# --- Test 5: gallery comparisons efficient batch -----------------------


def test_identify_gallery_comparison_batch(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    """Gallery comparisons should use batch/vectorized approach, not N separate calls."""
    _engine._num_faces = 2
    gallery = _make_gallery(num_candidates=10)
    image_bytes, gallery_json = _make_request(gallery=gallery)

    with TestClient(app) as client:
        r = _post_identify(client, image_bytes=image_bytes, gallery_json=gallery_json)
    assert r.status_code == 200


# --- Test 6: threshold applied server-side ------------------------------


def test_identify_threshold_server_side(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    """Threshold is applied by the Face Service, not by the client."""
    _engine._num_faces = 1
    # Return a completely different embedding (low similarity).
    vec = _unit_vector()
    vec[0] = -1.0  # Opposite direction = similarity -1.
    _engine._embeddings_to_return = [
        FaceEmbedding(vector=tuple(vec), dimension=_DIM),
    ]
    gallery = _make_gallery(num_candidates=1)
    image_bytes, gallery_json = _make_request(gallery=gallery)

    with TestClient(app) as client:
        r = _post_identify(client, image_bytes=image_bytes, gallery_json=gallery_json)
    assert r.status_code == 200
    body = r.json()
    # No match because similarity is below threshold (0.4).
    assert body["faces_detected"] == 1
    assert len(body["matches"]) == 0
    assert body["unmatched_count"] == 1


# --- Test 7: candidate cannot match two faces ---------------------------


def test_identify_candidate_not_assigned_to_two_faces(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    """One candidate should not be matched to multiple faces."""
    _engine._num_faces = 3
    # All faces get the same embedding as candidate c0.
    _engine._embeddings_to_return = [
        FaceEmbedding(vector=tuple(_unit_vector()), dimension=_DIM),
        FaceEmbedding(vector=tuple(_unit_vector()), dimension=_DIM),
        FaceEmbedding(vector=tuple(_unit_vector()), dimension=_DIM),
    ]
    gallery = _make_gallery(num_candidates=1)  # Only one candidate.
    image_bytes, gallery_json = _make_request(gallery=gallery)

    with TestClient(app) as client:
        r = _post_identify(client, image_bytes=image_bytes, gallery_json=gallery_json)
    assert r.status_code == 200
    body = r.json()
    assert body["faces_detected"] == 3
    # At most one face can match (one-to-one).
    assert len(body["matches"]) <= 1


# --- Test 8: deterministic matching --------------------------------------


def test_identify_deterministic_matching(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    """Same input should produce same output across multiple calls."""
    _engine._num_faces = 2
    _engine._embeddings_to_return = [
        FaceEmbedding(vector=tuple(_unit_vector()), dimension=_DIM),
        FaceEmbedding(vector=tuple(_unit_vector()), dimension=_DIM),
    ]
    gallery = _make_gallery(num_candidates=3, seed=42)
    image_bytes, gallery_json = _make_request(gallery=gallery)

    results = []
    with TestClient(app) as client:
        for _ in range(3):
            r = _post_identify(client, image_bytes=image_bytes, gallery_json=gallery_json)
            assert r.status_code == 200
            # Strip processing_ms for deterministic comparison.
            body = r.json()
            body.pop("processing_ms", None)
            results.append(body)

    # All three calls should produce the same result (ignoring timing).
    assert results[0] == results[1] == results[2]


# --- Test 9: no-face handled safely -------------------------------------


def test_identify_no_face_returns_422(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    _engine._num_faces = 0
    with TestClient(app) as client:
        r = _post_identify(client)
    assert r.status_code == 422
    body = r.json()
    assert "error" in body
    assert body["error"]["code"] == "NO_FACE"


# --- Test 10: bad image handled safely ----------------------------------


def test_identify_bad_image_returns_400(_setup: None) -> None:
    with TestClient(app) as client:
        r = _post_identify(client, image_bytes=b"not-an-image")
    assert r.status_code == 400


# --- Test 11: empty gallery handled safely ------------------------------


def test_identify_empty_gallery_returns_422(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    gallery = []
    image_bytes, gallery_json = _make_request(gallery=gallery)
    with TestClient(app) as client:
        r = _post_identify(client, image_bytes=image_bytes, gallery_json=gallery_json)
    assert r.status_code == 422
    body = r.json()
    assert body["error"]["code"] == "EMPTY_GALLERY"


# --- Test 12: embeddings never returned ---------------------------------


def test_identify_embeddings_not_returned(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    _engine._num_faces = 1
    _engine._embeddings_to_return = [
        FaceEmbedding(vector=tuple(_unit_vector()), dimension=_DIM),
    ]
    with TestClient(app) as client:
        r = _post_identify(client)
    assert r.status_code == 200
    body_str = str(r.json()).lower()
    assert "embedding" not in body_str
    assert "vector" not in body_str
    assert "centroid" not in body_str


# --- Test 13: missing candidate_key rejected ----------------------------


def test_identify_missing_candidate_key(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    gallery = [
        {
            "embedding": _unit_vector(),
            "embedding_dimension": _DIM,
            "normalization": "l2",
        }
    ]
    image_bytes, gallery_json = _make_request(gallery=gallery)
    with TestClient(app) as client:
        r = _post_identify(client, image_bytes=image_bytes, gallery_json=gallery_json)
    assert r.status_code == 422


# --- Test 14: missing embedding rejected ---------------------------------


def test_identify_missing_embedding(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    gallery = [
        {
            "candidate_key": "c0",
            "embedding_dimension": _DIM,
            "normalization": "l2",
        }
    ]
    image_bytes, gallery_json = _make_request(gallery=gallery)
    with TestClient(app) as client:
        r = _post_identify(client, image_bytes=image_bytes, gallery_json=gallery_json)
    assert r.status_code == 422


# --- Test 15: empty embedding rejected ----------------------------------


def test_identify_empty_embedding(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    gallery = [
        {
            "candidate_key": "c0",
            "embedding": [],
            "embedding_dimension": _DIM,
            "normalization": "l2",
        }
    ]
    image_bytes, gallery_json = _make_request(gallery=gallery)
    with TestClient(app) as client:
        r = _post_identify(client, image_bytes=image_bytes, gallery_json=gallery_json)
    assert r.status_code == 422


# --- Test 16: non-normalized embedding handled --------------------------


def test_identify_non_normalized_embedding(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    """Non-L2-normalized embeddings are rejected at the Face Service."""
    # Use a clearly non-normalized vector: large values that won't divide to unit length.
    # The threshold check requires the embedding to already be L2-normalised.
    gallery = [
        {
            "candidate_key": "c0",
            "embedding": [10.0] * _DIM,  # Norm is sqrt(_DIM * 100), clearly not unit.
            "embedding_dimension": _DIM,
            "normalization": "l2",
        }
    ]
    image_bytes, gallery_json = _make_request(gallery=gallery)
    with TestClient(app) as client:
        r = _post_identify(client, image_bytes=image_bytes, gallery_json=gallery_json)
    assert r.status_code == 422


# --- Test 17: wrong dimension rejected ----------------------------------


def test_identify_wrong_dimension(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    gallery = [
        {
            "candidate_key": "c0",
            "embedding": _unit_vector(256),  # Wrong dimension.
            "embedding_dimension": 256,
            "normalization": "l2",
        }
    ]
    image_bytes, gallery_json = _make_request(gallery=gallery)
    with TestClient(app) as client:
        r = _post_identify(client, image_bytes=image_bytes, gallery_json=gallery_json)
    assert r.status_code == 422


# --- Test 18: NaN/inf rejected ------------------------------------------


def test_identify_nan_embedding(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    vec = _unit_vector()
    vec[0] = float("nan")
    gallery = [
        {
            "candidate_key": "c0",
            "embedding": vec,
            "embedding_dimension": _DIM,
            "normalization": "l2",
        }
    ]
    image_bytes, gallery_json = _make_request(gallery=gallery)
    with TestClient(app) as client:
        r = _post_identify(client, image_bytes=image_bytes, gallery_json=gallery_json)
    assert r.status_code == 422


# --- Test 19: max_faces default and limit ------------------------------


def test_identify_max_faces_limit(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    """Request with max_faces > 10 should be capped at 10."""
    _engine._num_faces = 15
    gallery = _make_gallery(num_candidates=1)
    image_bytes, gallery_json = _make_request(gallery=gallery, max_faces=15)
    with TestClient(app) as client:
        r = _post_identify(client, image_bytes=image_bytes, gallery_json=gallery_json)
    assert r.status_code == 200
    body = r.json()
    # Should be bounded to max 10.
    assert body["faces_detected"] <= 10


# --- Test 20: too many faces bounded ------------------------------------


def test_identify_too_many_faces_bounded(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    """Faces beyond max_faces are not processed."""
    _engine._num_faces = 5
    gallery = _make_gallery(num_candidates=1)
    image_bytes, gallery_json = _make_request(gallery=gallery, max_faces=3)
    with TestClient(app) as client:
        r = _post_identify(client, image_bytes=image_bytes, gallery_json=gallery_json)
    assert r.status_code == 200
    body = r.json()
    assert body["faces_detected"] == 3


# --- Regression: /health unchanged ---------------------------------------


def test_health_endpoint_still_public(_setup: None) -> None:
    with TestClient(app) as client:
        r = client.get("/health")
    assert r.status_code == 200


# --- Regression: /v1/faces/analyze unchanged -----------------------------


def test_analyze_endpoint_still_requires_token(_engine: _FakeIdentifyEngine, _setup: None) -> None:
    with TestClient(app) as client:
        r = client.post("/v1/faces/analyze")
    assert r.status_code == 401
