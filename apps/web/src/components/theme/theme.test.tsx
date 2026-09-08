/**
 * Tests for the `ThemeProvider` rendering.
 *
 * Verifies that:
 *   1. The provider renders children without crashing (ssr-safe).
 *   2. The ThemeToggle renders with an accessible aria-label.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("next-themes", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
  useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
}));

import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { ThemeToggle } from "@/components/theme/ThemeToggle";

describe("ThemeProvider", () => {
  it("renders children without crashing (ssr-safe)", () => {
    const html = renderToString(
      <ThemeProvider>
        <span>Hello</span>
      </ThemeProvider>,
    );
    expect(html).toContain("Hello");
  });
});

describe("ThemeToggle", () => {
  it("renders a button with an accessible aria-label", () => {
    const html = renderToString(<ThemeToggle />);
    expect(html).toContain('aria-label="Toggle color theme"');
  });

  it("renders an icon button (h-9 w-9)", () => {
    const html = renderToString(<ThemeToggle />);
    // The button should contain the icon size classes.
    expect(html).toContain("h-9");
    expect(html).toContain("w-9");
  });
});
