/**
 * Tests for the route-guard decision helpers.
 *
 * These tests cover the conceptual matrix documented in
 * `route-guards.ts`:
 *
 *   - no session                                  -> /login
 *   - session + no profile / profile incomplete   -> /onboarding
 *   - session + profile complete                  -> /dashboard (or stays)
 *
 * Additional cases verify:
 *
 *   - authenticated completed user visiting /onboarding redirects dashboard
 *   - authenticated incomplete user visiting dashboard redirects onboarding
 */

import { describe, expect, it } from "vitest";

import {
  decideLogin,
  decideOnboarding,
  decideProtected,
  decideRoot,
  type AuthState,
} from "@/lib/route-guards";

const anonymous: AuthState = { isAuthenticated: false, isOnboardingComplete: false };
const incomplete: AuthState = { isAuthenticated: true, isOnboardingComplete: false };
const complete: AuthState = { isAuthenticated: true, isOnboardingComplete: true };

describe("route-guards / decideRoot", () => {
  it("renders landing when not authenticated", () => {
    expect(decideRoot(anonymous).redirectTo).toBeNull();
  });
  it("redirects to /onboarding when authenticated and incomplete", () => {
    expect(decideRoot(incomplete).redirectTo).toBe("/onboarding");
  });
  it("redirects to /dashboard when authenticated and complete", () => {
    expect(decideRoot(complete).redirectTo).toBe("/dashboard");
  });
});

describe("route-guards / decideLogin", () => {
  it("renders the login form when not authenticated", () => {
    expect(decideLogin(anonymous).redirectTo).toBeNull();
  });
  it("redirects authenticated-incomplete users to /onboarding", () => {
    expect(decideLogin(incomplete).redirectTo).toBe("/onboarding");
  });
  it("redirects authenticated-complete users to /dashboard", () => {
    expect(decideLogin(complete).redirectTo).toBe("/dashboard");
  });
});

describe("route-guards / decideOnboarding", () => {
  it("redirects anonymous users to /login", () => {
    expect(decideOnboarding(anonymous).redirectTo).toBe("/login");
  });
  it("renders onboarding for authenticated-incomplete users", () => {
    expect(decideOnboarding(incomplete).redirectTo).toBeNull();
  });
  it("redirects authenticated-complete users to /dashboard", () => {
    expect(decideOnboarding(complete).redirectTo).toBe("/dashboard");
  });
});

describe("route-guards / decideProtected", () => {
  it("redirects anonymous users to /login", () => {
    expect(decideProtected(anonymous).redirectTo).toBe("/login");
  });
  it("redirects authenticated-incomplete users to /onboarding", () => {
    expect(decideProtected(incomplete).redirectTo).toBe("/onboarding");
  });
  it("renders the page for authenticated-complete users", () => {
    expect(decideProtected(complete).redirectTo).toBeNull();
  });
});