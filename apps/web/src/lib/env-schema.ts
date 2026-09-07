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
 * corresponding integrations are not implemented yet. Phase 1+ will
 * enforce required values at boot.
 */
export const buildEnvSchema = () =>
  z.object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    // Public
    NEXT_PUBLIC_APP_URL: z.preprocess(
      emptyStringToUndefined,
      z.string().url().default("http://localhost:3000"),
    ),
    APP_NAME: z.preprocess(
      emptyStringToUndefined,
      z.string().default("Face Attendance System"),
    ),

    // Server-only (will be enforced as required in later phases)
    MONGODB_URI: optionalString,

    // Better Auth (official env var names)
    BETTER_AUTH_URL: optionalUrl,
    BETTER_AUTH_SECRET: optionalString,

    // Google OAuth
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,

    // Internal Face Service
    FACE_SERVICE_URL: optionalUrl,
    FACE_SERVICE_SECRET: optionalString,
  });
