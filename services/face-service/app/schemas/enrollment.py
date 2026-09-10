"""Pydantic response schemas for the enrollment sample endpoint.

The wire format intentionally mirrors the PHASE 3 ``FaceQualityOut`` shape
so that the future Next.js enrollment pipeline can reuse one parser, but
it does NOT expose the raw image, face crop, or filesystem paths.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class EnrollmentQualityOut(BaseModel):
    """The PHASE 3 quality metrics that drove the accept / reject decision.

    Reused as a stable, documented subset — the route does not invent
    additional metric fields here.
    """

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


class EnrollmentModelMetadataOut(BaseModel):
    """Engine identification that travels alongside accepted embeddings.

    The future Next.js ``EnrollmentSession`` MUST record this metadata so
    that stored embeddings can be checked for model compatibility before
    any recognition call. No filesystem paths, secrets, or biometric data.
    """

    model_config = ConfigDict(extra="forbid")

    identity: str = Field(
        description="Stable model identity string (e.g. 'insightface-buffalo-l').",
    )
    name: str = Field(description="User-facing model name (e.g. 'buffalo_l').")
    embedding_dimension: int = Field(ge=0)
    normalization: str = Field(description="Normalization basis: 'l2' | 'none' | ...")


class EnrollmentSampleResponse(BaseModel):
    """Response shape for ``POST /v1/faces/enrollment/sample``.

    Used for BOTH the accepted and rejected outcomes:

    - On accept (``accepted=true``) ``embedding`` carries the unit-norm
      vector and ``rejection_reasons`` is empty.
    - On reject (``accepted=false``) ``embedding`` is ``None`` and
      ``rejection_reasons`` carries one or more stable codes.

    The response never contains the raw image, face crop, or any
    filesystem path.
    """

    model_config = ConfigDict(extra="forbid")

    accepted: bool
    quality: EnrollmentQualityOut
    embedding: list[float] | None = Field(
        default=None,
        description=(
            "L2-normalised embedding. Present only when accepted=true."
        ),
    )
    rejection_reasons: list[str] = Field(default_factory=list)
    model: EnrollmentModelMetadataOut | None = Field(
        default=None,
        description=(
            "Engine identification. Present only when accepted=true."
        ),
    )
    processing_ms: float


__all__ = [
    "EnrollmentQualityOut",
    "EnrollmentModelMetadataOut",
    "EnrollmentSampleResponse",
]