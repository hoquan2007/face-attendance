"""Environment-driven settings for the Face Service."""

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

    # Service-to-service shared secret. REQUIRED from Phase 1 onward; optional
    # in Phase 0 so the service can boot for skeleton verification.
    face_service_secret: str | None = Field(default=None, alias="FACE_SERVICE_SECRET")

    # Model configuration (Phase 3+).
    face_model_name: str = Field(default="buffalo_l", alias="FACE_MODEL_NAME")
    face_execution_provider: str = Field(default="cpu", alias="FACE_EXECUTION_PROVIDER")

    # Bind config.
    face_service_host: str = Field(default="127.0.0.1", alias="FACE_SERVICE_HOST")
    face_service_port: int = Field(default=8001, alias="FACE_SERVICE_PORT")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()