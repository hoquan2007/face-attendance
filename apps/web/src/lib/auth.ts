/**
 * Better Auth server-side configuration.
 *
 * PHASE 1: Google OAuth + MongoDB session persistence.
 *
 * This module is server-only. Never import it from client components.
 * Use auth-client.ts for client-side authentication operations.
 */

import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { env } from "@/lib/env";
import { getMongoClient } from "@/lib/mongodb";

/**
 * Cached auth instance to avoid recreating on every request.
 */
let authInstance: Awaited<ReturnType<typeof createAuth>> | undefined;

/**
 * Creates the Better Auth server instance.
 * Called once per server lifetime via the cached `auth` export.
 */
async function createAuth() {
  const mongoClient = await getMongoClient();
  const database = mongoClient.db("face_attendance");

  return betterAuth({
    // MongoDB adapter using the shared MongoClient
    //
    // transaction: false is an explicit compatibility workaround for the
    // current Better Auth Mongo adapter transaction path. In this environment
    // the adapter was failing with:
    //   MongoTransactionError:
    //     Cannot call abortTransaction after calling commitTransaction
    // Note: MongoDB Atlas Free (M0) clusters are replica-set based and DO
    // support multi-document transactions. The issue being mitigated here is
    // specific to the current Better Auth Mongo adapter's transaction usage
    // in our environment, not a general Atlas Free limitation.
    //
    // With transaction: false, authentication writes (user / account /
    // session) execute without a multi-operation database transaction.
    //
    // Revisit this setting when:
    //   - upgrading Better Auth to a version where the Mongo adapter
    //     transaction path is stable in our environment, or
    //   - changing the underlying database setup.
    database: mongodbAdapter(database, {
      client: mongoClient,
      transaction: false,
    }),

    // Base URL for OAuth callbacks
    baseURL: env.BETTER_AUTH_URL,

    // Secret for signing session cookies
    secret: env.BETTER_AUTH_SECRET,

    // Email/password disabled (Phase 1: Google only)
    emailAndPassword: {
      enabled: false,
    },

    // Google as the only social provider in Phase 1
    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        // Only request basic identity scopes
        scope: ["openid", "email", "profile"],
      },
    },

    // Session configuration
    session: {
      expiresIn: 60 * 60 * 24 * 30, // 30 days
      updateAge: 60 * 60 * 24, // Update once per day
    },

    // Account linking: allow same email across providers in future
    account: {
      accountLinking: {
        enabled: false, // Strict mode in Phase 1
      },
    },

    // Trusted origins for CSRF / callback validation
    trustedOrigins: [
      env.BETTER_AUTH_URL,
      "http://localhost:3000",
    ],
  });
}

/**
 * Returns the cached Better Auth instance.
 *
 * The MongoDB connection is established lazily on first access.
 * Subsequent calls return the cached instance.
 *
 * Use this from:
 * - Server Components and Route Handlers in Next.js
 * - The catch-all /api/auth/[...all]/route.ts handler
 */
export async function auth() {
  if (!authInstance) {
    authInstance = await createAuth();
  }
  return authInstance;
}

export type Auth = Awaited<ReturnType<typeof createAuth>>;
