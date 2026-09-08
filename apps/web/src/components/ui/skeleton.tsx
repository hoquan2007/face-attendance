import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Skeleton — layout-aware loading placeholder.
 *
 * Geometry approximates final content so layouts do not shift on
 * load. Use sparingly: structure, not decoration.
 */
export const Skeleton = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, ...props }, ref) => (
  <div
    ref={ref}
    aria-hidden="true"
    className={cn(
      "relative overflow-hidden rounded-md bg-muted",
      "before:absolute before:inset-0",
      "before:bg-gradient-to-r before:from-transparent before:via-white/40 before:to-transparent",
      "dark:before:via-white/5",
      "before:animate-[shimmer_1.4s_infinite]",
      className,
    )}
    style={
      {
        animationDuration: "var(--motion-slow)",
      } as React.CSSProperties
    }
    {...props}
  />
));
Skeleton.displayName = "Skeleton";
