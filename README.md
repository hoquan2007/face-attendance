# Face Attendance System

A web-based facial-recognition attendance system for classrooms (and, later, employees). Each user signs in with their own Google account, enrolls their face once on their own device, and then teachers can run attendance sessions that recognize multiple students in a single camera frame.

This repository is a **monorepo**:

- `apps/web` — Next.js 16 (App Router) + TypeScript + Tailwind CSS 4 + Better Auth + Mongoose.
- `services/face-service` — Python 3.11+ FastAPI service that owns all facial-recognition logic (InsightFace + ONNX Runtime, introduced in Phase 3).
- `docs/` — architecture, data model, API contracts, privacy, and model-licensing notes.

The web app never performs facial recognition locally — it sends sampled JPEG frames to the Face Service over an authenticated internal HTTP boundary.

## Status

This is **Phase 2**: Better Auth + Google OAuth + MongoDB session, plus the application `profiles` collection. New users complete a role-aware onboarding flow (`/onboarding`) before they can reach the dashboard. Returning users with completed profiles skip onboarding and land directly on `/dashboard`. Face enrollment, classes, and attendance are not implemented yet.

See `docs/architecture.md` for the full phase plan.

See `docs/deployment-vercel.md` for the Vercel deployment procedure.

## Prerequisites

- Node.js **>= 24** (tested with 24.x)
- pnpm **>= 9** (`npm i -g pnpm`)
- Python **>= 3.11** (tested with 3.13)

## Local development

### 1. Install JS dependencies (root)

```bash
pnpm install
```

### 2. Configure environment variables

Copy the example file and fill in real values:

```bash
cp apps/web/.env.example apps/web/.env.local
```

Required variables for Phase 1 (all server-side, **never** committed):

| Variable | Purpose |
| --- | --- |
| `MONGODB_URI` | MongoDB Atlas connection string (database `face_attendance`). |
| `BETTER_AUTH_URL` | Origin URL. `http://localhost:3000` in dev, the Vercel domain in prod. |
| `BETTER_AUTH_SECRET` | Session signing secret (generate with `openssl rand -base64 32`). |
| `GOOGLE_CLIENT_ID` | Google OAuth client ID. |
| `GOOGLE_CLIENT_SECRET` | Google OAuth client secret. |
| `NEXT_PUBLIC_APP_URL` | Browser-exposed public origin. Must match `BETTER_AUTH_URL` in dev. |
| `FACE_SERVICE_SECRET` | Server-to-server token (optional in Phase 1, required in Phase 3+). |
| `FACE_SERVICE_URL` | Face Service endpoint (optional in Phase 1, required in Phase 3+). |

### 3. Run the web app

```bash
cd apps/web
pnpm dev          # http://localhost:3000
pnpm lint
pnpm typecheck
pnpm test
```

### 4. Sign in

Visit `http://localhost:3000/login` and click **Continue with Google**.

### 5. Run the Face Service (Phase 3+)

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
| [docs/deployment-vercel.md](docs/deployment-vercel.md) | Vercel deployment procedure |
| [docs/database.md](docs/database.md) | MongoDB collections — Better Auth owns auth; business data lands in later phases |
| [docs/api.md](docs/api.md) | HTTP API surface (web + face service) |
| [docs/privacy-security.md](docs/privacy-security.md) | Biometric handling, secrets, logging hygiene |
| [docs/model-license.md](docs/model-license.md) | InsightFace / buffalo_l licensing warning |

## Working agreement

- Phase-by-phase delivery. **Do not start the next phase until explicitly requested.**
- No silent tech-stack swaps, no premature InsightFace imports, no full-app generation in one response.
- Documentation must be updated alongside any architectural or API change.
