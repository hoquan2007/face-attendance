# API

> Status: **Phase 4.4C** — PHASE 4.4A shipped the Next.js server-only
> `FaceServiceClient`. PHASE 4.4B1 shipped the first Next.js Face ID
> route — `POST /api/face-id/enrollment/start` — which safely starts a
> temporary enrollment session for the authenticated user.
> PHASE 4.4B2 added the read-only status route
> `GET /api/face-id/enrollment/status`, which reports the safe current
> state of the user's Face ID enrollment without exposing any
> biometric data. PHASE 4.4C adds the sample upload route
> `POST /api/face-id/enrollment/sample`, which accepts one image,
> forwards it to the Face Service, encrypts accepted embeddings,
> and stores them in the temporary enrollment session.
> Camera UI, finalization, and re-enrollment belong to later phases.

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
| `/api/face-id/enrollment/start` | Start (or reset) a temporary enrollment session. Authenticated, no biometric payload. | **4.4B1** |
| `/api/face-id/enrollment/status` | Read-only safe status of permanent Face ID configuration and temporary enrollment progress. Authenticated, no biometric payload. | **4.4B2** |
| `/api/face-id/enrollment/sample` | Submit one enrollment sample image. Server-side Face Service call, AES-256-GCM encryption. Authenticated, active enrollment required. | **4.4C** |
| `/api/face/enroll` | Submit a single enrollment frame (multipart JPEG). | 4.4B |
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

### `POST /api/face-id/enrollment/start` (PHASE 4.4B1)

Safely starts (or resets) a temporary biometric enrollment session
for the currently authenticated user. The route is **not** a sample
upload — it accepts **no** biometric payload (image, embedding,
encrypted vector) and **does not** call the Face Service.

- **Auth:** required. Identity comes exclusively from
  `session.user.id`; client-supplied `userId` / `email` in the request
  body are ignored.
- **Profile requirement:** the authenticated user must already have a
  completed application Profile (`onboardingCompleted === true`).
  The route does NOT auto-create a Profile.
- **Existing `FaceProfile`:** in PHASE 4.4B1 a new enrollment is
  refused if an active `FaceProfile` already exists. The existing
  profile is left untouched. Explicit re-enrollment is implemented
  in a later mini-phase.
- **TTL:** the temporary session's `expiresAt` is generated
  server-side as `now + 15 minutes` using the centralized
  `DEFAULT_ENROLLMENT_SESSION_TTL_MS` helper. The browser cannot
  choose the expiry.
- **Reset semantics:** calling `start` again for a user who already
  has an unfinished CREATE session resets that session in place
  (`acceptedSamples` cleared, new `expiresAt`, model metadata
  cleared). Repeated requests cannot create duplicate enrollment
  documents.
- **Concurrency:** the existing `FaceEnrollmentSession` model is
  uniquely indexed on `userId`. The `createOrResetEnrollmentSession`
  service uses an upsert keyed on `userId`. At most one
  enrollment-session document per user exists at any time.

Request: `POST` with no body (the route does not read any input).

Success response (`200 OK`):

```json
{
  "status": "started",
  "mode": "create",
  "acceptedSamples": 0,
  "requiredSamples": 5,
  "expiresAt": "2026-09-10T14:30:00.000Z"
}
```

The response deliberately does **not** include `userId`, `email`,
encrypted samples, ciphertext / IV / authTag, model metadata, or
embeddings — the browser does not need them and they are not safe to
expose.

Error responses follow the project-wide shape:

```json
{ "error": { "code": "STRING_CODE", "message": "Human readable." } }
```

Stable codes for this endpoint:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | No valid Better Auth server session. |
| `PROFILE_INCOMPLETE` | 409 | Authenticated user has no Profile, or `onboardingCompleted` is false. The route does not auto-create a Profile. |
| `FACE_PROFILE_ALREADY_EXISTS` | 409 | Authenticated user already has an active `FaceProfile`. PHASE 4.4B1 blocks new enrollments in this state. |
| `ENROLLMENT_START_FAILED` | 500 | Persistence failure during create-or-reset. Mongoose / MongoDB internals are never returned. |

### `GET /api/face-id/enrollment/status` (PHASE 4.4B2)

Read-only endpoint that reports the safe current state of the
authenticated user's Face ID enrollment. The route is **not** a
sample upload — it accepts **no** biometric payload (image,
embedding, encrypted vector) and **does not** call the Face Service
or the encryption module.

- **Auth:** required. Identity comes exclusively from
  `session.user.id`; query parameters such as `?userId=...` are
  ignored.
- **Profile requirement:** the authenticated user must already have a
  completed application Profile (`onboardingCompleted === true`).
  The route does NOT auto-create a Profile.
- **Biometric payload:** none accepted, none read, none returned.
  The route never decrypts anything; `BIOMETRIC_ENCRYPTION_KEY` is
  not required to read status.
- **Face Service calls:** none. The route is a pure database read
  with optional best-effort cleanup of an expired enrollment
  session.
- **Expired sessions:** MongoDB TTL deletion is asynchronous. The
  route treats `expiresAt <= now` as expired even if the document
  is still present, attempts a best-effort
  `deleteEnrollmentSessionByUserId(...)` cleanup, and reports
  `enrollment.active = false` regardless of cleanup outcome.
- **Re-enrollment:** the route reports the facts; it does NOT
  auto-replace or delete the existing `FaceProfile`.

Request: `GET` (no body).

Success response (`200 OK`):

```json
{
  "configured": false,
  "faceId": null,
  "enrollment": {
    "active": false,
    "mode": null,
    "acceptedSamples": 0,
    "requiredSamples": 0,
    "expiresAt": null
  }
}
```

When the user has a permanent `FaceProfile`:

```json
{
  "configured": true,
  "faceId": {
    "enrolledAt": "2026-09-01T10:00:00.000Z",
    "sampleCount": 5
  },
  "enrollment": {
    "active": false,
    "mode": null,
    "acceptedSamples": 0,
    "requiredSamples": 0,
    "expiresAt": null
  }
}
```

When a temporary enrollment session is in progress (CREATE or
REPLACE):

```json
{
  "configured": false,
  "faceId": null,
  "enrollment": {
    "active": true,
    "mode": "create",
    "acceptedSamples": 2,
    "requiredSamples": 5,
    "expiresAt": "2026-09-10T14:30:00.000Z"
  }
}
```

`mode` is the literal stored value — either `"create"` or
`"replace"`. `acceptedSamples` is the LENGTH of the stored
`acceptedSamples` array; the actual array is never returned.

The response deliberately does **not** include `userId`, `email`,
encrypted samples, ciphertext / IV / authTag, model metadata,
embeddings, centroids, or quality summaries — the browser does not
need them and they are not safe to expose.

Error responses follow the project-wide shape:

```json
{ "error": { "code": "STRING_CODE", "message": "Human readable." } }
```

Stable codes for this endpoint:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | No valid Better Auth server session. |
| `PROFILE_INCOMPLETE` | 409 | Authenticated user has no Profile, or `onboardingCompleted` is false. The route does not auto-create a Profile. |
| `ENROLLMENT_STATUS_FAILED` | 500 | Persistence failure during status read. Mongoose / MongoDB internals are never returned. |

### `POST /api/face-id/enrollment/sample` (PHASE 4.4C)

Accepts ONE image from the authenticated web client, forwards it to the
trusted Face Service, encrypts accepted embeddings with AES-256-GCM,
and stores only encrypted sample data in the current temporary enrollment
session. The browser **never** receives embedding, ciphertext, IV, authTag,
keyVersion, or userId.

- **Auth:** required. Identity comes exclusively from
  `session.user.id`; client-supplied `userId` in the request body is
  ignored.
- **Profile requirement:** the authenticated user must already have a
  completed application Profile (`onboardingCompleted === true`).
  The route does NOT auto-create a Profile.
- **Active enrollment required:** an unexpired enrollment session must
  exist. Expired sessions return `ENROLLMENT_EXPIRED`; absent sessions
  return `ENROLLMENT_NOT_STARTED`. Users must call
  `POST /api/face-id/enrollment/start` explicitly.
- **Create mode only:** current implementation supports sessions with
  `mode = "create"` only. Replace-mode sessions are not yet supported.
- **One image per request:** `multipart/form-data` with exactly one
  `image` field. JSON base64, multiple files, and video are not
  accepted.
- **Image validation:** validated at the Next.js boundary before
  forwarding:
  - File must exist, size > 0, size ≤ 1.5 MB
  - MIME type must be `image/jpeg`, `image/png`, or `image/webp`
  - Face Service remains authoritative for real image decoding
- **Face Service call:** uses existing `analyzeEnrollmentSample(...)`
  through `face-service-client.ts`. Direct fetch in the route is
  forbidden. No automatic retry.
- **Quality rejection:** Face Service may return `accepted=false` with
  reasons like `TOO_BLURRY`, `FACE_TOO_SMALL`, etc. This is a normal
  domain response. Nothing is stored. The response includes rejection
  reasons for UI feedback.
- **Accepted sample:** embedding is encrypted using PHASE 4.1
  AES-256-GCM with AAD binding to `userId`, model identity, template
  version, `vectorType = "sample"`, and `sampleIndex`. Only encrypted
  data (ciphertext, IV, authTag, keyVersion) is persisted to MongoDB.
- **Model metadata:** the first accepted sample establishes session
  model metadata (identity, name, dimension, normalization). Subsequent
  samples must be compatible; mismatches return `MODEL_MISMATCH`.
- **Sample cap:** maximum 5 samples. When `acceptedSamples.length >=
  requiredSampleCount`, the route returns
  `ENROLLMENT_SAMPLE_LIMIT_REACHED` without calling the Face Service.
- **Concurrency:** atomic append via MongoDB `findOneAndUpdate` with
  filter conditions prevents race conditions.
- **No finalization:** `complete=true` in the response only means enough
  samples collected. `FaceProfile` creation belongs to a later phase.

Request: `POST` with `multipart/form-data`.

```
Content-Type: multipart/form-data
```

Form field: `image` — one image file (JPEG/PNG/WebP, max 1.5 MB).

Success response — accepted sample (`200 OK`):

```json
{
  "accepted": true,
  "rejectionReasons": [],
  "progress": {
    "acceptedSamples": 1,
    "requiredSamples": 5,
    "complete": false
  }
}
```

When `acceptedSamples` reaches `requiredSamples`:

```json
{
  "accepted": true,
  "rejectionReasons": [],
  "progress": {
    "acceptedSamples": 5,
    "requiredSamples": 5,
    "complete": true
  }
}
```

Success response — rejected quality (`200 OK`):

```json
{
  "accepted": false,
  "rejectionReasons": ["FACE_TOO_SMALL"],
  "progress": {
    "acceptedSamples": 2,
    "requiredSamples": 5,
    "complete": false
  }
}
```

The response deliberately does **not** include `embedding`, `ciphertext`,
`iv`, `authTag`, `keyVersion`, `modelIdentity`, or `userId`.

Error responses follow the project-wide shape:

```json
{ "error": { "code": "STRING_CODE", "message": "Human readable." } }
```

Stable codes for this endpoint:

| Code | HTTP | Meaning |
| --- | --- | --- |
| `UNAUTHENTICATED` | 401 | No valid Better Auth server session. |
| `PROFILE_INCOMPLETE` | 409 | Authenticated user has no Profile, or `onboardingCompleted` is false. |
| `ENROLLMENT_NOT_STARTED` | 409 | No active enrollment session. Call `POST /api/face-id/enrollment/start` first. |
| `ENROLLMENT_EXPIRED` | 409 | Enrollment session has expired. Call `POST /api/face-id/enrollment/start` again. |
| `INVALID_IMAGE` | 400 | No image provided, or invalid MIME type. |
| `IMAGE_TOO_LARGE` | 400 | Image exceeds 1.5 MB limit. |
| `NO_FACE` | 422 | No face detected in the image. |
| `MULTIPLE_FACES` | 422 | Multiple faces detected. Exactly one required. |
| `MODEL_MISMATCH` | 502 | Face Service model incompatible with session. |
| `ENROLLMENT_SAMPLE_LIMIT_REACHED` | 502 | Maximum 5 samples already collected. |
| `FACE_SERVICE_UNAVAILABLE` | 502 | Face Service unreachable or returned an error. |
| `FACE_SERVICE_TIMEOUT` | 502 | Face Service request timed out. |
| `FACE_SERVICE_NOT_CONFIGURED` | 502 | Face Service URL/secret not configured. |
| `BIOMETRIC_ENCRYPTION_UNAVAILABLE` | 503 | Encryption key missing or invalid. |
| `ENROLLMENT_SAMPLE_FAILED` | 500 | Could not save sample (concurrency conflict, persistence error). |

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
