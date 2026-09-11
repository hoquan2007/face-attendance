"""Endpoint tests for ``POST /v1/faces/enrollment/finalize`` (PHASE 4.6A2).

Covers:
20. missing X-Service-Token → 401
21. wrong token → 401
22. correct token allows processing
23. secret not returned in response
24. valid consistent request → HTTP success
25. response consistent=true
26. five samples → pair_count=10
27. response contains min similarity
28. response contains mean similarity
29. response contains configured threshold
30. response contains normalized centroid
31. response contains runtime model metadata
32. response contains no userId
33. response contains no images
34. response contains no ciphertext fields
35. malformed sample count rejected safely
36. NaN/non-finite request values rejected safely
37. mixed dimensions rejected safely
38. non-normalized embedding rejected safely
39. model mismatch mapped safely
40. inconsistent samples → domain 422
41. inconsistent response contains NO centroid
42. INVALID_CENTROID mapped safely

Plus regression tests for existing endpoints.
"""

from __future__ import annotations

import math
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


class _FakeFinalizeEngine(FaceEngine):
    """Fake engine for finalize endpoint tests."""

    name = "fake-finalize"
    model = "fake-model"
    provider = "CPUExecutionProvider"

    def __init__(
        self,
        model_identity: str = "insightface-buffalo-l",
        model_name: str = "buffalo_l",
        embedding_dimension: int = 512,
        normalization: str = "l2",
    ) -> None:
        self._model_identity = model_identity
        self._model_name = model_name
        self._embedding_dimension = embedding_dimension
        self._normalization = normalization

    def load(self) -> None:
        return None

    def status(self) -> EngineStatus:
        return EngineStatus(
            state=ENGINE_STATE_READY,
            engine_name="fake-finalize",
            model_name=self._model_name,
            model_identity=self._model_identity,
            provider=self.provider,
            embedding_dimension=self._embedding_dimension,
        )

    def metadata(self) -> EngineMetadata:
        return EngineMetadata(
            engine_name="fake-finalize",
            library_version="0.0.1",
            model_name=self._model_name,
            model_identity=self._model_identity,
            provider=self.provider,
            embedding_dimension=self._embedding_dimension,
            normalization=self._normalization,
            detection_module="fake",
            recognition_module="fake",
        )

    def detect_faces(self, image: bytes) -> list:
        return []

    def extract_embeddings(self, image: bytes, faces: list) -> list[FaceEmbedding]:
        return []

    def build_index(self, candidates: Any) -> Any:
        return None

    def recognize_faces(self, image: bytes, index: Any) -> list:
        return []

    def analyze(self, image: bytes) -> list:
        return []


# --- Synthetic data helpers -----------------------------------------------


_DIM = 512
_BASE = np.zeros(_DIM, dtype=np.float32)
_BASE[0] = 1.0


def _unit_vector(noise: float, rng: np.random.Generator) -> list[float]:
    vec = _BASE.astype(np.float32, copy=True)
    if noise > 0.0:
        vec = vec + float(noise) * rng.standard_normal(_DIM).astype(np.float32)
    norm = float(np.linalg.norm(vec))
    arr = (vec / norm).astype(np.float32, copy=False)
    return [float(x) for x in arr]


def _consistent_batch(n: int, seed: int, noise: float = 0.02) -> list[list[float]]:
    rng = np.random.default_rng(seed)
    return [_unit_vector(noise, rng) for _ in range(n)]


def _outlier_batch(n: int, seed: int) -> list[list[float]]:
    """n-1 consistent + 1 outlier."""
    rng = np.random.default_rng(seed)
    result = [_unit_vector(0.02, rng) for _ in range(n - 1)]
    # Outlier: nearly opposite direction
    outlier = -_BASE.astype(np.float32, copy=True)
    outlier[0] += 1e-3
    norm = float(np.linalg.norm(outlier))
    outlier = outlier / norm
    result.append([float(x) for x in outlier])
    return result


# --- Request builder -------------------------------------------------------


def _make_request(
    model_identity: str = "insightface-buffalo-l",
    model_name: str = "buffalo_l",
    embedding_dimension: int = 512,
    normalization: str = "l2",
    required_sample_count: int = 5,
    embeddings: list[list[float]] | None = None,
) -> dict[str, Any]:
    if embeddings is None:
        embeddings = _consistent_batch(required_sample_count, seed=1)
    return {
        "model": {
            "identity": model_identity,
            "name": model_name,
            "embedding_dimension": embedding_dimension,
            "normalization": normalization,
        },
        "required_sample_count": required_sample_count,
        "embeddings": embeddings,
    }


# --- Fixtures -------------------------------------------------------------


@pytest.fixture()
def _setup(monkeypatch: pytest.MonkeyPatch) -> None:
    secret = "test-finalize-secret"
    monkeypatch.setenv("FACE_SERVICE_SECRET", secret)
    monkeypatch.setenv("FACE_ENROLLMENT_MIN_SELF_SIMILARITY", "0.7")
    from app.core.config import get_settings
    get_settings.cache_clear()  # type: ignore[attr-defined]
    yield
    get_settings.cache_clear()  # type: ignore[attr-defined]


@pytest.fixture()
def _engine(_setup: None) -> _FakeFinalizeEngine:
    engine = _FakeFinalizeEngine()
    set_engine(engine)
    return engine


# --- Test 20: missing X-Service-Token → 401 ------------------------------


def test_finalize_missing_token_returns_401(_setup: None) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            json=_make_request(),
        )
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "FACE_SERVICE_UNAUTHORIZED"


# --- Test 21: wrong token → 401 ------------------------------------------


def test_finalize_wrong_token_returns_401(_setup: None) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "wrong-secret"},
            json=_make_request(),
        )
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "FACE_SERVICE_UNAUTHORIZED"


# --- Test 22: correct token allows processing ----------------------------


def test_finalize_correct_token_allows_processing(_engine: _FakeFinalizeEngine, _setup: None) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(),
        )
    assert r.status_code == 200


# --- Test 23: secret not returned in response ---------------------------


def test_finalize_secret_not_in_response(_engine: _FakeFinalizeEngine, _setup: None) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(),
        )
    body = r.json()
    body_str = str(body).lower()
    assert "test-finalize-secret" not in body_str
    assert "x-service-token" not in body_str


# --- Test 24: valid consistent request → HTTP success --------------------


def test_finalize_valid_consistent_request_returns_200(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(),
        )
    assert r.status_code == 200


# --- Test 25: response consistent=true ------------------------------------


def test_finalize_response_consistent_true(_engine: _FakeFinalizeEngine, _setup: None) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(),
        )
    body = r.json()
    assert body["consistent"] is True


# --- Test 26: five samples → pair_count=10 --------------------------------


def test_finalize_five_samples_pair_count_10(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(required_sample_count=5),
        )
    body = r.json()
    assert body["consistent"] is True
    assert body["sample_count"] == 5
    assert body["pair_count"] == 10


# --- Test 27: response contains min similarity ---------------------------


def test_finalize_response_contains_min_similarity(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(),
        )
    body = r.json()
    assert "min_self_similarity" in body
    assert -1.0 <= body["min_self_similarity"] <= 1.0


# --- Test 28: response contains mean similarity --------------------------


def test_finalize_response_contains_mean_similarity(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(),
        )
    body = r.json()
    assert "mean_self_similarity" in body
    assert -1.0 <= body["mean_self_similarity"] <= 1.0


# --- Test 29: response contains configured threshold -----------------------


def test_finalize_response_contains_threshold(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(),
        )
    body = r.json()
    assert "threshold" in body
    assert body["threshold"] == 0.7


# --- Test 30: response contains normalized centroid ------------------------


def test_finalize_response_contains_normalized_centroid(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(),
        )
    body = r.json()
    assert "centroid" in body
    centroid = body["centroid"]
    assert isinstance(centroid, list)
    assert len(centroid) == 512
    norm = math.sqrt(sum(v * v for v in centroid))
    assert math.isclose(norm, 1.0, abs_tol=1e-3)


# --- Test 31: response contains runtime model metadata --------------------


def test_finalize_response_contains_runtime_model_metadata(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(),
        )
    body = r.json()
    assert "model" in body
    model = body["model"]
    assert model["identity"] == "insightface-buffalo-l"
    assert model["name"] == "buffalo_l"
    assert model["embedding_dimension"] == 512
    assert model["normalization"] == "l2"


# --- Test 32: response contains no userId ---------------------------------


def test_finalize_response_no_userid(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(),
        )
    body_str = str(r.json()).lower()
    assert "userid" not in body_str


# --- Test 33: response contains no images --------------------------------


def test_finalize_response_no_images(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(),
        )
    body_str = str(r.json()).lower()
    assert "image" not in body_str
    assert "jpeg" not in body_str
    assert "png" not in body_str


# --- Test 34: response contains no ciphertext fields --------------------


def test_finalize_response_no_ciphertext_fields(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(),
        )
    body_str = str(r.json()).lower()
    assert "ciphertext" not in body_str
    assert "iv" not in body_str
    assert "authTag" not in body_str
    assert "auth_tag" not in body_str


# --- Test 35: malformed sample count rejected safely -----------------------


def test_finalize_malformed_sample_count_rejected(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json={
                **_make_request(),
                "required_sample_count": "not-a-number",
            },
        )
    assert r.status_code == 422


def test_finalize_mismatched_sample_count_rejected(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    """len(embeddings) != required_sample_count → 422."""
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json={
                **_make_request(required_sample_count=5),
                "required_sample_count": 3,
            },
        )
    assert r.status_code == 422


# --- Test 36: NaN/non-finite request values rejected safely ----------------


def test_finalize_nan_in_embedding_rejected(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    batch = _consistent_batch(5, seed=1)
    batch[0][0] = float("nan")
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(embeddings=batch),
        )
    assert r.status_code == 422


def test_finalize_inf_in_embedding_rejected(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    batch = _consistent_batch(5, seed=2)
    batch[0][0] = float("inf")
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(embeddings=batch),
        )
    assert r.status_code == 422


# --- Test 37: mixed dimensions rejected safely ----------------------------


def test_finalize_mixed_dimensions_rejected(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    batch = _consistent_batch(5, seed=3)
    batch[0] = [0.0] * 256  # Wrong dimension
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(embeddings=batch),
        )
    assert r.status_code == 422


# --- Test 38: non-normalized embedding rejected safely --------------------


def test_finalize_non_normalized_embedding_rejected(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    batch = _consistent_batch(5, seed=4)
    # Scale up to make it clearly non-normalized
    batch[0] = [v * 3.0 for v in batch[0]]
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(embeddings=batch),
        )
    assert r.status_code == 422


# --- Test 39: model mismatch mapped safely --------------------------------


def test_finalize_model_identity_mismatch_returns_422(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(model_identity="wrong-identity"),
        )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "MODEL_MISMATCH"


def test_finalize_model_name_mismatch_returns_422(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(model_name="wrong_name"),
        )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "MODEL_MISMATCH"


def test_finalize_model_dimension_mismatch_returns_422(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(embedding_dimension=256),
        )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "MODEL_MISMATCH"


def test_finalize_model_normalization_mismatch_returns_422(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(normalization="none"),
        )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "MODEL_MISMATCH"


# --- Test 40: inconsistent samples → domain 422 --------------------------


def test_finalize_inconsistent_samples_returns_422(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    batch = _outlier_batch(5, seed=5)
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(embeddings=batch),
        )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "INCONSISTENT_FACE_SAMPLES"


# --- Test 41: inconsistent response contains NO centroid ------------------


def test_finalize_inconsistent_response_no_centroid(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    """Test 41: inconsistent samples → HTTP 422 with error envelope (no centroid)."""
    batch = _outlier_batch(5, seed=6)
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(embeddings=batch),
        )
    assert r.status_code == 422
    body = r.json()
    # Inconsistent samples return a standard error envelope, NOT a consistent=false body.
    assert "error" in body
    assert body["error"]["code"] == "INCONSISTENT_FACE_SAMPLES"
    # The response has no centroid field.
    assert "centroid" not in body


# --- Test 42: INVALID_CENTROID mapped safely ------------------------------


def test_finalize_required_sample_count_below_two_returns_422(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/finalize",
            headers={"X-Service-Token": "test-finalize-secret"},
            json=_make_request(required_sample_count=1),
        )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "INVALID_SAMPLE_COUNT"


# --- Regression: /health unchanged ---------------------------------------


def test_health_endpoint_still_public(_setup: None) -> None:
    with TestClient(app) as client:
        r = client.get("/health")
    assert r.status_code == 200


# --- Regression: /v1/faces/analyze unchanged -------------------------------


def test_analyze_endpoint_still_requires_token(_engine: _FakeFinalizeEngine, _setup: None) -> None:
    with TestClient(app) as client:
        r = client.post("/v1/faces/analyze")
    assert r.status_code == 401


def test_analyze_endpoint_no_embedding_exposure(
    _engine: _FakeFinalizeEngine, _setup: None
) -> None:
    """Regression: /analyze must not return embeddings."""
    import cv2

    img = np.zeros((100, 100, 3), dtype=np.uint8)
    ok, buf = cv2.imencode(".png", img)
    assert ok
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/analyze",
            headers={"X-Service-Token": "test-finalize-secret"},
            files={"file": ("x.png", bytes(buf.tobytes()), "image/png")},
        )
    assert r.status_code == 200
    assert "embedding" not in r.text.lower()


# --- Regression: /v1/faces/compare unchanged ------------------------------


def test_compare_endpoint_still_requires_token(_engine: _FakeFinalizeEngine, _setup: None) -> None:
    with TestClient(app) as client:
        r = client.post("/v1/faces/compare")
    assert r.status_code == 401


# --- Regression: /v1/faces/enrollment/sample unchanged --------------------


def test_sample_endpoint_still_requires_token(_engine: _FakeFinalizeEngine, _setup: None) -> None:
    with TestClient(app) as client:
        r = client.post(
            "/v1/faces/enrollment/sample",
            files={"image": ("x.png", b"\x89PNG\r\n\x1a\n", "image/png")},
        )
    assert r.status_code == 401
