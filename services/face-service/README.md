# Face Service

FastAPI skeleton for the Face Attendance System. **Phase 0 only** — no InsightFace, no ONNX Runtime, no OpenCV are installed yet. The engine layer exposes a `FaceEngine` protocol with stub methods so later phases plug in a real implementation without changing call sites.

## Prerequisites

- Python **>= 3.11** (tested with 3.13)

## Run

Windows PowerShell:

```powershell
cd services/face-service
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8001
```

## Health check

```powershell
curl http://127.0.0.1:8001/health
# {"status":"ok","engine":"stub","model":null,"provider":null}
```

## Tests

```powershell
pytest -q
```

## Layout

```
services/face-service/
├── app/
│   ├── main.py              # FastAPI entrypoint
│   ├── core/
│   │   ├── config.py        # pydantic-settings
│   │   └── security.py      # shared-secret verification
│   ├── api/
│   │   └── health.py        # GET /health
│   ├── engine/
│   │   └── base.py          # FaceEngine Protocol (stub)
│   └── schemas/             # Pydantic request/response models (Phase 3+)
└── tests/
    └── test_health.py
```