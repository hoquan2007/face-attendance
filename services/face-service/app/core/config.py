"""Environment-driven settings for the Face Service.

PHASE 3: every Phase 3 setting has a typed field with a documented default.
Configuration is the single source of truth for the matcher threshold and the
image upload limits — code MUST NOT introduce local literals for these.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- Service-to-service shared secret (REQUIRED from Phase 3 onward) ---
    face_service_secret: str | None = Field(
        default=None,
        alias="FACE_SERVICE_SECRET",
        description=(
            "Shared X-Service-Token between apps/web and the Face Service. "
            "Required from Phase 3 onward; absent secrets cause engine boot "
            "to log a warning but the service still starts so /health stays "
            "reachable."
        ),
    )

    # --- Model configuration ---
    face_model_name: str = Field(
        default="buffalo_l",
        alias="FACE_MODEL_NAME",
        description=(
            "Official InsightFace model pack name. PHASE 3 ships with "
            "buffalo_l (SCRFD-10GF + ResNet50/WebFace600K ArcFace)."
        ),
    )
    face_execution_provider: str = Field(
        default="cpu",
        alias="FACE_EXECUTION_PROVIDER",
        description=(
            "ONNX Runtime provider. PHASE 3 only supports 'cpu'."
        ),
    )

    # --- Detection tuning ---
    face_det_threshold: float = Field(
        default=0.5,
        alias="FACE_DET_THRESHOLD",
        description="SCRFD detection confidence threshold (0..1).",
    )
    face_det_size: str = Field(
        default="640x640",
        alias="FACE_DET_SIZE",
        description=(
            "SCRFD detection input size in 'WxH' format. "
            "InsightFace 1.0 (SCRFD 10GF) does not accept 'auto' as a string; "
            "use '640x640' (default) or another concrete pair."
        ),
    )

    # --- Matcher ---
    face_match_threshold: float = Field(
        default=0.4,
        alias="FACE_MATCH_THRESHOLD",
        description=(
            "Cosine-similarity threshold for the matcher. "
            "DEVELOPMENT BASELINE ONLY — calibrate before production."
        ),
    )

    # --- Image upload limits ---
    face_max_upload_mb: int = Field(
        default=8,
        alias="FACE_MAX_UPLOAD_MB",
        description="Maximum accepted upload size in megabytes.",
    )
    face_max_image_width: int = Field(
        default=4096,
        alias="FACE_MAX_IMAGE_WIDTH",
        description="Maximum accepted image width in pixels.",
    )
    face_max_image_height: int = Field(
        default=4096,
        alias="FACE_MAX_IMAGE_HEIGHT",
        description="Maximum accepted image height in pixels.",
    )

    # --- Bind config ---
    face_service_host: str = Field(default="127.0.0.1", alias="FACE_SERVICE_HOST")
    face_service_port: int = Field(default=8001, alias="FACE_SERVICE_PORT")

    # --- Enrollment quality policy (PHASE 4.3) ---
    # These are CONSERVATIVE DEVELOPMENT BASELINES. Real production values
    # MUST be calibrated against a representative evaluation set before any
    # production deployment. Values are intentionally stricter than the
    # informational PHASE 3 quality metrics but permissive enough for normal
    # indoor webcam captures.
    face_enrollment_min_detection_score: float = Field(
        default=0.7,
        alias="FACE_ENROLLMENT_MIN_DETECTION_SCORE",
        description=(
            "Minimum SCRFD detection_score (0..1) required for an enrollment "
            "sample. DEVELOPMENT BASELINE — calibrate before production."
        ),
    )
    face_enrollment_min_face_area: float = Field(
        default=0.03,
        alias="FACE_ENROLLMENT_MIN_FACE_AREA",
        description=(
            "Minimum relative face area (face_area / image_area) required. "
            "DEVELOPMENT BASELINE — calibrate before production."
        ),
    )
    face_enrollment_max_face_area: float = Field(
        default=0.6,
        alias="FACE_ENROLLMENT_MAX_FACE_AREA",
        description=(
            "Maximum relative face area (face_area / image_area) allowed. "
            "DEVELOPMENT BASELINE — calibrate before production."
        ),
    )
    face_enrollment_min_blur_score: float = Field(
        default=80.0,
        alias="FACE_ENROLLMENT_MIN_BLUR_SCORE",
        description=(
            "Minimum variance-of-Laplacian required for a sharp sample. "
            "Resolution-dependent. DEVELOPMENT BASELINE — calibrate before "
            "production."
        ),
    )
    face_enrollment_min_brightness: float = Field(
        default=0.18,
        alias="FACE_ENROLLMENT_MIN_BRIGHTNESS",
        description=(
            "Minimum normalised mean luminance (0..1). DEVELOPMENT BASELINE — "
            "calibrate before production."
        ),
    )
    face_enrollment_max_brightness: float = Field(
        default=0.85,
        alias="FACE_ENROLLMENT_MAX_BRIGHTNESS",
        description=(
            "Maximum normalised mean luminance (0..1). DEVELOPMENT BASELINE — "
            "calibrate before production."
        ),
    )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


__all__ = ["Settings", "get_settings"]
