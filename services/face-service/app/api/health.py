"""Health endpoint.

Reports a truthful snapshot of the engine so external liveness probes and
operators can distinguish:

- ``process up, model not loaded`` (transient startup or repeated load failures)
- ``process up, model ready`` (normal operation)

No filesystem paths, secrets, or machine identifiers are exposed.
"""

from __future__ import annotations

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

from app.engine.base import get_engine


router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    status: str
    engine: str | None
    model: str | None
    provider: str | None
    ready: bool
    embedding_dimension: int | None = None
    error_code: str | None = None
    error_message: str | None = None


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Liveness + readiness snapshot.

    Returns ``status='ok'`` when the process is alive and ``ready=true`` only
    when the active engine reports its model is loaded. ``/health`` does not
    require the service token.
    """

    engine = get_engine()
    status = engine.status()
    ready = bool(status.state == "ready")
    overall_status = "ok" if ready else "degraded"
    return HealthResponse(
        status=overall_status,
        engine=status.engine_name,
        model=status.model_name,
        provider=status.provider,
        ready=ready,
        embedding_dimension=status.embedding_dimension,
        error_code=status.error_code,
        error_message=status.error_message,
    )


__all__ = ["health", "router"]
