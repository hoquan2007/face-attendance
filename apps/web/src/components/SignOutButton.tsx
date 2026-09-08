"use client";

/**
 * Sign-out trigger button.
 *
 * Calls Better Auth's official sign-out, then routes the browser
 * back to /login and forces server components to re-render.
 *
 * We expose it both as a button (`<SignOutButton />`) and as a hook
 * (`useSignOutHandler`) so the `UserMenu` can wire its "Sign out"
 * dropdown item to the same lifecycle without duplicating logic.
 */

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { signOut } from "@/lib/auth-client";

import { cn } from "@/lib/utils";

export interface SignOutButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  label?: string;
}

export function SignOutButton({
  label = "Sign out",
  className,
  ...props
}: SignOutButtonProps) {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const handleSignOut = useCallback(async () => {
    if (isLoading) return;
    setIsLoading(true);
    try {
      await signOut();
      router.replace("/login");
      router.refresh();
    } catch {
      setIsLoading(false);
    }
  }, [isLoading, router]);

  return (
    <button
      type="button"
      onClick={() => {
        void handleSignOut();
      }}
      disabled={isLoading}
      aria-busy={isLoading}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border bg-surface px-3.5 text-sm font-medium text-foreground shadow-sm",
        "transition-colors duration-[var(--motion-base)] hover:bg-muted",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
      {...props}
    >
      <LogOut aria-hidden="true" className="h-4 w-4" />
      <span>{isLoading ? "Signing out..." : label}</span>
    </button>
  );
}

/**
 * Hook form for callers that want to wire the sign-out lifecycle
 * to a non-button UI (e.g. a DropdownMenuItem).
 */
export function useSignOutHandler() {
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);

  const handleSignOut = useCallback(async () => {
    if (isLoading) return;
    setIsLoading(true);
    try {
      await signOut();
      router.replace("/login");
      router.refresh();
    } catch {
      setIsLoading(false);
    }
  }, [isLoading, router]);

  return { handleSignOut, isLoading } as const;
}
