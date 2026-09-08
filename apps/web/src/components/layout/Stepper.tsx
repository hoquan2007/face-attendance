import { Check } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Stepper — calm progress indicator for multi-step flows.
 *
 * Shows current step / total and the position of each step.
 * Indicators are dots with a small label; the active step uses
 * the primary token, completed steps check, future steps are muted.
 */
export interface StepperProps extends React.HTMLAttributes<HTMLDivElement> {
  steps: ReadonlyArray<string>;
  currentStep: number;
  /** Zero-based index; if omitted, falls back to currentStep. */
}

export function Stepper({
  steps,
  currentStep,
  className,
  ...props
}: StepperProps) {
  return (
    <nav
      aria-label="Progress"
      className={cn(
        "flex items-center gap-3 text-xs text-muted-foreground",
        className,
      )}
      {...props}
    >
      <span className="font-medium tabular-nums">
        Step {currentStep + 1} of {steps.length}
      </span>
      <ol className="flex flex-1 items-center gap-1.5" role="list">
        {steps.map((label, idx) => {
          const completed = idx < currentStep;
          const current = idx === currentStep;
          return (
            <li
              key={label}
              aria-current={current ? "step" : undefined}
              className="flex flex-1 items-center gap-1.5"
            >
              <span
                aria-hidden="true"
                className={cn(
                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold transition-colors",
                  completed
                    ? "border-primary bg-primary text-primary-foreground"
                    : current
                      ? "border-primary bg-accent text-accent-foreground"
                      : "border-border bg-muted text-muted-foreground",
                )}
              >
                {completed ? <Check className="h-3 w-3" /> : idx + 1}
              </span>
              <span
                className={cn(
                  "hidden text-xs sm:inline",
                  current ? "text-foreground font-medium" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
              {idx < steps.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "h-px flex-1",
                    completed ? "bg-primary" : "bg-border",
                  )}
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
