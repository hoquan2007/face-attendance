/**
 * Tests for the `cn()` utility.
 *
 * Verifies that `clsx` + `tailwind-merge` correctly combines
 * conditional classes and deduplicates conflicting Tailwind utilities.
 */

import { describe, expect, it } from "vitest";

import { cn } from "@/lib/utils";

describe("cn — className builder", () => {
  it("handles basic string classes", () => {
    expect(cn("foo", "bar")).toBe("foo bar");
  });

  it("handles conditional booleans", () => {
    expect(cn("base", false && "conditional")).toBe("base");
    expect(cn("base", true && "conditional")).toBe("base conditional");
  });

  it("handles undefined and null", () => {
    expect(cn("base", undefined, null, "end")).toBe("base end");
  });

  it("deduplicates conflicting Tailwind classes (last wins)", () => {
    // When two strings set the same utility, the last occurrence wins.
    expect(cn("text-red-500", "text-blue-500")).toBe("text-blue-500");
    expect(cn("px-4", "px-6")).toBe("px-6");
  });

  it("handles arrays and nested arrays", () => {
    expect(cn(["a", "b"], ["c"])).toBe("a b c");
  });

  it("handles empty input gracefully", () => {
    expect(cn()).toBe("");
    expect(cn("")).toBe("");
  });
});
