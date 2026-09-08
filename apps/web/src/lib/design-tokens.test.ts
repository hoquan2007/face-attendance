/**
 * Tests for the design token variables in globals.css.
 *
 * Verifies that all documented semantic token names are present in the
 * CSS custom property declarations so that adding a new token is a
 * conscious act.
 *
 * This test parses the CSS source file and extracts token names.
 * It does NOT load the CSS in a browser — it is a static parse.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Minimal CSS variable extractor.
 * Matches `--var-name: value` declarations in the `:root` block.
 */
function extractTokenNames(css: string): Set<string> {
  const tokens = new Set<string>();
  // Match --color-*, --radius-*, --shadow-*, --motion-* declarations
  const re = /--([\w-]+)\s*:/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css)) !== null) {
    tokens.add(match[1]!);
  }
  return tokens;
}

const CSS_PATH = resolve(__dirname, "../app/globals.css");

describe("design tokens in globals.css", () => {
  let tokens: Set<string>;

  beforeAll(() => {
    const css = readFileSync(CSS_PATH, "utf-8");
    tokens = extractTokenNames(css);
  });

  it("defines the primary color token", () => {
    expect(tokens.has("color-primary")).toBe(true);
  });

  it("defines background and foreground tokens", () => {
    expect(tokens.has("color-background")).toBe(true);
    expect(tokens.has("color-foreground")).toBe(true);
  });

  it("defines surface tokens", () => {
    expect(tokens.has("color-surface")).toBe(true);
    expect(tokens.has("color-surface-raised")).toBe(true);
  });

  it("defines sidebar tokens", () => {
    expect(tokens.has("color-sidebar")).toBe(true);
    expect(tokens.has("color-sidebar-foreground")).toBe(true);
    expect(tokens.has("color-sidebar-accent")).toBe(true);
  });

  it("defines semantic status tokens", () => {
    expect(tokens.has("color-success")).toBe(true);
    expect(tokens.has("color-warning")).toBe(true);
    expect(tokens.has("color-destructive")).toBe(true);
    expect(tokens.has("color-info")).toBe(true);
  });

  it("defines radius tokens", () => {
    expect(tokens.has("radius-sm")).toBe(true);
    expect(tokens.has("radius-md")).toBe(true);
    expect(tokens.has("radius-lg")).toBe(true);
    expect(tokens.has("radius-xl")).toBe(true);
  });

  it("defines motion tokens", () => {
    expect(tokens.has("motion-fast")).toBe(true);
    expect(tokens.has("motion-base")).toBe(true);
    expect(tokens.has("motion-slow")).toBe(true);
  });

  it("defines easing token", () => {
    expect(tokens.has("easing-standard")).toBe(true);
  });
});
