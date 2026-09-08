"use client";

/**
 * Global client-side providers boundary.
 *
 * Composes all client-side context providers in one place:
 *   - ThemeProvider (next-themes) for light/dark mode
 *   - TooltipProvider (Radix) for accessible tooltips
 *
 * This component is rendered inside RootLayout, which remains a Server Component.
 * Only the parts that require client-side context (theme, tooltips) are wrapped.
 */

import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ReactNode } from "react";

interface ProvidersProps {
  children: ReactNode;
}

export function Providers({ children }: ProvidersProps) {
  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={400}>
        {children}
      </TooltipProvider>
    </ThemeProvider>
  );
}
