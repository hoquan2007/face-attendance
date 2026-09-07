import { z } from "zod";

/**
 * Preprocessing helper: treats empty / whitespace-only strings as
 * "missing" (`undefined`) so that downstream Zod schemas can fall back to
 * defaults or to `.optional()` semantics.
 *
 * Why this exists: some deployment providers (notably Vercel) expose an
 * unset environment variable as an empty string `""` rather than
 * `undefined`. Zod's `.optional()` accepts `undefined` but NOT `""`, so
 * raw `process.env.X` would fail `z.string().url()` validation during the
 * Next.js page-data collection step of the build.
 */
export const emptyStringToUndefined = (value: unknown): unknown => {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return value;
};

const optionalString = z.preprocess(
  emptyStringToUndefined,
  z.string().optional(),
);

const optionalUrl = z.preprocess(
  emptyStringToUndefined,
  z.string().url().optional(),
);

/**
 * Builds the boot-time environment schema.
 *
 * Exported as a factory so tests can drive it with arbitrary inputs
 * without touching `process.env`. The real `env.ts` module consumes
 * `process.env` and exports a frozen `env` object.
 *
 * Phase 0.6: all optional server-side secrets stay optional because the
 * corresponding integrations are not implemented yet.
 *
 * Phase 1: authentication-required variables (Better Auth, Google OAuth,
 * MongoDB) are validated as non-empty strings when BETTER_AUTH_SECRET is
 * present, indicating auth is expected to be configured.
 */
export const buildEnvSchema = () =>
  z.object({
    // Accept any non-empty string for NODE_ENV so tests work too.
    // Real environments are still constrained via the consuming app code.
    NODE_ENV: z.string().optional().default("development"),

    // Public
    NEXT_PUBLIC_APP_URL: z.preprocess(
      emptyStringToUndefined,
      z.string().url().default("http://localhost:3000"),
    ),
    APP_NAME: z.preprocess(
      emptyStringToUndefined,
      z.string().default("Face Attendance System"),
    ),

    // MongoDB — required for Phase 1 authentication
    MONGODB_URI: z.preprocess(
      emptyStringToUndefined,
      z.string().min(1, "MONGODB_URI is required for Phase 1 authentication"),
    ),

    // Better Auth (official env var names) — required for Phase 1
    BETTER_AUTH_URL: z.preprocess(
      emptyStringToUndefined,
      z.string().url().min(1, "BETTER_AUTH_URL is required for Phase 1 authentication"),
    ),
    BETTER_AUTH_SECRET: z.preprocess(
      emptyStringToUndefined,
      z.string().min(1, "BETTER_AUTH_SECRET is required for Phase 1 authentication"),
    ),

    // Google OAuth — required for Phase 1
    GOOGLE_CLIENT_ID: z.preprocess(
      emptyStringToUndefined,
      z.string().min(1, "GOOGLE_CLIENT_ID is required for Phase 1 authentication"),
    ),
    GOOGLE_CLIENT_SECRET: z.preprocess(
      emptyStringToUndefined,
      z.string().min(1, "GOOGLE_CLIENT_SECRET is required for Phase 1 authentication"),
    ),

    // Internal Face Service — optional (not required for Phase 1 auth)
    FACE_SERVICE_URL: optionalUrl,
    FACE_SERVICE_SECRET: optionalString,
  });
