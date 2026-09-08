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


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


__all__ = ["Settings", "get_settings"]
