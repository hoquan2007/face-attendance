"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import * as React from "react";

import { NAV_GROUPS, type NavItem } from "@/components/layout/nav-config";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * AppSidebar — desktop navigation rail.
 *
 * Visual targets:
 *   - Width: 240px (within the 232–240px range from the design doc).
 *   - Background: slightly muted/off-white in light; one shade
 *     darker than the canvas. Sits visually quieter than the main
 *     workspace.
 *   - Border-right: 1px subtle border.
 *   - Items:
 *       - Inactive  : muted icon + text, transparent background
 *       - Hover     : soft neutral background
 *       - Active    : subtle primary-tinted background + strong text
 *                     + primary icon (NOT a fully saturated blue
 *                     rectangle)
 *
 * Coming-soon items are visually disabled (`opacity-60` +
 * `cursor-not-allowed`) and tooltip-explained. They never link
 * to a page.
 */
export function AppSidebar() {
  const pathname = usePathname();

  return (
    <aside
      aria-label="Primary"
      className={cn(
        "hidden lg:flex lg:w-60 lg:shrink-0 lg:flex-col",
        "bg-sidebar text-sidebar-foreground",
        "border-r border-sidebar-border",
      )}
    >
      <div className="flex h-full flex-col">
        <SidebarBrand />
        <nav className="flex-1 overflow-y-auto px-3 pb-6 pt-2">
          {NAV_GROUPS.map((group) => (
            <div key={group.id} className="mt-4 first:mt-2">
              {group.label ? (
                <p className="px-3 pb-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </p>
              ) : null}
              <ul className="flex flex-col gap-0.5">
                {group.items.map((item) => (
                  <li key={item.key}>
                    <SidebarLink item={item} pathname={pathname} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
        <SidebarFooter />
      </div>
    </aside>
  );
}

function SidebarBrand() {
  return (
    <Link
      href="/"
      className={cn(
        "flex h-[60px] items-center gap-2 px-5",
        "border-b border-sidebar-border",
        "transition-colors duration-[var(--motion-base)] hover:bg-sidebar-accent",
      )}
    >
      <span
        aria-hidden="true"
        className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-primary-foreground"
      >
        <BrandMark />
      </span>
      <span className="flex flex-col leading-tight">
        <span className="text-sm font-semibold tracking-tight text-foreground">
          Face Attendance
        </span>
        <span className="text-[11px] text-muted-foreground">
          Phase 2 preview
        </span>
      </span>
    </Link>
  );
}

function SidebarFooter() {
  return (
    <div className="border-t border-sidebar-border px-5 py-4">
      <p className="text-[11px] leading-[15px] text-muted-foreground">
        Phase 2 ships authentication, profiles, and role-aware
        onboarding. Attendance arrives later.
      </p>
    </div>
  );
}

function SidebarLink({
  item,
  pathname,
}: {
  item: NavItem;
  pathname: string | null;
}) {
  const Icon = item.icon;
  const ready = item.status === "ready" && item.href;
  const active = ready && item.href && pathname?.startsWith(item.href);

  const linkClasses = cn(
    "group flex items-center gap-2.5 rounded-md px-3 py-2 text-sm",
    "transition-colors duration-[var(--motion-base)] ease-[var(--easing-standard)]",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar",
    active
      ? "bg-accent text-accent-foreground font-medium"
      : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  );

  const content = (
    <>
      <Icon
        className={cn(
          "h-[18px] w-[18px] shrink-0",
          active ? "text-primary" : "text-muted-foreground",
          !ready && "opacity-50",
          ready && "group-hover:text-foreground",
        )}
        aria-hidden="true"
      />
      <span className={cn("flex-1", !ready && "opacity-60")}>
        {item.label}
      </span>
      {!ready ? (
        <span className="rounded-sm border border-border bg-surface px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          Soon
        </span>
      ) : null}
    </>
  );

  if (ready) {
    return (
      <Link href={item.href!} className={linkClasses}>
        {content}
      </Link>
    );
  }

  const fallback = (
    <span
      aria-disabled="true"
      className={cn(linkClasses, "cursor-not-allowed")}
    >
      {content}
    </span>
  );

  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        {/* The trigger needs a focusable element to show the tooltip
            on focus. We wrap the non-interactive span in a focusable
            div. */}
        <div tabIndex={0} className="rounded-md focus:outline-none">
          {fallback}
        </div>
      </TooltipTrigger>
      {item.tooltip ? (
        <TooltipContent>{item.tooltip}</TooltipContent>
      ) : null}
    </Tooltip>
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
