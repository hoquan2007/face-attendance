"""FastAPI lifespan management.

The InsightFace model is heavy to initialize. We load it ONCE during the
``startup`` phase and tear down nothing in particular on shutdown (ONNX
Runtime releases its own state when the process exits). If loading fails,
the service still boots — :func:`/health` reports ``ready=false`` and
``/v1/*`` endpoints return ``ENGINE_NOT_READY`` until the operator fixes
the configuration and restarts.

Test note: when a test has already installed a fake engine via
:func:`app.engine.base.set_engine`, the lifespan detects that and skips
loading — this keeps the production startup semantics intact while letting
unit tests substitute fakes without paying the model-init cost.
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI

from app.core.config import get_settings
from app.engine.runtime import (
    StubFaceEngine,
    _DEFAULT_SENTINEL,
    get_active_engine,
    set_active_engine,
)
from app.engine.insightface_engine import InsightFaceEngine


log = logging.getLogger("face_service.lifespan")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Initialise the engine on startup; reset the reference on shutdown.

    Loads the real InsightFace model only when the active engine still
    matches the module-level default sentinel. After ``yield`` we restore
    the (non-sentinel) stub so subsequent tests start from a known state.
    """

    settings = get_settings()
    if settings.face_service_secret is None:
        log.warning(
            "FACE_SERVICE_SECRET is not configured. /v1/* endpoints will reject "
            "every request until a secret is provided."
        )

    existing = get_active_engine()
    if existing is _DEFAULT_SENTINEL:
        engine = InsightFaceEngine()
        set_active_engine(engine)

        load_t0 = time.perf_counter()
        try:
            engine.load()
        except Exception as exc:  # noqa: BLE001 — survive all errors at boot
            load_elapsed_ms = (time.perf_counter() - load_t0) * 1000.0
            log.error(
                "engine_load_failed elapsed_ms=%.1f error_code=%s",
                load_elapsed_ms,
                "MODEL_LOAD_FAILED",
                exc_info=False,
            )
            # Service still starts so /health can report the failure cleanly.
            try:
                yield
            finally:
                set_active_engine(StubFaceEngine())
            return

        load_elapsed_ms = (time.perf_counter() - load_t0) * 1000.0
        try:
            meta = engine.metadata()
            log.info(
                "engine_ready model=%s identity=%s provider=%s embedding_dim=%d "
                "load_ms=%.1f",
                meta.model_name,
                meta.model_identity,
                meta.provider,
                meta.embedding_dimension,
                load_elapsed_ms,
            )
        except Exception:  # noqa: BLE001
            log.info("engine_ready load_ms=%.1f", load_elapsed_ms)
    else:
        # A test has already injected a fake engine — skip real model load.
        log.debug("engine_skipped reason=injected_by_test")

    try:
        yield
    finally:
        # Restore stub so the next test sees a clean slate.
        set_active_engine(StubFaceEngine())


__all__ = ["lifespan"]
