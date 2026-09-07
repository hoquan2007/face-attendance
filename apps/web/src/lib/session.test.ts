import { describe, expect, it, vi } from "vitest";

/**
 * Tests for the server-side session helper.
 *
 * The session helper is built around `auth.api.getSession()`, which
 * requires an initialized Better Auth instance. We mock the module to
 * exercise the helper logic without spinning up a real DB.
 */

const mockGetSession = vi.fn();

vi.mock("@/lib/auth", () => ({
  auth: () =>
    Promise.resolve({
      api: {
        getSession: mockGetSession,
      },
    }),
}));

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers()),
}));

import { getCurrentUser, getSession, requireSession } from "@/lib/session";

describe("session helpers", () => {
  it("returns null when there is no session", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const session = await getSession();
    expect(session).toBeNull();
  });

  it("returns null when the user is missing from the session", async () => {
    mockGetSession.mockResolvedValueOnce({ session: { expiresAt: "2030-01-01T00:00:00Z" } });
    const session = await getSession();
    expect(session).toBeNull();
  });

  it("returns a normalized session when authenticated", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: {
        id: "user-1",
        email: "user@example.com",
        name: "Test User",
        image: "https://example.com/avatar.png",
      },
      session: { expiresAt: "2030-01-01T00:00:00Z" },
    });

    const session = await getSession();

    expect(session).not.toBeNull();
    expect(session?.user.id).toBe("user-1");
    expect(session?.user.email).toBe("user@example.com");
    expect(session?.user.name).toBe("Test User");
    expect(session?.user.image).toBe("https://example.com/avatar.png");
    expect(session?.expiresAt).toBeInstanceOf(Date);
  });

  it("returns null image when Better Auth gives undefined", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: {
        id: "user-2",
        email: "user2@example.com",
        name: "User Two",
        image: undefined,
      },
      session: { expiresAt: "2030-01-01T00:00:00Z" },
    });

    const user = await getCurrentUser();
    expect(user).not.toBeNull();
    expect(user?.image).toBeNull();
  });

  it("getCurrentUser returns null when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const user = await getCurrentUser();
    expect(user).toBeNull();
  });

  it("requireSession throws when not authenticated", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    await expect(requireSession()).rejects.toThrow(/Authentication required/);
  });

  it("requireSession returns the session when authenticated", async () => {
    mockGetSession.mockResolvedValueOnce({
      user: {
        id: "user-3",
        email: "user3@example.com",
        name: "User Three",
        image: "https://example.com/avatar3.png",
      },
      session: { expiresAt: "2030-01-01T00:00:00Z" },
    });

    const session = await requireSession();
    expect(session.user.id).toBe("user-3");
  });
});
