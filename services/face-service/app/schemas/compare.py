"""Pydantic response schema for the /v1/faces/compare endpoint."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class CompareResponse(BaseModel):
    """Public shape of ``POST /v1/faces/compare``."""

    model_config = ConfigDict(extra="forbid")

    similarity: float = Field(ge=-1.0, le=1.0)
    threshold: float = Field(ge=-1.0, le=1.0)
    match: bool
    processing_ms: float


__all__ = ["CompareResponse"]
