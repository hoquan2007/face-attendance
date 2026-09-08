/**
 * AppHeader — top bar above the main workspace.
 *
 * Visual targets:
 *   - Height: 56–60px
 *   - Left : brand on mobile; on desktop the brand lives in the
 *            sidebar instead.
 *   - Right: theme toggle + user avatar/menu.
 *
 * On mobile, a left-side Sheet drawer hosts the navigation items.
 */

"use client";

import { Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { Button } from "@/components/ui/button";
import { UserMenu } from "@/components/layout/UserMenu";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { NAV_GROUPS } from "@/components/layout/nav-config";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface AppHeaderProps {
  user: {
    name: string;
    email: string;
    image: string | null;
    role: "student" | "teacher";
  } | null;
  /** Optional context line shown on desktop (page title / breadcrumb). */
  context?: React.ReactNode;
}

export function AppHeader({ user, context }: AppHeaderProps) {
  const pathname = usePathname();

  return (
    <TooltipProvider delayDuration={200} skipDelayDuration={400}>
      <header
        className={cn(
          "sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-border bg-background/85 backdrop-blur",
          "px-4 sm:px-6 lg:px-8",
        )}
      >
        <div className="flex min-w-0 items-center gap-3">
          {/* Mobile navigation drawer */}
          <Sheet>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Open navigation"
                className="lg:hidden"
              >
                <Menu className="h-5 w-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left">
              <SheetHeader>
                <SheetTitle>Face Attendance</SheetTitle>
                <p className="text-xs text-muted-foreground">Phase 2 preview</p>
              </SheetHeader>
              <nav className="flex flex-col gap-1 p-3" aria-label="Mobile navigation">
                {NAV_GROUPS.flatMap((group) => [
                  group.label ? (
                    <p
                      key={`label-${group.id}`}
                      className="px-2 pb-1.5 pt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      {group.label}
                    </p>
                  ) : null,
                  ...group.items.map((item) => {
                    const isReady = item.status === "ready" && item.href;
                    const isActive =
                      isReady && pathname?.startsWith(item.href!);
                    const Icon = item.icon;
                    return isReady ? (
                      <Link
                        key={item.key}
                        href={item.href!}
                        className={cn(
                          "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                          isActive
                            ? "bg-accent text-accent-foreground font-medium"
                            : "text-foreground hover:bg-muted",
                        )}
                      >
                        <Icon
                          className="h-[18px] w-[18px]"
                          aria-hidden="true"
                        />
                        <span>{item.label}</span>
                      </Link>
                    ) : (
                      <span
                        key={item.key}
                        aria-disabled="true"
                        className="flex cursor-not-allowed items-center gap-2.5 rounded-md px-3 py-2 text-sm text-muted-foreground"
                      >
                        <Icon
                          className="h-[18px] w-[18px] opacity-50"
                          aria-hidden="true"
                        />
                        <span className="flex-1 opacity-60">{item.label}</span>
                        <span className="rounded-sm border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Soon
                        </span>
                      </span>
                    );
                  }),
                ])}
              </nav>
            </SheetContent>
          </Sheet>

          {/* Mobile wordmark — hidden on desktop */}
          <Link
            href="/"
            className="flex items-center gap-2 lg:hidden"
            aria-label="Face Attendance home"
          >
            <span
              aria-hidden="true"
              className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground"
            >
              <BrandMark />
            </span>
            <span className="text-sm font-semibold tracking-tight">
              Face Attendance
            </span>
          </Link>

          {/* Desktop-only context label */}
          {context ? (
            <div className="ml-2 hidden text-sm text-muted-foreground md:block">
              {context}
            </div>
          ) : null}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle />
          {user ? (
            <UserMenu
              user={{
                name: user.name,
                email: user.email,
                image: user.image,
                roleLabel: user.role === "teacher" ? "Teacher" : "Student",
              }}
            />
          ) : null}
        </div>
      </header>
    </TooltipProvider>
  );
}

function BrandMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      className="h-4 w-4"
    >
      <path
        d="M4 8.5C4 6.01 6.01 4 8.5 4H10v3H8.5A1.5 1.5 0 0 0 7 8.5V10H4V8.5Z"
        fill="currentColor"
      />
      <path
        d="M20 8.5V10h-3V8.5A1.5 1.5 0 0 0 15.5 7H14V4h1.5C17.99 4 20 6.01 20 8.5Z"
        fill="currentColor"
      />
      <path
        d="M15.5 20H14v-3h1.5a1.5 1.5 0 0 0 1.5-1.5V14h3v1.5c0 2.49-2.01 4.5-4.5 4.5Z"
        fill="currentColor"
      />
      <path
        d="M4 14h3v1.5A1.5 1.5 0 0 0 8.5 17H10v3H8.5C6.01 20 4 17.99 4 15.5V14Z"
        fill="currentColor"
      />
      <circle cx="12" cy="11.5" r="2.25" fill="currentColor" />
    </svg>
  );
}
