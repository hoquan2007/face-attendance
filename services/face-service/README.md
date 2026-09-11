# Face Service

FastAPI + InsightFace service that owns all facial-recognition logic for the
Face Attendance System. **Phase 4.3** adds the protected enrollment-sample
endpoint (`POST /v1/faces/enrollment/sample`); Phase 3 remains the engine
foundation:

- One-time InsightFace model load at FastAPI startup.
- Detection of 0 / 1 / many faces in an uploaded image.
- Per-face 5-point landmarks + quality metadata.
- L2-normalised 512-D recognition embeddings (validated at runtime).
- Deterministic cosine similarity matcher + configurable threshold.
- Versioned, server-to-server authenticated endpoints (`/v1/faces/*`).
- Local CPU benchmark and offline threshold-evaluation tools.

**PHASE 4.3** ships the enrollment sample endpoint. The endpoint accepts
**exactly one** face, applies a development-baseline quality gate, and
returns the L2-normalised embedding only on accept. It is
**server-to-server only** — the browser must never call it directly.

**PHASE 4.6A1** ships a pure-Python **enrollment finalization math
foundation** (`app/engine/enrollment_finalization.py`). The module
turns a batch of validated, L2-normalised embeddings into a single
L2-normalised centroid *iff* the batch is mutually consistent enough
to form one enrollment template. The module is intentionally
decoupled from HTTP, the engine, and persistence.

**PHASE 4.6A2** adds the protected internal finalization endpoint
(`POST /v1/faces/enrollment/finalize`). The endpoint receives
already-decrypted, already-L2-normalized embeddings from the trusted
Next.js server and returns a consistency result plus a normalized centroid.
The Face Service does NOT read MongoDB, does NOT decrypt biometric data,
and does NOT persist the centroid.

PHASE 3 explicitly does **not** enroll users, persist embeddings, or run
face identification against a class gallery. Those arrive in later phases.

## Licensing notice

`buffalo_l` and the other official InsightFace model packs are released
for **non-commercial research use only**. Production deployment requires
a separate commercial license — see [`docs/model-license.md`](../../docs/model-license.md)
before shipping attendance workloads.

## Prerequisites

- Python **>= 3.11** (tested with 3.13).
- Windows / macOS / Linux. No CUDA required — Phase 3 runs on CPU only.
- No paid cloud APIs.

## Installation

```powershell
cd services/face-service
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

macOS / Linux:

```bash
cd services/face-service
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

`requirements.txt` pins (as of PHASE 3):

| Package | Version | Purpose |
| --- | --- | --- |
| `insightface` | `1.0.1` | ArcFace R50 + SCRFD-10GF (auto-downloaded on first run) |
| `onnxruntime` | `1.29.0` | CPU inference (CUDA intentionally not installed) |
| `onnx` | `1.22.0` | ONNX model format |
| `opencv-python` | `4.13.0.92` | Image decoding + quality heuristics |
| `numpy` | `2.1.3` | Array math (matches `opencv-python` ABI on Python 3.13) |
| `fastapi` / `uvicorn` / `pydantic` / `pydantic-settings` / `python-multipart` / `httpx` | as in `requirements.txt` | HTTP layer |

> Do **NOT** install `onnxruntime` and `onnxruntime-gpu` together — they
> conflict at runtime. Phase 3 is CPU-only.

## First model download

The first call to `uvicorn` triggers an InsightFace model download into
`~/.insightface/` (override via `INSIGHTFACE_HOME`). The `buffalo_l` pack
is ~326 MB.

The downloaded pack and any local cache are excluded by
`services/face-service/.gitignore` (and by the root `.gitignore`) so
nothing leaks into version control.

## Configuration

Copy and fill in:

```powershell
cp .env.example .env
```

Key variables:

| Variable | Default | Notes |
| --- | --- | --- |
| `FACE_SERVICE_SECRET` | (none) | Required from Phase 3. Browser must never see this. |
| `FACE_MODEL_NAME` | `buffalo_l` | See `docs/model-license.md` before any production change. |
| `FACE_EXECUTION_PROVIDER` | `cpu` | CPU only in Phase 3. |
| `FACE_MATCH_THRESHOLD` | `0.4` | **Development baseline** — re-calibrate before production. |
| `FACE_DET_THRESHOLD` | `0.5` | SCRFD detection confidence cutoff. |
| `FACE_DET_SIZE` | `auto` | InsightFace 1.0 default — joint 128 + 640 NMS. |
| `FACE_MAX_UPLOAD_MB` | `8` | Reject larger uploads as `IMAGE_TOO_LARGE`. |
| `FACE_MAX_IMAGE_WIDTH` / `FACE_MAX_IMAGE_HEIGHT` | `4096` | Reject larger dimensions as `IMAGE_TOO_LARGE`. |
| `FACE_ENROLLMENT_MIN_DETECTION_SCORE` | `0.7` | Phase 4.3 — **development baseline**, re-calibrate. |
| `FACE_ENROLLMENT_MIN_FACE_AREA` | `0.03` | Phase 4.3 — **development baseline**, re-calibrate. |
| `FACE_ENROLLMENT_MAX_FACE_AREA` | `0.6` | Phase 4.3 — **development baseline**, re-calibrate. |
| `FACE_ENROLLMENT_MIN_BLUR_SCORE` | `80.0` | Phase 4.3 — **development baseline**, re-calibrate. |
| `FACE_ENROLLMENT_MIN_BRIGHTNESS` | `0.18` | Phase 4.3 — **development baseline**, re-calibrate. |
| `FACE_ENROLLMENT_MAX_BRIGHTNESS` | `0.85` | Phase 4.3 — **development baseline**, re-calibrate. |
| `FACE_SERVICE_HOST` / `FACE_SERVICE_PORT` | `127.0.0.1` / `8001` | Bind config. |

## Run

```powershell
uvicorn app.main:app --reload --port 8001
```

Then:

```powershell
curl http://127.0.0.1:8001/health
# {"status":"ok","engine":"insightface","model":"buffalo_l",
#  "provider":"CPUExecutionProvider","ready":true,"embedding_dimension":512}
```

`GET /health` is unauthenticated. Everything else under `/v1/*` requires
the `X-Service-Token` header.

Open `http://127.0.0.1:8001/docs` for the Swagger UI (development only).

## API examples

All examples assume `TOKEN` is set to your `FACE_SERVICE_SECRET`.

```bash
# Analyze a one-face image — never returns embeddings.
curl -X POST http://127.0.0.1:8001/v1/faces/analyze \
  -H "X-Service-Token: $TOKEN" \
  -F "file=@benchmarks/fixtures-local/single-face/sample.jpg"

# 1:1 verify between two single-face images.
curl -X POST http://127.0.0.1:8001/v1/faces/compare \
  -H "X-Service-Token: $TOKEN" \
  -F "image_a=@benchmarks/fixtures-local/pairs/p1_a.jpg" \
  -F "image_b=@benchmarks/fixtures-local/pairs/p1_b.jpg"

# Validate one enrollment sample — server-to-server only. Exactly one
# face required. Returns the L2-normalised embedding only when the
# quality gate passes.
curl -X POST http://127.0.0.1:8001/v1/faces/enrollment/sample \
  -H "X-Service-Token: $TOKEN" \
  -F "image=@benchmarks/fixtures-local/person-a/a1.jpg"
```

Stable error codes:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `INVALID_IMAGE` | 400 | Payload did not decode as JPEG / PNG / WebP / BMP. |
| `IMAGE_TOO_LARGE` | 413 | Exceeded upload size or dimension limit. |
| `NO_FACE` | 422 | `/compare` or `/v1/faces/enrollment/sample` image contained 0 faces. |
| `MULTIPLE_FACES` | 422 | `/compare` or `/v1/faces/enrollment/sample` image contained > 1 faces. |
| `ENGINE_NOT_READY` | 503 | Model is not yet loaded (or load failed). |
| `MODEL_LOAD_FAILED` | (reported via `/health`) | InsightFace init failed. |
| `INVALID_EMBEDDING` | (matcher / service layer) | Empty / NaN / zero-norm / mismatched-dim. |
| `FACE_SERVICE_UNAUTHORIZED` | 401 | `X-Service-Token` missing or wrong. |

Phase 4.3 enrollment-sample rejection codes (returned in the response
body, **not** as an error envelope):

| Code | Meaning |
| --- | --- |
| `LOW_DETECTION_CONFIDENCE` | `detection_score` below threshold. |
| `FACE_TOO_SMALL` | `relative_face_area` below threshold. |
| `FACE_TOO_LARGE` | `relative_face_area` above threshold. |
| `TOO_BLURRY` | `blur_score` below threshold. |
| `TOO_DARK` | normalised brightness below threshold. |
| `TOO_BRIGHT` | normalised brightness above threshold. |
| `FACE_NEAR_EDGE` | bbox touches the image border. |

**The thresholds are CONSERVATIVE DEVELOPMENT BASELINES, NOT
production-calibrated.** They MUST be re-calibrated against a
representative evaluation set before any production deployment.

## Tests

```powershell
# Unit tests only — no model download, no network access.
pytest -q

# Integration tests — load the real model. Requires first-run download.
pytest -q -m integration

# Lint (optional; not bundled in Phase 3).
```

## Benchmark

The benchmark reads consented images from `benchmarks/fixtures-local/`
(see `benchmarks/README.md`) and reports model load time, decode /
detection ms, and per-bucket aggregates (`zero_face`, `one_face`,
`multi_face`). It NEVER prints embeddings or saves annotated images.

```powershell
python -m benchmarks.benchmark_engine --fixtures benchmarks/fixtures-local
```

Add `--json-out reports/benchmark.json` to also dump the JSON report.

## Threshold evaluation

Given a manifest of image pairs, compute cosine similarities and
threshold operating points (`FAR` / `FRR` / `TAR`) where the dataset
permits:

```text
# manifest.csv
path_a,path_b,label
pairs/p1_a.jpg,pairs/p1_b.jpg,same
pairs/p1_a.jpg,pairs/p2_a.jpg,different
```

```powershell
python -m benchmarks.evaluate_pairs --manifest benchmarks/fixtures-local/pairs/manifest.csv
```

With < 20 valid pairs the report prints `calibration_status:
INSUFFICIENT`. Never claim statistical significance from a tiny
dataset, and never claim "100% accurate".

## Layout

```text
services/face-service/
├── app/
│   ├── main.py                       # FastAPI entrypoint
│   ├── api/
│   │   ├── health.py                 # GET /health
│   │   ├── faces.py                  # POST /v1/faces/analyze
│   │   ├── compare.py                # POST /v1/faces/compare
│   │   └── enrollment.py             # POST /v1/faces/enrollment/sample (4.3)
│   ├── core/
│   │   ├── config.py                 # Pydantic Settings (incl. 4.3 thresholds)
│   │   ├── lifespan.py               # one-time engine load
│   │   └── security.py               # X-Service-Token dependency
│   ├── engine/
│   │   ├── base.py                   # FaceEngine Protocol
│   │   ├── runtime.py                # active-engine singleton
│   │   ├── insightface_engine.py     # real engine implementation
│   │   ├── matcher.py                # cosine similarity + threshold
│   │   ├── quality.py                # blur, brightness, near-edge
│   │   ├── enrollment_quality.py     # 4.3 quality policy
│   │   ├── enrollment_finalization.py  # 4.6A1 pure finalization math
│   │   └── types.py                  # application-owned DTOs
│   ├── schemas/
│   │   ├── common.py                 # FaceErrorCode, EnrollmentQualityRejection, FinalizationErrorCode
│   │   ├── face.py                   # analyze response
│   │   ├── compare.py                # compare response
│   │   ├── enrollment.py             # 4.3 enrollment-sample response
│   │   └── enrollment_finalization.py # 4.6A2 finalize request/response schemas
│   ├── services/
│   │   ├── recognition_service.py    # route-layer pipeline
│   │   ├── enrollment_sample_service.py  # 4.3 enrollment pipeline
│   │   └── enrollment_finalization_service.py # 4.6A2 finalization service
│   └── utils/
│       └── image.py                  # in-memory decoder + limits
├── benchmarks/
│   ├── README.md
│   ├── benchmark_engine.py
│   ├── evaluate_pairs.py
│   ├── synthetic_fixtures.py
│   └── fixtures-local/               # gitignored
├── tests/
│   ├── conftest.py
│   ├── test_analyze_endpoint.py
│   ├── test_compare_endpoint.py
│   ├── test_engine_metadata.py
│   ├── test_health.py
│   ├── test_image_decoder.py
│   ├── test_insightface_engine.py
│   ├── test_insightface_engine_parsing.py
│   ├── test_matcher.py
│   ├── test_quality.py
│   ├── test_security.py
│   ├── test_settings.py
│   ├── test_enrollment_quality.py        # 4.3
│   ├── test_enrollment_sample_service.py # 4.3
│   ├── test_enrollment_endpoint.py       # 4.3
│   ├── test_enrollment_finalization.py   # 4.6A1
│   ├── test_enrollment_finalization_config.py  # 4.6A2 config tests
│   ├── test_enrollment_finalization_service.py  # 4.6A2 service tests
│   ├── test_enrollment_finalization_endpoint.py # 4.6A2 endpoint tests
│   ├── fakes.py
│   └── integration/
│       └── test_engine_lifecycle.py
├── .env.example
├── .gitignore
├── README.md
├── pyproject.toml
└── requirements.txt
```

## What PHASE 4.3 does NOT do

- Persist embeddings or quality metadata (lives in PHASE 4.4 via the
  Next.js-side `FaceEnrollmentSession`).
- Run multiple samples, compute centroids, or finalise enrollment
  (PHASE 4.4).
- Re-enroll, replace, or delete an existing Face ID (PHASE 4.4+).
- Accept camera frames directly from the browser (PHASE 4.4+).
- Implement liveness / anti-spoofing (PHASE 9).
- Identify a 1:N candidate gallery (PHASE 7).
- Modify any of the `apps/web` Phase 1–4.2 features (Better Auth,
  Google OAuth, profile, onboarding, biometric encryption foundation,
  `FaceProfile` / `FaceEnrollmentSession` persistence).

## What PHASE 3 does NOT do

- Persist face embeddings to MongoDB (PHASE 4).
- Accept browser camera frames directly (PHASE 4–6).
- Implement liveness / anti-spoofing (PHASE 9).
- Identify a 1:N candidate gallery (PHASE 7).
- Modify any of the `apps/web` Phase 2 features (Better Auth, Google
  OAuth, profile, onboarding, Design System, Vercel config).
