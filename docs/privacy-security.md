# Privacy & Security

> Status: **Phase 4.3** — Face Service operational in local
> development. PHASE 4.1 introduced AES-256-GCM encryption for biometric
> vectors. PHASE 4.2 introduced the Mongoose persistence foundation for
> `face_profiles` and `face_enrollment_sessions`. **PHASE 4.3 adds the
> protected Face Service enrollment-sample endpoint
> (`POST /v1/faces/enrollment/sample`)** — server-to-server only, never
> called from the browser. **No biometric data has been persisted to
> the production database yet** — PHASE 4.3 ships the endpoint and
> quality gate only; the Next.js-side enrollment orchestration
> (sample upload, session finalisation, centroid calculation, re-
> enrollment, delete Face ID) arrives in PHASE 4.4+. The privacy
> posture documented here still applies.

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

Stored fields (PHASE 4.2 — persistence foundation only):

- `userId`, `mode` (`"create"` or `"replace"`), `templateVersion`,
  `requiredSampleCount`
- Optional model metadata (`modelIdentity`, `modelName`,
  `embeddingDimension`, `normalization`) — these fields are absent until
  the first sample is processed in a future phase
- `acceptedSamples[]`: each entry carries an encrypted vector
  (`encryptedVector`), `sampleIndex`, an optional quality block, and
  `acceptedAt`
- `expiresAt`, `createdAt`, `updatedAt`

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
  `undefined`), `deleteEnrollmentSessionByUserId`,
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

## Face Service authentication (Phase 3)

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
