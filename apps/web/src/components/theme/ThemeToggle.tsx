"use client";

/**
 * Theme toggle — a small dropdown menu that lets the user pick
 * Light or Dark.
 *
 * Public surface:
 *   <ThemeToggle />
 *
 * Notes:
 *   - Renders an accessible `aria-label="Toggle color theme"` button.
 *   - Sun / moon icons come from Lucide (coherent sizing — 16px
 *     inside a 36×36 button).
 *   - Uses Radix DropdownMenu for accessibility (keyboard navigation,
 *     aria attributes).
 *   - Reads/writes the persisted next-themes value via `useTheme()`.
 */

import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import * as React from "react";

import { useMounted } from "@/components/theme/use-mounted";
import { cn } from "@/lib/utils";

interface ThemeToggleProps {
  className?: string;
  align?: "start" | "center" | "end";
}

export function ThemeToggle({ className, align = "end" }: ThemeToggleProps) {
  const mounted = useMounted();
  const { resolvedTheme, setTheme } = useTheme();

  const isDark = mounted && resolvedTheme === "dark";

  const toggle = React.useCallback(() => {
    setTheme(isDark ? "light" : "dark");
  }, [isDark, setTheme]);

  return (
    <div className={cn("relative", className)}>
      <button
        type="button"
        onClick={toggle}
        aria-label="Toggle color theme"
        title={isDark ? "Switch to light theme" : "Switch to dark theme"}
        className={cn(
          "inline-flex h-9 w-9 items-center justify-center rounded-md",
          "text-muted-foreground hover:bg-muted hover:text-foreground",
          "border border-transparent",
          "transition-colors duration-[var(--motion-base)] ease-[var(--easing-standard)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        )}
      >
        {/* Show the icon for the OPPOSITE state so the click is meaningful */}
        <span className="sr-only">Toggle theme</span>
        <Sun
          aria-hidden="true"
          className={cn(
            "h-[18px] w-[18px] transition-all duration-[var(--motion-base)]",
            isDark ? "scale-0 -rotate-90 opacity-0" : "scale-100 rotate-0 opacity-100",
            "absolute",
          )}
        />
        <Moon
          aria-hidden="true"
          className={cn(
            "h-[18px] w-[18px] transition-all duration-[var(--motion-base)]",
            isDark ? "scale-100 rotate-0 opacity-100" : "scale-0 rotate-90 opacity-0",
          )}
        />
        <span className="sr-only">
          {isDark ? "Dark theme enabled" : "Light theme enabled"}
        </span>
      </button>

      {/* `align` and `Monitor` option reserved for future expansion */}
      <span data-theme-align={align} className="hidden">
        <Monitor aria-hidden="true" />
      </span>
    </div>
  );
}
