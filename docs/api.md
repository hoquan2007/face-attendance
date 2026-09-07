# API

> Status: **Phase 1** — Better Auth catch-all route + protected `/dashboard` page. Face Service endpoints and business API endpoints land in later phases.

All endpoints are JSON unless stated otherwise. The web app and the Face Service have separate base URLs and separate authentication mechanisms.

## Conventions

- Error responses use a consistent shape (finalised in Phase 6+):

  ```json
  { "error": { "code": "STRING_CODE", "message": "Human readable." } }
  ```

  Initial error codes include: `UNAUTHENTICATED`, `FORBIDDEN`, `CLASS_NOT_FOUND`, `INVALID_CLASS_PASSWORD`, `ALREADY_MEMBER`, `FACE_NOT_FOUND`, `MULTIPLE_FACES`, `FACE_QUALITY_TOO_LOW`, `FACE_NOT_ENROLLED`, `SESSION_NOT_ACTIVE`, `UNKNOWN_FACE`, `FACE_SERVICE_UNAVAILABLE`.

- All request bodies are validated with Zod on the web side and Pydantic on the Python side.
- Server-side authorization is mandatory — never trust a client-supplied user id.

## `apps/web` (Next.js route handlers)

Base URL: `${NEXT_PUBLIC_APP_URL}`

| Prefix | Purpose | Phase |
| --- | --- | --- |
| `/api/auth/[...all]` | Better Auth catch-all (Google OAuth handlers). | **1** |
| `/api/me` | Current session user. | **1** |
| `/api/health` | Health probe (returns `{ status: "ok", service: "web" }`). | 0 |
| `/api/profile` | Update `profile.*`. | 2 |
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

## Page routes (Phase 1)

| Path | Auth requirement | Behaviour |
| --- | --- | --- |
| `/` | Public | Landing page with link to `/login`. |
| `/login` | Public | Continue with Google button. Authenticated users are redirected to `/dashboard`. |
| `/dashboard` | Required (server-side `getSession()`) | Displays Google profile data and a sign-out button. Unauthenticated users are redirected to `/login`. |

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