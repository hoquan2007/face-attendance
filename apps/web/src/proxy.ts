/**
 * Next.js middleware proxy.
 *
 * This module runs at the edge on every matched request.
 * Authentication redirects are handled exclusively by Server Components
 * using the real Better Auth session (getSession()). Middleware only
 * passes requests through without making auth decisions.
 *
 * Removing auth logic from middleware is intentional:
 * - Middleware cannot access the MongoDB session store.
 * - Middleware can only check cookie *presence*, not cookie *validity*.
 * - Relying on middleware for auth allows cookie spoofing attacks.
 * - Server Components use auth.api.getSession() for authoritative decisions.
 */

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function proxy(_request: NextRequest) {
  return NextResponse.next();
}

export const config = {
  // Match all paths except Next.js internals and the auth API.
  // The auth API must not be intercepted here — Better Auth handles it directly.
  matcher: [
    "/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\..*).*)",
  ],
};
