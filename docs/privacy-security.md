# Privacy & Security

> Status: **Phase 3** — Face Service operational in local development. No
> biometric data has been persisted to the production database yet; PHASE 4
> will introduce enrollment. The privacy posture documented here still
> applies.

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
