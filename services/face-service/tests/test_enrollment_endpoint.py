"""Endpoint tests for ``POST /v1/faces/enrollment/sample``.

Covers:

- service-token enforcement (18, 19)
- existing INVALID_IMAGE contract on malformed input (20)
- NO_FACE / MULTIPLE_FACES contract preserved (21, 22)
- poor-quality single face → 200 with ``accepted=false`` (23)
- good-quality single face → 200 with ``accepted=true`` (24)
- model metadata included in accepted response (25)
- embedding omitted on rejection (26)
- embedding present on accept (27)
- PHASE 3 ``/v1/faces/analyze`` still does NOT return embeddings (28)

PHASE 3 security tests live in ``test_security.py`` and are intentionally
left untouched; the new test cases below only add coverage for the
PHASE 4.3 endpoint.
"""

from __future__ import annotations

import math

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app.engine.base import FaceEngine, set_engine
from app.engine.types import (
    BoundingBox,
    DetectedFace,
    ENGINE_STATE_READY,
    EngineMetadata,
    EngineStatus,
    FaceEmbedding,
    FaceQuality,
    Landmark,
)
from app.main import app


# --- fake engine ----------------------------------------------------------


class _FakeEndpointEngine(FaceEngine):
    name = "fake-endpoint"
    model = "fake"
    provider = "CPUExecutionProvider"

    def __init__(self, faces_to_return: list[DetectedFace]) -> None:
        self._faces = faces_to_return
        arr = np.zeros(512, dtype=np.float32)
        arr[0] = 1.0
        self._embedding = FaceEmbedding(
            vector=tuple(float(x) for x in arr), dimension=512
        )

    def load(self) -> None:
        return None

    def status(self) -> EngineStatus:
        return EngineStatus(
            state=ENGINE_STATE_READY,
            engine_name="fake-endpoint",
            model_name="fake",
            model_identity="fake-identity-endpoint",
            provider="CPUExecutionProvider",
            embedding_dimension=512,
        )

    def metadata(self) -> EngineMetadata:
        return EngineMetadata(
            engine_name="fake-endpoint",
            library_version="0.0.0",
            model_name="fake",
            model_identity="fake-identity-endpoint",
            provider="CPUExecutionProvider",
            embedding_dimension=512,
            normalization="l2",
            detection_module="scrfd",
            recognition_module="arcface",
        )

    def detect_faces(self, image):  # pragma: no cover — unused
        return list(self.analyze(image))

    def extract_embeddings(self, image, faces):
        if not faces:
            return []
        return [self._embedding]

    def build_index(self, candidates):  # pragma: no cover — unused
        return []

    def recognize_faces(self, image, index):  # pragma: no cover — unused
        return []

    def analyze(self, image):
        return list(self._faces)


# --- helpers --------------------------------------------------------------


def _png(width: int, height: int) -> bytes:
    import cv2  # type: ignore[import-not-found]

    img = np.zeros((height, width, 3), dtype=np.uint8)
    img[:] = (96, 128, 160)
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return bytes(buf.tobytes())


def _face(quality: FaceQuality) -> DetectedFace:
    return DetectedFace(
        bbox=BoundingBox(x=50.0, y=50.0, width=120.0, height=120.0),
        detection_score=quality.detection_score,
        landmarks=[
            Landmark(x=60.0, y=70.0),
            Landmark(x=160.0, y=70.0),
            Landmark(x=110.0, y=130.0),
            Landmark(x=60.0, y=170.0),
            Landmark(x=160.0, y=170.0),
        ],
        quality=quality,
    )


def _good_quality() -> FaceQuality:
    return FaceQuality(
        detection_score=0.95,
        face_width=120.0,
        face_height=120.0,
        relative_face_area=0.06,
        blur_score=400.0,
        brightness=0.5,
        near_edge=False,
    )


def _bad_quality() -> FaceQuality:
    return FaceQuality(
        detection_score=0.3,
        face_width=10.0,
        face_height=10.0,
        relative_face_area=0.005,
        blur_score=5.0,
        brightness=0.05,
        near_edge=True,
    )


@pytest.fixture()
def _secret(monkeypatch: pytest.MonkeyPatch) -> str:
    secret = "test-secret-value-long-enough"
    monkeypatch.setenv("FACE_SERVICE_SECRET", secret)
    monkeypatch.setenv("FACE_ENROLLMENT_MIN_DETECTION_SCORE", "0.7")
    monkeypatch.setenv("FACE_ENROLLMENT_MIN_FACE_AREA", "0.03")
    monkeypatch.setenv("FACE_ENROLLMENT_MAX_FACE_AREA", "0.6")
    monkeypatch.setenv("FACE_ENROLLMENT_MIN_BLUR_SCORE", "80")
    monkeypatch.setenv("FACE_ENROLLMENT_MIN_BRIGHTNESS", "0.18")
    monkeypatch.setenv("FACE_ENROLLMENT_MAX_BRIGHTNESS", "0.85")
    from app.core.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield secret
    get_settings.cache_clear()  # type: ignore[attr-defined]


# --- 18. missing token → unauthorized -------------------------------------


def test_enrollment_endpoint_rejects_without_token(_secret: str) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/sample",
            files={"image": ("x.png", _png(200, 200), "image/png")},
        )
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "FACE_SERVICE_UNAUTHORIZED"


# --- 19. wrong token → unauthorized ---------------------------------------


def test_enrollment_endpoint_rejects_wrong_token(_secret: str) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/sample",
            headers={"X-Service-Token": "wrong"},
            files={"image": ("x.png", _png(200, 200), "image/png")},
        )
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "FACE_SERVICE_UNAUTHORIZED"


# --- 20. invalid image → INVALID_IMAGE contract ---------------------------


def test_enrollment_endpoint_rejects_invalid_image(_secret: str) -> None:
    set_engine(_FakeEndpointEngine([]))
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/sample",
            headers={"X-Service-Token": _secret},
            files={"image": ("x.png", b"not-an-image", "image/png")},
        )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "INVALID_IMAGE"


def test_enrollment_endpoint_rejects_empty_upload(_secret: str) -> None:
    set_engine(_FakeEndpointEngine([]))
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/sample",
            headers={"X-Service-Token": _secret},
            files={"image": ("x.png", b"", "image/png")},
        )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "INVALID_IMAGE"


# --- 21. no-face → NO_FACE -----------------------------------------------


def test_enrollment_endpoint_no_face_returns_no_face_error(_secret: str) -> None:
    set_engine(_FakeEndpointEngine([]))
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/sample",
            headers={"X-Service-Token": _secret},
            files={"image": ("x.png", _png(200, 200), "image/png")},
        )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "NO_FACE"


# --- 22. multiple-face → MULTIPLE_FACES ----------------------------------


def test_enrollment_endpoint_multiple_faces_returns_multiple_faces_error(
    _secret: str,
) -> None:
    set_engine(_FakeEndpointEngine([_face(_good_quality()), _face(_good_quality())]))
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/sample",
            headers={"X-Service-Token": _secret},
            files={"image": ("x.png", _png(200, 200), "image/png")},
        )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "MULTIPLE_FACES"


# --- 23. poor-quality single face → accepted=false -----------------------


def test_enrollment_endpoint_poor_quality_returns_accepted_false(_secret: str) -> None:
    set_engine(_FakeEndpointEngine([_face(_bad_quality())]))
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/sample",
            headers={"X-Service-Token": _secret},
            files={"image": ("x.png", _png(200, 200), "image/png")},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["accepted"] is False
    assert isinstance(body["rejection_reasons"], list)
    assert len(body["rejection_reasons"]) >= 1


# --- 24. good-quality single face → HTTP success + accepted=true ---------


def test_enrollment_endpoint_good_quality_returns_accepted_true(_secret: str) -> None:
    set_engine(_FakeEndpointEngine([_face(_good_quality())]))
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/sample",
            headers={"X-Service-Token": _secret},
            files={"image": ("x.png", _png(200, 200), "image/png")},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["accepted"] is True
    assert body["rejection_reasons"] == []


# --- 25. good response includes model metadata ---------------------------


def test_enrollment_endpoint_accepted_response_includes_model_metadata(
    _secret: str,
) -> None:
    set_engine(_FakeEndpointEngine([_face(_good_quality())]))
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/sample",
            headers={"X-Service-Token": _secret},
            files={"image": ("x.png", _png(200, 200), "image/png")},
        )
    body = r.json()
    assert body["accepted"] is True
    assert body["model"] is not None
    assert body["model"]["identity"] == "fake-identity-endpoint"
    assert body["model"]["name"] == "fake"
    assert body["model"]["embedding_dimension"] == 512
    assert body["model"]["normalization"] == "l2"


# --- 26. rejected response contains no embedding --------------------------


def test_enrollment_endpoint_rejected_response_has_no_embedding(_secret: str) -> None:
    set_engine(_FakeEndpointEngine([_face(_bad_quality())]))
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/sample",
            headers={"X-Service-Token": _secret},
            files={"image": ("x.png", _png(200, 200), "image/png")},
        )
    body = r.json()
    assert body["accepted"] is False
    assert body["embedding"] is None
    assert body["model"] is None


# --- 27. accepted response contains embedding -----------------------------


def test_enrollment_endpoint_accepted_response_has_unit_norm_embedding(
    _secret: str,
) -> None:
    set_engine(_FakeEndpointEngine([_face(_good_quality())]))
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/sample",
            headers={"X-Service-Token": _secret},
            files={"image": ("x.png", _png(200, 200), "image/png")},
        )
    body = r.json()
    assert body["accepted"] is True
    embedding = body["embedding"]
    assert isinstance(embedding, list)
    assert len(embedding) == 512
    norm = math.sqrt(sum(v * v for v in embedding))
    assert math.isclose(norm, 1.0, rel_tol=1e-4)


# --- 28. /v1/faces/analyze still does NOT return embeddings ---------------


def test_analyze_endpoint_still_does_not_return_embeddings(_secret: str) -> None:
    """PHASE 3 regression guard — the new endpoint must not have leaked
    embedding exposure back into the existing /analyze contract.
    """
    set_engine(_FakeEndpointEngine([_face(_good_quality())]))
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/analyze",
            headers={"X-Service-Token": _secret},
            files={"file": ("x.png", _png(200, 200), "image/png")},
        )
    assert r.status_code == 200, r.text
    body_text = r.text.lower()
    # 'embedding' must not appear in the JSON body at all.
    assert "embedding" not in body_text
    assert "normed_embedding" not in body_text