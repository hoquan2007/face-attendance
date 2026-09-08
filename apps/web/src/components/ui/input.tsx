import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Input — precise text input used across all forms.
 *
 * Height: 40px (h-10) with 8px radius (matches controls).
 * Border: 1px subtle. Focus shows the primary ring.
 * Invalid state switches the border to the destructive token
 * (and keeps the same focus styling for predictability).
 */
export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  invalid?: boolean;
};

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, type = "text", ...props }, ref) => {
    return (
      <input
        ref={ref}
        type={type}
        aria-invalid={invalid || undefined}
        className={cn(
          "flex h-10 w-full rounded-md border bg-surface px-3 py-2 text-sm",
          "text-foreground placeholder:text-subtle",
          "transition-colors duration-[var(--motion-base)] ease-[var(--easing-standard)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
          "disabled:cursor-not-allowed disabled:opacity-60 disabled:bg-muted",
          invalid
            ? "border-destructive focus-visible:ring-destructive"
            : "border-input hover:border-border-strong",
          className,
        )}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";
