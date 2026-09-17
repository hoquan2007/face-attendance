"""Pydantic request/response schemas for ``POST /attendance/identify``."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class IdentifyGalleryItem(BaseModel):
    """One candidate in the recognition gallery."""

    model_config = ConfigDict(extra="forbid")

    candidate_key: str = Field(
        ...,
        description="Ephemeral candidate key (e.g. 'c0', 'c1'). Not a real identity.",
        min_length=1,
    )
    embedding: list[float] = Field(
        ...,
        description="L2-normalised unit embedding vector.",
        min_length=1,
    )
    embedding_dimension: int = Field(
        ...,
        gt=0,
        description="Embedding vector dimension.",
    )
    normalization: str = Field(
        default="l2",
        description="Normalisation method (must be 'l2').",
    )


class IdentifyRequest(BaseModel):
    """Public contract for ``POST /attendance/identify``."""

    model_config = ConfigDict(extra="forbid")

    gallery: list[IdentifyGalleryItem] = Field(
        default_factory=list,
        description="Session-scoped recognition gallery (validated manually for emptiness).",
    )
    max_faces: int = Field(
        default=5,
        ge=1,
        le=20,
        description="Maximum number of faces to process per frame (server caps to 10).",
    )


class IdentifyMatch(BaseModel):
    """One successful face-to-candidate match."""

    model_config = ConfigDict(extra="forbid")

    face_index: int = Field(..., ge=0, description="Zero-based index of the detected face.")
    candidate_key: str = Field(..., description="Ephemeral candidate key of the matched face.")


class IdentifyResponse(BaseModel):
    """Public contract for a successful ``POST /attendance/identify`` response."""

    model_config = ConfigDict(extra="forbid")

    faces_detected: int = Field(..., ge=0, description="Total number of faces detected in the frame.")
    matches: list[IdentifyMatch] = Field(
        default_factory=list,
        description="Matched face-to-candidate pairs.",
    )
    unmatched_count: int = Field(
        ...,
        ge=0,
        description="Number of detected faces that did not match any candidate above threshold.",
    )
    processing_ms: float = Field(..., ge=0, description="Processing time in milliseconds.")


__all__ = [
    "IdentifyGalleryItem",
    "IdentifyRequest",
    "IdentifyMatch",
    "IdentifyResponse",
]
