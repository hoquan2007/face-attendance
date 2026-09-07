# Architecture

> Status: **Phase 1** — Better Auth + Google OAuth + MongoDB session. Authentication is live. Business data and face recognition are not yet implemented.

## Goals

1. Keep facial recognition fully isolated from the web application.
2. Allow the recognition engine to be swapped without rewriting callers.
3. Avoid false-positive attendance: when uncertain, return `UNKNOWN`.
4. Minimize stored biometric data — embeddings only, never raw frames.
5. Phase-by-phase delivery: no premature InsightFace or MongoDB business code in early phases.

## High-level components

```mermaid
flowchart LR
    Browser["Browser\n(classroom device / phone)"] -->|"HTTPS"| Web["apps/web\nNext.js 16 + Better Auth"]
    Web -->|"MongoDB driver"| Mongo["MongoDB Atlas\n(face_attendance database)"]
    Web -->|"internal HTTPS\nX-Service-Token"| Face["services/face-service\nFastAPI + InsightFace"]
    Face -->|"ONNX Runtime\nCPU or CUDA"| Engine["FaceEngine\n(detect / embed / match)"]
    Web -->|"Google OAuth"| Google["Google\nOpenID Connect"]
```

- **Browser** opens the camera locally for the teacher; only sampled JPEG frames are sent to the Face Service.
- **`apps/web`** owns authentication (Better Auth + Google OAuth), and will later own RBAC, classes, attendance sessions, history, Excel export.
- **`services/face-service`** owns *all* face-related computation. It is the only component that imports InsightFace / ONNX Runtime.
- **MongoDB Atlas** stores Better Auth collections (`user`, `session`, `account`, `verification`) in the `face_attendance` database. Future business collections (`profiles`, `classrooms`, `class_memberships`, `attendance_sessions`, `attendance_records`, `face_profiles`) will be added in later phases via Mongoose.
- **Google** is identity-only — only `sub`, `email`, `name`, `picture` are requested via the `openid email profile` scopes.

## FaceEngine abstraction

Defined in [`services/face-service/app/engine/base.py`](../services/face-service/app/engine/base.py) as a `Protocol` with three responsibilities:

- `detect_faces(image)` — return bounding boxes + confidence for every face in the frame.
- `extract_embeddings(image, bboxes)` — return a normalized embedding per detected face.
- `recognize_faces(image, candidate_index)` — return per-face `{ bbox, candidate_id | null, similarity, status }`.

The web app and the rest of the Face Service depend on this `Protocol`, not on InsightFace. Phase 3 plugs in `InsightFaceEngine` as the first implementation; future engines (e.g. a different backbone) can be added without touching call sites.

## Authentication and authorization

### End users (Google OAuth via Better Auth)

- Users sign in at `/login` by clicking **Continue with Google**.
- Better Auth handles the OAuth dance via the official `@better-auth/mongo-adapter` package using the MongoDB Node driver. Sessions and account links are stored in MongoDB Atlas under the `face_attendance` database.
- The web server exposes Better Auth through `/api/auth/[...all]` using the standard Next.js App Router integration (`toNextJsHandler`).
- The browser uses `authClient` from `better-auth/react` to trigger sign-in and sign-out.
- The server-side `auth.api.getSession()` call is the source of truth for every protected resource. Client-provided user IDs and emails are never trusted.

### Server-to-server (web ↔ Face Service)

- The web app and the Face Service share `FACE_SERVICE_SECRET`, sent as `X-Service-Token`. This is the MVP mechanism and is intended to be replaced later by a stronger identity (mTLS / signed JWT / workload identity).
- All authorization decisions (role checks, ownership checks, membership checks) are made server-side. UI-only hiding is **not** a security boundary.

## Authentication flow (Phase 1)

```mermaid
sequenceDiagram
    participant U as User (browser)
    participant W as apps/web
    participant G as Google
    participant DB as MongoDB Atlas

    U->>W: GET /login
    W-->>U: Render "Continue with Google"
    U->>W: Click sign-in (authClient.signIn.social)
    W->>G: Redirect to Google OAuth consent screen
    G-->>U: User grants consent
    G->>W: Callback to /api/auth/callback/google
    W->>DB: Better Auth persists user + account + session
    DB-->>W: Confirmation
    W->>W: Issue session cookie
    W-->>U: Redirect to /dashboard

    U->>W: GET /dashboard
    W->>W: getSession() validates session cookie
    W->>DB: Look up user via Better Auth
    W-->>U: Render dashboard with Google profile
```

## Data flow: an attendance session (target behaviour)

```mermaid
sequenceDiagram
    participant T as Teacher (browser)
    participant W as apps/web
    participant FS as face-service
    participant DB as MongoDB

    T->>W: Start attendance session
    W->>DB: Create AttendanceSession(status=active)
    W->>DB: Load ClassMembership + User.faceProfile.embeddings
    W->>FS: Build recognition index (candidate embeddings)
    loop every N ms (configurable, 2-5 fps target)
        T->>W: JPEG frame (multipart)
        W->>FS: POST /v1/recognize (X-Service-Token)
        FS-->>W: faces[] with bbox + candidate or UNKNOWN
        W->>W: Temporal confirmation (N consecutive frames)
        W->>DB: Insert AttendanceRecord (unique sessionId+userId)
    end
    T->>W: Stop session
    W->>DB: Set status=ended, endedAt
```

## Directory layout

```
face-attendance/
├── apps/
│   └── web/                 # Next.js 16 App Router
│       └── src/
│           ├── lib/
│           │   ├── auth.ts               # Better Auth server config (Phase 1)
│           │   ├── auth-client.ts        # Better Auth browser client (Phase 1)
│           │   ├── env.ts / env-schema.ts
│           │   ├── mongodb.ts            # Cached MongoClient for the adapter
│           │   ├── session.ts            # Server-side session helpers
│           │   └── route-guards.ts       # Pure redirect decision logic
│           ├── components/
│           │   ├── AppShell.tsx
│           │   ├── GoogleSignInButton.tsx
│           │   └── SignOutButton.tsx
│           ├── app/
│           │   ├── api/auth/[...all]/    # Better Auth catch-all route
│           │   ├── login/page.tsx        # /login
│           │   └── dashboard/page.tsx    # /dashboard (protected)
│           └── proxy.ts                  # Next.js proxy / middleware (UX layer only)
├── services/
│   └── face-service/        # FastAPI
├── docs/                    # This folder
├── package.json             # pnpm workspaces root
└── pnpm-workspace.yaml
```

## Phase plan

| Phase | Goal |
| --- | --- |
| 0 | Repo skeleton, docs, buildable foundations. |
| 0.5 | Dependency modernization. |
| 0.6 | Vercel deployment readiness. |
| **1** | **Better Auth + Google OAuth + MongoDB session (we are here).** |
| 2 | Profile onboarding (`/onboarding`). |
| 3 | FastAPI + InsightFace Face Service, model init, `/v1/recognize`. |
| 4 | Face enrollment (`/face-enrollment`). |
| 5 | Classroom creation and join-by-code+password. |
| 6 | Attendance session lifecycle. |
| 7 | Multi-face recognition + temporal confirmation. |
| 8 | Attendance history + Excel export. |
| 9 | Anti-spoofing / liveness (pluggable `LivenessProvider`). |
| 10 | Testing, calibration, deployment hardening. |

## Non-goals (for now)

- Employee / organization module. The recognition core uses generic user IDs so a future employee module can be added without touching `FaceEngine`.
- Mobile native apps. The web app must work in modern mobile browsers, but there is no React Native target in this MVP.
- Paid SaaS dependencies.
- Liveness / anti-spoofing. Phase 1 does not perform any face recognition.
