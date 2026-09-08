"use client";

/**
 * Theme provider — drives the Light/Dark theme of the application.
 *
 * Behaviour:
 *   - Light is the default. First-time users always see Light
 *     regardless of OS preference (`enableSystem: false`).
 *   - Users can explicitly switch themes via the `ThemeToggle`.
 *   - The selected theme is persisted across sessions.
 *   - Server renders with the persisted theme (or `defaultTheme`)
 *     to avoid hydration mismatch / theme flashing.
 *   - Inline script attaches the resolved class to <html> before
 *     React hydrates, so the first paint is already in the right theme.
 */

import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ReactNode } from "react";

interface AppThemeProviderProps {
  children: ReactNode;
}

export function ThemeProvider({ children }: AppThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="light"
      enableSystem={false}
      disableTransitionOnChange
      storageKey="face-attendance-theme"
      themes={["light", "dark"]}
    >
      {children}
    </NextThemesProvider>
  );
}
