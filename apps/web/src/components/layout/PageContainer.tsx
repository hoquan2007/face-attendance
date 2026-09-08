import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * PageContainer — consistent page-level spacing.
 *
 * Behaviour:
 *   - Vertical rhythm (top/bottom padding) is the same across pages.
 *   - Horizontal padding uses the design system 4px rhythm:
 *       mobile  : px-4 (16px)
 *       tablet  : px-6 (24px)
 *       desktop : px-8 (32px) — outer surface feels roomy
 *   - `size="wide"` raises the max-width for dashboard-like data
 *     screens. Default `size="default"` keeps forms readable.
 *   - Padding automatically shrinks inside the app shell to align
 *     with the sidebar's right edge.
 */

type Size = "narrow" | "default" | "wide";

export interface PageContainerProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: Size;
  as?: "main" | "div" | "section";
}

const sizeClass: Record<Size, string> = {
  narrow: "max-w-2xl",
  default: "max-w-3xl",
  wide: "max-w-5xl",
};

export function PageContainer({
  className,
  size = "default",
  as = "div",
  ...props
}: PageContainerProps) {
  const Comp = as;
  return (
    <Comp
      className={cn(
        "mx-auto w-full px-4 sm:px-6 lg:px-8",
        "py-8 lg:py-10",
        sizeClass[size],
        className,
      )}
      {...props}
    />
  );
}
