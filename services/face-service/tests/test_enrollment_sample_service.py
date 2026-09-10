"""Unit tests for the enrollment sample service.

These tests bypass the real InsightFace model. They install a fake
``FaceEngine`` whose ``analyze`` returns a configured sequence of
``DetectedFace`` objects and whose ``extract_embeddings`` returns a
configurable ``FaceEmbedding``. The fake engine reports ``ready`` so the
service can run end-to-end without booting real ONNX Runtime.

PHASE 3 surface is unchanged — this file only covers PHASE 4.3 service
behaviour (face-count errors, accepted branch, rejected branch, model
metadata propagation, embedding validation).
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from app.engine.base import FaceEngine, set_engine
from app.engine.matcher import MatcherError
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
from app.services.enrollment_sample_service import (
    EnrollmentDomainError,
    analyze_enrollment_sample,
)


# --- fake engine ----------------------------------------------------------


class _FakeEnrollmentEngine(FaceEngine):
    """Fake engine used to exercise the service in isolation."""

    name = "fake-enrollment"
    model = "fake"
    provider = "CPUExecutionProvider"

    def __init__(
        self,
        faces_to_return: list[DetectedFace],
        embedding_to_return: FaceEmbedding | None = None,
    ) -> None:
        self._faces = faces_to_return
        self._embedding = embedding_to_return or _unit_embedding(512)

    def load(self) -> None:
        return None

    def status(self) -> EngineStatus:
        return EngineStatus(
            state=ENGINE_STATE_READY,
            engine_name="fake-enrollment",
            model_name="fake",
            model_identity="fake-identity-v1",
            provider="CPUExecutionProvider",
            embedding_dimension=512,
        )

    def metadata(self) -> EngineMetadata:
        return EngineMetadata(
            engine_name="fake-enrollment",
            library_version="0.0.0",
            model_name="fake",
            model_identity="fake-identity-v1",
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


def _unit_embedding(dim: int = 512) -> FaceEmbedding:
    arr = np.zeros(dim, dtype=np.float32)
    arr[0] = 1.0
    return FaceEmbedding(vector=tuple(float(x) for x in arr), dimension=dim)


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
def _thresholds(monkeypatch: pytest.MonkeyPatch) -> None:
    """Push thresholds into the safe 'good' zone so good_quality passes."""
    monkeypatch.setenv("FACE_ENROLLMENT_MIN_DETECTION_SCORE", "0.7")
    monkeypatch.setenv("FACE_ENROLLMENT_MIN_FACE_AREA", "0.03")
    monkeypatch.setenv("FACE_ENROLLMENT_MAX_FACE_AREA", "0.6")
    monkeypatch.setenv("FACE_ENROLLMENT_MIN_BLUR_SCORE", "80")
    monkeypatch.setenv("FACE_ENROLLMENT_MIN_BRIGHTNESS", "0.18")
    monkeypatch.setenv("FACE_ENROLLMENT_MAX_BRIGHTNESS", "0.85")
    from app.core.config import get_settings

    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield
    get_settings.cache_clear()  # type: ignore[attr-defined]


# --- 11. zero faces → NO_FACE ---------------------------------------------


def test_service_zero_faces_raises_no_face(_thresholds) -> None:
    set_engine(_FakeEnrollmentEngine(faces_to_return=[]))
    with pytest.raises(EnrollmentDomainError) as exc:
        analyze_enrollment_sample(_png(64, 48))
    assert exc.value.code == "NO_FACE"


# --- 12. multiple faces → MULTIPLE_FACES ----------------------------------


def test_service_multiple_faces_raises_multiple_faces(_thresholds) -> None:
    faces = [_face(_good_quality()), _face(_good_quality())]
    set_engine(_FakeEnrollmentEngine(faces_to_return=faces))
    with pytest.raises(EnrollmentDomainError) as exc:
        analyze_enrollment_sample(_png(200, 200))
    assert exc.value.code == "MULTIPLE_FACES"


# --- 13. one good face → accepted -----------------------------------------


def test_service_one_good_face_accepted(_thresholds) -> None:
    set_engine(_FakeEnrollmentEngine(faces_to_return=[_face(_good_quality())]))
    response = analyze_enrollment_sample(_png(200, 200))
    assert response.accepted is True
    assert response.rejection_reasons == []


# --- 14. rejected quality → no embedding returned -------------------------


def test_service_rejected_quality_returns_no_embedding(_thresholds) -> None:
    set_engine(_FakeEnrollmentEngine(faces_to_return=[_face(_bad_quality())]))
    response = analyze_enrollment_sample(_png(200, 200))
    assert response.accepted is False
    assert response.embedding is None
    assert response.model is None
    assert len(response.rejection_reasons) >= 1


# --- 15. accepted sample → normalized embedding returned ------------------


def test_service_accepted_sample_returns_normalised_embedding(_thresholds) -> None:
    set_engine(_FakeEnrollmentEngine(faces_to_return=[_face(_good_quality())]))
    response = analyze_enrollment_sample(_png(200, 200))
    assert response.accepted is True
    assert response.embedding is not None
    assert len(response.embedding) == 512
    norm = math.sqrt(sum(v * v for v in response.embedding))
    assert math.isclose(norm, 1.0, rel_tol=1e-4)


# --- 16. invalid embedding rejected safely --------------------------------


def test_service_invalid_embedding_raises_matcher_error(_thresholds) -> None:
    """An embedding whose declared dimension does not match the engine
    metadata is rejected by the validation step inside the service.
    """
    bad = FaceEmbedding(vector=tuple([1.0, 0.0]), dimension=2)
    set_engine(_FakeEnrollmentEngine(faces_to_return=[_face(_good_quality())], embedding_to_return=bad))
    with pytest.raises(MatcherError) as exc:
        analyze_enrollment_sample(_png(200, 200))
    assert exc.value.code == "INVALID_EMBEDDING"


def test_service_non_unit_norm_embedding_rejected(_thresholds) -> None:
    arr = np.zeros(512, dtype=np.float32)
    arr[0] = 2.0  # not unit-norm
    bad = FaceEmbedding(vector=tuple(float(x) for x in arr), dimension=512)
    set_engine(_FakeEnrollmentEngine(faces_to_return=[_face(_good_quality())], embedding_to_return=bad))
    with pytest.raises(MatcherError) as exc:
        analyze_enrollment_sample(_png(200, 200))
    assert exc.value.code == "INVALID_EMBEDDING"


# --- 17. engine/model metadata propagated correctly ----------------------


def test_service_propagates_model_metadata_in_accepted_response(_thresholds) -> None:
    set_engine(_FakeEnrollmentEngine(faces_to_return=[_face(_good_quality())]))
    response = analyze_enrollment_sample(_png(200, 200))
    assert response.model is not None
    assert response.model.identity == "fake-identity-v1"
    assert response.model.name == "fake"
    assert response.model.embedding_dimension == 512
    assert response.model.normalization == "l2"


def test_service_does_not_propagate_model_metadata_on_rejection(_thresholds) -> None:
    set_engine(_FakeEnrollmentEngine(faces_to_return=[_face(_bad_quality())]))
    response = analyze_enrollment_sample(_png(200, 200))
    assert response.accepted is False
    assert response.model is None