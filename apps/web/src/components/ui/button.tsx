import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Button — single source of truth for all clickable actions.
 *
 * Four intentional variants cover the whole product:
 *   - primary    : main action
 *   - secondary  : supporting action
 *   - ghost      : low-emphasis (header icons, inline nav)
 *   - destructive: confirm-and-delete flows
 *
 * Two sizes (`md`, `lg`) map onto the height targets documented in
 * docs/frontend-design.md:
 *   - md  → 36–40px tall
 *   - lg  → 44px tall (primary hero actions)
 *
 * Use `asChild` with a Next.js `<Link>` to render an anchor with
 * button styling.
 */
const buttonVariants = cva(
  [
    "inline-flex items-center justify-center gap-2 whitespace-nowrap",
    "rounded-md font-medium select-none",
    "transition-colors duration-[var(--motion-base)] ease-[var(--easing-standard)]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50",
    "[&_svg]:shrink-0",
  ].join(" "),
  {
    variants: {
      variant: {
        primary:
          "bg-primary text-primary-foreground hover:bg-[var(--color-primary-hover)] shadow-sm",
        secondary:
          "bg-secondary text-secondary-foreground border border-border hover:bg-muted",
        ghost:
          "bg-transparent text-foreground hover:bg-muted",
        destructive:
          "bg-destructive text-destructive-foreground hover:opacity-90 shadow-sm",
        outline:
          "border border-border-strong bg-surface text-foreground hover:bg-muted",
        link:
          "bg-transparent text-primary underline-offset-4 hover:underline px-0",
      },
      size: {
        md: "h-9 px-3.5 text-sm [&_svg]:h-4 [&_svg]:w-4",
        lg: "h-11 px-5 text-sm [&_svg]:h-4 [&_svg]:w-4",
        sm: "h-8 px-3 text-xs [&_svg]:h-3.5 [&_svg]:w-3.5",
        icon: "h-9 w-9 px-0 [&_svg]:h-4 [&_svg]:w-4",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<
  HTMLButtonElement,
  ButtonProps
>(
  (
    {
      className,
      variant,
      size,
      asChild = false,
      loading = false,
      children,
      disabled,
      type,
      ...props
    },
    ref,
  ) => {
    // Loading spinner: shown inside the button content.
    const spinner = (
      <svg
        className="h-4 w-4 animate-spin"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          strokeOpacity="0.25"
          strokeWidth="2.5"
        />
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
      </svg>
    );

    if (asChild) {
      // asChild: Slot passes button classes to the first child element.
      // Common use case: <Button asChild><Link href="...">Label</Link></Button>
      return (
        <Slot
          className={cn(buttonVariants({ variant, size, className }))}
          {...props}
        >
          {loading ? (
            <>
              {spinner}
              {children}
            </>
          ) : (
            children
          )}
        </Slot>
      );
    }

    return (
      <button
        ref={ref}
        type={type ?? "button"}
        disabled={disabled || loading}
        aria-busy={loading || undefined}
        className={cn(buttonVariants({ variant, size, className }))}
        {...props}
      >
        {loading ? (
          <>
            {spinner}
            {children}
          </>
        ) : (
          children
        )}
      </button>
    );
  },
);
Button.displayName = "Button";

export { buttonVariants };
