"""FastAPI application entrypoint."""

from fastapi import FastAPI

from app.api.health import router as health_router
from app.core.config import get_settings

settings = get_settings()

app = FastAPI(
    title="Face Attendance — Face Service",
    version="0.1.0",
    description=(
        "Internal facial-recognition service. All endpoints except /health require "
        "the X-Service-Token shared secret."
    ),
    docs_url="/docs",
    redoc_url=None,
)

app.include_router(health_router)

# Future routers (Phase 3+):
#   app.include_router(recognize_router, prefix="/v1", dependencies=[Depends(verify_service_token)])
#   app.include_router(enroll_router, prefix="/v1", dependencies=[Depends(verify_service_token)])


@app.get("/", include_in_schema=False)
def root() -> dict[str, str]:
    return {"service": "face-service", "version": "0.1.0", "phase": "0"}