"""Enrollment quality policy (PHASE 4.3).

The policy converts a single ``FaceQuality`` measurement into an accept /
reject decision with stable rejection codes. It is intentionally decoupled
from the FastAPI route layer so that:

- The policy is testable in isolation with synthetic ``FaceQuality``
  objects — no InsightFace / OpenCV / network required.
- Future calibration changes (e.g. swapping a constant for a per-camera
  lookup) stay localised.

PHASE 3 introduced the **measurement** module (:mod:`app.engine.quality`)
without any reject policy. This module is the **policy** layer: it
consumes the PHASE 3 metrics and applies configured thresholds.

DESIGN PRINCIPLES
=================

1. **No demographic rejection.** Brightness refers only to image exposure,
   not skin tone; detection confidence is the only detector-side gate.
2. **Multiple reasons.** A sample can be rejected for more than one reason.
   Ordering is deterministic (see ``_ORDER`` below) so callers and tests
   get stable lists.
3. **Scale uses relative area.** Raw pixel size depends on resolution; we
   prefer ``relative_face_area`` (face / image) for too-small / too-large
   decisions so the same webcam is judged fairly across frame sizes.
4. **Stricter than PHASE 3 metrics, not aggressive.** The thresholds are
   tighter than the values observed in PHASE 3 real-model reports but
   permissive enough for ordinary indoor webcam captures.
5. **No renormalization.** If the engine produced a unit-norm embedding we
   return it unchanged — the policy never recomputes quality.

REJECTION REASONS
=================

The string codes returned to clients are stable:

- ``LOW_DETECTION_CONFIDENCE`` — detection_score < threshold.
- ``FACE_TOO_SMALL`` — relative_face_area < min threshold.
- ``FACE_TOO_LARGE`` — relative_face_area > max threshold.
- ``TOO_BLURRY`` — blur_score (variance of Laplacian) below threshold.
- ``TOO_DARK`` — normalised brightness below threshold.
- ``TOO_BRIGHT`` — normalised brightness above threshold.
- ``FACE_NEAR_EDGE`` — bbox side touches image border.

Face-count errors (``NO_FACE`` / ``MULTIPLE_FACES``) live in the service
layer and are NOT computed here.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from app.core.config import get_settings
from app.engine.types import FaceQuality


# Stable, machine-readable rejection codes. Order is meaningful: it drives
# the deterministic ``rejection_reasons`` ordering so callers and tests can
# assert on the returned list.
LOW_DETECTION_CONFIDENCE: Final[str] = "LOW_DETECTION_CONFIDENCE"
FACE_TOO_SMALL: Final[str] = "FACE_TOO_SMALL"
FACE_TOO_LARGE: Final[str] = "FACE_TOO_LARGE"
TOO_BLURRY: Final[str] = "TOO_BLURRY"
TOO_DARK: Final[str] = "TOO_DARK"
TOO_BRIGHT: Final[str] = "TOO_BRIGHT"
FACE_NEAR_EDGE: Final[str] = "FACE_NEAR_EDGE"

_ORDER: Final[tuple[str, ...]] = (
    LOW_DETECTION_CONFIDENCE,
    FACE_TOO_SMALL,
    FACE_TOO_LARGE,
    TOO_BLURRY,
    TOO_DARK,
    TOO_BRIGHT,
    FACE_NEAR_EDGE,
)


@dataclass(frozen=True)
class EnrollmentQualityThresholds:
    """Snapshot of the configured thresholds used by the policy.

    Exposed as a frozen dataclass so that tests can build deterministic
    fixtures without mutating the global settings cache.
    """

    min_detection_score: float
    min_face_area: float
    max_face_area: float
    min_blur_score: float
    min_brightness: float
    max_brightness: float

    @classmethod
    def from_settings(cls) -> "EnrollmentQualityThresholds":
        s = get_settings()
        return cls(
            min_detection_score=float(s.face_enrollment_min_detection_score),
            min_face_area=float(s.face_enrollment_min_face_area),
            max_face_area=float(s.face_enrollment_max_face_area),
            min_blur_score=float(s.face_enrollment_min_blur_score),
            min_brightness=float(s.face_enrollment_min_brightness),
            max_brightness=float(s.face_enrollment_max_brightness),
        )


@dataclass(frozen=True)
class EnrollmentQualityResult:
    """Outcome of applying the enrollment quality policy."""

    accepted: bool
    rejection_reasons: tuple[str, ...]
    thresholds: EnrollmentQualityThresholds


def evaluate_enrollment_quality(
    quality: FaceQuality,
    thresholds: EnrollmentQualityThresholds | None = None,
) -> EnrollmentQualityResult:
    """Apply the policy to a single ``FaceQuality`` measurement.

    The input is the engine's measurement of one face — no face-count
    validation is performed here. Rejection codes are returned in
    deterministic order (``_ORDER``).
    """

    active = thresholds or EnrollmentQualityThresholds.from_settings()
    reasons: list[str] = []

    if quality.detection_score < active.min_detection_score:
        reasons.append(LOW_DETECTION_CONFIDENCE)
    if quality.relative_face_area < active.min_face_area:
        reasons.append(FACE_TOO_SMALL)
    if quality.relative_face_area > active.max_face_area:
        reasons.append(FACE_TOO_LARGE)
    if quality.blur_score < active.min_blur_score:
        reasons.append(TOO_BLURRY)
    if quality.brightness < active.min_brightness:
        reasons.append(TOO_DARK)
    if quality.brightness > active.max_brightness:
        reasons.append(TOO_BRIGHT)
    if quality.near_edge:
        reasons.append(FACE_NEAR_EDGE)

    ordered = tuple(code for code in _ORDER if code in reasons)
    return EnrollmentQualityResult(
        accepted=not ordered,
        rejection_reasons=ordered,
        thresholds=active,
    )


__all__ = [
    "LOW_DETECTION_CONFIDENCE",
    "FACE_TOO_SMALL",
    "FACE_TOO_LARGE",
    "TOO_BLURRY",
    "TOO_DARK",
    "TOO_BRIGHT",
    "FACE_NEAR_EDGE",
    "EnrollmentQualityThresholds",
    "EnrollmentQualityResult",
    "evaluate_enrollment_quality",
]