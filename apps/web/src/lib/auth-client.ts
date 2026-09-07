"use client";

/**
 * Better Auth client-side configuration.
 *
 * PHASE 1: Google OAuth + session management from the browser.
 *
 * This module communicates with the server-side Better Auth API exposed
 * at /api/auth/*.
 *
 * Never include server-only secrets here (MONGODB_URI, BETTER_AUTH_SECRET,
 * GOOGLE_CLIENT_SECRET, FACE_SERVICE_SECRET).
 */

import { createAuthClient } from "better-auth/react";

/**
 * Browser auth client.
 *
 * The baseURL is relative ("") so that:
 * - In development, requests go to the same origin (localhost:3000)
 * - In production, requests go to the deployed domain
 *
 * This means the auth client automatically adapts to whichever environment
 * is serving the page.
 */
export const authClient = createAuthClient({
  baseURL: "",
});

/**
 * Helpers for direct invocation in Client Components.
 */
export const { signIn, signOut, useSession } = authClient;
