"""Real-model acceptance for PHASE 4.3 enrollment sample endpoint.

Spins up the real InsightFace engine, loads `services/face-service/.env`
for the secret, and exercises ``POST /v1/faces/enrollment/sample`` against
the consented local fixtures.

NEVER prints the embedding. Reports:

- HTTP status
- accepted / rejected
- rejection reasons (if any)
- quality metrics
- embedding dimension

If a fixture path is missing the script reports ``NOT TESTED — FIXTURE
MISSING`` and exits 0 (the script is helpful, not mandatory).
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
        print("SKIP — FACE_SERVICE_SECRET not set in services/face-service/.env")
        return 0

    fixtures_root = (
        Path(__file__).resolve().parents[1]
        / "benchmarks"
        / "fixtures-local"
    )

    candidate = None
    for sub in ("person-a", "person-b", "single-face"):
        folder = fixtures_root / sub
        if folder.exists():
            for suffix in (".jpg", ".jpeg", ".png"):
                matches = sorted(folder.glob(f"*{suffix}"))
                if matches:
                    candidate = matches[0]
                    break
        if candidate:
            break

    if candidate is None:
        print("NOT TESTED — FIXTURE MISSING")
        return 0

    # Engine + endpoint exercise.
    from fastapi.testclient import TestClient

    from app.core.config import get_settings
    from app.engine.base import set_engine
    from app.engine.insightface_engine import InsightFaceEngine
    from app.main import app

    get_settings.cache_clear()  # type: ignore[attr-defined]
    engine = InsightFaceEngine()
    set_engine(engine)
    engine.load()
    status = engine.status()
    if status.state != "ready":
        print(
            f"NOT TESTED — engine not ready: {status.error_code} "
            f"{status.error_message}"
        )
        return 0

    payload = candidate.read_bytes()
    try:
        with TestClient(app) as client:
            r = client.post(
                "/v1/faces/enrollment/sample",
                headers={"X-Service-Token": secret},
                files={"image": (candidate.name, payload, "image/jpeg")},
            )
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL — request exception: {type(exc).__name__}: {exc}")
        return 0
    finally:
        set_engine(None)

    body = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code != 200:
        print(f"FAIL — http {r.status_code} body={body}")
        return 0

    summary = {
        "fixture": str(candidate),
        "http_status": r.status_code,
        "accepted": body.get("accepted"),
        "rejection_reasons": body.get("rejection_reasons", []),
        "quality": body.get("quality"),
        "embedding_dimension": (
            len(body["embedding"]) if body.get("embedding") else None
        ),
        "model_identity": (body.get("model") or {}).get("identity"),
        "model_name": (body.get("model") or {}).get("name"),
        "processing_ms": body.get("processing_ms"),
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())