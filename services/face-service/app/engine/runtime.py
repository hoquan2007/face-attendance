"""Active-engine singleton.

Phase 3: the FastAPI lifespan calls :func:`set_active_engine` once at
startup. The route layer and the benchmark tools always read the engine
through :func:`get_active_engine` so the model is never re-initialized.

Identity-based sentinel:
    The module initialises ``_engine`` to a single private ``StubFaceEngine``
    instance (``_DEFAULT_SENTINEL``). The lifespan detects this identity
    and only then attempts to load the real InsightFace model. Any call to
    ``set_active_engine(...)`` — even ``set_active_engine(None)`` — replaces
    the active engine with a *new* instance, so the lifespan's identity
    check fails and the real model is never loaded during tests.
"""

from __future__ import annotations

import threading
from typing import Iterable, Optional, Sequence

from app.engine.types import (
    Candidate,
    DetectedFace,
    EngineMetadata,
    EngineStatus,
    FaceEmbedding,
    RecognitionResult,
)


class StubFaceEngine:
    """Phase 0/3 placeholder engine. Tests and the runtime distinguish this
    from the module-level ``_DefaultStub`` sentinel via identity.
    """

    name = "stub"
    model = None
    provider = None

    def load(self) -> None:
        return None

    def status(self) -> EngineStatus:
        return EngineStatus(
            state="unloaded",
            engine_name=self.name,
            model_name=self.model,
            model_identity=None,
            provider=self.provider,
            embedding_dimension=None,
        )

    def metadata(self) -> EngineMetadata:
        raise NotImplementedError("StubFaceEngine: not implemented.")

    def detect_faces(self, image: bytes) -> list[DetectedFace]:
        raise NotImplementedError("StubFaceEngine: not implemented.")

    def extract_embeddings(
        self, image: bytes, faces: Sequence[DetectedFace]
    ) -> list[FaceEmbedding]:
        raise NotImplementedError("StubFaceEngine: not implemented.")

    def build_index(self, candidates: Iterable[Candidate]) -> object:
        raise NotImplementedError("StubFaceEngine: not implemented.")

    def recognize_faces(self, image: bytes, index: object) -> list[RecognitionResult]:
        raise NotImplementedError("StubFaceEngine: not implemented.")

    def analyze(self, image: bytes) -> list[DetectedFace]:
        raise NotImplementedError("StubFaceEngine: not implemented.")


_lock = threading.Lock()

# Module-level singleton used as the *default* active engine. The lifespan
# checks ``is existing is _DEFAULT_SENTINEL:`` and only then attempts to
# load the real InsightFace model. Any test that calls ``set_active_engine``
# (even with another ``StubFaceEngine()``) breaks this identity check, so
# the real model is never loaded during unit-test runs.
_DEFAULT_SENTINEL = StubFaceEngine()
_engine: StubFaceEngine = _DEFAULT_SENTINEL


def get_active_engine() -> StubFaceEngine:
    """Return the currently-active engine. Always non-null."""
    with _lock:
        return _engine


def set_active_engine(engine: Optional[StubFaceEngine]) -> None:
    """Set the active engine.

    - Pass a ``StubFaceEngine`` instance to install a fake engine.
    - Pass ``None`` to revert to a *new* ``StubFaceEngine()``.

    Either way, the active engine no longer matches ``_DEFAULT_SENTINEL``
    by identity, which signals the lifespan to leave it alone.
    """
    global _engine
    with _lock:
        if engine is None:
            _engine = StubFaceEngine()
        else:
            _engine = engine


__all__ = [
    "StubFaceEngine",
    "get_active_engine",
    "set_active_engine",
    "_DEFAULT_SENTINEL",
]
