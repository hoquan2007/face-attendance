# Privacy & Security

> Status: **Phase 1** — Better Auth + Google OAuth + MongoDB session. Authentication is enforced server-side. Liveness and face recognition are not yet implemented.

## Biometric handling principles

1. **Store embeddings, not images.** The web database stores normalized numeric vectors returned by the Face Service. Raw camera frames are decoded, processed, and discarded in the same request lifecycle.
2. **No permanent image retention.** Phase 0/1 never write raw frames to disk. Subsequent phases may temporarily buffer a frame for enrollment quality checks but must discard it immediately after embedding.
3. **No logging of biometric data.** Server logs must never include embeddings, raw image bytes, or base64 image data.
4. **No embedding exposure to the browser.** Normal user-facing APIs never return another user's `faceProfile.embeddings`. Only the Face Service and the server-side enrollment path see embeddings.
5. **Owner-only modification.** A user may only modify their own `faceProfile`. Teacher endpoints cannot write student embeddings.

## Phase 2 identity vs business data

Better Auth owns the `user`, `session`, `account`, `verification` collections. The application owns the `profiles` collection. The application **must not** write to Better Auth's collections directly. Better Auth continues to use its official MongoDB adapter; the application uses Mongoose via a separate cached `mongoose.connect()` connection against the same `face_attendance` database.

The `Profile.userId` field references the Better Auth `user._id` conceptually (as a string). The application does not enforce a cross-collection foreign key at the database level because Better Auth owns its own user collection.

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
- `teacher` self-selection is allowed for the MVP. **This is a known security limitation.** A future production deployment must add a teacher-invite flow, an administrator approval flow, or a verification step. Phase 2 documents this gap but does not implement the verification flow.

## Phase 2 stored profile fields (privacy posture)

The application stores only what Phase 2 actually needs:

- `fullName`
- `identificationCode` (treated as a generic business identifier)
- `phone` (optional)
- `role`
- `emailSnapshot` (captured from Better Auth session, never from request body)
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

- All secrets live in environment variables. `.env.example` exists at the repo root and inside each app; the real `.env*` files are gitignored.
- **Better Auth** uses the official standardized variable names: `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`.
- **Google OAuth** uses: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`.
- **MongoDB**: `MONGODB_URI` (server-side only). The application database is `face_attendance`.
- **Internal Face Service**: `FACE_SERVICE_SECRET` is shared between the web app and the Face Service, sent as `X-Service-Token`. It is never bundled to the browser.

### Phase 1 environment requirements

| Variable | Required | Scope |
| --- | --- | --- |
| `MONGODB_URI` | yes | server |
| `BETTER_AUTH_URL` | yes | server |
| `BETTER_AUTH_SECRET` | yes | server |
| `GOOGLE_CLIENT_ID` | yes | server |
| `GOOGLE_CLIENT_SECRET` | yes | server |
| `NEXT_PUBLIC_APP_URL` | yes | public |
| `FACE_SERVICE_SECRET` | optional (Phase 3+ required) | server |
| `FACE_SERVICE_URL` | optional (Phase 3+ required) | server |

## Phase 2 authentication guarantees

- `/login` is public. Authenticated users are redirected based on onboarding state: incomplete → `/onboarding`, complete → `/dashboard`.
- `/onboarding` requires a valid Better Auth session. Returning users with completed profiles are redirected to `/dashboard`. Unauthenticated users are redirected to `/login`.
- `/dashboard` requires a valid Better Auth session AND a completed Profile. Unauthenticated users are redirected to `/login`. Authenticated users without a completed Profile are redirected to `/onboarding`.
- `/profile` requires a valid Better Auth session AND a completed Profile.
- `/` (root) renders the landing page when not authenticated, and redirects authenticated users through the same onboarding gate.
- The browser `proxy.ts` adds a UX-level pass-through but is never the sole security boundary. All redirects are computed server-side by `route-guards.ts` after consulting `auth.api.getSession()` and the application `profiles` collection.
- Sign-out calls Better Auth's official `signOut()`, invalidates the server-side session row, and clears the session cookie.

## Phase 1 authentication guarantees

- `/login` is public.
- `/dashboard` requires a valid Better Auth session. Server Components call `auth.api.getSession()` and redirect to `/login` if the session is missing. The browser `proxy.ts` adds a UX-level cookie check but is never the sole security boundary.
- Authenticated users visiting `/login` are redirected to `/dashboard`.
- Sign-out calls Better Auth's official `signOut()`, invalidates the server-side session row, and clears the session cookie.

## Authorization rules (server-enforced)

| Action | Required |
| --- | --- |
| Create / edit / delete a class | Role = `teacher` AND `teacherId = currentUser._id` |
| Manage class members | Role = `teacher` AND owns the class |
| Start / stop an attendance session | Role = `teacher` AND owns the class |
| Export attendance | Role = `teacher` AND owns the class |
| Join a class | Role = `student` AND not already a member AND correct class password |
| Submit enrollment frames | Authenticated AND `user._id = currentUser._id` |

The frontend may hide buttons for clarity, but it is **not** a security boundary.

## Transport

- All browser → web traffic is HTTPS in production.
- Web → Face Service traffic is HTTPS in production; loopback is acceptable only in development.
- No wildcard CORS. The web origin is explicitly allow-listed on the Face Service.

## Validation

- Every web request body is validated with Zod.
- Every Face Service request body is validated with Pydantic.
- File uploads enforce an upper size cap (planned: 1 MB per frame) and an explicit MIME allow-list (`image/jpeg`).
- Embeddings posted from the browser are never trusted as-is. They are produced by the Face Service during enrollment.

## Logging hygiene

Log structured fields, not bodies:

- `route`, `method`, `status`, `duration_ms`, `user_id` (Better Auth user ID string), `class_id`, `session_id`, `face_count`, `engine`, `provider`.

Never log:

- Raw image bytes, base64 frames, embeddings.
- OAuth tokens, Better Auth session tokens.
- Class passwords (plain or hashed).
- `MONGODB_URI`, `BETTER_AUTH_SECRET`, `FACE_SERVICE_SECRET`, `GOOGLE_CLIENT_SECRET`.

## Future: stronger service-to-service auth

`FACE_SERVICE_SECRET` is the MVP mechanism. The architecture allows swapping it for mTLS, signed JWTs from the web app's identity provider, or workload identity (e.g. cloud IAM) without changing route signatures.