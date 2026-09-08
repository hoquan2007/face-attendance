import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * EmptyState — calm, helpful placeholder.
 *
 * Never display only "No data". Always:
 *   - short title
 *   - one-sentence description
 *   - optional contextual action
 *
 * Geometry follows real content shape so layouts don't shift
 * materially when transitioning from empty to populated state.
 */
export interface EmptyStateProps extends React.HTMLAttributes<HTMLDivElement> {
  icon?: React.ReactNode;
  title: string;
  description?: React.ReactNode;
  action?: React.ReactNode;
  tone?: "neutral" | "muted";
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = "neutral",
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      role="status"
      className={cn(
        "flex flex-col items-center justify-center gap-2",
        "rounded-xl border border-dashed px-6 py-10 text-center",
        tone === "neutral"
          ? "border-border bg-surface"
          : "border-border-strong bg-muted",
        className,
      )}
      {...props}
    >
      {icon ? (
        <div
          aria-hidden="true"
          className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground"
        >
          {icon}
        </div>
      ) : null}
      <h3 className="text-base font-semibold tracking-tight text-foreground">
        {title}
      </h3>
      {description ? (
        <p className="max-w-sm text-sm leading-[21px] text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  );
}
