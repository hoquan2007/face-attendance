# Face Attendance System

A web-based facial-recognition attendance system for classrooms (and, later, employees). Each user signs in with their own Google account, enrolls their face once on their own device, and then teachers can run attendance sessions that recognize multiple students in a single camera frame.

This repository is a **monorepo**:

- `apps/web` — Next.js 16 (App Router) + TypeScript + Tailwind CSS 4 + Better Auth + Mongoose.
- `services/face-service` — Python 3.11+ FastAPI service that owns all facial-recognition logic (InsightFace + ONNX Runtime, introduced in Phase 3).
- `docs/` — architecture, data model, API contracts, privacy, and model-licensing notes.

The web app never performs facial recognition locally — it sends sampled JPEG frames to the Face Service over an authenticated internal HTTP boundary.

## Status

This is **Phase 0**: monorepo skeleton, buildable foundations, documentation. No OAuth, no MongoDB models, no InsightFace yet. See `docs/architecture.md` for the full phase plan.

## Prerequisites

- Node.js **>= 20.11** (tested with 24.x)
- pnpm **>= 9** (`npm i -g pnpm`)
- Python **>= 3.11** (tested with 3.13)

## Local development

### 1. Install JS dependencies (root)

```bash
pnpm install
```

### 2. Run the web app

```bash
cd apps/web
pnpm dev          # http://localhost:3000
pnpm lint
pnpm typecheck
```

Copy `apps/web/.env.example` to `apps/web/.env.local` and fill in values. The web app expects the standardized Better Auth variable names (`BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`) along with `MONGODB_URI`, `NEXT_PUBLIC_APP_URL`, `FACE_SERVICE_URL`, and `FACE_SERVICE_SECRET`. See `docs/privacy-security.md`.

### 3. Run the Face Service

Windows PowerShell:

```powershell
cd services/face-service
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8001
```

Then `GET http://127.0.0.1:8001/health` should return `{ "status": "ok", "engine": "stub" }`.

Run tests:

```powershell
pytest -q
```

## Documentation

| File | Purpose |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | High-level architecture, component responsibilities, phase plan |
| [docs/database.md](docs/database.md) | Planned MongoDB collections and relationships |
| [docs/api.md](docs/api.md) | Planned HTTP API surface (web + face service) |
| [docs/privacy-security.md](docs/privacy-security.md) | Biometric handling, secrets, logging hygiene |
| [docs/model-license.md](docs/model-license.md) | InsightFace / buffalo_l licensing warning |

## Working agreement

- Phase-by-phase delivery. **Do not start the next phase until explicitly requested.**
- No silent tech-stack swaps, no premature InsightFace imports, no full-app generation in one response.
- Documentation must be updated alongside any architectural or API change.