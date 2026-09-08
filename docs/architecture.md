# Architecture

> Status: **Phase 3** — InsightFace Face Service is operational in local
> development. `apps/web` remains a separate Next.js application; **the
> browser never calls the Face Service directly**. Face enrollment,
> classes, and attendance are not implemented yet.

## Goals

1. Keep facial recognition fully isolated from the web application.
2. Allow the recognition engine to be swapped without rewriting callers.
3. Avoid false-positive attendance: when uncertain, return `UNKNOWN`.
4. Minimize stored biometric data — embeddings only, never raw frames.
5. Phase-by-phase delivery: no premature InsightFace or MongoDB business
   code in early phases.
6. Separate identity data from business data: Better Auth owns the auth
   collections; the application owns the `profiles` collection.

## High-level components

```mermaid
flowchart LR
    Browser["Browser\n(classroom device / phone)"] -->|"HTTPS"| Web["apps/web\nNext.js 16 + Better Auth"]
    Web -->|"MongoDB driver"| Mongo["MongoDB Atlas\n(face_attendance database)"]
    Web -->|"internal HTTPS\nX-Service-Token"| Face["services/face-service\nFastAPI + InsightFace"]
    Face -->|"ONNX Runtime\nCPUExecutionProvider"| Engine["FaceEngine\n(detect / embed / match)"]
    Web -->|"Google OAuth"| Google["Google\nOpenID Connect"]
```

- **Browser** opens the camera locally for the teacher; only sampled JPEG
  frames are sent to the Face Service (PHASE 3 ships no browser sampling
  logic yet — the Face Service already accepts multipart uploads).
- **`apps/web`** owns authentication (Better Auth + Google OAuth), and will
  later own RBAC, classes, attendance sessions, history, Excel export.
- **`services/face-service`** owns *all* face-related computation. It is
  the only component that imports InsightFace / ONNX Runtime. The engine
  is loaded once at process start and reused for every request.
- **MongoDB Atlas** stores Better Auth collections (`user`, `session`,
  `account`, `verification`) in the `face_attendance` database. The
  application owns `profiles` (Phase 2) and will own future business
  collections (`classrooms`, `class_memberships`, `attendance_sessions`,
  `attendance_records`, `face_profiles`) in later phases via Mongoose.
- **Google** is identity-only — only `sub`, `email`, `name`, `picture` are
  requested via the `openid email profile` scopes.

## FaceEngine abstraction

Defined in [`services/face-service/app/engine/base.py`](../services/face-service/app/engine/base.py)
as a `Protocol` with three legacy responsibilities plus four PHASE 3
additions:

**Phase 0 surface (preserved):**

- `detect_faces(image)` — return bounding boxes + confidence for every
  face in the frame.
- `extract_embeddings(image, faces)` — return a normalized embedding per
  detected face.
- `recognize_faces(image, candidate_index)` — return per-face
  `{ bbox, candidate_id | null, similarity, status }`.

**Phase 3 additions:**

- `load()` — synchronous, idempotent model init (called once by the
  FastAPI lifespan).
- `status()` — readiness snapshot for `/health` (distinguishes "process
  up, model not loaded" from "model ready").
- `metadata()` — immutable identification (engine name, library version,
  model name, model identity, provider, embedding dimension) used to
  guarantee model compatibility in later phases.
- `analyze(image)` — convenience that returns full `DetectedFace`
  dataclasses (bbox + 5-point landmarks + quality).

The web app and the rest of the Face Service depend on this `Protocol`,
not on InsightFace. PHASE 3 ships `InsightFaceEngine` as the first
implementation; future engines (e.g. a different backbone) can be added
without touching call sites.

```
FastAPI Route
      │
      ▼
Face Service (recognition_service.py)
      │
      ▼
FaceEngine Protocol  (app.engine.base.FaceEngine)
      │
      ▼
InsightFaceEngine    (app.engine.insightface_engine)
      │
      ├── SCRFD / detection
      └── ArcFace recognition (ResNet50@WebFace600K)
              │
              ▼
       normalized 512-D embedding
```

### Quality heuristics (PHASE 3, informational only)

Per detected face the engine reports a `FaceQuality` block:

- `detection_score`
- `face_width` / `face_height` (pixels)
- `relative_face_area` (face area / image area)
- `blur_score` (variance of Laplacian — resolution-dependent)
- `brightness` (normalised mean luminance — exposure only)
- `near_edge`

**No hard rejection is enforced in PHASE 3.** Hard rejection policies
belong to PHASE 4 enrollment.

## Authentication and authorization

### End users (Google OAuth via Better Auth)

Unchanged from Phase 2. See "Authentication and authorization" below.

### Server-to-server (web ↔ Face Service)

- All Face Service endpoints **except** `GET /health` require the shared
  `FACE_SERVICE_SECRET` sent as `X-Service-Token`.
- The browser **never** calls the Face Service directly — the web app is
  the only client.
- When the secret is not configured on the server, every protected
  request is rejected with `FACE_SERVICE_UNAUTHORIZED` so the
  misconfiguration is loud rather than silent.

```
Browser
   ↓
Next.js Server (apps/web)
   ↓  FACE_SERVICE_SECRET in X-Service-Token
FastAPI Face Service (services/face-service)
   ↓
RecognitionService
   ↓
FaceEngine (InsightFaceEngine)
   ├── SCRFD detector
   └── ArcFace recognizer
        └── 512-D L2-normalised embedding
```

## Face Service API (PHASE 3 surface)

Base URL: `${FACE_SERVICE_URL}`.
Authentication: `X-Service-Token: ${FACE_SERVICE_SECRET}` on every
request **except `GET /health`**.

| Endpoint | Method | Auth | Purpose |
| --- | --- | --- | --- |
| `/health` | GET | public | Liveness + readiness (engine state, model, provider, embedding dimension). |
| `/v1/faces/analyze` | POST | service token | Detect 0 / 1 / many faces + quality. Returns no embeddings. |
| `/v1/faces/compare` | POST | service token | 1:1 verification between two single-face images. |
| `/docs` | GET | public | OpenAPI Swagger UI (development only). |

### Error contract

```json
{
  "error": {
    "code": "STRING_CODE",
    "message": "Human readable."
  }
}
```

Stable codes include: `INVALID_IMAGE`, `IMAGE_TOO_LARGE`, `NO_FACE`,
`MULTIPLE_FACES`, `ENGINE_NOT_READY`, `MODEL_LOAD_FAILED`,
`INVALID_EMBEDDING`, `FACE_SERVICE_UNAUTHORIZED`.

Stack traces are logged server-side and **never** returned to clients.

## Data flow: a recognition call (PHASE 3)

```mermaid
sequenceDiagram
    participant C as Caller (apps/web)
    participant FS as face-service
    participant E as InsightFaceEngine
    participant ORT as ONNX Runtime (CPU)

    C->>FS: POST /v1/faces/analyze (multipart JPEG, X-Service-Token)
    FS->>FS: decode_image() — validate format/size/dims
    FS->>E: analyze(bytes)
    E->>ORT: SCRFD.detect (CPU)
    ORT-->>E: bboxes, landmarks
    E->>ORT: recognizer.get (CPU, per face)
    ORT-->>E: 512-D embeddings
    E-->>FS: DetectedFace list (ordered, quality metadata)
    FS-->>C: AnalyzeResponse JSON
```

## Phase plan

| Phase | Goal |
| --- | --- |
| 0 | Repo skeleton, docs, buildable foundations. |
| 0.5 | Dependency modernization. |
| 0.6 | Vercel deployment readiness. |
| **1** | Better Auth + Google OAuth + MongoDB session. |
| **2** | Application profile + role + onboarding. |
| **3** | **FastAPI + InsightFace Face Service — current phase.** |
| 4 | Face enrollment (`/face-enrollment`). |
| 5 | Classroom creation and join-by-code+password. |
| 6 | Attendance session lifecycle. |
| 7 | Multi-face recognition + temporal confirmation. |
| 8 | Attendance history + Excel export. |
| 9 | Anti-spoofing / liveness (pluggable `LivenessProvider`). |
| 10 | Testing, calibration, deployment hardening. |

## Non-goals (for now)

- Employee / organization module. The recognition core uses generic user
  IDs so a future employee module can be added without touching
  `FaceEngine`.
- Mobile native apps. The web app must work in modern mobile browsers,
  but there is no React Native target in this MVP.
- Paid SaaS dependencies.
- Liveness / anti-spoofing. Phase 3 does **not** perform any liveness
  check; see `docs/privacy-security.md` for the explicit warning.
