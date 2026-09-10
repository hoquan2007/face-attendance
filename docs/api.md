# API

> Status: **Phase 4.3** — Face Service operational in local development.
> Phase 3 shipped detection + 1:1 comparison + quality metadata. Phase
> 4.3 adds the **protected enrollment sample endpoint** (server-to-server
> only). `apps/web` still uses Phase 2 Server Actions for profile
> mutations; no HTTP recognition endpoints are wired into the web app
> yet. PHASE 4.4 (Next.js-side enrollment orchestration) is **NOT**
> implemented yet — that arrives in a later phase.

All endpoints are JSON unless stated otherwise. The web app and the Face
Service have separate base URLs and separate authentication mechanisms.

## Conventions

- Error responses use a consistent shape:

  ```json
  { "error": { "code": "STRING_CODE", "message": "Human readable." } }
  ```

  Initial error codes include: `UNAUTHENTICATED`, `FORBIDDEN`,
  `INVALID_PROFILE_DATA`, `IDENTIFICATION_CODE_TAKEN`, `PROFILE_NOT_FOUND`,
  `PROFILE_ALREADY_EXISTS`, `CLASS_NOT_FOUND`, `INVALID_CLASS_PASSWORD`,
  `ALREADY_MEMBER`, `FACE_NOT_FOUND`, `MULTIPLE_FACES`,
  `FACE_QUALITY_TOO_LOW`, `FACE_NOT_ENROLLED`, `SESSION_NOT_ACTIVE`,
  `UNKNOWN_FACE`, `FACE_SERVICE_UNAVAILABLE`.

  Phase 2 surface these via the Server Action `ActionResult.error.code`
  field; the stable codes used today are `UNAUTHENTICATED`,
  `INVALID_PROFILE_DATA`, `IDENTIFICATION_CODE_TAKEN`, `PROFILE_NOT_FOUND`,
  `UNKNOWN_ERROR`.

  Phase 3 Face Service codes include: `INVALID_IMAGE`, `IMAGE_TOO_LARGE`,
  `NO_FACE`, `MULTIPLE_FACES`, `ENGINE_NOT_READY`, `MODEL_LOAD_FAILED`,
  `INVALID_EMBEDDING`, `FACE_SERVICE_UNAUTHORIZED`.

- All request bodies are validated with Zod on the web side and Pydantic
  on the Python side.
- Server-side authorization is mandatory — never trust a client-supplied
  user id.

## `apps/web` (Next.js route handlers)

Base URL: `${NEXT_PUBLIC_APP_URL}`

| Prefix | Purpose | Phase |
| --- | --- | --- |
| `/api/auth/[...all]` | Better Auth catch-all (Google OAuth handlers). | **1** |
| `/api/me` | Current session user. | **1** |
| `/api/health` | Health probe (returns `{ status: "ok", service: "web" }`). | 0 |
| `/api/face/enroll` | Submit a single enrollment frame (multipart JPEG). | 4 |
| `/api/classes` | List / create / get classes. | 5 |
| `/api/classes/join` | Join with `classCode` + `classPassword`. | 5 |
| `/api/classes/:id/members` | Manage members (teacher only). | 5 |
| `/api/classes/:id/attendance/sessions` | Create / list sessions. | 6 |
| `/api/attendance/sessions/:id/recognize` | Teacher submits sampled frames; returns per-face result + confirmed records. | 7 |
| `/api/attendance/sessions/:id/end` | Stop a session. | 6 |
| `/api/attendance/sessions/:id/export` | Stream `.xlsx` (ExcelJS). | 8 |
| `/api/attendance/sessions/:id/history` | Session detail / history view. | 8 |

### Better Auth endpoints (Phase 1, exposed under `/api/auth/*`)

Better Auth exposes the following routes through the catch-all handler:

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/auth/session` | Returns the current session or 401. |
| POST | `/api/auth/sign-in/social` | Initiate Google OAuth flow. |
| GET | `/api/auth/callback/google` | Google OAuth callback (handled by Better Auth). |
| POST | `/api/auth/sign-out` | Invalidate current session and clear cookie. |

Browser code uses `authClient.signIn.social({ provider: "google" })` from
`better-auth/react` rather than calling these routes directly.

## Phase 2 Server Actions

Phase 2 uses Server Actions (not HTTP route handlers) for profile
mutations. They live in `apps/web/src/lib/profile-actions.ts` and are
invoked from the multi-step onboarding form and the profile edit form.

| Action | Purpose | Identity source |
| --- | --- | --- |
| `submitOnboarding(prev, FormData)` | Upsert the current user's `Profile`, set `onboardingCompleted: true`, redirect to `/dashboard`. | `getSession()` → `session.user.id`, `session.user.email` |
| `submitProfileUpdate(prev, FormData)` | Update the current user's `fullName` / `identificationCode` / `phone`. | `getSession()` → `session.user.id` |

Both actions validate form input with Zod, derive identity from the
Better Auth session (never from the form body), map MongoDB duplicate-key
errors to safe user-facing `ProfileError` instances, and revalidate the
dashboard / profile pages on success.

There is no `/api/profile` HTTP endpoint in Phase 2 — the only mutating
API is the Server Action. There is no public lookup endpoint for
arbitrary profiles.

### Action result shape

Both actions return a serializable object the client form can render:

```ts
type ActionResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string; fieldErrors?: Record<string, string[] | undefined> } };
```

Stable error codes include: `UNAUTHENTICATED`, `INVALID_PROFILE_DATA`,
`IDENTIFICATION_CODE_TAKEN`, `PROFILE_NOT_FOUND`, `UNKNOWN_ERROR`.
MongoDB internals (stack traces, connection strings, the `11000` code) are
never returned to the client.

## Page routes (Phase 2)

| Path | Auth requirement | Behaviour |
| --- | --- | --- |
| `/` | Public | Landing page with a link to `/login`. Authenticated users are redirected to `/onboarding` (incomplete) or `/dashboard` (complete). |
| `/login` | Public | Continue with Google button. Authenticated users are redirected to `/onboarding` (incomplete) or `/dashboard` (complete). |
| `/onboarding` | Required (server-side `getSession()`) | Two-step role + personal-info form. Unauthenticated users are redirected to `/login`. Authenticated users with a completed profile are redirected to `/dashboard`. |
| `/profile` | Required (session + completed Profile) | Read-only summary + edit form. Unauthenticated users are redirected to `/login`. Authenticated users without a completed profile are redirected to `/onboarding`. |
| `/dashboard` | Required (session + completed Profile) | Real profile data, role-aware empty state cards, Face ID status. Unauthenticated users are redirected to `/login`. Authenticated users without a completed profile are redirected to `/onboarding`. |

## `services/face-service` (FastAPI)

Base URL: `${FACE_SERVICE_URL}`

Authentication: `X-Service-Token: ${FACE_SERVICE_SECRET}` on every request
**except `GET /health`**.

| Endpoint | Method | Auth | Purpose | Phase |
| --- | --- | --- | --- | --- |
| `/health` | GET | public | Liveness + readiness (engine state, model, provider, embedding dimension). | **3** |
| `/v1/faces/analyze` | POST | service token | Detect 0 / 1 / many faces + quality metadata. **No embeddings returned.** | **3** |
| `/v1/faces/compare` | POST | service token | 1:1 verification between two single-face images (internal / Phase 4). | **3** |
| `/v1/faces/enrollment/sample` | POST | service token | Validate one enrollment sample (exactly one face + quality gate). Returns the L2-normalised embedding only on accept. **Server-to-server only.** | **4.3** |
| `/v1/recognize` | POST | service token | Detect + embed + match against provided candidate index. | 7 |
| `/v1/enroll` | POST | service token | Validate enrollment frame (single high-quality face). | 4 |
| `/v1/index/build` | POST | service token | Build a normalized candidate matrix from embeddings. | 7 |
| `/docs` | GET | public | OpenAPI Swagger UI. | **3** |

### `GET /health`

Returns:

```json
{
  "status": "ok",
  "engine": "insightface",
  "model": "buffalo_l",
  "provider": "CPUExecutionProvider",
  "ready": true,
  "embedding_dimension": 512
}
```

`status` is `"ok"` only when the model is loaded; otherwise
`"degraded"` with `ready=false`. When `MODEL_LOAD_FAILED` occurs the
response also carries `error_code` + `error_message`.

### `POST /v1/faces/analyze`

Request: `multipart/form-data` with a single `file` field
(JPEG / PNG / WebP / BMP).

Response:

```json
{
  "image": { "width": 1280, "height": 720 },
  "face_count": 2,
  "faces": [
    {
      "face_index": 0,
      "bbox": { "x": 312.5, "y": 145.0, "width": 168.0, "height": 168.0 },
      "detection_score": 0.96,
      "landmarks": [
        { "x": 354.0, "y": 191.0 }, { "x": 437.0, "y": 191.0 },
        { "x": 396.0, "y": 230.0 }, { "x": 354.0, "y": 269.0 },
        { "x": 437.0, "y": 269.0 }
      ],
      "quality": {
        "detection_score": 0.96,
        "face_width": 168.0,
        "face_height": 168.0,
        "relative_face_area": 0.0306,
        "blur_score": 142.7,
        "brightness": 0.58,
        "near_edge": false
      }
    }
  ],
  "processing_ms": 87.4
}
```

Faces are ordered **left-to-right** by bbox centre X with a stable
tie-break. The response **never** includes raw embeddings.

### `POST /v1/faces/compare`

Request: `multipart/form-data` with two image fields
(`image_a`, `image_b`). Each must contain exactly one face.

Response:

```json
{
  "similarity": 0.83,
  "threshold": 0.4,
  "match": true,
  "processing_ms": 165.1
}
```

The threshold is the configured `FACE_MATCH_THRESHOLD` —
**DEVELOPMENT BASELINE ONLY**. Re-calibrate with representative
evaluation data before any production deployment.

Domain errors:

- `NO_FACE` — 422, when either image contains 0 faces.
- `MULTIPLE_FACES` — 422, when either image contains > 1 face.

### `POST /v1/faces/enrollment/sample`

**Server-to-server only.** The browser must never call this endpoint
directly — it returns the L2-normalised embedding, a piece of biometric
data the Face Service otherwise never exposes. CORS is intentionally
not configured for arbitrary browser origins. Only the trusted Next.js
server (`apps/web`) is allowed to call this endpoint via the shared
`X-Service-Token`.

> Phase 4.3 ships this single sample endpoint only. Multi-sample
> finalisation, centroid calculation, re-enrollment, and the
> `EnrollmentSession` orchestration live in **PHASE 4.4** (not yet
> implemented).

Request: `multipart/form-data` with a single `image` field
(JPEG / PNG / WebP / BMP). Reuses the existing PHASE 3 image-decoding
pipeline and upload limits (`FACE_MAX_UPLOAD_MB`, `FACE_MAX_IMAGE_WIDTH`,
`FACE_MAX_IMAGE_HEIGHT`).

Behaviour:

- 0 faces → `422 NO_FACE` (stable PHASE 3 error envelope).
- 2+ faces → `422 MULTIPLE_FACES` (stable PHASE 3 error envelope).
- Exactly 1 face, quality gate passes → `200 OK` with `accepted=true`
  and the L2-normalised embedding + engine metadata.
- Exactly 1 face, quality gate fails → `200 OK` with `accepted=false`,
  a list of rejection codes, **no embedding**, **no model metadata**.

The endpoint never returns:

- the raw uploaded image,
- a face crop or aligned chip,
- filesystem paths,
- the `X-Service-Token` value.

Accepted response shape:

```json
{
  "accepted": true,
  "quality": {
    "detection_score": 0.95,
    "face_width": 120.0,
    "face_height": 120.0,
    "relative_face_area": 0.06,
    "blur_score": 400.0,
    "brightness": 0.5,
    "near_edge": false
  },
  "embedding": [/* 512 floats, L2-normalised, in order */],
  "rejection_reasons": [],
  "model": {
    "identity": "insightface-buffalo-l",
    "name": "buffalo_l",
    "embedding_dimension": 512,
    "normalization": "l2"
  },
  "processing_ms": 165.1
}
```

Rejected (single-face, poor quality) response shape:

```json
{
  "accepted": false,
  "quality": { "...": "..." },
  "embedding": null,
  "rejection_reasons": ["TOO_BLURRY"],
  "model": null,
  "processing_ms": 80.2
}
```

Stable quality rejection codes:

| Code | Meaning |
| --- | --- |
| `LOW_DETECTION_CONFIDENCE` | `detection_score` below threshold. |
| `FACE_TOO_SMALL` | `relative_face_area` below threshold. |
| `FACE_TOO_LARGE` | `relative_face_area` above threshold. |
| `TOO_BLURRY` | `blur_score` (variance of Laplacian) below threshold. |
| `TOO_DARK` | normalised brightness below threshold. |
| `TOO_BRIGHT` | normalised brightness above threshold. |
| `FACE_NEAR_EDGE` | bbox touches the image border. |

A sample may carry more than one rejection reason. The order is
deterministic (see `app/engine/enrollment_quality.py`).

#### Development thresholds — NOT PRODUCTION-CALIBRATED

All thresholds live in a single configuration source
(`services/face-service/app/core/config.py`):

| Variable | Default | Notes |
| --- | --- | --- |
| `FACE_ENROLLMENT_MIN_DETECTION_SCORE` | `0.7` | Minimum SCRFD detection score. |
| `FACE_ENROLLMENT_MIN_FACE_AREA` | `0.03` | Minimum face / image area ratio. |
| `FACE_ENROLLMENT_MAX_FACE_AREA` | `0.6` | Maximum face / image area ratio. |
| `FACE_ENROLLMENT_MIN_BLUR_SCORE` | `80.0` | Minimum variance-of-Laplacian. |
| `FACE_ENROLLMENT_MIN_BRIGHTNESS` | `0.18` | Minimum normalised luminance. |
| `FACE_ENROLLMENT_MAX_BRIGHTNESS` | `0.85` | Maximum normalised luminance. |

**These baselines are not production-calibrated.** Re-calibrate against a
representative evaluation set before any production deployment.

Scale strategy: the policy uses `relative_face_area` (face_area /
image_area) for too-small / too-large decisions because raw pixel size
depends on resolution. Brightness refers to image exposure only — the
policy never rejects based on skin tone, ethnicity, age, or gender.

## Camera transport (future)

- The browser samples the local `MediaStream` at a configurable rate
  (target 2–5 fps).
- Each sampled frame is resized, JPEG-encoded, sent as
  `multipart/form-data` `file=@frame.jpg`.
- Base64 image transport is avoided unless technically required.
- No video streaming.
