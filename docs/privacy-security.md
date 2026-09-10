# Privacy & Security

> Status: **Phase 4.2** — Face Service operational in local
> development. PHASE 4.1 introduced AES-256-GCM encryption for biometric
> vectors. PHASE 4.2 introduced the Mongoose persistence foundation for
> `face_profiles` and `face_enrollment_sessions`. **No biometric data has
> been persisted to the production database yet** — PHASE 4.2 ships the
> model, indexes, service layer, and tests only; the enrollment UI,
> Face Service integration, embedding extraction, quality gate, sample
> upload, centroid calculation, and finalization arrive in PHASE 4.3+.
> The privacy posture documented here still applies.

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
