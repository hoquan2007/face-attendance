import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * PageHeader — page title, optional description, optional actions.
 *
 * Visual target:
 *   - Title: 28/36, weight 600
 *   - Description: muted 14/21
 *   - Optional action slot on the right at md+
 */
export interface PageHeaderProps extends React.HTMLAttributes<HTMLElement> {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  /** A heading level. Defaults to <h1>. */
  as?: "h1" | "h2" | "h3";
}

export function PageHeader({
  title,
  description,
  actions,
  as = "h1",
  className,
  ...props
}: PageHeaderProps) {
  const Heading = as;
  return (
    <header
      className={cn(
        "flex flex-col gap-3 md:flex-row md:items-end md:justify-between md:gap-6",
        className,
      )}
      {...props}
    >
      <div className="flex flex-col gap-1.5">
        <Heading className="text-[28px] leading-[36px] font-semibold tracking-tight text-foreground">
          {title}
        </Heading>
        {description ? (
          <p className="text-sm leading-[21px] text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
