"""Stable machine-readable error codes for the Face Service API."""

from __future__ import annotations

from enum import Enum


class FaceErrorCode(str, Enum):
    """Machine-readable error codes returned to API clients.

    All codes are stable — clients may match on them. Human-readable messages
    can change but codes never will without a major version bump.
    """

    INVALID_IMAGE = "INVALID_IMAGE"
    IMAGE_TOO_LARGE = "IMAGE_TOO_LARGE"
    NO_FACE = "NO_FACE"
    MULTIPLE_FACES = "MULTIPLE_FACES"
    ENGINE_NOT_READY = "ENGINE_NOT_READY"
    MODEL_LOAD_FAILED = "MODEL_LOAD_FAILED"
    INVALID_EMBEDDING = "INVALID_EMBEDDING"
    FACE_SERVICE_UNAUTHORIZED = "FACE_SERVICE_UNAUTHORIZED"
    INTERNAL_ERROR = "INTERNAL_ERROR"


__all__ = ["FaceErrorCode"]
