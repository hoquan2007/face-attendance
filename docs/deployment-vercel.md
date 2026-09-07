# Vercel Deployment Guide

> Status: **Phase 0.6** — Vercel deployment readiness. Authentication (Better Auth + Google OAuth) and MongoDB connectivity will be configured in Phase 1.

## Overview

This document describes how to import the Face Attendance System into Vercel for the first skeleton deployment.

**Important:** The first deployment does NOT require real OAuth credentials or a database connection. The web application will start and display the placeholder homepage.

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

**For the first skeleton deployment, no environment variables are required.**

The application will start without `MONGODB_URI`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BETTER_AUTH_SECRET`, `FACE_SERVICE_URL`, or `FACE_SERVICE_SECRET`.

All authentication and database environment variables are optional at this stage because:

- The homepage is a static placeholder.
- No routes require authentication yet.
- No routes connect to MongoDB yet.

If you add environment variables now, the values will be available for Phase 1.

### Step 4: Deploy

Click **Deploy**. Vercel will:

1. Clone the repository.
2. Set the Root Directory to `apps/web`.
3. Run `pnpm install`.
4. Build with `pnpm build`.
5. Deploy to a preview URL (e.g., `https://face-attendance-xxxx.vercel.app`).

---

## Verifying the Deployment

After deployment, visit:

- **Homepage:** `https://<your-project>.vercel.app` — should display the placeholder homepage.
- **Health Endpoint:** `https://<your-project>.vercel.app/api/health` — should return `{ "status": "ok", "service": "web" }`.

---

## What Happens AFTER the First Deployment

### Step 1: Obtain the Stable Vercel Production Domain

After the first deployment, Vercel assigns a production domain. Note this domain for the next steps.

Example: `https://face-attendance.vercel.app`

### Step 2: Configure Google OAuth Production Origin

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Select your project.
3. Navigate to **APIs & Services** → **Credentials**.
4. Edit your OAuth 2.0 Client ID.
5. Add your Vercel production domain to **Authorized JavaScript origins**:

   ```
   https://face-attendance.vercel.app
   ```

6. Add the callback URL to **Authorized redirect URIs**:

   ```
   https://face-attendance.vercel.app/api/auth/callback/google
   ```

7. Click **Save**.

### Step 3: Configure Vercel Environment Variables

In the Vercel dashboard for your project:

1. Go to **Settings** → **Environment Variables**.
2. Add the following variables:

| Name | Value | Environment |
|---|---|---|
| `NEXT_PUBLIC_APP_URL` | `https://face-attendance.vercel.app` | Production, Preview, Development |
| `BETTER_AUTH_URL` | `https://face-attendance.vercel.app` | Production, Preview, Development |
| `BETTER_AUTH_SECRET` | Generate with `openssl rand -base64 32` | Production |
| `GOOGLE_CLIENT_ID` | Your Google OAuth Client ID | Production |
| `GOOGLE_CLIENT_SECRET` | Your Google OAuth Client Secret | Production |

3. Click **Save**.

### Step 4: Configure MongoDB Network Access

If using MongoDB Atlas:

1. Go to your MongoDB Atlas cluster.
2. Navigate to **Network Access**.
3. Add a new entry for Vercel's IP ranges, or use `0.0.0.0/0` (Atlas allows this for serverless instances).
4. Ensure your `MONGODB_URI` in Vercel includes the correct cluster endpoint.

### Step 5: Implement Phase 1

Once you have:
- A stable Vercel production domain.
- Google OAuth configured with the production origin and redirect URI.
- Vercel environment variables set.
- MongoDB network access configured.

Then implement **Phase 1: Better Auth + Google OAuth**.

### Step 6: Test Production Login

1. Push your Phase 1 changes to `main`.
2. Vercel will automatically redeploy.
3. Visit the production URL and verify:
   - Google login works.
   - The session persists across requests.
   - No errors in the Vercel function logs.

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

## What is NOT Deployed Yet

The following are NOT deployed in Phase 0.6:

- **Authentication** — Better Auth + Google OAuth (Phase 1)
- **MongoDB** — Database models and connectivity (Phase 1)
- **Face Service** — FastAPI + InsightFace (Phase 3)
- **Frontend Design System** — Professional UI/UX (separate phase)

---

## Face Service Note

The FastAPI Face Service (`services/face-service`) is **NOT** deployed to Vercel.

- It runs separately as a Python service.
- It is not bundled with the Next.js application.
- The `FACE_SERVICE_URL` and `FACE_SERVICE_SECRET` variables are for the production Face Service endpoint, not for Vercel.

Do NOT set `FACE_SERVICE_URL` to a localhost address in production. Localhost on a Vercel server does NOT refer to your development machine.

---

## Troubleshooting

### Build Fails

1. Check that the Root Directory is set to `apps/web`.
2. Verify `package.json` scripts: `build`, `start`, `dev` are present.
3. Check the Vercel build logs for specific errors.

### Environment Variables Not Available

1. Verify environment variables are set in Vercel dashboard.
2. Ensure the variable names match exactly (case-sensitive).
3. Check that the variable scope (Production/Preview/Development) is appropriate.

### Health Endpoint Returns 404

1. Verify the route file exists at `apps/web/src/app/api/health/route.ts`.
2. Ensure the build completed successfully.

---

## Documentation References

- [Architecture](architecture.md) — High-level system design
- [Privacy & Security](privacy-security.md) — Security principles and secrets management
- [Database](database.md) — Planned MongoDB collections
- [API](api.md) — HTTP API surface
