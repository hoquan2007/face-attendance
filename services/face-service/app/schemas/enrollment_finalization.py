"""Pydantic schemas for the ``POST /v1/faces/enrollment/finalize`` endpoint.

This endpoint is server-to-server only (trusted Next.js → Face Service).
It receives already-decrypted, already-L2-normalised embeddings and returns
a consistency result plus a normalized centroid on success.

The request never carries userId, ciphertext, IV, authTag, keyVersion,
images, or face crops — those live on the Next.js side.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class FinalizationModelMetadataIn(BaseModel):
    """Model metadata submitted alongside the embedding batch.

    The endpoint validates these fields against the ACTIVE Face Engine
    at runtime. The Next.js server obtained this metadata from the
    ``POST /v1/faces/enrollment/sample`` responses during sample
    collection and passes it through unchanged.
    """

    model_config = ConfigDict(extra="forbid")

    identity: str = Field(
        description=(
            "Stable model identity string (e.g. 'insightface-buffalo-l')."
        ),
    )
    name: str = Field(
        description="User-facing model name (e.g. 'buffalo_l').",
    )
    embedding_dimension: int = Field(
        ge=1,
        description="Embedding vector dimension.",
    )
    normalization: str = Field(
        description="Normalization basis — must be 'l2' for this endpoint.",
    )


class FinalizationRequest(BaseModel):
    """Request shape for ``POST /v1/faces/enrollment/finalize``.

    The caller (trusted Next.js server) provides already-decrypted,
    already-L2-normalised embeddings that were produced by the Face
    Service during the sample-collection phase.
    """

    model_config = ConfigDict(extra="forbid")

    model: FinalizationModelMetadataIn = Field(
        description="Face engine metadata recorded during sample collection.",
    )

    required_sample_count: int = Field(
        ge=2,
        description=(
            "Number of samples required for this enrollment. "
            "Must be >= 2. len(embeddings) must equal this value."
        ),
    )

    embeddings: list[list[float]] = Field(
        min_length=1,
        description=(
            "List of already-L2-normalised embedding vectors. "
            "Each vector must be finite and have the dimension declared "
            "in model.embedding_dimension. "
            "The caller (Next.js) is responsible for ensuring all "
            "vectors are L2-normalised before submission."
        ),
    )


class FinalizationModelMetadataOut(BaseModel):
    """Engine metadata returned alongside the consistency result."""

    model_config = ConfigDict(extra="forbid")

    identity: str = Field(description="Stable model identity string.")
    name: str = Field(description="User-facing model name.")
    embedding_dimension: int = Field(ge=1)
    normalization: str = Field(description="Normalization basis — 'l2'.")


class FinalizationConsistentResponse(BaseModel):
    """Response shape when the embedding batch is mutually consistent."""

    model_config = ConfigDict(extra="forbid")

    consistent: bool = Field(
        default=True,
        description="True when the batch passed the consistency check.",
    )

    sample_count: int = Field(
        ge=0,
        description="Number of embeddings in the batch.",
    )
    pair_count: int = Field(
        ge=0,
        description="Number of unique pairwise comparisons performed.",
    )

    min_self_similarity: float = Field(
        description="Minimum pairwise cosine similarity in the batch.",
    )
    mean_self_similarity: float = Field(
        description="Mean pairwise cosine similarity in the batch.",
    )
    threshold: float = Field(
        description="Configured consistency threshold applied to this batch.",
    )

    centroid: list[float] = Field(
        description=(
            "L2-normalised centroid of the batch. "
            "The centroid is computed and returned only for consistent batches."
        ),
    )

    model: FinalizationModelMetadataOut = Field(
        description="Active face engine metadata used for this finalization.",
    )


class FinalizationInconsistentResponse(BaseModel):
    """Response shape when the embedding batch fails the consistency check."""

    model_config = ConfigDict(extra="forbid")

    consistent: bool = Field(
        default=False,
        description="False when the batch failed the consistency check.",
    )

    error: FinalizationErrorBody = Field(
        description="Domain error indicating the consistency failure reason.",
    )


class FinalizationErrorBody(BaseModel):
    """Domain error body returned for inconsistent batches."""

    code: str = Field(
        description=(
            "Stable machine-readable error code. "
            "For inconsistent batches this is always 'INCONSISTENT_FACE_SAMPLES'."
        ),
    )
    message: str = Field(
        description="Human-readable description of the failure.",
    )


__all__ = [
    "FinalizationModelMetadataIn",
    "FinalizationRequest",
    "FinalizationModelMetadataOut",
    "FinalizationConsistentResponse",
    "FinalizationInconsistentResponse",
    "FinalizationErrorBody",
]
