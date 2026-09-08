/**
 * Tests for the Profile Server Actions.
 *
 * These tests mock `getSession` and `revalidatePath`/`redirect` so we
 * can exercise the action entry points without real I/O.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGetSession = vi.fn();

vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers()),
}));

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    // Mimic Next's behavior: redirect() throws a control-flow exception.
    const err = new Error(`NEXT_REDIRECT: ${url}`);
    (err as { digest?: string }).digest = `NEXT_REDIRECT;replace;;${url};307;`;
    throw err;
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/session", () => ({
  getSession: () => mockGetSession(),
}));

const mockUpsertOnboarding = vi.fn();
const mockUpdateProfile = vi.fn();

// Import the real ProfileError so we can construct one inside mock
// implementations (without needing a dynamic import inside a sync
// callback).
import { ProfileError as _ProfileError } from "@/lib/profile-errors";

vi.mock("@/lib/profile-service", () => ({
  upsertOnboarding: (...args: unknown[]) => {
    mockUpsertOnboarding(...args);
    return Promise.resolve();
  },
  updateProfile: (...args: unknown[]) => {
    mockUpdateProfile(...args);
    return Promise.resolve();
  },
}));

import {
  submitOnboarding,
  submitProfileUpdate,
} from "@/lib/profile-actions";
import { PROFILE_ERROR_CODES } from "@/lib/profile-errors";

function makeSession(user: { id: string; email: string; name: string }) {
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      image: null,
    },
    expiresAt: new Date(),
  };
}

describe("profile-actions / submitOnboarding", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockUpsertOnboarding.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns UNAUTHENTICATED when there is no session", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const result = await submitOnboarding(undefined, new FormData());
    expect(result).toEqual({
      ok: false,
      error: { code: PROFILE_ERROR_CODES.UNAUTHENTICATED, message: expect.any(String) },
    });
    expect(mockUpsertOnboarding).not.toHaveBeenCalled();
  });

  it("uses session.user.id and session.user.email (not body values)", async () => {
    mockGetSession.mockResolvedValueOnce(
      makeSession({ id: "session-user", email: "session@example.com", name: "S" }),
    );

    const fd = new FormData();
    fd.set("role", "student");
    fd.set("fullName", "Body Name");
    fd.set("identificationCode", "STU-1");
    fd.set("phone", "+84 901");
    // The browser is not allowed to control identity. Even if it
    // tries, the action does not pass body values for userId/email.
    fd.set("userId", "attacker");
    fd.set("email", "attacker@example.com");

    try {
      await submitOnboarding(undefined, fd);
    } catch {
      // redirect() throws — that's the happy path here.
    }

    expect(mockUpsertOnboarding).toHaveBeenCalledTimes(1);
    const callArgs = mockUpsertOnboarding.mock.calls[0];
    expect(callArgs).toBeDefined();
    const [userId, email, payload] = callArgs as [string, string, Record<string, unknown>];
    expect(userId).toBe("session-user");
    expect(email).toBe("session@example.com");
    expect(payload).toMatchObject({
      role: "student",
      fullName: "Body Name",
      identificationCode: "STU-1",
    });
    // The body-supplied userId/email must NOT be in the payload.
    expect(payload.userId).toBeUndefined();
    expect(payload.email).toBeUndefined();
  });

  it("returns INVALID_PROFILE_DATA when service throws that code", async () => {
    mockGetSession.mockResolvedValueOnce(
      makeSession({ id: "u", email: "u@example.com", name: "U" }),
    );
    mockUpsertOnboarding.mockImplementationOnce(() => {
      throw new _ProfileError({
        code: PROFILE_ERROR_CODES.INVALID_PROFILE_DATA,
        message: "Some fields are missing or invalid.",
        fieldErrors: { fullName: ["Full name is required."] },
      });
    });

    const fd = new FormData();
    fd.set("role", "student");
    fd.set("fullName", "");
    fd.set("identificationCode", "STU-1");

    const result = await submitOnboarding(undefined, fd);
    expect(result).toMatchObject({
      ok: false,
      error: { code: PROFILE_ERROR_CODES.INVALID_PROFILE_DATA },
    });
  });

  it("returns IDENTIFICATION_CODE_TAKEN when service throws that code", async () => {
    mockGetSession.mockResolvedValueOnce(
      makeSession({ id: "u", email: "u@example.com", name: "U" }),
    );
    mockUpsertOnboarding.mockImplementationOnce(() => {
      throw new _ProfileError({
        code: PROFILE_ERROR_CODES.IDENTIFICATION_CODE_TAKEN,
        message: "This identification code is already in use.",
      });
    });

    const fd = new FormData();
    fd.set("role", "student");
    fd.set("fullName", "Alice");
    fd.set("identificationCode", "DUPE");

    const result = await submitOnboarding(undefined, fd);
    expect(result).toMatchObject({
      ok: false,
      error: { code: PROFILE_ERROR_CODES.IDENTIFICATION_CODE_TAKEN },
    });
  });
});

describe("profile-actions / submitProfileUpdate", () => {
  beforeEach(() => {
    mockGetSession.mockReset();
    mockUpdateProfile.mockReset();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns UNAUTHENTICATED when there is no session", async () => {
    mockGetSession.mockResolvedValueOnce(null);
    const result = await submitProfileUpdate(undefined, new FormData());
    expect(result).toMatchObject({
      ok: false,
      error: { code: PROFILE_ERROR_CODES.UNAUTHENTICATED },
    });
    expect(mockUpdateProfile).not.toHaveBeenCalled();
  });

  it("uses session.user.id (not body) when calling updateProfile", async () => {
    mockGetSession.mockResolvedValueOnce(
      makeSession({ id: "session-user", email: "session@example.com", name: "S" }),
    );

    const fd = new FormData();
    fd.set("fullName", "New Name");
    fd.set("identificationCode", "STU-1");
    fd.set("phone", "+84 901");
    fd.set("userId", "attacker");
    fd.set("role", "teacher"); // should be ignored by the action

    const result = await submitProfileUpdate(undefined, fd);
    expect(result).toEqual({ ok: true });
    const updateCallArgs = mockUpdateProfile.mock.calls[0];
    expect(updateCallArgs).toBeDefined();
    const [userId, payload] = updateCallArgs as [string, Record<string, unknown>];
    expect(userId).toBe("session-user");
    expect(payload).not.toHaveProperty("userId");
    expect(payload).not.toHaveProperty("role");
  });

  it("returns IDENTIFICATION_CODE_TAKEN when service throws that code", async () => {
    mockGetSession.mockResolvedValueOnce(
      makeSession({ id: "u", email: "u@example.com", name: "U" }),
    );
    mockUpdateProfile.mockImplementationOnce(() => {
      throw new _ProfileError({
        code: PROFILE_ERROR_CODES.IDENTIFICATION_CODE_TAKEN,
        message: "This identification code is already in use.",
      });
    });

    const fd = new FormData();
    fd.set("fullName", "Alice");
    fd.set("identificationCode", "DUPE");

    const result = await submitProfileUpdate(undefined, fd);
    expect(result).toMatchObject({
      ok: false,
      error: { code: PROFILE_ERROR_CODES.IDENTIFICATION_CODE_TAKEN },
    });
  });
});