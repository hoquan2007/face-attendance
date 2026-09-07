/**
 * Server-side session helpers.
 *
 * Centralizes session retrieval for Server Components, Route Handlers,
 * and Server Actions.
 *
 * The Better Auth session is the source of truth. Never trust a
 * client-provided user ID, email, or cookie presence alone.
 */

import { headers } from "next/headers";
import { auth } from "@/lib/auth";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  image: string | null;
}

export interface AuthSession {
  user: SessionUser;
  expiresAt: Date;
}

/**
 * Returns the current authenticated session, or null if not authenticated.
 *
 * Server Components and Route Handlers should use this for any
 * authorization decision. UI-only hiding is NOT a security boundary.
 *
 * @returns The active session or null.
 */
export async function getSession(): Promise<AuthSession | null> {
  const authInstance = await auth();

  // Better Auth's getSession reads cookies from the incoming request.
  // We pass the request headers so it can validate cookies server-side.
  const requestHeaders = await headers();
  const result = await authInstance.api.getSession({
    headers: requestHeaders,
  });

  if (!result || !result.user) {
    return null;
  }

  return {
    user: {
      id: result.user.id,
      email: result.user.email,
      name: result.user.name,
      image: result.user.image ?? null,
    },
    expiresAt: new Date(result.session.expiresAt),
  };
}

/**
 * Returns the current authenticated user, or null if not authenticated.
 *
 * Convenience wrapper around getSession() for code that only needs
 * the user identity.
 */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const session = await getSession();
  return session?.user ?? null;
}

/**
 * Returns the current authenticated session or throws.
 *
 * Use inside protected resources where the route layer (e.g. layout.tsx,
 * route.ts) has already verified the user is authenticated.
 */
export async function requireSession(): Promise<AuthSession> {
  const session = await getSession();
  if (!session) {
    throw new Error("Authentication required");
  }
  return session;
}
