"""FaceEngine abstraction.

Defines the Protocol that all face-recognition implementations must satisfy.
The rest of the Face Service (and the web app, indirectly) depends on this
abstraction — NOT on InsightFace — so the model can be swapped without
rewriting callers.

All application-owned types are canonical in :mod:`app.engine.types`. This
module re-exports them and additionally defines the :class:`FaceEngine`
Protocol.
"""

from __future__ import annotations

from typing import Iterable, Protocol, Sequence, runtime_checkable

from app.engine.types import (
    BoundingBox,
    Candidate,
    DecodedImage,
    DetectedFace,
    EngineMetadata,
    EngineStatus,
    FaceEmbedding,
    RecognitionResult,
)


@runtime_checkable
class FaceEngine(Protocol):
    """Contract every face-recognition implementation must satisfy."""

    name: str
    model: str | None
    provider: str | None

    # --- Phase 0 surface ---
    def detect_faces(self, image: bytes) -> list[DetectedFace]: ...
    def extract_embeddings(
        self, image: bytes, faces: Sequence[DetectedFace]
    ) -> list[FaceEmbedding]: ...
    def build_index(self, candidates: Iterable[Candidate]) -> object: ...
    def recognize_faces(self, image: bytes, index: object) -> list[RecognitionResult]: ...

    # --- Phase 3 additions ---
    def load(self) -> None: ...
    def status(self) -> EngineStatus: ...
    def metadata(self) -> EngineMetadata: ...
    def analyze(self, image: bytes) -> list[DetectedFace]: ...


# Re-export everything for the public API surface.
# Re-export engine factory helpers (used by routes and tests).
from app.engine.runtime import get_active_engine, set_active_engine

from app.engine.runtime import get_active_engine, set_active_engine

get_engine = get_active_engine
set_engine = set_active_engine

__all__ = [
    "FaceEngine",
    "BoundingBox",
    "DetectedFace",
    "FaceEmbedding",
    "Candidate",
    "RecognitionResult",
    "DecodedImage",
    "EngineMetadata",
    "EngineStatus",
    "get_engine",
    "set_engine",
]
