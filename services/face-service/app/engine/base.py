"""FaceEngine abstraction.

Defines the Protocol that all face-recognition implementations must satisfy.
The rest of the Face Service (and the web app, indirectly) depends on this
abstraction — NOT on InsightFace — so the model can be swapped without
rewriting callers.

PHASE 0: stub only. Every method raises NotImplementedError so the skeleton
can boot without a model. Phase 3 plugs in `InsightFaceEngine`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable, Protocol, Sequence, runtime_checkable


@dataclass(frozen=True)
class BoundingBox:
    """Axis-aligned face bounding box in pixel coordinates."""

    x: float
    y: float
    width: float
    height: float

    def as_list(self) -> list[float]:
        return [self.x, self.y, self.width, self.height]


@dataclass(frozen=True)
class DetectedFace:
    bbox: BoundingBox
    detection_score: float


@dataclass(frozen=True)
class FaceEmbedding:
    """A normalized face embedding (unit-norm float vector)."""

    vector: list[float]


@dataclass(frozen=True)
class Candidate:
    user_id: str
    embedding: list[float]


@dataclass(frozen=True)
class RecognitionResult:
    bbox: BoundingBox
    candidate_id: str | None
    similarity: float
    status: str  # "candidate" | "low_quality" | "unknown"


@runtime_checkable
class FaceEngine(Protocol):
    """Contract every face-recognition implementation must satisfy."""

    name: str
    model: str | None
    provider: str | None

    def detect_faces(self, image: bytes) -> list[DetectedFace]:
        """Detect faces in a JPEG/PNG image and return bounding boxes."""
        ...

    def extract_embeddings(
        self, image: bytes, faces: Sequence[DetectedFace]
    ) -> list[FaceEmbedding]:
        """For each detected face, return a normalized embedding."""
        ...

    def build_index(self, candidates: Iterable[Candidate]) -> object:
        """Prepare an in-memory recognition index from candidate embeddings.

        Returns an opaque index object that `recognize_faces` can consume.
        """
        ...

    def recognize_faces(
        self, image: bytes, index: object
    ) -> list[RecognitionResult]:
        """Detect + embed + match. Returns one result per detected face."""
        ...


class StubFaceEngine:
    """Phase 0 placeholder. All operations raise NotImplementedError."""

    name = "stub"
    model = None
    provider = None

    def detect_faces(self, image: bytes) -> list[DetectedFace]:
        raise NotImplementedError("StubFaceEngine: InsightFace implementation arrives in Phase 3.")

    def extract_embeddings(
        self, image: bytes, faces: Sequence[DetectedFace]
    ) -> list[FaceEmbedding]:
        raise NotImplementedError("StubFaceEngine: InsightFace implementation arrives in Phase 3.")

    def build_index(self, candidates: Iterable[Candidate]) -> object:
        raise NotImplementedError("StubFaceEngine: InsightFace implementation arrives in Phase 3.")

    def recognize_faces(self, image: bytes, index: object) -> list[RecognitionResult]:
        raise NotImplementedError("StubFaceEngine: InsightFace implementation arrives in Phase 3.")


def get_engine() -> FaceEngine:
    """Return the active FaceEngine implementation.

    PHASE 0: always returns the stub. Phase 3 will select the real engine
    based on settings (and warm it up once at process start).
    """
    return StubFaceEngine()