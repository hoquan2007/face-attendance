# API

> Status: **Phase 2** — Better Auth catch-all route + protected `/login`, `/onboarding`, `/dashboard`, `/profile` pages. Server Actions handle onboarding and profile-edit mutations. Face Service endpoints and business API endpoints land in later phases.

All endpoints are JSON unless stated otherwise. The web app and the Face Service have separate base URLs and separate authentication mechanisms.

## Conventions

- Error responses use a consistent shape (finalised in Phase 6+):

  ```json
  { "error": { "code": "STRING_CODE", "message": "Human readable." } }
  ```

  Initial error codes include: `UNAUTHENTICATED`, `FORBIDDEN`, `INVALID_PROFILE_DATA`, `IDENTIFICATION_CODE_TAKEN`, `PROFILE_NOT_FOUND`, `PROFILE_ALREADY_EXISTS`, `CLASS_NOT_FOUND`, `INVALID_CLASS_PASSWORD`, `ALREADY_MEMBER`, `FACE_NOT_FOUND`, `MULTIPLE_FACES`, `FACE_QUALITY_TOO_LOW`, `FACE_NOT_ENROLLED`, `SESSION_NOT_ACTIVE`, `UNKNOWN_FACE`, `FACE_SERVICE_UNAVAILABLE`.

  Phase 2 surface these via the Server Action `ActionResult.error.code` field; the stable codes used today are `UNAUTHENTICATED`, `INVALID_PROFILE_DATA`, `IDENTIFICATION_CODE_TAKEN`, `PROFILE_NOT_FOUND`, `UNKNOWN_ERROR`.

- All request bodies are validated with Zod on the web side and Pydantic on the Python side.
- Server-side authorization is mandatory — never trust a client-supplied user id.

## `apps/web` (Next.js route handlers)

Base URL: `${NEXT_PUBLIC_APP_URL}`

| Prefix | Purpose | Phase |
| --- | --- | --- |
| `/api/auth/[...all]` | Better Auth catch-all (Google OAuth handlers). | **1** |
| `/api/me` | Current session user. | **1** |
| `/api/health` | Health probe (returns `{ status: "ok", service: "web" }`). | 0 |
| `/api/profile` | Update `profile.*`. (Phase 2 uses Server Actions instead — see Server Actions below.) | 2 |
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

Browser code uses `authClient.signIn.social({ provider: "google" })` from `better-auth/react` rather than calling these routes directly.

## Phase 2 Server Actions

Phase 2 uses Server Actions (not HTTP route handlers) for profile mutations. They live in `apps/web/src/lib/profile-actions.ts` and are invoked from the multi-step onboarding form and the profile edit form.

| Action | Purpose | Identity source |
| --- | --- | --- |
| `submitOnboarding(prev, FormData)` | Upsert the current user's `Profile`, set `onboardingCompleted: true`, redirect to `/dashboard`. | `getSession()` → `session.user.id`, `session.user.email` |
| `submitProfileUpdate(prev, FormData)` | Update the current user's `fullName` / `identificationCode` / `phone`. | `getSession()` → `session.user.id` |

Both actions validate form input with Zod, derive identity from the Better Auth session (never from the form body), map MongoDB duplicate-key errors to safe user-facing `ProfileError` instances, and revalidate the dashboard / profile pages on success.

There is no `/api/profile` HTTP endpoint in Phase 2 — the only mutating API is the Server Action. There is no public lookup endpoint for arbitrary profiles.

### Action result shape

Both actions return a serializable object the client form can render:

```ts
type ActionResult =
  | { ok: true }
  | { ok: false; error: { code: string; message: string; fieldErrors?: Record<string, string[] | undefined> } };
```

Stable error codes include: `UNAUTHENTICATED`, `INVALID_PROFILE_DATA`, `IDENTIFICATION_CODE_TAKEN`, `PROFILE_NOT_FOUND`, `UNKNOWN_ERROR`. MongoDB internals (stack traces, connection strings, the `11000` code) are never returned to the client.

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

Authentication: `X-Service-Token: ${FACE_SERVICE_SECRET}` on every request except `/health`.

| Endpoint | Method | Purpose | Phase |
| --- | --- | --- | --- |
| `/health` | GET | Liveness, reports current engine and provider. | 0 |
| `/v1/recognize` | POST | Detect + embed + match against provided candidate index. | 3, 7 |
| `/v1/enroll` | POST | Validate enrollment frame (single high-quality face). | 4 |
| `/v1/index/build` | POST | Build a normalized candidate matrix from embeddings. | 7 |

### `/v1/recognize` response shape (target)

```json
{
  "faces": [
    {
      "bbox": [x, y, w, h],
      "candidateId": "65f...",
      "similarity": 0.91,
      "status": "candidate"
    },
    {
      "bbox": [x, y, w, h],
      "candidateId": null,
      "similarity": 0.51,
      "status": "unknown"
    }
  ],
  "engine": "insightface:buffalo_l",
  "provider": "cpu"
}
```

`status` is one of `candidate` (above threshold), `low_quality` (frame rejected), or `unknown` (below threshold). The threshold is per-session and lives in `attendance_sessions.recognitionSettings.threshold`.

## Camera transport (future)

- The browser samples the local `MediaStream` at a configurable rate (target 2–5 fps).
- Each sampled frame is resized, JPEG-encoded, sent as `multipart/form-data` `file=@frame.jpg`.
- Base64 image transport is avoided unless technically required.
- No video streaming.