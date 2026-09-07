/**
 * Better Auth catch-all API route.
 *
 * Exposes all Better Auth endpoints under /api/auth/*.
 * This is the standard Better Auth Next.js App Router integration pattern.
 *
 * All authentication operations (Google OAuth flow, session retrieval,
 * sign-out) are routed through Better Auth's internal handlers here.
 */

import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth";

const authInstance = await auth();
export const { GET, POST } = toNextJsHandler(authInstance);
