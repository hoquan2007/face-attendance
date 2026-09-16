# API

> Status: **Phase 5.1D2B** — PHASE 5.1A shipped the persistence foundation for `classes` and `class_memberships`. PHASE 5.1A.1 hardened the class password primitive (PBKDF2-SHA256, async, constant-time verification, versioned encoded hash). PHASE 5.1B shipped the **authenticated Teacher create-class Server Action** (`createClassAction`) — the first browser-reachable entry point on top of the 5.1A service. Identity derives exclusively from the Better Auth server session; profile gating requires `onboardingCompleted === true` and `role === "teacher"`; the browser supplies only class `name` + class `password`; `classCode` is generated server-side; the exact `classCode` unique collision uses bounded retry; class password is stored only as PBKDF2 hash; safe result does not expose `passwordHash`. PHASE 5.1C ships the **authenticated Student join-class Server Action** (`createJoinClassAction`) — the student-side counterpart to 5.1B. Identity derives exclusively from the Better Auth server session; profile gating requires `onboardingCompleted === true` and `role === "student"`; the browser supplies only `classCode` + `password`; the canonical timing path runs ONE async PBKDF2 verification workload (real or dummy) on every short-circuit branch (missing class / archived class / malformed stored hash all run `await runDummyPasswordVerification(password)` against the fixed `DUMMY_CLASS_PASSWORD_HASH` constant before returning the same safe code `INVALID_CLASS_CREDENTIALS`); membership writes are classified via the precise server-only `isMembershipDuplicateKeyError` predicate that accepts ONLY compound `(classId, studentUserId)` collisions — unrelated 11000 errors map to `CLASS_JOIN_FAILED` and the insert is NEVER retried; the `getClassJoinCredentialByCode` primitive and `DUMMY_CLASS_PASSWORD_HASH` constant are server-only deep-path imports and are INTENTIONALLY NOT re-exported through the public `index.ts` barrel; `SafeClassDto` still omits `passwordHash`. PHASE 5.1D1 ships the **authenticated class-list read model foundation** as a server-only module (`getVisibleClassesForCurrentUser()` in `apps/web/src/lib/classes/class-read-service.ts`) — NOT a Server Action, NOT an HTTP route. The function accepts NO arguments; identity derives exclusively from `session.user.id`; role derives exclusively from `Profile.role`; teacher visibility = `Class.teacherUserId === session.user.id`; student visibility = `ClassMembership.studentUserId === session.user.id` AND `status === "active"`; the student path batch-fetches the referenced classes in a single `ClassModel.find({ _id: { $in: [...] } })` query (no application-memory scan, no obvious N+1); missing referenced class ids are skipped safely; safe summary contains ONLY `{ id, name, classCode, status, createdAt }` — NO `passwordHash`, NO `teacherUserId`, NO `studentUserId`, NO membership internal ids, NO biometric fields. NO public list API. NO class UI. NO class detail/roster. NO attendance. Better Auth collections remain untouched. PHASE 5.1D2A ships the **authenticated class-detail read model** as a server-only function (`getClassDetailForCurrentUser(classId)` in `apps/web/src/lib/classes/class-read-service.ts`) — NOT a Server Action, NOT an HTTP route. The function accepts ONLY `classId` (the resource identifier). Identity derives exclusively from `session.user.id`; role derives exclusively from `Profile.role`. Teacher access = `ClassModel.findOne({ _id: classId, teacherUserId: session.user.id })` (the authorization constraint is encoded directly in the filter — the database refuses to surface a class the teacher does not own). Student access = `ClassMembershipModel.findOne({ classId, studentUserId: session.user.id, status: "active" })` THEN `ClassModel.findById(classId)`. Malformed `classId` (not a canonical 24-hex string) collapses to the SAME `CLASS_NOT_ACCESSIBLE` boundary used for missing / unauthorized classes — there is intentionally NO separate outward-facing code for "malformed syntax" vs "not yours" vs "no membership". The safe detail DTO contains ONLY `{ id, name, classCode, status, createdAt, updatedAt, role }` — NO `passwordHash`, NO `teacherUserId`, NO `studentUserId`, NO membership internal ids, NO `identificationCode`, NO roster, NO biometric fields. NO public detail API. NO class detail UI. NO roster. NO attendance. NO biometric requirement. NO class password requirement. Better Auth collections remain untouched. PHASE 5.1D2B ships the **authenticated teacher-owner roster read model** as a server-only function (`getClassRosterForCurrentTeacher(classId)` in `apps/web/src/lib/classes/class-read-service.ts`) — NOT a Server Action, NOT an HTTP route, NOT a UI surface. The function accepts ONLY `classId`. Identity derives exclusively from `session.user.id`; role derives exclusively from `Profile.role === "teacher"`; the teacher-owner constraint is encoded directly in `ClassModel.findOne({ _id: classId, teacherUserId: session.user.id })`. The roster is teacher-only — a student (or any non-teacher role) returns `TEACHER_REQUIRED` BEFORE any class / membership / Profile query is performed; a student must NOT be able to probe the existence of a class through the roster boundary. Malformed `classId` collapses to the SAME `CLASS_NOT_ACCESSIBLE` boundary. Active memberships for the class are loaded in a single `ClassMembershipModel.find({ classId, status: "active" }).sort({ joinedAt: 1 })` query (oldest member first); student Profiles are batch-loaded in ONE call via the new server-only `getStudentProfilesByUserIds(userIds)` primitive on `@/lib/profile-service` (NO N+1, NO application-memory scan). Orphaned / incomplete / non-student Profile references are skipped silently — the roster is read-only and never mutates any document. The safe roster DTO contains ONLY `{ class: { id, name, classCode, status, createdAt, updatedAt }, students: [{ fullName, identificationCode, joinedAt }] }` — NO `passwordHash`, NO `teacherUserId`, NO `studentUserId`, NO membership internal ids, NO `emailSnapshot`, NO `phone`, NO email, NO `FaceProfile`, NO embedding / centroid, NO attendance, NO Better Auth user lookup. NO public roster API. NO roster UI. NO roster Server Action. Better Auth collections remain untouched.
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
  `ALREADY_MEMBER`, `TEACHER_REQUIRED`, `INVALID_CLASS_NAME`,
  `CLASS_CODE_GENERATION_FAILED`, `CLASS_CREATION_FAILED`,
  `FACE_NOT_FOUND`, `MULTIPLE_FACES`,
  `FACE_QUALITY_TOO_LOW`, `FACE_NOT_ENROLLED`, `SESSION_NOT_ACTIVE`,
  `UNKNOWN_FACE`, `FACE_SERVICE_UNAVAILABLE`.

  Phase 2 surface these via the Server Action `ActionResult.error.code`
  field; the stable codes used today are `UNAUTHENTICATED`,
  `INVALID_PROFILE_DATA`, `IDENTIFICATION_CODE_TAKEN`, `PROFILE_NOT_FOUND`,
  `UNKNOWN_ERROR`.

  Phase 5.1B adds the authenticated create-class Server Action error
  codes: `UNAUTHENTICATED`, `PROFILE_INCOMPLETE`, `TEACHER_REQUIRED`,
  `INVALID_CLASS_NAME`, `INVALID_CLASS_PASSWORD`,
  `CLASS_CODE_GENERATION_FAILED`, `CLASS_CREATION_FAILED`. These
  codes are returned by the `createClassAction(input)` discriminated
  union and never carry `password`, `passwordHash`, `teacherUserId`,
  raw stack traces, or Mongo internals.

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
| `createClassAction()` *(Server Action)* | Authenticated Teacher create-class Server Action. Identity derives EXCLUSIVELY from the Better Auth session (`session.user.id`). The action gates on a completed Profile with `role === "teacher"` and accepts ONLY browser input `{ name, password }` (validated server-side via Zod `.strict()`; the browser cannot supply `teacherUserId` / `userId` / `role` / `classCode` / `passwordHash`). `classCode` is generated server-side via the canonical 7-char crypto-random generator. The class password is hashed via the PHASE 5.1A.1 `hashClassPassword` PBKDF2 primitive and stored only as `passwordHash`. Bounded internal retry (`MAX_CLASS_CODE_ATTEMPTS`) handles the exact `classCode` unique collision ONLY — unrelated 11000 errors and other failures stop the loop immediately. Discriminated-union safe result `{ ok, class: { id, name, classCode, status: "active", createdAt } }`; safe error union `UNAUTHENTICATED`, `PROFILE_INCOMPLETE`, `TEACHER_REQUIRED`, `INVALID_CLASS_NAME`, `INVALID_CLASS_PASSWORD`, `CLASS_CODE_GENERATION_FAILED`, `CLASS_CREATION_FAILED`. No `password`, `passwordHash`, `teacherUserId`, raw stack, or Mongo internals are ever serialized. NO public create-class API route exists — the Server Action is the only entry point. NO create-class UI is added in PHASE 5.1B — UI consumption belongs to a later phase. | **5.1B** |

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

## Authenticated Teacher create-class Server Action (PHASE 5.1B)

PHASE 5.1B ships the first browser-reachable entry point on top of
the PHASE 5.1A class persistence foundation:
`createClassAction(input)` in
`apps/web/src/lib/classes/create-class-action.ts`. The action is
opened with `"use server"` and is the ONLY create-class entry
point — no `/api/classes` route is added.

### `createClassAction(input)` *(Server Action)*

#### Input

The browser supplies exactly:

```json
{ "name": "<string>", "password": "<string>" }
```

The action's Zod input schema is `.strict()`; any extra key
(`teacherUserId`, `userId`, `role`, `classCode`, `passwordHash`,
`status`, `createdAt`, `_id`, …) is rejected before the service
layer is reached.

- `name`     — string, trimmed, 1..200 characters (mirrors the
               class model constraint).
- `password` — string, 4..128 characters. The action never
               trims, lowercases, or otherwise transforms the
               password bytes — they are preserved exactly.

#### Authentication

The action derives `teacherUserId` exclusively from
`session.user.id` via the Better Auth `getSession()` helper. No
request body field, query parameter, or cookie is consulted for
identity.

#### Profile gating

The application `Profile` is loaded via the existing
`getProfileByUserId(userId)` profile service. The action requires:

- profile exists,
- `profile.onboardingCompleted === true`,
- `profile.role === "teacher"`.

Missing or incomplete profile → `PROFILE_INCOMPLETE`. Authenticated
student → `TEACHER_REQUIRED`. The Profile is read for gating only
— it is NEVER mutated by the action.

#### Server-side class code

`classCode` is generated inside the action via the existing
`generateClassCode()` primitive (canonical 7-char uppercase,
unambiguous alphabet, `node:crypto.randomBytes()` — no
`Math.random`). The browser never supplies `classCode`. Each insert
attempt produces a fresh code.

#### Bounded retry on `classCode` collision

The MongoDB unique index on `classCode` is the authoritative
uniqueness guard. The action performs a BOUNDED internal retry
loop with at most `MAX_CLASS_CODE_ATTEMPTS` insert attempts. The
loop retries ONLY when the service throws
`ClassServiceError(CLASS_CODE_ALREADY_EXISTS)`, which the service
produces ONLY when the precise `isClassCodeDuplicateKeyError(err)`
predicate confirms the MongoDB `code === 11000` collided key is
`classCode` (via `keyValue.classCode`). Unrelated 11000 errors and
any other service error stop the loop immediately. Exhausting the
retry budget surfaces `CLASS_CODE_GENERATION_FAILED` with
`retryable: true`.

#### Password hashing

The action reuses the PHASE 5.1A.1 `hashClassPassword(...)` PBKDF2
primitive (`pbkdf2` via `util.promisify`, no `pbkdf2Sync`, no
SHA-256, no reversible encryption). The plaintext password:

- enters the action exactly once (because the teacher chose it),
- is never trimmed or transformed (the teacher's exact bytes are
  hashed),
- is never logged, returned, persisted, or serialized,
- is discarded immediately after `await hashClassPassword(...)`
  returns. Only `passwordHash` is persisted.

#### Success response

```json
{
  "ok": true,
  "class": {
    "id": "<mongo _id.toString()>",
    "name": "<canonical trimmed name>",
    "classCode": "<canonical 7-char uppercase>",
    "status": "active",
    "createdAt": "<ISO 8601>"
  }
}
```

`password`, `passwordHash`, `teacherUserId`, Mongoose internals,
and stack traces are NEVER serialized.

#### Error response

```json
{
  "ok": false,
  "code": "<safe enum>",
  "message": "<restrained human-readable>",
  "retryable": true | false
}
```

Stable codes:

| Code                            | Meaning                                                   | Retryable |
| ------------------------------- | --------------------------------------------------------- | --------- |
| `UNAUTHENTICATED`               | No Better Auth session.                                   | false     |
| `PROFILE_INCOMPLETE`            | Profile missing or `onboardingCompleted === false`.       | false     |
| `TEACHER_REQUIRED`              | Profile exists but `role !== "teacher"`.                  | false     |
| `INVALID_CLASS_NAME`            | Server-side name validation failed.                       | false     |
| `INVALID_CLASS_PASSWORD`        | Server-side password validation failed.                   | false     |
| `CLASS_CODE_GENERATION_FAILED`  | `MAX_CLASS_CODE_ATTEMPTS` exact `classCode` collisions.   | true      |
| `CLASS_CREATION_FAILED`         | Generic / unmapped persistence failure (no internals).    | true      |

#### One invocation → one Class

A successful invocation persists exactly one `Class` document
with `teacherUserId === session.user.id`. The action does NOT
create `ClassMembership`, attendance sessions, `FaceProfile`, or
any other domain record.

#### No automatic browser-side retry

The bounded retry above is INTERNAL to the action and is triggered
ONLY by an exact `classCode` unique-index collision. All other
failure modes return a single, safe error result so the future UI
can decide whether to re-invoke the action. The action does NOT
internally retry on auth failure, validation failure, generic DB
error, or password hashing error.

#### What PHASE 5.1B does NOT add

- No create-class UI (`/classes`, `/classes/new`, form
  components, buttons, navigation entries).
- No public `/api/classes` route.
- No `ClassMembership` write.
- No attendance session / record.
- No Face Service call.
- No `FaceProfile` touch.

#### UI-to-Server-Action usage inventory

The `createClassAction(input)` Server Action is consumed
EXCLUSIVELY by the PHASE 5.1E2 client form
`apps/web/src/components/classes/create-class-form.tsx`,
rendered from the server-gated page
`apps/web/src/app/classes/new/page.tsx`. The form passes
exactly `{ name, password }` and reads the discriminated
result. No REST/HTTP route, no other server action, and no
third-party caller invokes `createClassAction`.

The `createJoinClassAction(input)` Server Action is consumed
EXCLUSIVELY by the PHASE 5.1E3 client form
`apps/web/src/components/classes/join-class-form.tsx`,
rendered from the server-gated page
`apps/web/src/app/classes/join/page.tsx`. The form passes
exactly `{ classCode, password }` and reads the discriminated
result. No REST/HTTP route, no other server action, and no
third-party caller invokes `createJoinClassAction`. E3 does
NOT modify the action's semantics; the action remains the
canonical PHASE 5.1C entry point.
- No Profile mutation.
- No Better Auth configuration change.
- No student join (`/api/classes/join`).
- No membership / join semantics (PHASE 5.1C).
- No new rate-limit primitive.
- No re-enrollment, delete-Face-ID, or attendance flow.

## Phase 5.1C — Authenticated Student join class Server Action

PHASE 5.1C adds the student-side counterpart to PHASE 5.1B: a
`"use server"` Server Action that lets an authenticated, fully-
onboarded Student join a Class by code + password. The action
runs on top of the existing 5.1A service primitives and
introduces four new server-only primitives that are the heart
of this phase's architectural lockdown.

### Architectural lockdown invariants

1. **Fixed `DUMMY_CLASS_PASSWORD_HASH` constant.** A single,
   syntactically-valid encoded PBKDF2 hash (`pbkdf2-sha256$
   100000$<32-byte salt hex>$<32-byte derived key hex>`) lives
   in `apps/web/src/lib/classes/class-service.ts` as a single
   string literal. It is NEVER generated at module load via
   `hashClassPassword()`, `pbkdf2`, `randomBytes`, top-level
   `await`, or any other runtime primitive. The salt and
   derived-key bytes are random-looking placeholders — verifying
   any real password against this hash returns `false`.

2. **Internal `getClassJoinCredentialByCode(code)` primitive.**
   The server-only credential lookup primitive is the ONLY
   sanctioned entry point for join orchestration to access
   `passwordHash`. Its return type `ClassJoinCredential`
   deliberately exposes `passwordHash` for the join Server
   Action's use, but it is INTENTIONALLY NOT re-exported
   through the public barrel so a hand-crafted client cannot
   smuggle `passwordHash` into a browser-facing payload.
   `SafeClassDto` continues to omit `passwordHash`.

3. **Canonical timing path.** Missing class / archived class /
   malformed stored hash all execute ONE async PBKDF2
   verification workload (against the dummy hash) before
   returning `INVALID_CLASS_CREDENTIALS`. Wrong password
   executes the real verification workload and also returns
   `INVALID_CLASS_CREDENTIALS`. An attacker observing latency
   cannot differentiate the four branches by less than the
   cost of one async PBKDF2 workload.

4. **Precise `isMembershipDuplicateKeyError` classifier.** The
   classifier accepts a Mongo `code === 11000` collision ONLY
   when `keyValue` (or `keyPattern`) identifies the compound
   `(classId, studentUserId)` uniqueness. Unrelated 11000
   collisions map to `CLASS_JOIN_FAILED` and the insert is
   NEVER retried.

### Action

| Field        | Value                                              |
| ------------ | -------------------------------------------------- |
| File         | `apps/web/src/lib/classes/join-class-action.ts`    |
| Test file    | `apps/web/src/lib/classes/join-class-action.test.ts` |
| Directive    | `"use server"` — Next.js refuses to bundle the body into the client build. |
| Browser input | `{ classCode: string, password: string }` only.   |
| Identity     | `studentUserId ← session.user.id` (Better Auth).    |
| Role         | `student` (Profile gating via `getProfileByUserId`). |

### Browser input

```jsonc
{
  "classCode": "ABCDEFG",         // 7-char canonical code, canonicalized via z.preprocess
  "password":  "ClassP@ssw0rd-2026" // 4..128 chars, NOT trimmed
}
```

The Zod input schema is `.strict()` — the browser cannot smuggle
`studentUserId`, `userId`, `classId`, `role`, `passwordHash`,
`status`, `joinedAt`, or any other field through the action
signature. The schema canonicalizes the classCode to uppercase
and enforces the canonical alphabet `[A-HJ-NP-Z2-9]`.

### Success response

```json
{
  "ok": true,
  "membership": {
    "id":        "<mongo _id.toString()>",
    "classId":   "<canonical ObjectId string>",
    "classCode": "ABCDEFG",
    "joinedAt":  "<ISO 8601>",
    "status":    "active"
  },
  "alreadyJoined": false  // false on fresh insert; true on idempotent re-join
}
```

PHASE 5.1C.1 — duplicate membership is an **idempotent success**,
not an error. A second valid join (compound unique collision on
`(classId, studentUserId)`) returns the same `ok: true` shape with
`alreadyJoined: true` and the ALREADY-PERSISTED membership projected
into the result. The password is still verified, no second membership
document is written, and no `ALREADY_JOINED` error code is surfaced.

`password`, `passwordHash`, `studentUserId`, `teacherUserId`,
Mongoose internals, and stack traces are NEVER serialized.

### Error response

```json
{
  "ok": false,
  "code": "<safe enum>",
  "message": "<restrained human-readable>",
  "retryable": true | false
}
```

Stable codes:

| Code                          | Meaning                                                | Retryable |
| ----------------------------- | ------------------------------------------------------ | --------- |
| `UNAUTHENTICATED`             | No Better Auth session.                                | false     |
| `PROFILE_INCOMPLETE`          | Profile missing or `onboardingCompleted === false`.    | false     |
| `STUDENT_REQUIRED`            | Profile exists but `role !== "student"`.               | false     |
| `INVALID_CLASS_CODE`          | Server-side class-code validation failed.              | false     |
| `INVALID_CLASS_PASSWORD`      | Server-side password validation failed.                | false     |
| `INVALID_CLASS_CREDENTIALS`   | Wrong password / missing class / archived class /      | false     |
|                               | malformed stored hash — collapsed to one code so the   |           |
|                               | browser cannot enumerate live classes by error code.   |           |
| `CLASS_JOIN_FAILED`           | Generic / unmapped persistence failure (no internals). | true      |

Note: duplicate membership (compound `(classId, studentUserId)`
uniqueness hit) is **NOT** represented as an error code. It is an
**idempotent success** with `alreadyJoined: true` (PHASE 5.1C.1).

### One invocation → at most one `ClassMembership`

A successful invocation persists exactly one `ClassMembership`
document with `studentUserId === session.user.id` and
`classId === <lookup result of classCode>`. The action does
NOT create / mutate `Class`, `Profile`, `FaceProfile`,
attendance sessions, or any other domain record.

### No automatic browser-side retry

The action does NOT internally retry on any failure. All
failure modes return a single, safe error result so the future
UI can decide whether to re-invoke the action. The action does
NOT internally retry on auth failure, validation failure,
wrong password, archived class, missing class, malformed hash,
duplicate membership, or generic DB error.

### What PHASE 5.1C explicitly does NOT change

- `SafeClassDto` still omits `passwordHash`.
- The public barrel still exposes the safe DTOs only.
- The 5.1A.1 `hashClassPassword(...)` primitive is unchanged.
- The 5.1B `createClassAction` Server Action is unchanged.
- The `Class.codeAlreadyExists` retry model is unchanged.

## Server-only class-detail read boundary (PHASE 5.1D2A)

PHASE 5.1D2A ships the first server-only class-detail read
boundary as a plain `async` function —
`getClassDetailForCurrentUser(classId)` in
`apps/web/src/lib/classes/class-read-service.ts`. It is NOT a
Server Action, NOT an HTTP route, NOT a UI surface, and NOT a
roster. It is the canonical, READ-ONLY entry point for future
Server Components and other server-rendered surfaces that need
to read a single Class identified by `classId`.

### `getClassDetailForCurrentUser(classId)`

#### Input

The function accepts a single argument:

```ts
getClassDetailForCurrentUser(classId: string)
```

The function does NOT accept `userId`, `teacherUserId`,
`studentUserId`, `role`, or `membershipId` — those are derived
exclusively from the Better Auth server session and the
persisted Profile. A future `/classes/[classId]` route will
supply the resource identifier; no other caller-supplied
identity is required or accepted.

#### Authentication

The function uses the existing `getSession()` helper from
`@/lib/session`, which calls `auth.api.getSession({ headers })`.
A missing session returns a safe `UNAUTHENTICATED` error result.
Raw Better Auth errors are NEVER serialized into the response.

#### Profile gating

The function calls `getProfileByUserId(session.user.id)`. A
profile that does not exist or has
`onboardingCompleted === false` returns `PROFILE_INCOMPLETE`.
The function does NOT auto-create a profile.

#### `classId` syntax validation

`classId` is validated to be a canonical 24-hex string BEFORE
any database call. A malformed id (empty, wrong length,
non-hex characters) collapses to the same safe
`CLASS_NOT_ACCESSIBLE` boundary used for missing / unauthorized
classes. Malformed ids NEVER reach the database — no
`CastError`, no raw Mongoose exception, no stack trace leak.

#### Teacher authorization

The teacher path encodes the authorization constraint DIRECTLY
in the database filter:

```
ClassModel.findOne({ _id: classId, teacherUserId: session.user.id })
```

The database itself refuses to surface a class the teacher
does not own. A `null` result collapses to `CLASS_NOT_ACCESSIBLE`
— there is intentionally NO separate `NOT_CLASS_OWNER`
outward-facing code.

#### Student authorization

The student path proves an ACTIVE membership FIRST, THEN loads
the class:

```
ClassMembershipModel.findOne({
  classId,
  studentUserId: session.user.id,
  status: "active",
})
// only if the membership exists:
ClassModel.findById(classId)
```

No application-memory filter is performed. The membership is
loaded ONLY as authorization proof — it is NEVER projected into
the safe detail result.

#### Archived class behavior

Archived does NOT automatically mean inaccessible. The owner
teacher and the active-member student may still read archived
class detail; the result exposes `status: "archived"` safely.
A non-member cannot infer archived-class existence — the
failure collapses to `CLASS_NOT_ACCESSIBLE`.

#### Success response

```json
{
  "ok": true,
  "result": {
    "role": "teacher" | "student",
    "class": {
      "id":         "<canonical ObjectId string>",
      "name":       "<canonical class name>",
      "classCode":  "<canonical 7-char uppercase code>",
      "status":     "active" | "archived",
      "createdAt":  "<ISO 8601>",
      "updatedAt":  "<ISO 8601>"
    }
  }
}
```

`password`, `passwordHash`, `teacherUserId`, `studentUserId`,
`membershipId`, `identificationCode`, Mongoose internals (`__v`),
biometric fields, raw timestamps, student profiles, member
rosters, student counts, and credential helpers are NEVER
serialized.

#### Error response

```json
{
  "ok": false,
  "code": "<safe enum>",
  "message": "<restrained human-readable>"
}
```

Stable codes:

| Code | Meaning | When |
| --- | --- | --- |
| `UNAUTHENTICATED` | No Better Auth session. | Missing session. |
| `PROFILE_INCOMPLETE` | Profile missing or `onboardingCompleted === false`. | Gating failure. |
| `CLASS_NOT_ACCESSIBLE` | Malformed id / missing class / wrong teacher / no membership / inactive membership — collapsed to one code so the browser cannot enumerate live classes by error code. | Inaccessible boundary. |
| `CLASS_READ_FAILED` | Unexpected DB / read failure (no internals leaked). | Generic DB failure. |

There is intentionally NO `CLASS_NOT_FOUND`, NO
`NOT_CLASS_OWNER`, NO `NOT_CLASS_MEMBER`, NO
`INVALID_CLASS_ID` outward-facing code. Future UI may map
every one of these branches to a generic 404 / not-accessible
affordance.

#### Idempotency

The function is read-only and side-effect-free. Repeated calls
return the same projection for the same `(session, classId)`
pair. The function does NOT cache, does NOT debounce, does NOT
queue, and does NOT mutate any persisted document.

#### Privacy guarantees

- Identity (`userId`) is derived from the Better Auth session;
  the caller never supplies it.
- The success result never exposes `password`, `passwordHash`,
  `teacherUserId`, `studentUserId`, `membershipId`,
  `identificationCode`, `__v`, biometric fields, raw
  timestamps, student profiles, member rosters, student
  counts, or credential helpers.
- The error result never exposes internal stack traces, raw
  HTTP bodies, service URLs, `CastError`, or `FACE_SERVICE_SECRET`.
- No browser storage (`localStorage` / `sessionStorage` /
  IndexedDB / Cache API) is touched.
- The function does not `console.log` or otherwise emit
  biometric data, `passwordHash`, or internal lineage.

#### What PHASE 5.1D2A does NOT do

- No class detail page / UI.
- No `POST /api/classes/[id]` or any other HTTP route.
- No Server Action.
- No roster query (`listMembershipsByClassId`).
- No class write / mutation.
- No membership write / mutation.
- No profile mutation.
- No Face Service call.
- No `FaceProfile` read or write.
- No biometric requirement.
- No class password requirement.
- No attendance data.
- No `console.log` of biometric data.
- No automatic retry.

### Internal query primitives (PHASE 5.1D2A)

The read service internally uses three focused server-only
primitives. They are NOT exported from the public
`apps/web/src/lib/classes/index.ts` barrel and MUST NOT be
re-exported by a future phase without an explicit
architectural decision:

- `findOwnedClassForTeacher(classId, teacherUserId)` —
  teacher ownership-encoded `ClassModel.findOne({ _id,
  teacherUserId })`. Returns the safe-class projection or
  `null`. Never throws on a missing class.
- `findActiveMembershipForStudent(classId, studentUserId)` —
  `ClassMembershipModel.findOne({ classId, studentUserId,
  status: "active" })`. Returns the membership or `null`. The
  membership is loaded ONLY as authorization proof and is
  NEVER projected into the safe detail result.
- `findClassById(classId)` — `ClassModel.findById(classId)`
  used by the student path AFTER the active membership has
  been verified. Returns the safe-class projection or `null`.

The password-bearing join primitive
(`getClassJoinCredentialByCode`) and the fixed
`DUMMY_CLASS_PASSWORD_HASH` constant are NOT touched by
PHASE 5.1D2A. The D2A read service has no business knowing
the class password — existing membership / ownership grants
read authorization.

## Teacher-owner roster read boundary (PHASE 5.1D2B)

PHASE 5.1D2B ships the **teacher-owner roster read model** as
a plain `async` function —
`getClassRosterForCurrentTeacher(classId)` in
`apps/web/src/lib/classes/class-read-service.ts`. It is NOT a
Server Action, NOT an HTTP route, NOT a UI surface. It is the
canonical, READ-ONLY entry point for future Server Components
that need to render the active student roster of a class the
authenticated Teacher owns.

### `getClassRosterForCurrentTeacher(classId)`

#### Input

The function accepts a single argument:

```ts
getClassRosterForCurrentTeacher(classId: string)
```

The function does NOT accept `userId`, `teacherUserId`,
`studentUserId`, `role`, or `membershipId` — those are all
derived exclusively from the Better Auth server session and
the persisted Profile.

#### Authentication

The function uses the established `getSession()` helper from
`@/lib/session`, which calls `auth.api.getSession({ headers })`.
A missing session returns a safe `UNAUTHENTICATED` error
result. Raw Better Auth errors are NEVER serialized into the
response.

#### Profile gating

The function calls `getProfileByUserId(session.user.id)`. A
profile that does not exist or has
`onboardingCompleted === false` returns `PROFILE_INCOMPLETE`.
The function does NOT auto-create a profile.

#### Role gating

The function requires `profile.role === "teacher"`. A
student (or any non-teacher role) returns `TEACHER_REQUIRED`
BEFORE any class / membership / roster query is performed. A
truly unknown role value collapses to `CLASS_READ_FAILED` so
a legacy Profile cannot leak the unknown value through the
failure path. The role check is the "no student access"
invariant — a student must NOT be able to probe whether a
class exists through the roster boundary.

#### `classId` syntax validation

`classId` is validated to be a canonical 24-hex string BEFORE
any database call. A malformed id (empty, wrong length,
non-hex characters) collapses to the same safe
`CLASS_NOT_ACCESSIBLE` boundary used for missing / unauthorized
classes. Malformed ids NEVER reach the database — no
`CastError`, no raw Mongoose exception, no stack trace leak.

#### Teacher-owner authorization

The teacher path encodes the authorization constraint
DIRECTLY in the database filter:

```
ClassModel.findOne({ _id: classId, teacherUserId: session.user.id })
```

The database itself refuses to surface a class the teacher
does not own. A `null` result collapses to
`CLASS_NOT_ACCESSIBLE` — there is intentionally NO separate
`NOT_CLASS_OWNER` outward-facing code.

#### Active-membership filter

After the teacher-owned class is loaded, the function lists
its ACTIVE memberships in a single batched query:

```
ClassMembershipModel.find({ classId: <ObjectId>, status: "active" })
  .select({ studentUserId: 1, joinedAt: 1 })
  .sort({ joinedAt: 1 })   // oldest member first
```

Only `status === "active"` memberships are surfaced. Future
statuses (`removed`, etc.) cannot leak into the roster.
Memberships for any other class are excluded by the
`classId` filter.

#### Batched Profile lookup

The student `userId` values are deduplicated and fetched in
ONE batched query via the new server-only
`getStudentProfilesByUserIds(userIds)` primitive on
`@/lib/profile-service`. The batch primitive projects ONLY
`userId`, `fullName`, `identificationCode`, `role`, and
`onboardingCompleted` — `emailSnapshot`, `phone`, `createdAt`,
`updatedAt`, and the Mongo `_id` are NEVER read from the
database driver buffer. Profiles that are absent, incomplete,
or carry a non-student `role` are OMITTED from the map so the
roster can skip those memberships safely.

The roster function NEVER iterates memberships and calls
`getProfileByUserId(...)` per row — that would be an N+1
lookup. The batched primitive is the ONLY sanctioned Profile
source for roster composition.

#### Roster composition

The function iterates the already-sorted, deduplicated
membership list (not the Profile-query result) and joins each
membership `joinedAt` to the matched Profile's
`fullName` + `identificationCode`. Membership internal ids,
`classId`, `studentUserId`, and `status` are NEVER projected.
The final ordering is `joinedAt` ASC (oldest member first)
with a stable order from the underlying membership list;
Profile query result order cannot reorder the roster.

#### Archived class behavior

Archived does NOT automatically mean inaccessible. The owner
teacher may still read the roster of an archived class —
the safe class DTO exposes `status: "archived"`. No archive
controls are implemented in this phase.

#### Success response

```json
{
  "ok": true,
  "result": {
    "class": {
      "id":         "<canonical ObjectId string>",
      "name":       "<canonical class name>",
      "classCode":  "<canonical 7-char uppercase code>",
      "status":     "active" | "archived",
      "createdAt":  "<ISO 8601>",
      "updatedAt":  "<ISO 8601>"
    },
    "students": [
      {
        "fullName":          "<student full name from Profile>",
        "identificationCode": "<student identificationCode from Profile>",
        "joinedAt":          "<ISO 8601>"
      }
    ]
  }
}
```

`password`, `passwordHash`, `teacherUserId`, `studentUserId`,
`membershipId`, `emailSnapshot`, `phone`, `email`, Mongoose
internals (`__v`), biometric fields, raw timestamps, member
counts, credential helpers, and attendance data are NEVER
serialized.

#### Error response

```json
{ "ok": false, "code": "<safe enum>", "message": "<restrained human-readable>" }
```

Stable codes:

| Code | Meaning | When |
| --- | --- | --- |
| `UNAUTHENTICATED` | No Better Auth session. | Missing session. |
| `PROFILE_INCOMPLETE` | Profile missing or `onboardingCompleted === false`. | Gating failure. |
| `TEACHER_REQUIRED` | Authenticated user has a non-teacher role (typically `student`). | Role gate (BEFORE class lookup). |
| `CLASS_NOT_ACCESSIBLE` | Malformed id / missing class / wrong teacher — collapsed to one code so the browser cannot enumerate live classes by error code. | Inaccessible boundary. |
| `CLASS_READ_FAILED` | Unexpected DB / read failure (no internals leaked). | Generic DB failure. |

There is intentionally NO `CLASS_NOT_FOUND`, NO
`NOT_CLASS_OWNER`, NO `STUDENT_NOT_IN_ROSTER`, NO
`INVALID_CLASS_ID` outward-facing code. Future UI may map
every one of these branches to a generic 404 / not-accessible
affordance.

#### Idempotency

The function is read-only and side-effect-free. Repeated calls
return the same projection for the same `(session, classId)`
pair. The function does NOT cache, does NOT debounce, does NOT
queue, and does NOT mutate any persisted document.

#### Privacy guarantees

- Identity (`userId`) is derived from the Better Auth session;
  the caller never supplies it.
- The success result never exposes `password`, `passwordHash`,
  `teacherUserId`, `studentUserId`, `membershipId`,
  `emailSnapshot`, `phone`, `email`, `__v`, biometric
  fields, raw timestamps, member counts, credential helpers,
  Better Auth user data, or attendance data.
- The error result never exposes internal stack traces, raw
  HTTP bodies, service URLs, `CastError`, or `FACE_SERVICE_SECRET`.
- No browser storage (`localStorage` / `sessionStorage` /
  IndexedDB / Cache API) is touched.
- The function does not `console.log` or otherwise emit
  biometric data, `passwordHash`, or internal lineage.
- Better Auth user collection is NOT queried for roster
  composition — Profile is the application identity source.
- Corrupt / orphaned memberships (membership exists but Profile
  is missing / incomplete / non-student) are skipped silently.
  The orphaned `studentUserId` is NEVER surfaced.
- The read path NEVER mutates or deletes the membership.

#### Internal query primitives (PHASE 5.1D2B)

The read service internally uses two focused server-only
primitives plus the new server-only Profile batch primitive.
They are NOT exported from the public
`apps/web/src/lib/classes/index.ts` barrel and MUST NOT be
re-exported by a future phase without an explicit
architectural decision:

- `findOwnedClassForTeacher(classId, teacherUserId)` —
  teacher ownership-encoded `ClassModel.findOne({ _id,
  teacherUserId })`. Reused from PHASE 5.1D2A. Returns the
  safe-class projection or `null`. Never throws on a missing
  class.
- `listActiveMembershipsByClassId(classId)` —
  `ClassMembershipModel.find({ classId: new Types.ObjectId(classId), status: "active" }).select({ studentUserId: 1, joinedAt: 1 }).sort({ joinedAt: 1 }).lean().exec()`.
  Returns the deduplicated, sorted active membership rows for
  the requested class. Membership internal ids, `classId`,
  and `status` are NEVER projected out of the driver buffer.
- `getStudentProfilesByUserIds(userIds)` (on
  `@/lib/profile-service`) — server-only batched
  `ProfileModel.find({ userId: { $in: [...] } })`. Projects
  ONLY `userId`, `fullName`, `identificationCode`, `role`,
  `onboardingCompleted`. `emailSnapshot`, `phone`, Mongo
  `_id`, and timestamps are NEVER read. Profiles that are
  absent, incomplete, or non-student are OMITTED from the
  returned Map.

The password-bearing join primitive
(`getClassJoinCredentialByCode`), the fixed
`DUMMY_CLASS_PASSWORD_HASH` constant, and the
`runDummyPasswordVerification` helper are NOT touched by
PHASE 5.1D2B. The D2B read service has no business knowing
the class password — existing class ownership grants roster
access.

#### What PHASE 5.1D2B does NOT do

- No roster UI (`/classes/[id]`, roster page, student rows,
  buttons, navigation entries).
- No `POST /api/classes/[id]/roster` or any other HTTP route.
- No Server Action.
- No class / membership write / mutation.
- No profile write / mutation.
- No Face Service call.
- No `FaceProfile` read or write.
- No biometric requirement.
- No class password verification (teacher ownership alone
  authorizes the roster).
- No attendance data.
- No `console.log` of biometric data.
- No Better Auth user lookup (Profile is the application
  identity source).
- No automatic retry.
