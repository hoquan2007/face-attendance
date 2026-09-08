/**
 * Pure redirect-decision helpers for Phase 2 routes.
 *
 * The functions in this module are intentionally free of side effects
 * (no `redirect()`, no DB calls). They take a session/profile state
 * object and return a string URL or `null`. This keeps the decision
 * logic trivially unit-testable and lets every page render with the
 * same canonical behavior.
 *
 * The single source of truth for the user's identity is the Better
 * Auth session (`getSession()`). Profile completeness is determined
 * server-side by checking the `profiles` collection.
 *
 * Conceptual matrix:
 *
 *   no session                                  -> /login
 *   session + no profile / profile incomplete   -> /onboarding
 *   session + profile complete                  -> /dashboard (or stays)
 *   session + profile complete + visiting /login or /onboarding
 *                                              -> /dashboard
 */

export type AuthState = {
  /** Better Auth session is present and valid. */
  isAuthenticated: boolean;
  /** True if the profile exists AND `onboardingCompleted === true`. */
  isOnboardingComplete: boolean;
};

export type RouteDecision = {
  /** URL to redirect to, or `null` to render the current page. */
  redirectTo: string | null;
};

/**
 * Decide what `/` (root) should do for the given auth state.
 */
export function decideRoot(auth: AuthState): RouteDecision {
  if (!auth.isAuthenticated) {
    return { redirectTo: null }; // Render landing.
  }
  if (!auth.isOnboardingComplete) {
    return { redirectTo: "/onboarding" };
  }
  return { redirectTo: "/dashboard" };
}

/**
 * Decide what `/login` should do.
 *
 * `/login` is normally public, but authenticated users should be sent
 * to the right place based on onboarding state.
 */
export function decideLogin(auth: AuthState): RouteDecision {
  if (!auth.isAuthenticated) {
    return { redirectTo: null }; // Render the login form.
  }
  if (!auth.isOnboardingComplete) {
    return { redirectTo: "/onboarding" };
  }
  return { redirectTo: "/dashboard" };
}

/**
 * Decide what `/onboarding` should do.
 *
 * Unauthenticated users are sent to `/login`. Users with a completed
 * profile are sent to `/dashboard`. Otherwise, render the onboarding
 * flow.
 */
export function decideOnboarding(auth: AuthState): RouteDecision {
  if (!auth.isAuthenticated) {
    return { redirectTo: "/login" };
  }
  if (auth.isOnboardingComplete) {
    return { redirectTo: "/dashboard" };
  }
  return { redirectTo: null };
}

/**
 * Decide what `/dashboard` (and any other protected application page)
 * should do. Pages in this category require both an authenticated
 * session and a completed profile.
 */
export function decideProtected(auth: AuthState): RouteDecision {
  if (!auth.isAuthenticated) {
    return { redirectTo: "/login" };
  }
  if (!auth.isOnboardingComplete) {
    return { redirectTo: "/onboarding" };
  }
  return { redirectTo: null };
}