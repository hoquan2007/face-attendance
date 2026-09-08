import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Avatar — small circular surface for the user identity.
 *
 * `src`/`alt` render an <img>. When `src` is missing we render the
 * user's initials on a neutral surface.
 *
 * We deliberately do not import a Google avatar URL from the
 * consumer in the browser for privacy tracking reasons — the
 * Better Auth provider already gives us a sanitized URL via the
 * session.
 */
export interface AvatarProps extends React.HTMLAttributes<HTMLSpanElement> {
  src?: string | null;
  alt?: string;
  name?: string;
  size?: "sm" | "md" | "lg" | "xl";
}

const sizeClass: Record<NonNullable<AvatarProps["size"]>, string> = {
  sm: "h-8 w-8 text-xs",
  md: "h-10 w-10 text-sm",
  lg: "h-12 w-12 text-base",
  xl: "h-16 w-16 text-lg",
};

function initials(name?: string) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1]?.[0] ?? "" : "";
  return (first + last).toUpperCase() || "?";
}

export const Avatar = React.forwardRef<HTMLSpanElement, AvatarProps>(
  ({ className, src, alt, name, size = "md", ...props }, ref) => {
    const sizeClasses = sizeClass[size];
    if (src) {
      return (
        <span
          ref={ref}
          className={cn(
            "relative inline-flex shrink-0 overflow-hidden rounded-full border border-border bg-muted",
            sizeClasses,
            className,
          )}
          {...props}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt={alt ?? name ?? "User avatar"}
            className="h-full w-full object-cover"
            referrerPolicy="no-referrer"
            draggable={false}
          />
        </span>
      );
    }
    return (
      <span
        ref={ref}
        aria-hidden={alt ? undefined : true}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-muted font-semibold text-muted-foreground",
          sizeClasses,
          className,
        )}
        {...props}
      >
        {initials(name ?? alt)}
      </span>
    );
  },
);
Avatar.displayName = "Avatar";
