# API

> Status: **Phase 4.6B3B** — PHASE 4.4A shipped the Next.js server-only
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
> PHASE 4.6B1A extends the existing server-only `FaceServiceClient`
> with a `finalizeFaceEnrollment(...)` function that calls
> `POST /v1/faces/enrollment/finalize`. The function is the
> server-only Next.js client for the protected finalization endpoint;
> it is server-only, validates the request and the returned centroid,
> preserves the upstream domain codes, and does NOT read MongoDB,
> decrypt samples, or persist anything.
> PHASE 4.6B1B adds the server-only Next.js orchestration function
> `finalizeEnrollmentSessionForUser(userId)` that loads the
> temporary enrollment session, decrypts its accepted samples
> server-side, validates plaintext vectors, calls the B1A client
> exactly once, and re-checks the enrollment generation after the
> response. B1B is server-internal only: there is still NO public
> Next.js finalization API. PHASE 4.6B2 will expose the orchestration
> through an authenticated route and add the atomic persistence
> generation compare; until then no finalization is user-accessible.
> PHASE 4.6B2B adds the claim-bound `FaceProfile` persistence
> orchestration in `face-profile-finalization-service.ts`
> (`persistFinalizedFaceProfileForUser`). It is **server-only**
> and is **NOT** wired to any HTTP route, Server Action, or UI
> in this phase. PHASE 4.6B2C will atomically consume the
> temporary enrollment session; until then no finalize endpoint
> exists for the browser.
> PHASE 4.6B2C adds the temporary-enrollment consumption +
> post-persistence crash-recovery orchestration in
> `face-enrollment-completion-service.ts`
> (`completeFinalizedFaceEnrollmentForUser`). It remains
> **server-internal only** — there is intentionally NO
> browser-visible finalize route, Server Action, or UI in B2C.

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
| — _no finalize endpoint_ | PHASE 4.6B2B performs claim-bound `FaceProfile` persistence entirely server-only via `persistFinalizedFaceProfileForUser(userId)`. There is intentionally NO browser-visible finalize route, Server Action, or UI in this phase. Cleanup / session consumption belongs to PHASE 4.6B2C. | **4.6B2B** |
| `finishFaceEnrollment()` *(Server Action)* | Zero-argument authenticated Server Action that wraps `completeFinalizedFaceEnrollmentForUser`. Identity derives exclusively from the Better Auth session; the action gates on a completed `Profile` and returns a small safe browser result `{ ok, configured, faceId: { enrolledAt, sampleCount }, cleanupStatus }`. No biometric payload, no claim token, no `userId`/`generationId`/`centroid`/ciphertext exposure. NO `POST /api/face-id/enrollment/finalize` route exists — the Server Action is the only entry point. PHASE 4.6B3B consumes this Server Action from the `EnrollmentFinishButton` client component (zero-argument invocation, double-click protected, navigates to `/face-id` on success). | **4.6B3A / 4.6B3B** |
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
  "expiresAt": "2026-09-10T14:30:00.000Z",
  "generationId": "<stable server-issued UUID>"
}
```

The response deliberately does **not** include `userId`, `email`,
encrypted samples, ciphertext / IV / authTag, model metadata, or
embeddings — the browser does not need them and they are not safe to
expose.

`generationId` is a stable UUID v4 issued by the server at
create-or-reset time (PHASE 4.5B4.3). The browser uses it as the
primary reconciliation discriminator for multi-tab and reload
resilience. It is not a secret and is safe to render.

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
| `ENROLLMENT_FINALIZATION_IN_PROGRESS` | 409 | PHASE 4.6B2A — an active finalization claim is held by the in-progress B2B orchestrator. The route refuses to replace the claimed generation. The browser may retry shortly. The response never includes the claim token, generationId, or any Mongo detail. |
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
    "expiresAt": null,
    "generationId": null
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
    "expiresAt": null,
    "generationId": null
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
    "expiresAt": "2026-09-10T14:30:00.000Z",
    "generationId": "<stable server-issued UUID>"
  }
}
```

`mode` is the literal stored value — either `"create"` or
`"replace"`. `acceptedSamples` is the LENGTH of the stored
`acceptedSamples` array; the actual array is never returned.

`generationId` (PHASE 4.5B4.3) is the stable UUID the server uses
as the reconciliation discriminator. For any active session it is
a non-empty server-issued value. For inactive enrollment it is
`null`. The status service never invents an ephemeral UUID; the
identity comes from the persisted session document (or from a lazy
atomic backfill for legacy sessions created before B4.3).

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

### Browser consumption of `POST /api/face-id/enrollment/sample` (PHASE 4.5B3)

PHASE 4.5B3 introduces the first browser caller of the sample
endpoint. The contract above is unchanged; this subsection documents
the small, restrained client shape.

- **Single network target:** the browser posts to
  `POST /api/face-id/enrollment/sample` ONLY. The browser does not
  call `${FACE_SERVICE_URL}` or the FastAPI
  `/v1/faces/enrollment/sample` route.
- **Headers:** no `Authorization`, no `X-Service-Token`, no manual
  `Content-Type: multipart/form-data`. The browser is allowed to
  generate the multipart boundary itself.
- **Body:** `multipart/form-data` with exactly one field named
  `image`, carrying the JPEG `Blob`. Filename is the harmless
  metadata string `"face-sample.jpg"`.
- **Identity:** the request body MUST NOT carry `userId`, `email`,
  `sampleIndex`, or `modelIdentity`. Identity is derived from the
  Better Auth session exclusively, and the sample index is managed
  atomically server-side.
- **One capture, one POST:** each Capture sample click produces
  exactly one capture and exactly one POST. There is no automatic
  retry on timeout, 409 conflict, 5xx, or network failure.
- **Parsed response:** the browser parses the route's safe shape
  with a Zod schema. Recognised fields are `accepted`,
  `rejectionReasons`, and `progress.{acceptedSamples,
  requiredSamples, complete}`. On error the standard envelope
  `{ error: { code, message } }` is consumed. The browser never sees
  `embedding`, `ciphertext`, `iv`, `authTag`, `keyVersion`,
  `modelIdentity`, or `userId`.
- **Blob lifecycle:** the captured JPEG `Blob` is held only in a
  local variable inside the click handler. It is never stored in
  React state, never passed through `URL.createObjectURL`, and never
  written to `localStorage` / `sessionStorage` / IndexedDB / the
  Cache API.
- **Finalization:** `progress.complete === true` only disables
  further submissions. It does NOT trigger any other endpoint, does
  NOT calculate a centroid, and does NOT create a `FaceProfile`.

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
| `/v1/faces/enrollment/finalize` | POST | service token | Finalize an enrollment batch: validate model compatibility, run pairwise consistency check, return normalized centroid on success. **Server-to-server only.** | **4.6A2** |
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

### `POST /v1/faces/enrollment/finalize`

**Server-to-server only (PHASE 4.6A2).** The browser must never call
this endpoint directly — it receives biometric vectors and returns a
centroid. Only the trusted Next.js server calls it after decrypting
MongoDB data.

**Architecture boundary:** The Face Service does NOT read MongoDB,
does NOT perform biometric decryption (AES-GCM, `BIOMETRIC_ENCRYPTION_KEY`),
and does NOT persist the centroid. These responsibilities belong to
PHASE 4.6B.

**Authentication:** `X-Service-Token` required (same as other `/v1/*` routes).

**Request shape:**

```json
{
  "model": {
    "identity": "insightface-buffalo-l",
    "name": "buffalo_l",
    "embedding_dimension": 512,
    "normalization": "l2"
  },
  "required_sample_count": 5,
  "embeddings": [
    [0.123, -0.456, ...],
    [0.111, -0.444, ...],
    ...
  ]
}
```

The request NEVER carries: `userId`, `email`, `ciphertext`, `iv`,
`authTag`, `keyVersion`, images, or face crops.

**Response (consistent batch, HTTP 200):**

```json
{
  "consistent": true,
  "sample_count": 5,
  "pair_count": 10,
  "min_self_similarity": 0.82,
  "mean_self_similarity": 0.87,
  "threshold": 0.7,
  "centroid": [0.123, -0.456, ...],
  "model": {
    "identity": "insightface-buffalo-l",
    "name": "buffalo_l",
    "embedding_dimension": 512,
    "normalization": "l2"
  }
}
```

**Response (inconsistent batch, HTTP 422):**

```json
{
  "consistent": false,
  "error": {
    "code": "INCONSISTENT_FACE_SAMPLES",
    "message": "Enrollment batch is internally inconsistent..."
  }
}
```

**Stable domain error codes:**

| Code | HTTP | Meaning |
| --- | --- | --- |
| `MODEL_MISMATCH` | 422 | Request metadata incompatible with active engine. |
| `INVALID_SAMPLE_COUNT` | 422 | `required_sample_count < 2` or count mismatch. |
| `INVALID_EMBEDDING` | 422 | Empty / non-finite / wrong dimension embedding. |
| `EMBEDDING_DIMENSION_MISMATCH` | 422 | Embedding dimension disagrees with metadata. |
| `EMBEDDING_NOT_NORMALIZED` | 422 | Embedding is not L2-normalised. |
| `INCONSISTENT_FACE_SAMPLES` | 422 | Min pairwise similarity below threshold. No centroid. |
| `INVALID_CENTROID` | 422 | Defensive: arithmetic mean non-finite or zero-norm. |

**Configuration:** `FACE_ENROLLMENT_MIN_SELF_SIMILARITY` (default: `0.7`).
DEVELOPMENT BASELINE ONLY — calibrate before production.

**Privacy:** Embeddings, centroid values, and request bodies are never
logged. Safe log fields: `sample_count`, `pair_count`, `consistent`,
`model_identity`, domain error code.

## Server-only Next.js finalization client (PHASE 4.6B1A)

PHASE 4.6B1A extends the existing PHASE 4.4A server-only
`FaceServiceClient` with one new function:

```
finalizeFaceEnrollment(input: FinalizeFaceEnrollmentInput)
                       -> Promise<FinalizeFaceEnrollmentResult>
```

It is the Next.js server-only client for the PHASE 4.6A2 endpoint
`POST /v1/faces/enrollment/finalize`.

### Import

```ts
import { finalizeFaceEnrollment } from "@/lib/biometrics/face-service-client";
```

Because the module opens with `import "server-only"`, this import is
forbidden inside Client Components. Use it from Server Components,
Server Actions, or Route Handlers.

### Input shape (server-internal)

```ts
type FinalizeFaceEnrollmentInput = {
  model: {
    identity: string;          // e.g. "insightface-buffalo-l"
    name: string;              // e.g. "buffalo_l"
    embeddingDimension: number;
    normalization: "l2";
  };
  requiredSampleCount: number; // >= 2
  embeddings: number[][];      // length === requiredSampleCount
};
```

The request never carries `userId`, `email`, `generationId`, or any
MongoDB identifier.

### Success result shape

```ts
type FinalizeFaceEnrollmentResult = {
  consistent: true;
  sampleCount: number;
  pairCount: number;
  minSelfSimilarity: number;
  meanSelfSimilarity: number;
  threshold: number;
  centroid: number[];
  model: {
    identity: string;
    name: string;
    embeddingDimension: number;
    normalization: string;
  };
};
```

The HTTP envelope is NOT exposed; the result is a strongly typed
server-internal object.

### Behaviour

- Sends `Content-Type: application/json`.
- Sends `X-Service-Token` using the existing auth path.
- Reuses the existing 10-second timeout.
- Exactly one POST per invocation. No automatic retry.
- Validates the request shape server-side BEFORE the HTTP call.
- Validates the returned centroid: non-empty, finite, dimension
  matches both request and response model metadata, L2 norm ≈ 1
  (tolerance 1e-3).
- Enforces exact response `model` metadata match against request
  metadata; mismatches fail safely.

### Domain error codes (preserved on `domainError.code`)

| Upstream code | HTTP | Mapped client code |
| --- | --- | --- |
| `INCONSISTENT_FACE_SAMPLES` | 422 | `FACE_SERVICE_REJECTED_REQUEST` + centroid never exposed |
| `MODEL_MISMATCH` | 422 | `FACE_SERVICE_REJECTED_REQUEST` |
| `INVALID_SAMPLE_COUNT` | 422 | `FACE_SERVICE_REJECTED_REQUEST` |
| `INVALID_EMBEDDING` | 422 | `FACE_SERVICE_REJECTED_REQUEST` |
| `EMBEDDING_DIMENSION_MISMATCH` | 422 | `FACE_SERVICE_REJECTED_REQUEST` |
| `EMBEDDING_NOT_NORMALIZED` | 422 | `FACE_SERVICE_REJECTED_REQUEST` |
| `INVALID_CENTROID` | 422 | `FACE_SERVICE_REJECTED_REQUEST` |

Transport-level codes are unchanged:
`FACE_SERVICE_NOT_CONFIGURED`, `FACE_SERVICE_UNAVAILABLE`,
`FACE_SERVICE_TIMEOUT`, `FACE_SERVICE_UNAUTHORIZED`,
`FACE_SERVICE_INVALID_RESPONSE`, `FACE_SERVICE_REJECTED_REQUEST`.

### Privacy

The plaintext embeddings and centroid live only in server memory for
the lifetime of the call. They are never logged, never serialized
into a safe error message, and never persisted.

### What PHASE 4.6B1A does NOT do

- No MongoDB read / write
- No AES-GCM decryption
- No `FaceEnrollmentSession` or `FaceProfile` persistence
- No temporary-session deletion
- No finalization API route or Server Action
- No browser fetch
- No re-enrollment

## Phase 4.6B1B Next.js finalization orchestration (server-only)

PHASE 4.6B1B adds the first server-only Next.js orchestration layer
that combines the PHASE 4.5B4.3 enrollment session persistence
service, the PHASE 4.1 AES-GCM decryption utility, and the PHASE
4.6B1A `finalizeFaceEnrollment` client. The orchestrator is exposed
internally as a single function:

```ts
finalizeEnrollmentSessionForUser(userId: string)
  -> Promise<EnrollmentFinalizationResult>
```

Implementation lives at
`apps/web/src/lib/biometrics/enrollment-finalization-service.ts`.
The module opens with `import "server-only"`. There is no
public Next.js route, Server Action, or browser fetch in B1B —
orchestration exposure is a precondition for PHASE 4.6B3, and
authentication is documented as a precondition for callers.

### Public Next.js API in PHASE 4.6B1B

- No new public Next.js API.
- No Next.js Server Action.
- No browser fetch.
- No UI / button / `router.refresh`.

### Stable error codes

The orchestrator exposes a focused set of orchestration codes that
mirror the validation it actually performs:

| Code | Status (when surfaced) | Notes |
| --- | --- | --- |
| `ENROLLMENT_SESSION_NOT_FOUND` | 404 | No current session for `userId`. |
| `ENROLLMENT_SESSION_EXPIRED` | 410 | Session expired — no decrypt, no Face Service call. |
| `ENROLLMENT_INCOMPLETE` | 409 | `acceptedSamples.length !== requiredSampleCount`. |
| `ENROLLMENT_SESSION_INVALID` | 422 | Required authoritative metadata missing or malformed. |
| `UNSUPPORTED_ENROLLMENT_MODE` | 409 | Only `create` is supported in B1B. |
| `UNSUPPORTED_TEMPLATE_VERSION` | 422 | `templateVersion` not in the supported set. |
| `ENROLLMENT_SAMPLE_INDEX_INVALID` | 422 | Sample indexes are not exactly `0..N-1`. |
| `ENROLLMENT_SAMPLE_DECRYPTION_FAILED` | 422 | AES-GCM auth tag failed; the whole batch is aborted. |
| `ENROLLMENT_SAMPLE_VECTOR_INVALID` | 422 | Decrypted plaintext vector failed dimension / finiteness / L2-norm check. |
| `ENROLLMENT_GENERATION_CHANGED` | 409 | Post-finalize recheck failed — the centroid is discarded. |

The orchestrator preserves B1A's `FaceServiceClientError` codes
(`INCONSISTENT_FACE_SAMPLES`, `MODEL_MISMATCH`, `INVALID_SAMPLE_COUNT`,
`INVALID_EMBEDDING`, `EMBEDDING_DIMENSION_MISMATCH`,
`EMBEDDING_NOT_NORMALIZED`, `INVALID_CENTROID`) on `domainError.code`
so a future API layer can distinguish them.

### Result shape (server-only)

```ts
type EnrollmentFinalizationResult = {
  sourceGenerationId: string;     // captured before finalize
  mode: "create";
  templateVersion: number;
  requiredSampleCount: number;
  model: {
    identity: string;
    name: string;
    embeddingDimension: number;
    normalization: "l2";
  };
  finalization: {
    sampleCount: number;
    pairCount: number;
    minSelfSimilarity: number;
    meanSelfSimilarity: number;
    threshold: number;
    centroid: number[];            // SERVER-ONLY; not user-accessible in B1B
  };
};
```

The result intentionally excludes `userId`, encrypted samples,
plaintext sample embeddings, ciphertext, IV, and authTag. The
plaintext sample vectors are wiped best-effort after the B1A call
resolves.

### Privacy

- AES-GCM decryption happens ONLY inside the server-only
  orchestrator. The browser never sees decrypted embeddings.
- The AAD is reconstructed from authoritative persisted session
  metadata and the function argument's `userId`. No browser-supplied
  metadata participates in AAD reconstruction.
- Plaintext sample embeddings live only in local server memory for
  the duration of the call.
- No FaceProfile is written; no temporary enrollment session is
  deleted. PHASE 4.6B2 will add the atomic generation compare and
  the persistence/delete operations.

## Camera transport (future)

- The browser samples the local `MediaStream` at a configurable rate
  (target 2–5 fps).
- Each sampled frame is resized, JPEG-encoded, sent as
  `multipart/form-data` `file=@frame.jpg`.
- Base64 image transport is avoided unless technically required.
- No video streaming.

## Authenticated enrollment completion Server Action (PHASE 4.6B3A)

PHASE 4.6B3A ships the first authenticated entry point on top of
the B2C orchestrator. The action is implemented at
`apps/web/src/lib/biometrics/enrollment-completion-action.ts`
and opens with `"use server"`. It is the **only** finalization
entry point exposed by PHASE 4.6B3A; there is intentionally no
`POST /api/face-id/enrollment/finalize` HTTP route.

### `finishFaceEnrollment()` *(Server Action)*

Zero-argument action. The browser does NOT supply a `userId`,
`email`, `generationId`, `claimToken`, `centroid`, `sampleIndex`,
or `FaceProfile` id. Identity comes exclusively from the Better
Auth server session.

#### Input

The action signature is:

```ts
finishFaceEnrollment(): Promise<FaceEnrollmentCompletionActionResult>
```

There is no input. The function has arity `0`.

#### Authentication

The action uses the existing `getSession()` helper from
`@/lib/session`, which calls `auth.api.getSession({ headers })`.
A missing session returns a safe `UNAUTHENTICATED` error result.
Raw Better Auth errors are NEVER serialized into the response.

#### Profile gating

The action calls `isOnboardingComplete(session.user.id)`. A
profile that does not exist or has `onboardingCompleted === false`
returns `PROFILE_INCOMPLETE`. The action does NOT auto-create a
profile.

#### Delegation

After auth + profile validation the action invokes
`completeFinalizedFaceEnrollmentForUser(session.user.id)`
EXACTLY ONCE. The action never calls B1B / B2A / B2B / the Face
Service client / a Mongoose model directly. B2C is the
authoritative completion orchestration boundary.

#### Success response

```json
{
  "ok": true,
  "configured": true,
  "faceId": {
    "enrolledAt": "2026-09-12T10:00:00.000Z",
    "sampleCount": 5
  },
  "cleanupStatus": "consumed"
}
```

`cleanupStatus` may be `"consumed"`, `"already_consumed"`, or
`"cleanup_pending"`. All three express a fully-finished
enrollment. The success response NEVER includes `userId`,
`generationId`, `sourceEnrollmentGenerationId`, `claimToken`,
`centroid`, plaintext embeddings, ciphertext, IV, authTag,
`keyVersion`, `modelIdentity`, `modelName`,
`embeddingDimension`, or `normalization`.

#### Error response

The discriminated-union error result carries a stable code, a
restrained human-readable message, and a `retryable` hint:

```json
{
  "ok": false,
  "code": "INCONSISTENT_FACE_SAMPLES",
  "message": "The captured samples were not consistent enough. Start setup again and capture new samples.",
  "retryable": false
}
```

Stable codes (all browser-safe — no claim tokens, no
generationIds, no model identifiers, no thresholds):

| Code | Meaning | retryable |
| --- | --- | --- |
| `UNAUTHENTICATED` | No Better Auth server session. | `false` |
| `PROFILE_INCOMPLETE` | Onboarding / `Profile` not complete. | `false` |
| `ENROLLMENT_SESSION_NOT_FOUND` | No temporary enrollment session for this user. | `false` |
| `ENROLLMENT_SESSION_EXPIRED` | Temporary session expired. | `false` |
| `ENROLLMENT_INCOMPLETE` | Fewer than the required samples collected. | `false` |
| `INCONSISTENT_FACE_SAMPLES` | Face Service rejected the batch as inconsistent. | `false` |
| `MODEL_MISMATCH` | Session model incompatible with the active engine / template. | `false` |
| `ENROLLMENT_SAMPLE_DECRYPTION_FAILED` | AES-GCM auth tag failure (data integrity). | `false` |
| `ENROLLMENT_SAMPLE_VECTOR_INVALID` | Decrypted plaintext vector failed validation. | `false` |
| `ENROLLMENT_GENERATION_CHANGED` | Another tab reset the session mid-flight. | `true` |
| `ENROLLMENT_FINALIZATION_ALREADY_CLAIMED` | Another request holds the finalization claim. | `true` |
| `ENROLLMENT_FINALIZATION_IN_PROGRESS` | Concurrent completion in progress. | `true` |
| `FACE_PROFILE_ALREADY_EXISTS` | Lineage conflict — durable profile already in place. | `false` |
| `FACE_SERVICE_TIMEOUT` | Face Service request timed out. | `true` |
| `FACE_SERVICE_UNAVAILABLE` | Face Service unreachable or returning errors. | `true` |
| `FACE_SERVICE_UNAUTHORIZED` | Face Service rejected the service token. | `false` |
| `FACE_SERVICE_INVALID_RESPONSE` | Face Service returned malformed JSON. | `false` |
| `BIOMETRIC_ENCRYPTION_UNAVAILABLE` | Encryption key missing / invalid. | `false` |
| `ENROLLMENT_COMPLETION_FAILED` | Generic / unmapped completion failure. | `false` |

#### Idempotency

The action preserves B2C's idempotency:

- First call → success result with `cleanupStatus: "consumed"` (or
  `"already_consumed"` if the temporary session was TTL-removed
  by MongoDB between B2B persistence and B2C consume).
- Second explicit call → success result with
  `cleanupStatus: "already_consumed"`. The action does NOT
  fabricate an error merely because completion already happened.
- `cleanupStatus: "cleanup_pending"` is treated as a successful
  completion — the durable `FaceProfile` is the commit point.

#### One invocation → one B2C invocation

The action invokes the B2C orchestrator EXACTLY ONCE per call.
There is NO automatic retry on Face Service timeout, claim
conflict, generation drift, or Mongo errors.

#### No revalidation / no navigation

The action does NOT call `router.refresh()`, `redirect()`, or
`revalidatePath()`. UI refresh and navigation behavior belong to
PHASE 4.6B3B. B3A is pure authenticated action plumbing.

#### Privacy guarantees

- Identity (`userId`) is derived from the Better Auth session;
  the browser never supplies it.
- The success result never exposes `userId`, `generationId`,
  `sourceEnrollmentGenerationId`, `claimToken`, `centroid`,
  embeddings, ciphertext, IV, authTag, `keyVersion`,
  `modelIdentity`, `modelName`, `embeddingDimension`, or
  `normalization`.
- The error result never exposes internal stack traces, raw HTTP
  bodies, service URLs, or `FACE_SERVICE_SECRET`.
- No browser storage (`localStorage` / `sessionStorage` /
  IndexedDB / Cache API) is touched.
- The action does not `console.log` or otherwise emit biometric
  data, claim tokens, or internal lineage.

#### What PHASE 4.6B3A does NOT do

- No Finish setup button — UI is B3B's responsibility.
- No `/face-id` or `/face-id/setup` page change.
- No `EnrollmentSamplePanel` change.
- No sidebar / navigation change.
- No public `/api/face-id/enrollment/finalize` HTTP route.
- No direct Face Service fetch — only B2C is invoked.
- No automatic retry.
- No `router.refresh` / `redirect` / `revalidatePath`.
- No re-enrollment flow.
- No `console.log` of biometric data.

## Finish setup UI (PHASE 4.6B3B)

PHASE 4.6B3B adds the user-visible trigger for the temporary
enrollment → durable `FaceProfile` transition. It does NOT add any
new HTTP surface; it consumes the PHASE 4.6B3A
`finishFaceEnrollment()` Server Action through the
`EnrollmentFinishButton` client component.

### Visibility contract

The "Finish setup" button is rendered inside the
`EnrollmentSamplePanelWrapper` (composed on `/face-id/setup`) ONLY
when:

1. `canFinish === true` — the server reports the temporary
   enrollment has reached `requiredSamples` (5/5 complete state).
2. `faceProfileConfigured === false` — no durable `FaceProfile`
   already exists. The setup page additionally redirects to
   `/face-id` when a profile is configured, so this branch is
   enforced at both the page and the component level.

At 0/5, 1/5, 2/5, 3/5, or 4/5 the button is hidden. The button is
also hidden after a successful enrollment.

### Action contract

The button is the ONLY browser-side trigger for the
`finishFaceEnrollment()` Server Action. The component does NOT call
the action from:

- `useEffect` (mount, props update, prop reconciliation)
- page load
- `router.refresh()`
- progress updates
- camera callbacks
- `getUserMedia` callbacks

The action is invoked with ZERO arguments. The browser does NOT
forward `userId`, `generationId`, `claimToken`, sample count, or
model metadata.

### Double-click protection

A synchronous `finishInFlightRef` guards the action invocation. Two
rapid clicks collapse into exactly ONE Server Action call. The ref
is released after a failed action so the user can explicitly retry
when the error is retryable. On success the user is navigated to
`/face-id` via `router.replace(...)`; a second invocation is not
needed.

### Pending state

While the action is in flight, the button is disabled and labelled
"Finishing setup…". No other controls are intercepted; the camera
sample panel retains its own state machine.

### Success navigation

`router.replace("/face-id")` is used so the Back button cannot
return the user to the completion screen. The URL never receives
biometric values.

### Error feedback

The button maps the safe B3A error codes to a small, restrained
heading / body pair rendered with `role="alert"`. The mapping
never references thresholds, model identifiers, service URLs, or
raw error strings. Retryable errors keep the user on the 5/5
setup state and allow another explicit click. Non-retryable
errors render the safe message without auto-restart; a later phase
may add a richer recovery affordance. Expired /
generation-changed / not-found / incomplete states trigger a
single, safe `router.refresh()` to reconcile the server-rendered
setup shell without re-invoking the action.

### No public finalize API

PHASE 4.6B3B deliberately does NOT add
`POST /api/face-id/enrollment/finalize` or any other HTTP route.
The PHASE 4.6B3A Server Action remains the only entry point.

### Browser persistence

The Finish setup flow does NOT write to `localStorage`,
`sessionStorage`, `IndexedDB`, or the `Cache` API. The durable
commit point is the `FaceProfile` document in MongoDB.

### What PHASE 4.6B3B does NOT add

- No `POST /api/face-id/enrollment/finalize` route.
- No automatic finalization — the button is the ONLY trigger.
- No automatic retry.
- No re-enrollment flow.
- No delete-Face-ID flow.
- No camera restart / new capture.
- No biometric fields in the URL.
- No biometric fields in the rendered DOM.
- No `localStorage` / `sessionStorage` / `IndexedDB` writes.
