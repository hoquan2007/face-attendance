/**
 * `EnrollmentStartButton` — interactive client component for starting
 * Face ID enrollment.
 *
 * PHASE 4.5B1 — Face ID Page Shell.
 *
 * Scope:
 *   - Calls the server action to start enrollment explicitly
 *   - Disables repeat clicks while the request is pending
 *   - Maps server error codes to safe, friendly UI messages
 *   - Refreshes the page state on success via `router.refresh()`
 *
 * Out of scope:
 *   - Camera capture
 *   - Image submission
 *   - Finalization
 */

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { startFaceEnrollment } from "@/lib/biometrics/enrollment-start-action";

export interface EnrollmentStartButtonProps {
  /** Visual variant of the button. */
  variant?: "primary" | "secondary";
  /** Label text when not pending. */
  label?: string;
  /** Optional className for the wrapper. */
  className?: string;
}

/**
 * Maps a server-side error code to a user-friendly message.
 * Returns the raw error message only if it's already safe.
 */
function friendlyErrorMessage(code: string, defaultMessage: string): string {
  switch (code) {
    case "UNAUTHENTICATED":
      return "Please sign in again to continue.";
    case "PROFILE_INCOMPLETE":
      return "Complete your profile before setting up Face ID.";
    case "FACE_PROFILE_ALREADY_EXISTS":
      return "Face ID is already configured for your account.";
    case "ENROLLMENT_START_FAILED":
      return "We could not start the setup. Please try again.";
    default:
      return defaultMessage;
  }
}

/**
 * Interactive button that explicitly starts Face ID enrollment.
 *
 * Enrollment never starts automatically — this button is the only
 * trigger. While the request is in flight, the button is disabled to
 * prevent duplicate submissions.
 */
export function EnrollmentStartButton({
  variant = "primary",
  label = "Set up Face ID",
  className,
}: EnrollmentStartButtonProps) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const onClick = React.useCallback(async (): Promise<void> => {
    if (pending) return; // Prevent concurrent calls.
    setPending(true);
    setError(null);

    try {
      const result = await startFaceEnrollment();
      if (result.ok) {
        // Refresh server state so the page shows the new active session.
        router.refresh();
      } else {
        setError(friendlyErrorMessage(result.error.code, result.error.message));
      }
    } catch {
      setError("We could not start the setup. Please try again.");
    } finally {
      setPending(false);
    }
  }, [pending, router]);

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <Button
        type="button"
        variant={variant}
        onClick={onClick}
        disabled={pending}
        loading={pending}
        aria-busy={pending || undefined}
      >
        {label}
      </Button>
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2 text-sm text-destructive"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
