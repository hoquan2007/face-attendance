"""Health endpoint."""

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: str
    engine: str
    model: str | None
    provider: str | None


@router.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Liveness probe.

    Reports the active FaceEngine implementation. In Phase 0 the engine is
    a stub; InsightFace will replace it in Phase 3.
    """
    return HealthResponse(status="ok", engine="stub", model=None, provider=None)