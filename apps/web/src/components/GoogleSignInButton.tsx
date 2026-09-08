"use client";

import { useState } from "react";

import { signIn } from "@/lib/auth-client";
import { Button } from "@/components/ui/button";

/**
 * "Continue with Google" button.
 *
 * Triggers Better Auth's Google social sign-in flow.
 * Renders using the primary button variant from the design system.
 */
export function GoogleSignInButton({
  callbackURL = "/dashboard",
}: {
  callbackURL?: string;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = async () => {
    setError(null);
    setIsLoading(true);
    try {
      const result = await signIn.social({
        provider: "google",
        callbackURL,
      });
      if (result?.error) {
        setError("Unable to sign in with Google. Please try again.");
        setIsLoading(false);
      }
      // On success, the browser will be redirected to Google.
      // isLoading stays true during the redirect.
    } catch {
      setError("Unable to sign in with Google. Please try again.");
      setIsLoading(false);
    }
  };

  return (
    <div className="flex w-full flex-col gap-3">
      <Button
        type="button"
        variant="secondary"
        size="lg"
        onClick={handleSignIn}
        disabled={isLoading}
        aria-busy={isLoading}
        className="w-full gap-3"
      >
        <GoogleIcon />
        <span>{isLoading ? "Redirecting..." : "Continue with Google"}</span>
      </Button>

      {error && (
        <p role="alert" className="text-sm text-destructive text-center">
          {error}
        </p>
      )}
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 48 48"
      className="shrink-0"
    >
      <path
        fill="#4285F4"
        d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.6 6.1 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"
      />
      <path
        fill="#34A853"
        d="M6.3 14.7l6.6 4.8C14.6 15.1 19 12 24 12c3 0 5.8 1.1 7.9 3l5.7-5.7C34.6 6.1 29.6 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#FBBC05"
        d="M24 44c5.4 0 10.3-2.1 14-5.4l-6.5-5.3C29.5 34.9 26.9 36 24 36c-5.3 0-9.7-3.4-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#EA4335"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4-4 5.3l6.5 5.3C41.8 35.7 44 30.4 44 24c0-1.3-.1-2.3-.4-3.5z"
      />
    </svg>
  );
}
