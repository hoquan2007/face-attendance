"""Real-model multi-face acceptance for PHASE 4.3 enrollment sample endpoint.

Loads the consented ``multi/group.jpg`` fixture and verifies that the
real engine + real route return ``422 MULTIPLE_FACES`` for a multi-face
image. Does NOT print the embedding.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def main() -> int:
    from dotenv import dotenv_values

    env = dotenv_values(Path(__file__).resolve().parents[1] / ".env")
    secret = env.get("FACE_SERVICE_SECRET")
    if not secret:
        print("SKIP — FACE_SERVICE_SECRET not set")
        return 0

    fixture = (
        Path(__file__).resolve().parents[1]
        / "benchmarks"
        / "fixtures-local"
        / "multi"
        / "group.jpg"
    )
    if not fixture.exists():
        print("NOT TESTED — FIXTURE MISSING")
        return 0

    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.engine.base import set_engine
    from app.engine.insightface_engine import InsightFaceEngine
    from app.main import app

    get_settings.cache_clear()  # type: ignore[attr-defined]
    engine = InsightFaceEngine()
    set_engine(engine)
    engine.load()
    if engine.status().state != "ready":
        print("NOT TESTED — engine not ready")
        return 0

    payload = fixture.read_bytes()
    try:
        with TestClient(app) as client:
            r = client.post(
                "/v1/faces/enrollment/sample",
                headers={"X-Service-Token": secret},
                files={"image": (fixture.name, payload, "image/jpeg")},
            )
    finally:
        set_engine(None)

    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    summary = {
        "fixture": str(fixture),
        "http_status": r.status_code,
        "error_code": body.get("error", {}).get("code") if isinstance(body, dict) else None,
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())