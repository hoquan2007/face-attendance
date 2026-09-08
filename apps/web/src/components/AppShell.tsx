/**
 * AppShell — client shell that wraps authenticated application pages.
 *
 * Structure:
 *   - lg: fixed sidebar (240px) + scrollable main content
 *   - < lg: no sidebar; top header with hamburger drawer
 *
 * The shell is rendered by `layout.tsx` and receives the user's
 * session profile as props. Pages that should NOT have the shell
 * (login, onboarding) are rendered OUTSIDE it in layout.tsx.
 */

"use client";

import * as React from "react";

import { AppHeader } from "@/components/layout/AppHeader";
import { AppSidebar } from "@/components/layout/AppSidebar";

interface AppShellProps {
  children: React.ReactNode;
  user: {
    name: string;
    email: string;
    image: string | null;
    role: "student" | "teacher";
  } | null;
}

export function AppShell({ children, user }: AppShellProps) {
  const roleLabel = user
    ? user.role === "teacher"
      ? "Teacher"
      : "Student"
    : null;

  return (
    <div className="flex min-h-screen flex-col">
      {/* Top bar — always visible */}
      <AppHeader
        user={
          user && roleLabel
            ? {
                name: user.name,
                email: user.email,
                image: user.image,
                role: user.role,
              }
            : null
        }
      />

      {/* Two-column layout for authenticated pages */}
      {user ? (
        <div className="flex flex-1">
          {/* Desktop sidebar */}
          <AppSidebar />
          {/* Main content */}
          <main
            id="main-content"
            className="flex-1 overflow-y-auto"
            tabIndex={-1}
          >
            {children}
          </main>
        </div>
      ) : (
        /* Unauthenticated shell — no sidebar, just a simple top bar */
        <main id="main-content" className="flex-1 overflow-y-auto">
          {children}
        </main>
      )}
    </div>
  );
}
