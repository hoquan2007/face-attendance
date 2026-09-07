import { z } from "zod";

/**
 * Boot-time environment configuration.
 *
 * PHASE 0.5: variable names are standardized around Better Auth's official
 * naming. Phase 1+ wires the actual values; missing required values will
 * throw at boot from Phase 1 onward.
 *
 * NOTE: client-side code must only read `NEXT_PUBLIC_*` variables.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // Public
  NEXT_PUBLIC_APP_URL: z.string().url().default("http://localhost:3000"),
  APP_NAME: z.string().default("Face Attendance System"),

  // Server-only (will be enforced as required in later phases)
  MONGODB_URI: z.string().optional(),

  // Better Auth (official env var names)
  BETTER_AUTH_URL: z.string().url().optional(),
  BETTER_AUTH_SECRET: z.string().optional(),

  // Google OAuth
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),

  // Internal Face Service
  FACE_SERVICE_URL: z.string().url().optional(),
  FACE_SERVICE_SECRET: z.string().optional(),
});

const parsed = schema.safeParse({
  NODE_ENV: process.env.NODE_ENV,
  NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  APP_NAME: process.env.APP_NAME ?? "Face Attendance System",
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
export type Env = z.infer<typeof schema>;
