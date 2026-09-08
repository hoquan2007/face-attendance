import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * SectionHeader — secondary heading used inside cards / page bodies.
 *
 * Visual target:
 *   - Title: 18/26, weight 600
 *   - Description: muted 14/21
 *   - Optional action slot on the right
 */
export interface SectionHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  as?: "h2" | "h3";
  className?: string;
}

export function SectionHeader({
  title,
  description,
  actions,
  as = "h2",
  className,
}: SectionHeaderProps) {
  const Heading = as;
  return (
    <div
      className={cn(
        "flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-4",
        className,
      )}
    >
      <div className="flex flex-col gap-1">
        <Heading className="text-[18px] leading-[26px] font-semibold tracking-tight text-foreground">
          {title}
        </Heading>
        {description ? (
          <p className="text-sm leading-[21px] text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}
