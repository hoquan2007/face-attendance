import { buildEnvSchema } from "@/lib/env-schema";

/**
 * Boot-time environment configuration.
 *
 * PHASE 1: Better Auth + Google OAuth + MongoDB session.
 * All authentication-related variables are now required.
 * Phase 0.6 allowed optional server-side secrets because no auth was implemented.
 *
 * The schema and preprocessing helper live in `./env-schema` so that they
 * can be unit-tested without mutating `process.env`. This module consumes
 * `process.env` and exports a frozen `env` object.
 *
 * NOTE: client-side code must only read `NEXT_PUBLIC_*` variables.
 * All other variables are server-only.
 */
const parsed = buildEnvSchema().safeParse({
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  APP_NAME: process.env.APP_NAME,
  MONGODB_URI: process.env.MONGODB_URI,
  BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  FACE_SERVICE_URL: process.env.FACE_SERVICE_URL,
  FACE_SERVICE_SECRET: process.env.FACE_SERVICE_SECRET,
});

if (!parsed.success) {
  // Fail fast on misconfiguration rather than letting downstream code crash later.
  throw new Error(
    `Invalid environment configuration: ${JSON.stringify(parsed.error.flatten())}`,
  );
}

export const env = parsed.data;
export type Env = typeof env;
