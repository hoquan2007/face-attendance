/**
 * Tests for the Face ID navigation entry.
 *
 * PHASE 4.5B1 — Face ID Page Shell.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("nav-config / Face ID entry", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("exposes Face ID as a ready nav item pointing to /face-id", async () => {
    const { NAV_GROUPS } = await import("@/components/layout/nav-config");
    const faceId = NAV_GROUPS.flatMap((g) => g.items).find(
      (i) => i.key === "face_id",
    );
    expect(faceId).toBeDefined();
    expect(faceId?.status).toBe("ready");
    expect(faceId?.href).toBe("/face-id");
  });

  it("does NOT carry the coming-soon tooltip anymore", async () => {
    const { NAV_GROUPS } = await import("@/components/layout/nav-config");
    const faceId = NAV_GROUPS.flatMap((g) => g.items).find(
      (i) => i.key === "face_id",
    );
    expect(faceId?.tooltip).toBeUndefined();
  });
});

describe("nav active-state logic for Face ID prefix", () => {
  // The actual active-state logic in AppSidebar.tsx is:
  //   pathname?.startsWith(item.href)
  // This makes `/face-id` highlight when on `/face-id` and on `/face-id/setup`.
  function isActive(itemHref: string, pathname: string | null): boolean {
    return Boolean(pathname?.startsWith(itemHref));
  }

  it("highlights Face ID nav on /face-id", () => {
    expect(isActive("/face-id", "/face-id")).toBe(true);
  });

  it("highlights Face ID nav on /face-id/setup", () => {
    expect(isActive("/face-id", "/face-id/setup")).toBe(true);
  });

  it("does NOT highlight Face ID nav on unrelated routes", () => {
    expect(isActive("/face-id", "/dashboard")).toBe(false);
    expect(isActive("/face-id", "/profile")).toBe(false);
    expect(isActive("/face-id", "/onboarding")).toBe(false);
  });
});
