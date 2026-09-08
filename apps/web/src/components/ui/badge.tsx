import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Badge — small token for status, role, counts.
 *
 * Tones follow the semantic status tokens defined in the design doc:
 *   - neutral  : inactive / pending / unknown
 *   - info     : active / information
 *   - success  : present / confirmed
 *   - warning  : late / incomplete
 *   - destructive : absent / error
 */
const badgeVariants = cva(
  [
    "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
    "transition-colors duration-[var(--motion-base)] ease-[var(--easing-standard)]",
    "[&_svg]:h-3 [&_svg]:w-3",
  ].join(" "),
  {
    variants: {
      tone: {
        neutral:
          "border-border bg-muted text-muted-foreground",
        info: "border-info/30 bg-info-soft text-info",
        success:
          "border-success/30 bg-success-soft text-success",
        warning:
          "border-warning/30 bg-warning-soft text-warning",
        destructive:
          "border-destructive/30 bg-destructive-soft text-destructive",
        outline: "border-border-strong bg-transparent text-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
