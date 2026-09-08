"""Pydantic response schemas for the Face Service.

Only application-owned types appear in the wire format. Raw InsightFace
``Face`` objects never escape the engine layer.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class BoundingBoxOut(BaseModel):
    """Public-facing bounding box. Pixel coordinates, top-left origin."""

    model_config = ConfigDict(extra="forbid")

    x: float
    y: float
    width: float
    height: float


class LandmarkOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float
    y: float


class FaceQualityOut(BaseModel):
    """Lightweight quality metadata. Resolution-dependent values are documented."""

    model_config = ConfigDict(extra="forbid")

    detection_score: float = Field(ge=0.0, le=1.0)
    face_width: float = Field(ge=0.0)
    face_height: float = Field(ge=0.0)
    relative_face_area: float = Field(ge=0.0, le=1.0)
    blur_score: float = Field(
        ge=0.0,
        description="Variance of Laplacian — resolution-dependent.",
    )
    brightness: float = Field(ge=0.0, le=1.0)
    near_edge: bool


class FaceOut(BaseModel):
    """One detected face — geometry + quality. No raw embedding."""

    model_config = ConfigDict(extra="forbid")

    face_index: int = Field(ge=0)
    bbox: BoundingBoxOut
    detection_score: float = Field(ge=0.0, le=1.0)
    landmarks: list[LandmarkOut] = Field(default_factory=list)
    quality: FaceQualityOut | None = None


class ImageDimensionsOut(BaseModel):
    model_config = ConfigDict(extra="forbid")

    width: int = Field(ge=0)
    height: int = Field(ge=0)


class AnalyzeResponse(BaseModel):
    """Response shape for ``POST /v1/faces/analyze``."""

    model_config = ConfigDict(extra="forbid")

    image: ImageDimensionsOut
    face_count: int = Field(ge=0)
    faces: list[FaceOut]
    processing_ms: float


class CompareResponse(BaseModel):
    """Response shape for ``POST /v1/faces/compare``."""

    model_config = ConfigDict(extra="forbid")

    similarity: float = Field(ge=-1.0, le=1.0)
    threshold: float = Field(ge=-1.0, le=1.0)
    match: bool
    processing_ms: float


class FaceErrorPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str
    message: str


class FaceErrorResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    error: FaceErrorPayload


__all__ = [
    "BoundingBoxOut",
    "LandmarkOut",
    "FaceQualityOut",
    "FaceOut",
    "ImageDimensionsOut",
    "AnalyzeResponse",
    "CompareResponse",
    "FaceErrorPayload",
    "FaceErrorResponse",
]
