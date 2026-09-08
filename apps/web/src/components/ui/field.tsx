import * as React from "react";

import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Field — composes a labelled input with optional help text and
 * error text. Keeps label / hint / error markup consistent across
 * every form in the app.
 *
 * Accessibility:
 *   - The label is always rendered (never placeholder-only).
 *   - `aria-invalid` and `aria-describedby` link the input to its
 *     error / help text.
 */

export interface FieldProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  wrapperClassName?: string;
}

export const Field = React.forwardRef<HTMLInputElement, FieldProps>(
  (
    {
      label,
      hint,
      error,
      id,
      required,
      className,
      wrapperClassName,
      ...props
    },
    ref,
  ) => {
    const reactId = React.useId();
    const fieldId = id ?? reactId;
    const hintId = `${fieldId}-hint`;
    const errorId = `${fieldId}-error`;
    const describedBy = error ? errorId : hint ? hintId : undefined;
    return (
      <div className={cn("flex flex-col gap-1.5", wrapperClassName)}>
        <Label htmlFor={fieldId} className="flex items-center gap-1">
          <span>{label}</span>
          {required ? (
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          ) : null}
        </Label>
        <Input
          ref={ref}
          id={fieldId}
          required={required}
          invalid={Boolean(error)}
          aria-describedby={describedBy}
          className={className}
          {...props}
        />
        {error ? (
          <p id={errorId} role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : hint ? (
          <p id={hintId} className="text-xs text-muted-foreground">
            {hint}
          </p>
        ) : null}
      </div>
    );
  },
);
Field.displayName = "Field";
