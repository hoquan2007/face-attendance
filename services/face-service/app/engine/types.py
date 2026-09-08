"""Application-owned face-related types.

These dataclasses are the public contract between the engine layer and the rest
of the Face Service (and, eventually, the web app). They intentionally do NOT
expose InsightFace-specific classes (e.g. ``insightface.app.common.Face``) so
that the recognition engine can be swapped without changing call sites.

PHASE 3 additions:
- ``FaceQuality``            — modular, lightweight metadata used by PHASE 4 enrollment.
- ``EngineMetadata``         — immutable engine identification used for model
                               compatibility checks and stored alongside future
                               FaceProfile templates.
- ``DecodedImage``           — in-memory decoded image with metadata.
- ``EngineState``            — readiness sentinel (``unloaded`` / ``ready`` / ``error``).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Mapping


@dataclass(frozen=True)
class BoundingBox:
    """Axis-aligned face bounding box in pixel coordinates.

    The convention is ``(x, y, width, height)`` where ``(x, y)`` is the top-left
    corner. Coordinates are clamped to ``[0, image_dimension]`` by the engine.
    """

    x: float
    y: float
    width: float
    height: float

    def as_list(self) -> list[float]:
        return [self.x, self.y, self.width, self.height]


@dataclass(frozen=True)
class Landmark:
    """A single facial landmark point in pixel coordinates."""

    x: float
    y: float


@dataclass(frozen=True)
class FaceQuality:
    """Lightweight, modular quality metadata reported per detected face.

    Quality values in PHASE 3 are *informational*. Hard-rejection policies
    belong to PHASE 4 enrollment. Heuristics included here:

    - ``detection_score``       — confidence returned by the detector.
    - ``face_width`` / ``face_height`` — pixel dimensions.
    - ``relative_face_area``    — face area / total image area (0..1).
    - ``blur_score``            — variance of Laplacian (resolution-dependent).
    - ``brightness``            — normalized mean luminance (0..1).
    - ``near_edge``             — True if any face side touches the image border.
    """

    detection_score: float
    face_width: float
    face_height: float
    relative_face_area: float
    blur_score: float
    brightness: float
    near_edge: bool

    def as_dict(self) -> dict[str, float | bool]:
        return {
            "detection_score": float(self.detection_score),
            "face_width": float(self.face_width),
            "face_height": float(self.face_height),
            "relative_face_area": float(self.relative_face_area),
            "blur_score": float(self.blur_score),
            "brightness": float(self.brightness),
            "near_edge": bool(self.near_edge),
        }


@dataclass(frozen=True)
class DetectedFace:
    """One detected face — geometry, landmarks, quality. No embedding."""

    bbox: BoundingBox
    detection_score: float
    landmarks: list[Landmark] = field(default_factory=list)
    quality: FaceQuality | None = None


@dataclass(frozen=True)
class FaceEmbedding:
    """A normalized face embedding (unit-norm float vector)."""

    vector: tuple[float, ...]
    dimension: int

    def as_list(self) -> list[float]:
        return list(self.vector)


@dataclass(frozen=True)
class Candidate:
    """An enrollment candidate: opaque user id + unit-norm embedding."""

    user_id: str
    embedding: FaceEmbedding


@dataclass(frozen=True)
class RecognitionResult:
    """Result of matching one detected face against a candidate index."""

    bbox: BoundingBox
    candidate_id: str | None
    similarity: float
    status: str  # "candidate" | "low_quality" | "unknown"


@dataclass(frozen=True)
class EngineMetadata:
    """Immutable engine identification.

    Stored alongside future FaceProfile templates so that embeddings from
    incompatible models are not silently compared. NEVER includes filesystem
    paths, secrets, or biometric data.
    """

    engine_name: str
    library_version: str
    model_name: str
    model_identity: str
    provider: str
    embedding_dimension: int
    normalization: str  # "l2" / "none" / ...
    detection_module: str
    recognition_module: str

    def as_dict(self) -> dict[str, str | int]:
        return {
            "engine_name": self.engine_name,
            "library_version": self.library_version,
            "model_name": self.model_name,
            "model_identity": self.model_identity,
            "provider": self.provider,
            "embedding_dimension": int(self.embedding_dimension),
            "normalization": self.normalization,
            "detection_module": self.detection_module,
            "recognition_module": self.recognition_module,
        }


@dataclass(frozen=True)
class DecodedImage:
    """In-memory decoded image — never written to disk by the Face Service."""

    bgr: object  # numpy.ndarray, kept untyped to avoid hard imports.
    width: int
    height: int
    channels: int

    @property
    def pixel_count(self) -> int:
        return int(self.width) * int(self.height)


# Engine readiness states.
ENGINE_STATE_UNLOADED = "unloaded"
ENGINE_STATE_READY = "ready"
ENGINE_STATE_ERROR = "error"
EngineState = str  # one of the three constants above.


@dataclass(frozen=True)
class EngineStatus:
    """Lightweight snapshot of the engine — used by /health and tests."""

    state: EngineState
    engine_name: str | None
    model_name: str | None
    model_identity: str | None
    provider: str | None
    embedding_dimension: int | None
    error_code: str | None = None
    error_message: str | None = None


__all__ = [
    "BoundingBox",
    "Landmark",
    "FaceQuality",
    "DetectedFace",
    "FaceEmbedding",
    "Candidate",
    "RecognitionResult",
    "EngineMetadata",
    "DecodedImage",
    "EngineStatus",
    "EngineState",
    "ENGINE_STATE_UNLOADED",
    "ENGINE_STATE_READY",
    "ENGINE_STATE_ERROR",
]
