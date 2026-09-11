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


class EnrollmentQualityRejection(str, Enum):
    """Stable rejection codes for the ``POST /v1/faces/enrollment/sample`` endpoint.

    Quality-policy codes are returned in the response body (not as error
    envelopes) when an upload is structurally valid but the face itself
    is unsuitable for enrollment. They are intentionally distinct from
    :class:`FaceErrorCode` because they do not indicate an infrastructure
    failure — they signal that the user should retake the photo.

    Face-count errors (``NO_FACE`` / ``MULTIPLE_FACES``) live in
    :class:`FaceErrorCode` and remain infrastructure-level error codes
    — they are still returned as ``{"error": {"code": ...}}`` envelopes.
    """

    LOW_DETECTION_CONFIDENCE = "LOW_DETECTION_CONFIDENCE"
    FACE_TOO_SMALL = "FACE_TOO_SMALL"
    FACE_TOO_LARGE = "FACE_TOO_LARGE"
    TOO_BLURRY = "TOO_BLURRY"
    TOO_DARK = "TOO_DARK"
    TOO_BRIGHT = "TOO_BRIGHT"
    FACE_NEAR_EDGE = "FACE_NEAR_EDGE"


class FinalizationErrorCode(str, Enum):
    """Stable error codes for the ``POST /v1/faces/enrollment/finalize`` endpoint.

    These codes cover model incompatibility, embedding validation, and
    batch consistency. They are intentionally distinct from
    :class:`FaceErrorCode` because they belong to a different endpoint
    and concern a different failure class (enrollment consistency rather
    than image decoding or face detection).
    """

    # Model / metadata incompatibility
    MODEL_MISMATCH = "MODEL_MISMATCH"

    # Embedding validation (upstream of finalization math)
    INVALID_SAMPLE_COUNT = "INVALID_SAMPLE_COUNT"
    INVALID_EMBEDDING = "INVALID_EMBEDDING"
    EMBEDDING_DIMENSION_MISMATCH = "EMBEDDING_DIMENSION_MISMATCH"
    EMBEDDING_NOT_NORMALIZED = "EMBEDDING_NOT_NORMALIZED"

    # Batch consistency
    INCONSISTENT_FACE_SAMPLES = "INCONSISTENT_FACE_SAMPLES"

    # Centroid output guard
    INVALID_CENTROID = "INVALID_CENTROID"


__all__ = ["FaceErrorCode", "EnrollmentQualityRejection", "FinalizationErrorCode"]
