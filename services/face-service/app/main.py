"""FastAPI application entrypoint.

PHASE 3:
- Lifespan-driven model load (see :mod:`app.core.lifespan`).
- ``/health`` is unauthenticated.
- ``/v1/*`` endpoints require the shared service token.
- No raw InsightFace objects are exposed in any response.
"""

from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api import compare as compare_api
from app.api import faces as faces_api
from app.api.health import router as health_router
from app.core.config import get_settings
from app.core.lifespan import lifespan


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

settings = get_settings()

app = FastAPI(
    title="Face Attendance — Face Service",
    version="0.3.0",
    description=(
        "Internal facial-recognition service. Phase 3 ships detection + 1:1 "
        "comparison + quality metadata. All endpoints except /health require "
        "the X-Service-Token shared secret. Raw embeddings are never returned."
    ),
    docs_url="/docs",
    redoc_url=None,
    lifespan=lifespan,
)

app.include_router(health_router)
app.include_router(faces_api.router)
app.include_router(compare_api.router)


def _error_payload(code: str, message: str) -> dict[str, dict[str, str]]:
    """Build the standard error envelope.

    Lives at the response root so that test clients and the future
    Next.js integration can read ``response.json()["error"]["code"]``
    without having to unwrap FastAPI's default ``{"detail": ...}``.
    """

    return {"error": {"code": code, "message": message}}


@app.exception_handler(StarletteHTTPException)
async def _http_exception_handler(request: Request, exc: StarletteHTTPException):
    """Promote HTTPException details so the JSON body has ``error`` at top level.

    Callers expect a stable shape: ``{"error": {"code": "...", "message": "..."}}``.
    Routes already raise that shape inside ``detail=``; we lift it out.
    """

    detail = exc.detail
    if (
        isinstance(detail, dict)
        and "error" in detail
        and isinstance(detail["error"], dict)
        and "code" in detail["error"]
        and "message" in detail["error"]
    ):
        return JSONResponse(
            status_code=exc.status_code,
            content={"error": detail["error"]},
        )
    if isinstance(detail, str):
        return JSONResponse(
            status_code=exc.status_code,
            content=_error_payload("HTTP_ERROR", detail),
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": {
                "code": "HTTP_ERROR",
                "message": str(detail) if detail else "Request failed.",
            }
        },
    )


@app.exception_handler(RequestValidationError)
async def _validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content=_error_payload("INVALID_REQUEST", "Request validation failed."),
    )


@app.get("/", include_in_schema=False)
def root() -> dict[str, str]:
    return {
        "service": "face-service",
        "version": "0.3.0",
        "phase": "3",
    }
