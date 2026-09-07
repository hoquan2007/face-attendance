# Vercel Deployment Guide

> Status: **Phase 1** — Better Auth + Google OAuth + MongoDB session. The web app deploys to Vercel and exposes `/api/auth/*`, `/login`, and `/dashboard` against the production domain.

## Overview

This document describes how to deploy the Face Attendance System to Vercel for the **Phase 1** production environment.

**Important:** The deployment requires real OAuth credentials and a real MongoDB connection. Authentication fails fast if any required variable is missing.

Production domain (Phase 1):

```
https://face-attendance-web-pearl.vercel.app
```

---

## Vercel Import Settings

### Step 1: Connect GitHub Repository

1. Go to [vercel.com](https://vercel.com) and sign in.
2. Click **Add New...** → **Project**.
3. Select **Import Git Repository**.
4. Find and select your `face-attendance` repository.

### Step 2: Configure Project

| Setting | Value |
|---|---|
| **Framework Preset** | `Next.js` |
| **Root Directory** | `apps/web` |
| **Build Command** | `pnpm build` (auto-detected) |
| **Output Directory** | `.next` (auto-detected) |
| **Install Command** | `pnpm install` (auto-detected) |

> **Note:** The repository uses a pnpm monorepo. Vercel will install dependencies from the `apps/web` subdirectory when the Root Directory is set to `apps/web`.

### Step 3: Environment Variables

In the Vercel dashboard for your project:

1. Go to **Settings** → **Environment Variables**.
2. Add the following variables (Production scope at minimum; Preview / Development optional):

| Name | Value | Environment |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://face-attendance-web-pearl.vercel.app` | Production |
| `BETTER_AUTH_URL` | `https://face-attendance-web-pearl.vercel.app` | Production |
| `BETTER_AUTH_SECRET` | Generate with `openssl rand -base64 32` | Production |
| `MONGODB_URI` | MongoDB Atlas connection string (`mongodb+srv://...`) | Production |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID | Production |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret | Production |
| `FACE_SERVICE_URL` | (Phase 3+) Face Service endpoint | optional in Phase 1 |
| `FACE_SERVICE_SECRET` | (Phase 3+) Face Service shared secret | optional in Phase 1 |

3. Click **Save**.

### Step 4: Configure Google OAuth Production Origin

In the [Google Cloud Console](https://console.cloud.google.com/):

1. Select your project.
2. Navigate to **APIs & Services** → **Credentials**.
3. Edit your OAuth 2.0 Client ID.
4. Add your Vercel production domain to **Authorized JavaScript origins**:

   ```
   https://face-attendance-web-pearl.vercel.app
   ```

5. Add the callback URL to **Authorized redirect URIs**:

   ```
   https://face-attendance-web-pearl.vercel.app/api/auth/callback/google
   ```

6. Click **Save**.

### Step 5: Configure MongoDB Network Access

In MongoDB Atlas:

1. Navigate to **Network Access**.
2. Add an entry for Vercel's IP ranges or use `0.0.0.0/0` for serverless access.
3. Confirm that your application user has `readWrite` permissions on the `face_attendance` database.

### Step 6: Deploy

Click **Deploy**. Vercel will:

1. Clone the repository.
2. Set the Root Directory to `apps/web`.
3. Run `pnpm install`.
4. Build with `pnpm build` (which also runs typecheck).
5. Deploy to the production domain.

---

## Verifying the Deployment

After deployment, visit:

- **Homepage:** `https://face-attendance-web-pearl.vercel.app` — landing page with a "Sign in" link.
- **Login:** `https://face-attendance-web-pearl.vercel.app/login` — Continue with Google button.
- **Health Endpoint:** `https://face-attendance-web-pearl.vercel.app/api/health` — should return `{ "status": "ok", "service": "web" }`.
- **Better Auth session probe:** `https://face-attendance-web-pearl.vercel.app/api/auth/session` — returns `{ user: null, session: null }` for anonymous requests.

To verify the full flow:

1. Open `/login`.
2. Click **Continue with Google**.
3. Complete the Google OAuth consent screen.
4. Confirm redirect to `/dashboard` and that the user's name, email, and avatar render.
5. Open MongoDB Atlas → `face_attendance` → Browse Collections and confirm Better Auth documents exist.

---

## Node.js Runtime

The project targets **Node.js 24.x** for Vercel deployment.

This is specified in:

- `package.json` (root): `"engines": { "node": "^24.0.0" }`
- `apps/web/package.json`: `"engines": { "node": "^24.0.0" }`
- `.nvmrc`: `24`

Vercel automatically uses the Node.js version specified in `engines` when available.

---

## pnpm Monorepo

The repository uses pnpm workspaces:

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
```

When Vercel sets the Root Directory to `apps/web`, it will:

1. Run `pnpm install` from the repository root.
2. Detect the `apps/web` workspace.
3. Install dependencies for `@face-attendance/web`.

No additional monorepo tooling (Turborepo, Nx) is required for this deployment.

---

## Production troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `redirect_uri_mismatch` from Google | Production callback URL not registered | Add `https://face-attendance-web-pearl.vercel.app/api/auth/callback/google` to Authorized redirect URIs. |
| `invalid_client` from Google | Wrong client ID / secret in Vercel | Re-set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and redeploy. |
| Better Auth startup crash | `MONGODB_URI` missing or wrong | Re-set `MONGODB_URI`; confirm the application user has `readWrite` on `face_attendance`. |
| `trusted origin` / base URL error | `BETTER_AUTH_URL` not aligned with the actual request origin | Set `BETTER_AUTH_URL` to `https://face-attendance-web-pearl.vercel.app` for Production. |
| Missing env vars at boot | One of `MONGODB_URI` / `BETTER_AUTH_URL` / `BETTER_AUTH_SECRET` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` is empty | All five are required for Phase 1; the boot-time schema fails fast. |

---

## Face Service Note

The FastAPI Face Service (`services/face-service`) is **NOT** deployed to Vercel.

- It runs separately as a Python service.
- It is not bundled with the Next.js application.
- `FACE_SERVICE_URL` and `FACE_SERVICE_SECRET` are unused in Phase 1.

Do NOT set `FACE_SERVICE_URL` to a localhost address in production. Localhost on a Vercel server does NOT refer to your development machine.

---

## Documentation References

- [Architecture](architecture.md) — High-level system design
- [Privacy & Security](privacy-security.md) — Security principles and secrets management
- [Database](database.md) — Better Auth + future business collections
- [API](api.md) — HTTP API surface
