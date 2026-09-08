"use client";

import { Moon, Sun, LogOut } from "lucide-react";
import { useTheme } from "next-themes";
import Link from "next/link";
import * as React from "react";

import { useSignOutHandler } from "@/components/SignOutButton";
import { Avatar } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * UserMenu — header right-side avatar dropdown.
 *
 * Contains:
 *   - Profile link
 *   - Theme switcher (Light / Dark)
 *   - Sign out
 */
export interface UserMenuProps {
  user: {
    name: string;
    email: string;
    image: string | null;
    roleLabel: string;
  };
  className?: string;
}

export function UserMenu({ user, className }: UserMenuProps) {
  const { resolvedTheme, setTheme } = useTheme();
  const { handleSignOut, isLoading } = useSignOutHandler();
  const isDark = resolvedTheme === "dark";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Open user menu"
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-md px-1.5",
          "hover:bg-muted",
          "transition-colors duration-[var(--motion-base)]",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
          className,
        )}
      >
        <Avatar
          src={user.image ?? undefined}
          name={user.name}
          alt={user.name}
          size="md"
        />
        <span className="hidden text-left leading-tight lg:flex lg:flex-col">
          <span className="text-xs font-medium">{user.name}</span>
          <span className="text-[10px] text-muted-foreground">
            {user.roleLabel}
          </span>
        </span>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="min-w-[14rem]">
        <div className="flex items-center gap-3 p-2">
          <Avatar
            src={user.image ?? undefined}
            name={user.name}
            alt={user.name}
            size="lg"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {user.name}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {user.email}
            </p>
            <p className="mt-1 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              {user.roleLabel}
            </p>
          </div>
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <Link href="/profile">
            Profile
          </Link>
        </DropdownMenuItem>

        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>

        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            setTheme("light");
          }}
        >
          <Sun
            aria-hidden="true"
            className={cn(
              "h-4 w-4",
              !isDark ? "text-primary" : "text-muted-foreground",
            )}
          />
          <span className="flex-1">Light</span>
          {!isDark ? (
            <span className="text-[10px] font-semibold text-primary">Active</span>
          ) : null}
        </DropdownMenuItem>

        <DropdownMenuItem
          onSelect={(e) => {
            e.preventDefault();
            setTheme("dark");
          }}
        >
          <Moon
            aria-hidden="true"
            className={cn(
              "h-4 w-4",
              isDark ? "text-primary" : "text-muted-foreground",
            )}
          />
          <span className="flex-1">Dark</span>
          {isDark ? (
            <span className="text-[10px] font-semibold text-primary">Active</span>
          ) : null}
        </DropdownMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuItem
          onSelect={() => {
            void handleSignOut();
          }}
          disabled={isLoading}
          aria-busy={isLoading || undefined}
          className="text-destructive focus:bg-destructive-soft focus:text-destructive"
        >
          <LogOut aria-hidden="true" className="h-4 w-4" />
          <span>{isLoading ? "Signing out..." : "Sign out"}</span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
