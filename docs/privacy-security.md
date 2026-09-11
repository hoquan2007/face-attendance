# Privacy & Security

> Status: **Phase 4.6B1B** — PHASE 4.6A1 shipped the pure enrollment finalization
> math foundation. PHASE 4.6A2 adds the protected internal finalization
> endpoint (`POST /v1/faces/enrollment/finalize`) that receives
> already-decrypted, already-L2-normalized embeddings from the trusted
> Next.js server and returns a consistency result plus a normalized
> centroid. PHASE 4.6B1A extends the existing server-only Next.js
> `FaceServiceClient` with a `finalizeFaceEnrollment(...)` function that
> calls the protected finalization endpoint. PHASE 4.6B1B adds the
> server-only Next.js orchestration service
> (`finalizeEnrollmentSessionForUser`) that loads the temporary
> `FaceEnrollmentSession`, decrypts its accepted samples server-side
> using the existing PHASE 4.1 AES-256-GCM utility, reconstructs the
> exact AAD from authoritative persisted metadata, validates plaintext
> vectors, calls the B1A client exactly once, and re-checks the
> enrollment generation after the Face Service response. PHASE 4.6B1B
> does NOT persist a `FaceProfile`, does NOT delete the temporary
> session, and does NOT expose a Next.js route. Plaintext sample
> embeddings exist only transiently in server memory. The post-finalize
> generation re-check reduces stale-result risk but PHASE 4.6B2 must
> still atomically verify `generationId` when persisting/replacing
> `FaceProfile` and consuming the temporary session.

## Biometric handling principles

1. **Store embeddings, not images.** The web database stores normalized
   numeric vectors returned by the Face Service. Raw camera frames are
   decoded, processed, and discarded in the same request lifecycle.
2. **No permanent image retention.** The Face Service decodes uploads
   in memory and never writes them to disk. Benchmark tools print
   metrics only; they do not save annotated images.
3. **No logging of biometric data.** Server logs must never include
   embeddings, raw image bytes, or base64 image data. Safe log fields:
   `route`, `method`, `status`, `duration_ms`, `face_count`, `engine`,
   `provider`.
4. **No embedding exposure to the browser.** `POST /v1/faces/analyze`
   never returns embeddings. `POST /v1/faces/compare` returns similarity
   + threshold + match flag only — never embeddings.
5. **Owner-only modification.** A user may only modify their own
   `faceProfile`. Teacher endpoints cannot write student embeddings.
6. **Face recognition ≠ liveness detection.** PHASE 3 explicitly does not
   protect against photo spoof, screen replay, or printed face attacks.
   Anti-spoof / liveness detection will arrive in a dedicated later phase
   (Phase 9).
7. **Biometric encryption.** From PHASE 4.1, face embeddings are
   encrypted with AES-256-GCM before storage. The encryption key is
   independent from authentication secrets.

## Phase 2 identity vs business data

Better Auth owns the `user`, `session`, `account`, `verification`
collections. The application owns the `profiles` collection. The
application **must not** write to Better Auth's collections directly.
Better Auth continues to use its official MongoDB adapter; the
application uses Mongoose via a separate cached `mongoose.connect()`
connection against the same `face_attendance` database.

The `Profile.userId` field references the Better Auth `user._id`
conceptually (as a string). The application does not enforce a
cross-collection foreign key at the database level because Better Auth
owns its own user collection.

## Phase 2 profile authorization rules

| Action | Required |
| --- | --- |
| View another user's profile by id | **Not allowed.** No public profile lookup endpoint exists. |
| Update `profile.fullName`, `profile.identificationCode`, `profile.phone` | Authenticated AND `profile.userId = session.user.id` |
| Change `profile.role` via profile-edit | **Not allowed.** Role mutation must go through a dedicated controlled flow that does not exist yet. |
| Submit onboarding | Authenticated. Idempotent — repeated submissions do not create duplicate documents. |
| Update `profile.userId` / `profile.emailSnapshot` from a client | **Not allowed.** These fields are derived from the Better Auth session server-side. |

## Phase 2 role model limitations

- `student` self-selection is allowed.
- `teacher` self-selection is allowed for the MVP. **This is a known
  security limitation.** A future production deployment must add a
  teacher-invite flow, an administrator approval flow, or a verification
  step. Phase 2 documents this gap but does not implement the
  verification flow.

## Phase 2 stored profile fields (privacy posture)

The application stores only what Phase 2 actually needs:

- `fullName`
- `identificationCode` (treated as a generic business identifier)
- `phone` (optional)
- `role`
- `emailSnapshot` (captured from Better Auth session, never from request
  body)
- `onboardingCompleted` (boolean flag)
- `userId` (Better Auth user ID — not user-modifiable)
- `createdAt` / `updatedAt` (Mongoose timestamps)

The application does **not** store:

- home address
- date of birth
- government ID
- gender
- sensitive demographic information
- raw face photos, embeddings, or any biometric data

## Phase 4+ biometric encryption

**Face embeddings will use application-level AES-256-GCM encryption before
persistent storage.** This is implemented in PHASE 4.1 as a dedicated
encryption foundation module.

### Dedicated encryption key

Biometric data is protected with a dedicated key:

- `BIOMETRIC_ENCRYPTION_KEY` — independent from authentication and
  service secrets
- Must be exactly 32 random bytes, base64-encoded
- Generate locally with: `openssl rand -base64 32`
- Do NOT reuse `BETTER_AUTH_SECRET`, `FACE_SERVICE_SECRET`,
  `GOOGLE_CLIENT_SECRET`, or any other secret

### Encryption details

| Property | Value |
| --- | --- |
| Algorithm | AES-256-GCM |
| Key size | 256 bits (32 bytes) |
| Key encoding | base64 |
| IV | Fresh random per encryption (96 bits / 12 bytes) |
| Auth tag | 128 bits / 16 bytes (GCM built-in) |
| AAD | Context binding (userId, modelIdentity, templateVersion, vectorType) |
| Key version | `1` (for future rotation support) |

### Authenticated encryption

- AES-256-GCM provides authenticated encryption (AEAD)
- Every encryption operation generates a fresh IV
- IV is never derived from userId or any other predictable value
- Authenticated Associated Data (AAD) binds ciphertext to a specific
  context (user, model, template version)
- Decryption requires the same AAD — tampering causes authentication
  failure

### Key rotation readiness

- `keyVersion: 1` is included in all encrypted output
- The module infrastructure supports future key rotation
- Actual key rotation is not implemented in PHASE 4.1

### Vector serialization

- Face embeddings are serialized as float32 binary before encryption
- Float32 precision is sufficient for normalized ArcFace embeddings
- Binary format is deterministic and compact
- No JSON serialization for biometric vectors

### Template version vs key version

The biometric database uses two distinct version fields that must not
be confused:

- `templateVersion` — biometric template structure / format version.
  Lives on `FaceProfile` and `FaceEnrollmentSession`. A future change to
  the embedded schema (e.g. new quality fields, new sample ordering)
  increments this value.
- `keyVersion` (inside `EncryptedBiometricValue`) — encryption key
  generation. Lives on every encrypted value. A future key rotation
  increments this value. Currently always `1`.

The two are independent: rotating the encryption key does not require
a template migration, and bumping the template version does not require
re-encrypting old ciphertexts (old documents remain readable with the
old key).

## Phase 4.2 biometric database schema

PHASE 4.2 introduces two Mongoose collections. Both store ONLY
encrypted biometric vectors (`ciphertext`, `iv`, `authTag`, `keyVersion`)
plus aggregated, non-identifying quality metadata.

### `face_profiles`

Permanent active biometric enrollment. **Unique per Better Auth user**
via a unique index on `userId`.

Stored fields (PHASE 4.2 — persistence foundation only):

- `userId`, `status` (`"active"`), `modelIdentity`, `modelName`,
  `embeddingDimension`, `normalization` (`"l2"`), `templateVersion`,
  `requiredSampleCount`, `sampleCount`
- `samples[]`: each entry carries an encrypted vector (`encryptedVector`),
  `sampleIndex`, and an optional quality block (`detectionScore`,
  `blurScore`, `brightness`, `relativeFaceArea`)
- `centroid`: a single encrypted reference vector
- `qualitySummary`: aggregated, non-biometric metrics
  (`meanDetectionScore`, `meanBlurScore`, `meanBrightness`,
  `minSelfSimilarity`, `meanSelfSimilarity`)
- `enrolledAt`, `createdAt`, `updatedAt`

The schema does NOT include any field for plaintext embeddings, raw
images, base64 frames, face crops, landmarks, bounding boxes, image
hashes, or camera frames.

### `face_enrollment_sessions`

Temporary per-user state used while a user is enrolling. **Unique per
Better Auth user** via a unique index on `userId`. A TTL index on
`expiresAt` (with `expireAfterSeconds: 0`) instructs MongoDB to delete
the document once `expiresAt` is in the past.

Stored fields (PHASE 4.2 — persistence foundation only, plus
PHASE 4.5B4.3 `generationId`):

- `userId`, `mode` (`"create"` or `"replace"`), `templateVersion`,
  `requiredSampleCount`
- Optional model metadata (`modelIdentity`, `modelName`,
  `embeddingDimension`, `normalization`) — these fields are absent until
  the first sample is processed in a future phase
- `acceptedSamples[]`: each entry carries an encrypted vector
  (`encryptedVector`), `sampleIndex`, an optional quality block, and
  `acceptedAt`
- `expiresAt`, `createdAt`, `updatedAt`
- `generationId` (PHASE 4.5B4.3) — a UUID v4 minted by the server at
  create-or-reset time. Required, non-unique. Used as the
  reconciliation discriminator for multi-tab and reload resilience.
  For legacy documents created before PHASE 4.5B4.3 the field is
  backfilled lazily, atomically, and exactly once on the first
  read of the document (see "Legacy session migration" below).

**TTL deletion is asynchronous.** Service code must call
`isEnrollmentSessionExpired(session)` to detect expiration; relying
solely on physical deletion would create race conditions.

The schema does NOT include any field for plaintext embeddings, raw
images, base64 frames, face crops, or camera frames.

### Service layer

PHASE 4.2 ships two server-only service modules:

- `apps/web/src/lib/biometrics/face-profile-service.ts`
  — `getFaceProfileByUserId`, `hasFaceProfile`, `saveFaceProfile`
  (upsert keyed on `userId`), `deleteFaceProfileByUserId`.
- `apps/web/src/lib/biometrics/enrollment-session-service.ts`
  — `getEnrollmentSessionByUserId`,
  `createOrResetEnrollmentSession` (upsert keyed on `userId`, clears
  `acceptedSamples`, refreshes `expiresAt`, resets model metadata to
  `undefined`, mints a fresh `generationId`), and PHASE 4.5B4.3
  performs an atomic lazy server-side backfill of `generationId`
  for legacy sessions,
  `deleteEnrollmentSessionByUserId`,
  `isEnrollmentSessionExpired`.

Both services map MongoDB duplicate-key errors to safe
`BiometricPersistenceError` instances; raw driver errors never escape
the service layer.

### What is NOT yet implemented

PHASE 4.2 deliberately does NOT implement:

- Camera access (`getUserMedia`) or Face ID UI
- Next.js API routes or Server Actions
- Face Service enrollment endpoints
- InsightFace changes
- Embedding extraction
- Quality gate
- Sample upload
- Enrollment finalization
- Centroid calculation
- Re-enrollment UI
- Face ID deletion UI

Those belong to PHASE 4.3+ and are out of scope for this database-only
mini-phase.

## Phase 4.3 enrollment sample endpoint

PHASE 4.3 ships **one** new Face Service operation:
`POST /v1/faces/enrollment/sample`. The endpoint is the first piece of
the PHASE 4 enrollment pipeline on the server side — a thin wrapper
around the PHASE 3 detection + embedding primitives plus a new quality
gate.

### Server-to-server only

The endpoint requires the shared `X-Service-Token` (same mechanism as
every other `/v1/*` route). It is **internal infrastructure**: only the
trusted Next.js server (`apps/web`) may call it. The browser must
**never** call this endpoint directly. The Face Service does **not**
configure CORS for arbitrary browser origins.

The endpoint is the only place in the Face Service where an embedding
leaves the process. It is allowed to do so ONLY because the documented
caller is the Next.js server, which then encrypts the vector with
AES-256-GCM (PHASE 4.1) before any persistent storage.

### Exactly one face required

The endpoint requires exactly one detected face. Behaviour:

- 0 faces → `422 NO_FACE` (standard PHASE 3 error envelope).
- 2+ faces → `422 MULTIPLE_FACES` (standard PHASE 3 error envelope).

The endpoint never silently picks a single face out of many — it does
not choose the largest or the highest-confidence face. The user must
retake the photo so that exactly one face is in frame.

### Quality gate

The endpoint applies a quality policy on top of the PHASE 3 metrics:

- `detection_score`
- `face_width` / `face_height` (pixels)
- `relative_face_area` (face area / image area)
- `blur_score` (variance of Laplacian — resolution-dependent)
- `brightness` (normalised mean luminance — exposure only)
- `near_edge`

A single sample may be rejected for **one or more** reasons; the
endpoint returns the full list with deterministic ordering. Stable
codes:

| Code | Meaning |
| --- | --- |
| `LOW_DETECTION_CONFIDENCE` | `detection_score` below threshold. |
| `FACE_TOO_SMALL` | `relative_face_area` below threshold. |
| `FACE_TOO_LARGE` | `relative_face_area` above threshold. |
| `TOO_BLURRY` | `blur_score` below threshold. |
| `TOO_DARK` | normalised brightness below threshold. |
| `TOO_BRIGHT` | normalised brightness above threshold. |
| `FACE_NEAR_EDGE` | bbox touches the image border. |

When the gate fails the endpoint still returns `200 OK` with
`accepted=false` and the rejection list — this is a domain outcome, not
an infrastructure error. **The embedding is omitted** on rejection.

#### Scale strategy

The policy uses `relative_face_area` for too-small / too-large
decisions because raw pixel size depends on resolution. The same webcam
is judged fairly across frame sizes.

#### No demographic rejection

The policy never rejects based on gender, age, skin tone, ethnicity, or
appearance. Brightness refers to image exposure only.

#### Thresholds

The thresholds live in a single configuration source
(`services/face-service/app/core/config.py`) and surface in
`services/face-service/.env.example`. **They are CONSERVATIVE
DEVELOPMENT BASELINES — NOT production-calibrated.** They MUST be re-
calibrated against a representative evaluation set before any
production deployment.

| Variable | Default |
| --- | --- |
| `FACE_ENROLLMENT_MIN_DETECTION_SCORE` | `0.7` |
| `FACE_ENROLLMENT_MIN_FACE_AREA` | `0.03` |
| `FACE_ENROLLMENT_MAX_FACE_AREA` | `0.6` |
| `FACE_ENROLLMENT_MIN_BLUR_SCORE` | `80.0` |
| `FACE_ENROLLMENT_MIN_BRIGHTNESS` | `0.18` |
| `FACE_ENROLLMENT_MAX_BRIGHTNESS` | `0.85` |

### Liveness

**Liveness / anti-spoofing is NOT implemented in PHASE 4.3.** The
endpoint accepts any single face that passes the quality gate, including
printed photos, screen replays, and recorded video. Anti-spoof arrives
in a later release (Phase 9 in the architecture plan).

### No persistence

The Face Service remains **stateless**. It does NOT persist:

- raw image bytes
- face crops
- embeddings
- quality results

Everything lives in the request lifecycle. There is no MongoDB, no
SQLite, no JSON file, no `.npy`, no pickle.

### Logging hygiene

PHASE 4.3 safe log fields for the enrollment endpoint:

- `accepted` (bool)
- `face_count` (always 1 — face count errors use the standard envelope)
- `rejection_count` (number of stable codes)
- `processing_ms`

The Face Service **never logs**:

- raw image bytes
- base64 frames
- face crops
- the embedding vector
- the `X-Service-Token` header

### Browser exposure

The endpoint is the only place in the Face Service that returns an
embedding. The existing endpoints remain unchanged:

- `POST /v1/faces/analyze` — never returns embeddings.
- `POST /v1/faces/compare` — returns similarity + threshold + match
  flag only.

These invariants are guarded by unit tests (`/v1/faces/analyze` still
never contains the string `embedding` in its JSON body).

## Phase 4.4B1 enrollment start route

PHASE 4.4B1 ships the first Next.js Face ID route —
`POST /api/face-id/enrollment/start`. The route's only job is to
safely start (or reset) a temporary biometric enrollment session
for the authenticated user.

### Server-only and biometric-free

The route:

- Lives under `apps/web/src/app/api/face-id/enrollment/start/route.ts`.
  It is a Next.js Route Handler, run server-side. No Client Component
  or browser fetch hook is introduced in this mini-phase.
- Accepts **no** biometric payload. The request body is ignored. No
  image, no embedding, no encrypted vector enters or leaves this
  endpoint.
- Does **not** call the Face Service. Neither
  `getFaceServiceHealth()` nor `analyzeEnrollmentSample()` is invoked.
- Does **not** create, replace, or delete a `FaceProfile`.

### Authentication and ownership

- Identity comes exclusively from `session.user.id` (Better Auth
  server session). The request body's `userId` / `email` fields are
  ignored.
- If no session exists → `401 UNAUTHENTICATED`.
- A malicious body such as `{ "userId": "another-user" }` cannot
  cause creation of an enrollment session for another account. This
  invariant is covered by an explicit unit test.
- If the authenticated user has no Profile, or `onboardingCompleted`
  is false → `409 PROFILE_INCOMPLETE`. The route never auto-creates a
  Profile — onboarding is a separate flow.
- If an active `FaceProfile` already exists → `409
  FACE_PROFILE_ALREADY_EXISTS`. The existing profile is left
  untouched. Explicit re-enrollment is implemented in a later
  mini-phase.

### Session lifetime and reset semantics

- The temporary enrollment session has a server-generated `expiresAt`
  of `now + 15 minutes`, using the existing PHASE 4.2 helper
  `DEFAULT_ENROLLMENT_SESSION_TTL_MS` in
  `apps/web/src/lib/biometrics/enrollment-session-ttl.ts`. The
  browser cannot choose the expiry.
- The required sample count is centralized in
  `apps/web/src/lib/biometrics/biometric-constants.ts` as
  `DEFAULT_FACE_ENROLLMENT_REQUIRED_SAMPLES = 5`. The literal `5`
  must not be repeated across call sites.
- Calling `start` again for a user who already has an unfinished
  CREATE session **resets** that session in place: `acceptedSamples`
  is cleared, `expiresAt` is refreshed, model metadata is reset to
  `undefined`. The unique index on `userId` guarantees at most one
  enrollment-session document per user at the database layer.

### Response privacy

The route's success body is intentionally minimal:

```json
{
  "status": "started",
  "mode": "create",
  "acceptedSamples": 0,
  "requiredSamples": 5,
  "expiresAt": "2026-09-10T14:30:00.000Z"
}
```

It deliberately does **not** include:

- `userId`, `email`, or any other identity-bearing field.
- encrypted sample vectors (`ciphertext`, `iv`, `authTag`,
  `keyVersion`).
- model metadata (`modelIdentity`, `modelName`, `embeddingDimension`,
  `normalization`).
- embeddings.
- any object taken directly from the database row.

A failing response uses the standard project envelope:

```json
{ "error": { "code": "STRING_CODE", "message": "Human readable." } }
```

Stable codes include `UNAUTHENTICATED`, `PROFILE_INCOMPLETE`,
`FACE_PROFILE_ALREADY_EXISTS`, and `ENROLLMENT_START_FAILED`.
Mongoose / MongoDB / Better Auth internals are never returned.

### What is NOT yet implemented

PHASE 4.4B1 deliberately does NOT implement:

- Sample upload (`POST /api/face-id/enrollment/sample`).
- Camera access or `getUserMedia`.
- Embedding extraction, encryption, or persistence.
- Face Service calls (`/health` or `/v1/faces/enrollment/sample`).
- Enrollment finalization or `FaceProfile` creation.
- Re-enrollment / replacement flow.
- Status endpoint (`GET /api/face-id/enrollment`).
- Frontend pages, dashboard changes, attendance workflows.

PHASE 4.4B1 ships only the start route and its dedicated tests.

## Phase 4.4B2 enrollment status route

PHASE 4.4B2 adds the read-only status route
`GET /api/face-id/enrollment/status`. The route's only job is to
report the safe current state of the authenticated user's Face ID
enrollment.

### Server-only and biometric-free

The route:

- Lives under `apps/web/src/app/api/face-id/enrollment/status/route.ts`.
  It is a Next.js Route Handler, run server-side. No Client
  Component or browser fetch hook is introduced in this
  mini-phase.
- Accepts **no** biometric payload. No image, no embedding, no
  encrypted vector enters or leaves this endpoint.
- Does **not** call the Face Service. Neither
  `getFaceServiceHealth()` nor `analyzeEnrollmentSample()` is
  invoked.
- Does **not** call the encryption module. The route never
  decrypts anything; reading status does not require
  `BIOMETRIC_ENCRYPTION_KEY`.
- Does **not** create, replace, or delete a `FaceProfile`.
- May attempt a best-effort cleanup of an expired
  `FaceEnrollmentSession` document; cleanup failure never
  surfaces to the browser.

### Authentication and ownership

- Identity comes exclusively from `session.user.id` (Better Auth
  server session). Query parameters such as `?userId=...` are
  **ignored** — they cannot influence ownership, response
  content, or service calls. This invariant is covered by an
  explicit unit test.
- If no session exists → `401 UNAUTHENTICATED`.
- If the authenticated user has no Profile, or
  `onboardingCompleted` is false → `409 PROFILE_INCOMPLETE`. The
  route never auto-creates a Profile — onboarding is a separate
  flow.

### Expired session handling

- The route checks `isEnrollmentSessionExpired(session)` rather
  than relying on MongoDB TTL deletion. A document with
  `expiresAt` already in the past may still be present in the
  collection; the route treats it as expired regardless.
- On a known-expired session the route attempts a best-effort
  `deleteEnrollmentSessionByUserId(...)` cleanup. A cleanup
  failure is **internal-only** — the response still safely
  reports `enrollment.active = false` and never includes a 5xx
  error. The route does not log biometric sample contents.

### Response privacy

The route's success body is intentionally minimal:

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

When the user has a permanent Face ID enrollment, `configured`
is `true` and a `faceId` block is present:

```json
{
  "configured": true,
  "faceId": {
    "enrolledAt": "2026-09-01T10:00:00.000Z",
    "sampleCount": 5
  },
  "enrollment": { "...": "..." }
}
```

When a temporary enrollment session is in progress
(`mode` is `"create"` or `"replace"`), the `enrollment` block
reports:

- `active: true`
- `mode` — the stored value (`"create"` or `"replace"`)
- `acceptedSamples` — the LENGTH of the stored
  `acceptedSamples` array
- `requiredSamples` — the stored `requiredSampleCount`
- `expiresAt` — the stored expiry, serialized to ISO 8601

It deliberately does **not** include:

- `userId`, `email`, or any other identity-bearing field.
- encrypted sample vectors (`ciphertext`, `iv`, `authTag`,
  `keyVersion`).
- model metadata (`modelIdentity`, `modelName`,
  `embeddingDimension`, `normalization`).
- embeddings.
- centroids.
- quality summaries.
- the actual `acceptedSamples` array (only its length is
  returned).
- any object taken directly from the database row.

A failing response uses the standard project envelope:

```json
{ "error": { "code": "STRING_CODE", "message": "Human readable." } }
```

Stable codes include `UNAUTHENTICATED`, `PROFILE_INCOMPLETE`,
and `ENROLLMENT_STATUS_FAILED`. Mongoose / MongoDB / Better Auth
internals are never returned.

### What is NOT yet implemented

PHASE 4.4B2 deliberately does NOT implement:

- Sample upload (`POST /api/face-id/enrollment/sample`).
- Camera access or `getUserMedia`.
- Embedding extraction, encryption, or persistence.
- Face Service calls (`/health` or `/v1/faces/enrollment/sample`).
- Encryption / decryption calls (the route never imports the
  encryption module).
- Enrollment finalization or `FaceProfile` creation.
- Re-enrollment / replacement flow.
- Frontend pages, dashboard changes, attendance workflows.

PHASE 4.4B2 ships only the status route and its dedicated tests.

## Phase 4.4C enrollment sample route

PHASE 4.4C adds the sample upload route
`POST /api/face-id/enrollment/sample`. The route accepts ONE image
from the authenticated web client, forwards it to the trusted Face
Service, and on accepted samples encrypts the embedding with
AES-256-GCM before persisting it inside the temporary enrollment
session.

### Server-only and transient

The route:

- Lives under
  `apps/web/src/app/api/face-id/enrollment/sample/route.ts`. It is a
  Next.js Route Handler, run server-side. No Client Component or
  browser fetch hook is introduced in this mini-phase.
- Does **not** write the uploaded image to disk, MongoDB, Blob
  storage, `localStorage`, or any public folder. The image stays in
  request-scoped memory.
- Accepts **only** `multipart/form-data` with a single `image` field
  (JPEG, PNG, or WebP; max 1.5 MB). JSON base64, multiple files, and
  continuous video are not accepted.
- Uses existing `analyzeEnrollmentSample(...)` through
  `face-service-client.ts` (server-only). Direct fetch is forbidden.
- Does **not** create or modify any `FaceProfile`. It only appends
  encrypted samples to the existing temporary
  `FaceEnrollmentSession`.

### Authentication and ownership

- Identity comes exclusively from `session.user.id` (Better Auth
  server session). The request body — including any client-supplied
  `userId` field — is ignored for identity decisions. This invariant
  is covered by an explicit unit test.
- If no session exists → `401 UNAUTHENTICATED`.
- If the authenticated user has no Profile, or
  `onboardingCompleted` is false → `409 PROFILE_INCOMPLETE`. The
  route never auto-creates a Profile.
- If no active enrollment session exists → `409
  ENROLLMENT_NOT_STARTED`. The user must call
  `POST /api/face-id/enrollment/start` explicitly.
- If the existing session has `expiresAt <= now` → `409
  ENROLLMENT_EXPIRED`. The route does not auto-create a new session;
  the user must explicitly call `start` again.
- If the session mode is not `"create"` → the route rejects the
  request (replace-mode sessions are not yet implemented in this
  mini-phase).

### Image validation at the boundary

- File must exist, `size > 0`, `size <= FACE_ENROLLMENT_MAX_SAMPLE_BYTES`
  (centralized constant set to 1.5 MB).
- MIME type must be `image/jpeg`, `image/png`, or `image/webp`. Filename
  extension is not trusted; only the validated `Blob.type` is used.
- Invalid file / oversized / invalid MIME → `400 INVALID_IMAGE` or
  `400 IMAGE_TOO_LARGE`. No oversized payload is ever forwarded to the
  Face Service.
- Face Service remains authoritative for real image decoding.

### Face Service call

- The route calls existing `analyzeEnrollmentSample(...)` through the
  PHASE 4.4A server-only `face-service-client.ts`. The
  `X-Service-Token` is set by the client, never duplicated in the
  route.
- No automatic retry. Each request fires exactly one Face Service
  call. The secret token never appears in responses.

### Face Service error mapping

`FaceServiceClientError` is mapped to safe, stable web-level codes
without exposing raw fetch/FastAPI errors:

| Face Service domain error | Mapped route code | HTTP |
| --- | --- | --- |
| `NO_FACE` | `NO_FACE` (preserved) | 422 |
| `MULTIPLE_FACES` | `MULTIPLE_FACES` (preserved) | 422 |
| `FACE_SERVICE_NOT_CONFIGURED` | `FACE_SERVICE_NOT_CONFIGURED` | 502 |
| `FACE_SERVICE_UNAVAILABLE` | `FACE_SERVICE_UNAVAILABLE` | 502 |
| `FACE_SERVICE_TIMEOUT` | `FACE_SERVICE_TIMEOUT` | 502 |
| `FACE_SERVICE_UNAUTHORIZED` | `FACE_SERVICE_UNAUTHORIZED` | 502 |
| `FACE_SERVICE_INVALID_RESPONSE` | `FACE_SERVICE_INVALID_RESPONSE` | 502 |
| any other | `FACE_SERVICE_UNAVAILABLE` | 502 |

### Quality rejection handling

- Face Service may return `accepted=false` with one or more
  rejection codes (`LOW_DETECTION_CONFIDENCE`, `FACE_TOO_SMALL`,
  `FACE_TOO_LARGE`, `TOO_BLURRY`, `TOO_DARK`, `TOO_BRIGHT`,
  `FACE_NEAR_EDGE`).
- This is a normal domain outcome, **not** a server failure.
- **Nothing is persisted.** No encrypted sample is appended. The
  accepted-sample count is not incremented.
- The route returns a safe progress DTO:

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

- Quality threshold numbers are not returned to the browser.

### Accepted sample handling

For an accepted sample the route:

1. Re-validates the session is still active and below the sample
   limit.
2. Determines the deterministic 0-based `sampleIndex = currentCount`.
3. Validates model compatibility (for samples after the first).
4. Encrypts the embedding using PHASE 4.1 AES-256-GCM with AAD
   binding:

   ```ts
   {
     userId: session.user.id,
     modelIdentity: <from Face Service response>,
     templateVersion: session.templateVersion,
     vectorType: "sample",
     sampleIndex
   }
   ```

5. Atomically appends the encrypted sample to the session using
   `appendAcceptedEnrollmentSample(...)`, which uses MongoDB
   `findOneAndUpdate` with filter conditions to prevent race
   conditions.

For the **first** accepted sample, model metadata
(`modelIdentity`, `modelName`, `embeddingDimension`,
`normalization`) is established at the same time. Subsequent samples
must match exactly; mismatches return `MODEL_MISMATCH` without
modifying existing accepted samples.

### Sample limit

- Maximum `requiredSampleCount = 5` samples per session (centralized
  constant `DEFAULT_FACE_ENROLLMENT_REQUIRED_SAMPLES`).
- When `currentCount >= requiredSampleCount`, the route returns
  `ENROLLMENT_SAMPLE_LIMIT_REACHED` without calling the Face Service.

### Concurrency

`appendAcceptedEnrollmentSample(...)` uses MongoDB atomic
`findOneAndUpdate` with a filter that includes all of the following
conditions, evaluated atomically by MongoDB:

- `userId` matches the authenticated user.
- `expiresAt > now` (defense-in-depth — the route already checks
  this before calling).
- The session's current `acceptedSamples` length is EXACTLY equal to
  the caller's `expectedSampleIndex` (enforced via `$expr` + `$eq` +
  `$size`). This is the **PHASE 4.4C.1** atomic-exact-length guard
  that prevents duplicate `sampleIndex` values from being persisted
  when two simultaneous requests both read the same starting state.
- The session's current `acceptedSamples` length is less than
  `requiredSampleCount` (enforced via `$expr` + `$lt` + `$size`).
- For the FIRST sample (caller's `expectedSampleIndex === 0`):
  `modelIdentity`, `modelName`, `embeddingDimension`, and
  `normalization` are absent (`$exists: false`), so the FIRST atomic
  update both initializes model metadata AND appends the encrypted
  sample.
- For non-first samples: `modelIdentity`, `modelName`,
  `embeddingDimension`, and `normalization` match the incoming
  values exactly.

Two simultaneous accepted-sample requests therefore CANNOT both assign
the same `sampleIndex` or both exceed the required count. The losing
request receives a safe `ENROLLMENT_SAMPLE_CONFLICT` (HTTP 409) — a
stable application-level conflict that the user/browser may
explicitly retry. The route deliberately does NOT auto-retry, does
NOT call Face Service again, and does NOT re-encrypt under a
different `sampleIndex`.

For the first sample, the same atomic `findOneAndUpdate` initializes
model metadata and appends the encrypted sample in one operation, so
two simultaneous first-samples cannot establish conflicting model
identities. The losing first-sample request also returns
`ENROLLMENT_SAMPLE_CONFLICT`.

The three `sampleIndex` values — the route's AAD field, the
caller's `expectedSampleIndex` argument, and the persisted
`acceptedSamples[i].sampleIndex` field — are guaranteed to be
identical by construction (the route threads one local variable
through both calls).

### No plaintext embedding persistence

The route may temporarily hold the embedding in server memory while
calling `encryptBiometricVector(...)`. Before MongoDB persistence it
is encrypted, and only the encrypted value
(`ciphertext`/`iv`/`authTag`/`keyVersion`) is passed to the
persistence layer. A plaintext `number[]` is NEVER passed to
`appendAcceptedEnrollmentSample(...)`. An explicit unit test asserts
this against a recognizable fake embedding (`0.123456`).

### Biometric key failure handling

If the encryption key is missing or invalid, the route returns a safe
`503 BIOMETRIC_ENCRYPTION_UNAVAILABLE` and never persists the sample
(plaintext or otherwise).

### Response privacy

Success body — accepted sample:

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

`complete: true` is reported only when `acceptedSamples >=
requiredSamples`. It means "enough temporary samples collected"; it
does NOT mean a `FaceProfile` exists. FaceProfile creation belongs to
a later phase.

Success body — rejected quality:

```json
{
  "accepted": false,
  "rejectionReasons": ["TOO_BLURRY"],
  "progress": {
    "acceptedSamples": 3,
    "requiredSamples": 5,
    "complete": false
  }
}
```

These responses deliberately do **not** include:

- `userId`, `email`, or any other identity-bearing field.
- `embedding`.
- `ciphertext`, `iv`, `authTag`, `keyVersion`.
- `modelIdentity`, `modelName`, `embeddingDimension`,
  `normalization`.
- The Face Service response is NEVER spread directly into JSON;
  every field that reaches the wire is explicitly constructed by the
  route.

Stable codes for this endpoint include `UNAUTHENTICATED`,
`PROFILE_INCOMPLETE`, `ENROLLMENT_NOT_STARTED`, `ENROLLMENT_EXPIRED`,
`INVALID_IMAGE`, `IMAGE_TOO_LARGE`, `NO_FACE`, `MULTIPLE_FACES`,
`FACE_SERVICE_UNAVAILABLE`, `FACE_SERVICE_TIMEOUT`,
`FACE_SERVICE_NOT_CONFIGURED`, `MODEL_MISMATCH`,
`ENROLLMENT_SAMPLE_LIMIT_REACHED`, `BIOMETRIC_ENCRYPTION_UNAVAILABLE`,
and `ENROLLMENT_SAMPLE_FAILED`.

### What is NOT yet implemented

PHASE 4.4C deliberately does NOT implement:

- Camera access or `getUserMedia`.
- Frontend UI for capturing photos.
- Embedding-storage on the `FaceProfile` collection.
- Centroid calculation, finalization, or replacement.
- Re-enrollment / FaceProfile deletion flows.
- Attendance workflows.

PHASE 4.4C ships only the sample route and its dedicated tests.

## Phase 4.5A browser camera foundation

PHASE 4.5A ships the first **client-side** Face ID code in the
web app: a small, reusable camera primitive for future enrollment
UI. The mini-phase is deliberately minimal — a live preview and
nothing more.

### Client-only surface

The new files live entirely under
`apps/web/src/components/face-id/`:

- `camera-constants.ts` — stable error codes, friendly messages,
  and `getUserMedia` constraints (`audio: false`, `facingMode:
  "user"`, ideal `1280x720`).
- `camera-errors.ts` — a pure `mapCameraError(unknown)` utility that
  returns a closed-enum `CameraErrorShape` and never leaks raw
  exception names, messages, or stacks.
- `use-face-camera.ts` — a `"use client"` React hook exposing
  `videoRef`, `status` (`idle | requesting | ready | error`),
  `error`, `isReady`, `startCamera`, `stopCamera`.
- `camera-preview.tsx` — a `"use client"` React component that
  renders a `<video>`, "Turn on camera" / "Stop camera" buttons,
  an accessible error block, and a small privacy note.
- `index.ts` — public surface re-exports.

The module MUST NOT import any server-only module. In particular
the camera code never references:

- `face-service-client.ts`
- `encryption.ts`
- Mongoose models
- `FACE_SERVICE_SECRET`
- `BIOMETRIC_ENCRYPTION_KEY`
- `MONGODB_URI`

### Permission is explicit

The browser's `getUserMedia` permission dialog is one of the most
disruptive UX events on the web. PHASE 4.5A enforces the rule:

- `getUserMedia` is NEVER called on mount, render, or effect.
- The ONLY trigger is the user pressing **"Turn on camera"**.
- Opening a page that embeds `CameraPreview` must NOT immediately
  trigger the browser permission dialog.

This is the exact same posture called for in
`docs/frontend-design.md`: no surprise permission prompts.

### Audio is off

PHASE 4.5A requests `audio: false` unconditionally. Microphone
permission is NEVER requested. The microphone LED on supported
platforms therefore never lights up during PHASE 4.5A usage.

### Track cleanup on stop

`stopCamera()` stops EVERY active `MediaStreamTrack` and detaches
the stream from the `<video>` element. The OS-level camera LED is
guaranteed to turn off when the user presses Stop, navigates away,
or closes the consuming component.

The hook also performs the same cleanup in its unmount effect,
so leaving a page that embeds `CameraPreview` never leaves the
webcam running.

### No image capture / no upload

PHASE 4.5A does NOT capture, encode, or upload any image. There
is no:

- `<canvas>` element in the foundation code
- `drawImage`, `toBlob`, or `toDataURL` call
- `ImageCapture` API usage
- `fetch` call to `/api/face-id/enrollment/sample`
- persistent browser storage (`localStorage`, `IndexedDB`)

The only thing the camera writes to is the `<video>` element's
`srcObject` — a live in-memory `MediaStream`. There is no
persistent browser-side state to clean up.

### Privacy copy

`CameraPreview` includes a small, restrained privacy note near
the preview: "The camera preview stays on this device until you
choose to capture a sample." This wording is deliberately
limited to what is true in PHASE 4.5A. It does NOT claim that
future samples are never transmitted, because PHASE 4.5B will
send user-chosen samples to the server.

### Secure context

`navigator.mediaDevices.getUserMedia` is only available in a
secure context (HTTPS or localhost). `useFaceCamera` checks
`window.isSecureContext` BEFORE calling `getUserMedia` and
returns `CAMERA_INSECURE_CONTEXT` if the page is not in a secure
context. No production domains are hard-coded; localhost is
treated as secure by modern browsers.

### Stable camera error codes

Browser exceptions are mapped to a closed enum:

| Browser exception                                              | Mapped code                |
| -------------------------------------------------------------- | -------------------------- |
| `NotAllowedError`                                              | `CAMERA_PERMISSION_DENIED` |
| `NotFoundError`, `OverconstrainedError`                        | `CAMERA_NOT_FOUND`         |
| `NotReadableError`                                             | `CAMERA_IN_USE`            |
| `SecurityError`                                                | `CAMERA_INSECURE_CONTEXT`  |
| anything else (incl. `null`, `undefined`, primitives)          | `CAMERA_UNAVAILABLE`       |

The mapping is pure, isolated to `camera-errors.ts`, and is
unit-tested independently of the hook and the component. Raw
exception names, messages, and stacks are NEVER surfaced to
the user, to logs, or to the UI tree.

### What is NOT yet implemented

PHASE 4.5A deliberately does NOT implement:

- Image capture (`<canvas>`, `ImageCapture`, `toBlob`, `toDataURL`,
  `drawImage`).
- JPEG / PNG / WebP encoding.
- Sample submission to `/api/face-id/enrollment/sample`.
- 5-sample progress, embedding extraction, encryption, or
  persistence.
- Face Service calls.
- Finalization or `FaceProfile` creation.
- Re-enrollment or FaceProfile deletion flows.
- A `/face-id` or `/face-id/setup` application route.
- Any change to sidebar navigation.
- Dashboard, attendance, or classes integration.
- Camera device enumeration / selection.

PHASE 4.5B will integrate the camera foundation into a real
`/face-id` enrollment page and add the missing capture / submit
loop. No part of that work belongs to PHASE 4.5A.

## Phase 4.5B1 Face ID page shell

PHASE 4.5B1 introduces the first two Server Component pages that
expose Face ID to the authenticated user:

- `/face-id` — safe overview page
- `/face-id/setup` — enrollment shell

Both pages share the same server-side authentication and profile
gating as `/dashboard` and `/profile`. No biometric payload enters
or leaves these pages. No Face Service calls are made from the
pages themselves.

### No biometric exposure on the overview page

The `/face-id` page renders ONLY safe fields:

- `configured` (boolean)
- `faceId.enrolledAt` (ISO string)
- `faceId.sampleCount` (integer)
- `enrollment.active`, `enrollment.mode`, `enrollment.acceptedSamples`,
  `enrollment.requiredSamples`, `enrollment.expiresAt`

The page never renders or references:

- `userId`, `email`
- encrypted samples (`ciphertext`, `iv`, `authTag`, `keyVersion`)
- model metadata (`modelIdentity`, `modelName`,
  `embeddingDimension`, `normalization`)
- embeddings
- centroids
- quality summaries
- the actual `acceptedSamples` array

### Explicit start action, no auto-enrollment

The `/face-id/setup` page never auto-starts enrollment and never
auto-requests camera permission. The user must explicitly press the
"Start setup" button. The button calls a Server Action
(`startFaceEnrollment`) that wraps the same auth and profile checks
as `POST /api/face-id/enrollment/start`. The action sets the
session under the authenticated user's identity only — it never
accepts a `userId` from the browser.

### CameraPreview retains PHASE 4.5A guarantees

When the enrollment page renders `CameraPreview`, the component
behaves exactly as in PHASE 4.5A:

- `getUserMedia` is only triggered by an explicit button click.
- `audio: false` — no microphone access is requested.
- All MediaStreamTracks are stopped on unmount and on Stop press.

The setup page never exposes a functional Capture button. The
preview's purpose in PHASE 4.5B1 is purely to verify camera access
works before later phases add capture and submission.

### Privacy copy on the setup page

The setup page includes restrained, neutral privacy information:

- "Face setup will use several camera samples to create an
  encrypted biometric template."
- "Raw camera images are not kept by the application."
- "Liveness and anti-spoofing are not enabled in this preview."

These statements are deliberately limited to what the current
architecture supports. No unbacked promises (e.g. "100% secure",
"cannot be fooled") are made. The page is not rendered as a legal
consent form.

### Shared safe status service

To avoid duplicating safe status logic between the existing
`GET /api/face-id/enrollment/status` route and the new Server
Components, a shared module is introduced:

```
apps/web/src/lib/biometrics/face-id-status-service.ts
```

It is server-only, returns typed objects (no JSON-over-HTTP), and
performs the same TTL handling as the status route. It deliberately
NEVER returns any biometric field listed above.

### Server-secret hygiene

The page code NEVER imports:

- `face-service-client.ts`
- `encryption.ts`
- Mongoose models
- `FACE_SERVICE_SECRET`
- `BIOMETRIC_ENCRYPTION_KEY`
- `MONGODB_URI`

Only Client Components in the strict sense (the page-level Client
components for the start button and the pre-existing `CameraPreview`)
are present in the browser bundle. Both use only React, the
shared `cn()` helper, and the camera foundation modules.

### What PHASE 4.5B1 does NOT include

- Image capture / encoding / upload
- POST `/api/face-id/enrollment/sample`
- 5-sample capture loop
- Quality feedback
- Embedding handling
- Finalization
- Centroid calculation
- FaceProfile creation
- Re-enrollment or Face ID deletion

Those belong to PHASE 4.5B2.

## Phase 4.5B2 video frame capture foundation

PHASE 4.5B2 ships the first **client-side image processing** primitive
in the web app: a reusable utility that captures one frame from an
already-ready HTMLVideoElement and returns it as a JPEG Blob held
only in browser memory. PHASE 4.5B2 does NOT submit the frame
anywhere, does NOT persist it, and does NOT integrate into a UI yet.

### Client-only, server-secret free

The new file lives under
`apps/web/src/components/face-id/capture-video-frame.ts`. It is
client-only and never imports:

- `face-service-client.ts`
- `encryption.ts`
- Mongoose models
- `FACE_SERVICE_SECRET`
- `BIOMETRIC_ENCRYPTION_KEY`
- `MONGODB_URI`

The utility performs ZERO network requests — no `fetch`,
`XMLHttpRequest`, `sendBeacon`, or Server Action call. An explicit
unit test asserts `fetch` is never called.

### The captured JPEG stays in memory

The captured frame exists only as:

- temporary canvas pixels during encoding
- the returned in-memory JPEG `Blob`

The frame is NEVER written to:

- the filesystem
- IndexedDB
- localStorage
- sessionStorage
- the Cache API
- MongoDB
- a public directory

After `toBlob` completes, the ephemeral canvas backing memory is
released (`canvas.width = 0; canvas.height = 0`). The utility does
NOT create an object URL — `URL.createObjectURL()` is not called in
PHASE 4.5B2. There is no captured preview yet.

### Encoding policy

| Property | Value |
| --- | --- |
| MIME type | `image/jpeg` |
| Quality | `0.85` (development setting) |
| Max long edge | `1280` |
| Aspect ratio | preserved |
| Upscale | NEVER |
| Encoder | `canvas.toBlob` only |
| `toDataURL` | NOT used |
| Base64 output | NEVER produced |

The Next.js sample endpoint remains authoritative for its existing
1.5 MB request limit.

### Preview mirror does NOT mirror capture

The `CameraPreview` component applies a CSS
`[transform:scaleX(-1)]` to its `<video>` for selfie-style
presentation. CSS transforms do NOT affect the source pixels drawn
via `drawImage`. The capture utility does NOT apply
`ctx.scale(-1, 1)` or `ctx.translate(...)` — the captured image
preserves the original camera frame orientation. A test verifies
that no mirror transform is invoked.

### No biometric payload, no upload yet

The captured `Blob` is held only in browser memory. PHASE 4.5B2 does
NOT claim that future samples are never transmitted, because PHASE
4.5B3 will submit user-chosen samples to
`POST /api/face-id/enrollment/sample`. No part of that submission
flow belongs to PHASE 4.5B2.

### What PHASE 4.5B2 does NOT include

- POST `/api/face-id/enrollment/sample`
- A functional Capture button on `/face-id/setup`
- 5-sample progress mutations
- Quality feedback
- Embedding extraction, encryption, or persistence
- Face Service calls
- Finalization or `FaceProfile` creation
- Re-enrollment or Face ID deletion

Sample submission, finalization, and any embedding handling belong
to PHASE 4.5B3.

## Phase 4.5B3 capture + submit + quality feedback

PHASE 4.5B3 turns the previously-inert `CameraPreview` on
`/face-id/setup` into a working capture loop. Every biometric frame
still travels through the existing Next.js authenticated route; the
browser never speaks to the Face Service directly.

### Browser only ever calls the Next.js route

The browser is restricted to a single network endpoint:

- `POST /api/face-id/enrollment/sample`

The browser does **not** call:

- `${FACE_SERVICE_URL}` directly
- the FastAPI `/v1/faces/enrollment/sample` endpoint
- any other internal infrastructure

The browser does **not** send `X-Service-Token`, `FACE_SERVICE_SECRET`,
`userId`, `email`, `sampleIndex`, or `modelIdentity`. Identity is
derived from the Better Auth session exclusively, sample index is
managed atomically server-side.

### Strict network-boundary invariants

The browser request:

- Uses `multipart/form-data` with exactly one field, `image`,
  carrying the JPEG `Blob`.
- Filename: `"face-sample.jpg"` — harmless metadata only.
- NEVER manually sets `Content-Type: multipart/form-data`. The
  browser is responsible for generating the multipart boundary. A
  manual `Content-Type` would break the boundary and the request
  would be rejected.
- Sends NO `Authorization`, `X-Service-Token`, or any other internal
  header from the browser.

### What the browser sees from the server

The browser receives only safe fields from the existing route:

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

…or the standard `{ "error": { "code", "message" } }` envelope. The
browser never sees:

- `embedding`
- `ciphertext`, `iv`, `authTag`, `keyVersion`
- `modelIdentity`, `modelName`, `embeddingDimension`,
  `normalization`
- `userId`, `email`
- any other biometric payload

### No Blob persistence in the browser

The captured JPEG `Blob` lives only in the local variable inside the
click handler. It is **never**:

- stored in React state, context, or any store
- written to `localStorage`, `sessionStorage`, IndexedDB, or the
  Cache API
- exposed via `URL.createObjectURL()` or rendered into an `<img>`
  thumbnail

The PHASE 4.5B2 utility and the new submission helper both avoid
`toDataURL`, base64, object URLs, and `<canvas>` round-trips. There
is no captured-image preview UI in PHASE 4.5B3.

### Explicit action only

A "Capture sample" button is rendered only while:

- an active enrollment session exists, AND
- the camera hook reports `ready`, AND
- no submission is currently pending, AND
- `progress.complete === false`.

Two rapid clicks are prevented from producing two POSTs by a
synchronous `submissionInFlightRef` guard inside the click handler,
in addition to React's `pending` state used for the disabled
attribute. There is no timer, no interval, no `requestAnimationFrame`
loop, no face-triggered capture. One click produces exactly one
capture and exactly one POST.

### No automatic retry

The browser never retries the POST on:

- timeout
- 409 conflict (`ENROLLMENT_SAMPLE_CONFLICT`,
  `ENROLLMENT_SAMPLE_LIMIT_REACHED`)
- 5xx (`FACE_SERVICE_UNAVAILABLE`, `FACE_SERVICE_TIMEOUT`, ...)
- network failure
- `FACE_SERVICE_INVALID_RESPONSE`

The user must press "Capture sample" again explicitly. Quality
rejection, `NO_FACE`, and `MULTIPLE_FACES` are recoverable
domain-level outcomes; the camera is left running for the next
attempt.

### Server-authoritative progress

The browser receives safe initial progress from the existing
`face-id-status-service` and passes it to the panel as
`initialAcceptedSamples` and `requiredSamples`. The panel NEVER
increments its own counter (`setCount(count + 1)` is forbidden).
After every successful POST response the panel replaces its
displayed progress with the `progress` block from the server
response. Rejected samples, conflicts, and timeouts do NOT advance
progress.

### `complete=true` is an honest temporary state

When the server reports `progress.complete === true` the panel:

- disables further "Capture sample" submissions,
- displays an honest informational message such as *"All required
  samples collected. Final setup is not connected yet."*

The browser does **NOT** claim Face ID is configured, an identity is
verified, or a `FaceProfile` exists. `FaceProfile` creation belongs
to PHASE 4.5B4 / 4.6.

### Privacy copy on the setup page

The setup page privacy note is updated to reflect that each sample
the user explicitly chooses to capture is sent to the application
for face analysis, and that raw camera images are not kept by the
application. This is product information, not legal consent text.
The page does not claim end-to-end encryption.

### Camera lifecycle unchanged

PHASE 4.5B3 does NOT modify the PHASE 4.5A camera behavior:

- `getUserMedia` is still only triggered by an explicit button
  click.
- `audio: false` is still enforced.
- The pending-request guard, the request generation token, the
  unmount cleanup, and the error mapping all remain.

After a successful POST or a quality rejection the camera stream
is left running so the user can try again without re-requesting
permission. The camera is never restarted automatically.

### What is NOT yet implemented

PHASE 4.5B3 deliberately does NOT implement:

- `FaceProfile` creation or any finalization
- Centroid calculation
- Decryption of any persisted encrypted sample
- Re-enrollment or Face ID deletion
- Liveness / anti-spoofing
- Automatic capture, continuous capture, video recording
- base64 encoding, `toDataURL`, object URL preview
- `localStorage`, `sessionStorage`, IndexedDB, Cache API
  persistence of any captured frame
- Direct browser → Face Service calls
- Sending `X-Service-Token` or `FACE_SERVICE_SECRET` from the
  browser
- Sending `userId`, `email`, `sampleIndex`, or `modelIdentity` from
  the browser
- Manual `Content-Type: multipart/form-data`
- Any automatic retry of the POST

Finalization and any related workflow belong to PHASE 4.5B5 / 4.6.

## Phase 4.5B4.3 server-authoritative generation discriminator + legacy migration

PHASE 4.5B4.3 introduces a stable, server-authoritative
**`generationId`** for each `FaceEnrollmentSession` document. It
replaces `expiresAt` as the primary reconciliation discriminator for
multi-tab and reload-resilience paths. The browser continues to
receive `expiresAt` for display ("Session expires at …") but it is
**not** the trigger for the downward-replacement reconciliation
branch.

### Why a server-issued `generationId`?

`expiresAt` is a TTL field that may change on legitimate
non-reset operations (TTL extension). Two reads of the same
`FaceEnrollmentSession` may legitimately observe different
`expiresAt` values without the session having been replaced.
`generationId` is a UUID v4 minted by the server exactly once per
create-or-reset operation, so two reads of the same document
always observe the same `generationId`, and any operation that
replaces the session clears and re-mints it.

### Schema invariant

`generationId` is a non-unique, required `String` (minlength 1).
No global unique index is added — `userId` remains the unique
ownership index. Adding a global unique index would be a global
write bottleneck for an identifier that is only consumed locally
by the browser for reconciliation.

### Legacy session migration strategy

Documents created before PHASE 4.5B4.3 may not have a
`generationId` field. Mongoose does not auto-backfill required
fields on existing documents. The migration is therefore:

- **Lazy / on-demand.** Triggered on the first
  `getEnrollmentSessionByUserId(userId)` call after the schema
  change goes live.
- **Server-side only.** No migration script, no batch update, no
  global scan.
- **Atomic per-document.** Implemented as a single
  `findOneAndUpdate` with the guard
  `{ userId, generationId: { $exists: false } }` and the
  `$set: { generationId: randomUUID() }` payload. MongoDB's
  atomic write semantics guarantee only one concurrent request
  wins the match.
- **No in-memory lock.** The atomic guard is sufficient. The
  service does not rely on any singleton or module-level lock
  to ensure one-`generationId`-per-document.
- **Field-preserving.** The backfill sets only `generationId`.
  `acceptedSamples`, `expiresAt`, `mode`, model metadata, and
  `FaceProfile` are not touched.
- **Idempotent.** Subsequent reads find `generationId` already
  present and return the document unchanged. The second read
  returns the same `generationId` as the first.

### Concurrency contract

Two simultaneous readers of the same legacy session:

| Request | Candidate UUID | Atomic match | Outcome |
| --- | --- | --- | --- |
| A | UUID-A | wins | DB `generationId = UUID-A` |
| B | UUID-B | loses | re-reads, observes `UUID-A` |

Only **one** `generationId` is ever persisted. All readers
observe the same stable value.

### Expired legacy session

The lazy backfill runs lazily but the expired-session check runs
first. An already-expired legacy session is treated as inactive
and is **not** revived merely to attach a `generationId`. The
existing TTL / cleanup behaviour is unchanged.

### Status contract (safe DTO)

For any ACTIVE session returned by the safe status service:

```
generationId: <stable, server-issued, non-empty UUID>
```

For inactive enrollment:

```
generationId: null
```

The status service **never** invents an ephemeral UUID to satisfy
a `generationId ?? randomUUID()` fallback. Identity comes from
the persisted session document (or from the lazy atomic
backfill for legacy sessions). DTO construction must not compute
the ID.

### Browser-side guarantees

- The browser never sends `generationId` to the server in any
  fetch body or header.
- The browser never persists `generationId` to localStorage,
  sessionStorage, IndexedDB, the Cache API, or cookies.
- `expiresAt` is never used as a fallback for `generationId`.
- The same-generation vs new-generation decision uses only
  `generationId`.

### What this phase does NOT change

- `FaceProfile` finalization is unchanged.
- The TTL / expiration semantics are unchanged.
- The unique `userId` ownership invariant is unchanged.
- The session response shape only adds one optional field
  (`generationId`). Existing fields are untouched.

## Secrets

- All secrets live in environment variables. `.env.example` exists at the
  repo root and inside each app; the real `.env*` files are gitignored.
- **Better Auth** uses the official standardized variable names:
  `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`.
- **Google OAuth** uses: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- **MongoDB**: `MONGODB_URI` (server-side only). The application
  database is `face_attendance`.
- **Internal Face Service**: `FACE_SERVICE_SECRET` is shared between the
  web app and the Face Service, sent as `X-Service-Token`. It is never
  bundled to the browser.

### Environment requirements

| Variable | Required | Scope |
| --- | --- | --- |
| `MONGODB_URI` | yes | server |
| `BETTER_AUTH_URL` | yes | server |
| `BETTER_AUTH_SECRET` | yes | server |
| `GOOGLE_CLIENT_ID` | yes | server |
| `GOOGLE_CLIENT_SECRET` | yes | server |
| `NEXT_PUBLIC_APP_URL` | yes | public |
| `FACE_SERVICE_SECRET` | **yes from Phase 3** | server |
| `FACE_SERVICE_URL` | optional (Phase 3+ required) | server |
| `BIOMETRIC_ENCRYPTION_KEY` | optional (Phase 4.1); required from Phase 4.2 | server |

## Face Service authentication (Phase 3 / 4.4A)

- `GET /health` is public — liveness probes do not require credentials.
- All other endpoints (`/v1/*`) require `X-Service-Token:
  ${FACE_SERVICE_SECRET}`.
- When `FACE_SERVICE_SECRET` is not configured on the server, every
  protected request is rejected with `401 FACE_SERVICE_UNAUTHORIZED` so
  the misconfiguration is loud.
- The browser never calls the Face Service directly; only
  `apps/web` (the Next.js server) does.

## Authentication guarantees

### End-user (Better Auth)

- `/login` is public. Authenticated users are redirected based on
  onboarding state: incomplete → `/onboarding`, complete → `/dashboard`.
- `/onboarding`, `/dashboard`, `/profile` all require a valid Better
  Auth session AND, where applicable, a completed `Profile`.
- Sign-out calls Better Auth's official `signOut()`, invalidates the
  server-side session row, and clears the session cookie.

### Server-to-server (web ↔ Face Service)

- All Face Service endpoints except `/health` require the shared
  `FACE_SERVICE_SECRET`. `apps/web` proxies recognition requests to the
  Face Service; the browser holds no credential that could talk to the
  Face Service directly.

## Authorization rules (server-enforced)

| Action | Required |
| --- | --- |
| Create / edit / delete a class | Role = `teacher` AND `teacherId = currentUser._id` |
| Manage class members | Role = `teacher` AND owns the class |
| Start / stop an attendance session | Role = `teacher` AND owns the class |
| Export attendance | Role = `teacher` AND owns the class |
| Join a class | Role = `student` AND not already a member AND correct class password |
| Submit enrollment frames | Authenticated AND `user._id = currentUser._id` |
| Call `POST /api/face-id/enrollment/start` | Authenticated AND completed Profile AND no active `FaceProfile` |
| Call `GET /api/face-id/enrollment/status` | Authenticated AND completed Profile |
| Call Face Service `/v1/faces/*` | `X-Service-Token` matches `FACE_SERVICE_SECRET` |

The frontend may hide buttons for clarity, but it is **not** a security
boundary.

## Transport

- All browser → web traffic is HTTPS in production.
- Web → Face Service traffic is HTTPS in production; loopback is
  acceptable only in development.
- No wildcard CORS. The web origin is explicitly allow-listed on the
  Face Service.

## Validation

- Every web request body is validated with Zod.
- Every Face Service request body is validated with Pydantic.
- File uploads enforce an upper size cap (default 8 MB per frame, 4096 px
  per dimension — see `services/face-service/.env.example`) and an
  explicit MIME allow-list is enforced by content sniffing.
- Embeddings posted from the browser are never trusted as-is. They are
  produced by the Face Service during enrollment.

## Logging hygiene

Log structured fields, not bodies:

- `route`, `method`, `status`, `duration_ms`, `user_id` (Better Auth user
  ID string), `class_id`, `session_id`, `face_count`, `engine`,
  `provider`.

Never log:

- Raw image bytes, base64 frames, embeddings.
- OAuth tokens, Better Auth session tokens.
- Class passwords (plain or hashed).
- `MONGODB_URI`, `BETTER_AUTH_SECRET`, `FACE_SERVICE_SECRET`,
  `GOOGLE_CLIENT_SECRET`.

## Production gate (commercial licensing)

The Face Service uses the InsightFace `buffalo_l` pretrained recognition
model, which is licensed for **non-commercial research use only**.
Commercial deployment requires a separate license from InsightFace —
see `docs/model-license.md`. Do not move the Face Service to a production
attendance workload until the operator has confirmed a commercial model
license and updated the verification log there.

## Future: stronger service-to-service auth

`FACE_SERVICE_SECRET` is the MVP mechanism. The architecture allows
swapping it for mTLS, signed JWTs from the web app's identity provider,
or workload identity (e.g. cloud IAM) without changing route signatures.

## Phase 4.6A1 pure enrollment finalization math

PHASE 4.6A1 ships a **pure-Python math module** inside the Face
Service — `services/face-service/app/engine/enrollment_finalization.py`.
The module turns a batch of *already validated, L2-normalised*
embeddings into an L2-normalised centroid *iff* the batch is
mutually consistent enough to form one enrollment template.

### No HTTP, no persistence, no engine access

The pure math foundation explicitly does NOT:

- call the InsightFace engine
- read environment variables
- write to disk, MongoDB, SQLite, JSON, `.npy`, `.npz`, or `.pkl`
- touch the network
- decode images, handle JPEG bytes, or open raw camera frames
- log embedding values, centroid values, or pairwise vector contents

Configuration is supplied as function arguments by the caller.
`min_self_similarity` is a caller-supplied argument.

### No raw biometric fixtures or persistence

The unit test suite constructs deterministic normalised vectors
synthetically from a seeded numpy generator; no real biometric data is
loaded or referenced.

### Reuse of the PHASE 3 matcher

Pairwise cosine similarity is computed by the existing
`app.engine.matcher.cosine_similarity` helper. This guarantees:

- similarity semantics identical to the existing 1:1 / 1:N code paths
- the same float-drift clamping (`[-1.0, 1.0]`)
- the same shared `INVALID_EMBEDDING` error path for malformed
  inputs

The pure finalization layer wraps the matcher's domain errors into
its own stable codes (`INVALID_EMBEDDING`,
`EMBEDDING_DIMENSION_MISMATCH`, `EMBEDDING_NOT_NORMALIZED`,
`INCONSISTENT_FACE_SAMPLES`, `INVALID_CENTROID`,
`INVALID_SAMPLE_COUNT`) so the future endpoint layer can map them
onto HTTP envelopes without leaking matcher internals.

### What this phase does NOT do

- `FaceProfile` persistence
- Biometric encryption / decryption
- Re-enrollment, deletion, replacement
- Attendance, liveness, anti-spoofing

Those belong to later phases.

## Phase 4.6A2 protected finalization endpoint

PHASE 4.6A2 adds the protected internal HTTP endpoint
`POST /v1/faces/enrollment/finalize` to the Face Service.

### Server-to-server only

The endpoint is designed for **server-to-server communication** between
the trusted Next.js application and the Face Service. It receives
already-decrypted, already-L2-normalised embeddings and returns a
consistency result plus a normalized centroid. The browser must never
call this endpoint directly.

### Architecture boundary

The Face Service remains **stateless** in PHASE 4.6A2. It does NOT:

- read MongoDB (`FaceEnrollmentSession`, `FaceProfile`)
- perform biometric decryption (AES-GCM, `BIOMETRIC_ENCRYPTION_KEY`)
- know about `userId` or Better Auth
- persist the centroid or any other result

The Next.js server (PHASE 4.6B) will be responsible for:
1. Reading encrypted samples from MongoDB.
2. Decrypting them with `BIOMETRIC_ENCRYPTION_KEY`.
3. Sending already-decrypted vectors to this endpoint.

### Authentication

The endpoint is protected by the existing `X-Service-Token` mechanism
(`FACE_SERVICE_SECRET`). `GET /health` remains unchanged and public.

### Privacy guarantees

The endpoint receives biometric vectors, so:

- **Never log:** embeddings, centroid values, request bodies.
- **Safe log fields:** `sample_count`, `pair_count`, `consistent`,
  `model_identity`, domain error code.
- **No persistence:** the Face Service does not write anything to disk,
  MongoDB, or any storage.

### Configuration

`FACE_ENROLLMENT_MIN_SELF_SIMILARITY` (default: `0.7`) controls the
consistency threshold. This is a **DEVELOPMENT BASELINE ONLY** — it
must be re-calibrated against representative evaluation data before
any production deployment.

### What PHASE 4.6A2 does NOT implement

- MongoDB access or `FaceEnrollmentSession` / `FaceProfile` persistence.
- Biometric decryption (AES-GCM, `BIOMETRIC_ENCRYPTION_KEY`).
- Next.js server-side orchestration.
- Face ID enrollment workflow completion (belongs to PHASE 4.6B).

## Phase 4.6B1A Next.js finalization client (server-only)

PHASE 4.6B1A extends the existing server-only Next.js `FaceServiceClient`
(`apps/web/src/lib/biometrics/face-service-client.ts`) with a single
focused function `finalizeFaceEnrollment(...)`. The function is the
server-only Next.js client for the PHASE 4.6A2 endpoint.

### Server-only and biometric-only in memory

The function lives inside `face-service-client.ts`, which opens with
`import "server-only"`. Client Components cannot import it. The
plaintext embeddings and centroid exist only in server memory for
the lifetime of the call.

### No MongoDB / no decryption

PHASE 4.6B1A deliberately does NOT:

- read MongoDB,
- decrypt AES-GCM ciphertext,
- touch `BIOMETRIC_ENCRYPTION_KEY`,
- create, replace, or delete `FaceEnrollmentSession` or `FaceProfile`,
- call any enrollment API route or Server Action,
- expose any biometric payload to the browser.

The function is a thin server-side wrapper around the existing
PHASE 4.4A `faceServiceRequest` HTTP client. MongoDB-backed
orchestration, biometric decryption, and `FaceProfile` persistence
belong to PHASE 4.6B1B.

### Domain error preservation

The upstream domain error codes are preserved verbatim on
`FaceServiceClientError.domainError.code`:

- `INCONSISTENT_FACE_SAMPLES` — the centroid is NEVER exposed on this
  path. The function does NOT map this to `FACE_SERVICE_UNAVAILABLE`.
- `MODEL_MISMATCH`
- `INVALID_SAMPLE_COUNT`
- `INVALID_EMBEDDING`
- `EMBEDDING_DIMENSION_MISMATCH`
- `EMBEDDING_NOT_NORMALIZED`
- `INVALID_CENTROID`

Raw response bodies are never exposed in safe error messages.

### Privacy guarantees

- Plaintext embeddings exist only inside the request body sent to
  the Face Service. They are NOT logged.
- The returned centroid exists only in the typed
  `FinalizeFaceEnrollmentResult` until future Next.js orchestration
  consumes it. It is NOT logged.
- No persistence: nothing is written to disk, MongoDB, `.npy`,
  `.npz`, `.pkl`, JSON dump, or any temp file.
- The Face Service endpoint itself remains the authoritative
  owner of its privacy posture (PHASE 4.6A2 guarantees); the
  client does not weaken it.

### What PHASE 4.6B1A does NOT claim

- Web finalization is NOT yet wired end-to-end. The function is a
  client abstraction only; no Next.js API route, Server Action, or
  UI calls it in PHASE 4.6B1A.
- `FaceProfile` persistence is NOT yet implemented.
- Temporary enrollment sessions are NOT yet finalized or cleaned up.

## Phase 4.6B1B Next.js enrollment finalization orchestration (server-only)

PHASE 4.6B1B adds the first server-only Next.js orchestration that
combines the PHASE 4.5B4.3 enrollment session persistence service,
the PHASE 4.1 AES-GCM decryption utility, and the PHASE 4.6B1A
`finalizeFaceEnrollment` client. The orchestrator lives at
`apps/web/src/lib/biometrics/enrollment-finalization-service.ts` and
is opened with `import "server-only"`.

### Server-only data flow

```
authoritative userId (PHASE 4.6B3 will supply from auth.api.getSession())
    ↓
getEnrollmentSessionByUserId(userId)   ← existing PHASE 4.5B4.3 read service
    ↓
session preconditions (expiration, generationId, mode, sample count, model metadata)
    ↓
AAD reconstruction (PHASE 4.1 fields: userId, modelIdentity, templateVersion, vectorType="sample", sampleIndex)
    ↓
decryptBiometricVector(...) for each sample   ← PHASE 4.1 utility
    ↓
plaintext validation (dimension, finiteness, |v|≈1, tolerance 1e-3)
    ↓
finalizeFaceEnrollment(...)   ← PHASE 4.6B1A client (exactly once)
    ↓
re-read session: existence + expiration + generationId match + completeness
    ↓
return EnrollmentFinalizationResult (centroid + metrics + sourceGenerationId)
```

### Plaintext lifetime

- Plaintext sample embeddings exist only in local server memory for
  the lifetime of the `finalizeEnrollmentSessionForUser` call.
- After the B1A call resolves, the orchestrator best-effort wipes
  the per-sample local buffers (the `decryptedVectors[i]` arrays).
  JavaScript does not guarantee memory zeroization, but this
  best-effort scrub keeps the residual window small.
- Plaintext embeddings never enter:
  - module / global / cache state,
  - React state, cookies, or browser code,
  - logs (no `console.log` of plaintext, centroid, ciphertext, IV,
    authTag, AAD bytes, or full session documents),
  - MongoDB or the filesystem.

### AAD reconstruction

The orchestrator rebuilds the EXACT AAD bytes used by PHASE 4.4C
when the sample was first encrypted. No new AAD fields are
introduced. The fields are:

```
userId                    ← from the function argument (authoritative)
modelIdentity             ← session.modelIdentity
templateVersion           ← session.templateVersion
vectorType                ← constant "sample"
sampleIndex               ← persisted sample.sampleIndex
```

### Session validation

The orchestrator refuses a malformed or expired session, an
unsupported enrollment mode (currently only `create` is supported;
`replace` is rejected with `UNSUPPORTED_ENROLLMENT_MODE`), or
missing authoritative model metadata. It does NOT silently repair
malformed sessions.

### Generation re-check

`sourceGenerationId = session.generationId` is captured BEFORE the
Face Service call. AFTER the call the session is re-read through
the same service. If the generation changed (e.g. another tab
reset the session), the successful centroid is DISCARDED and a
stable `ENROLLMENT_GENERATION_CHANGED` error is thrown. No
persistence happens.

> **PHASE 4.6B2 still requires the atomic CAS.** The B1B recheck
> is a single-document, non-atomic read. PHASE 4.6B2 MUST still
> atomically verify `generationId === sourceGenerationId` when
> persisting the new `FaceProfile` and consuming the temporary
> session. B1B reduces stale-result risk but does NOT close the
> persistence race.

### What PHASE 4.6B1B does NOT do (privacy guarantees)

- No `FaceProfile` write
- No `deleteEnrollmentSessionByUserId` / temporary-session delete
- No `MONGODB_URI` write / transaction
- No Next.js API route, Server Action, or browser fetch
- No UI button / router.refresh
- No plaintext sample embedding returned to any caller
- No logging of plaintext, centroid, ciphertext, IV, authTag, AAD,
  key configuration, or full biometric session documents
- No filesystem write of biometric data (no `.npy`, `.npz`, `.pkl`,
  JSON dumps, etc.)

### What PHASE 4.6B1B does NOT claim

- Enrollment finalization is NOT yet user-accessible. There is NO
  Next.js API, Server Action, or UI for it in PHASE 4.6B1B. The
  orchestrator function exists as a server-internal entry point for
  future phases.
- PHASE 4.6B2 must still perform the atomic generation compare
  before persisting. B1B alone is not sufficient.
- Plaintext sample vectors are wiped best-effort; the orchestrator
  does not claim JavaScript memory zeroization.
