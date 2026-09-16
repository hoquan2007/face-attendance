/**
 * Navigation model — single source of truth for sidebar / mobile
 * nav / future shortcuts.
 *
 * Phase 2.5 only routes Dashboard and Profile to live pages.
 * All other items are flagged "coming_soon" so we never render a
 * navigation link to a non-existent page.
 *
 * Items are grouped under `group` headings:
 *   - Overview
 *   - Workspace (classes/attendance)
 *   - Account
 *
 * `icon` is a Lucide icon component. The keys are stable for
 * persistence / future keyboard shortcuts.
 */
import {
  Building2,
  CalendarCheck2,
  ClipboardList,
  GraduationCap,
  History,
  LayoutDashboard,
  ScanFace,
  Settings,
  UserCircle2,
  Users2,
  Wand2,
} from "lucide-react";
import type { ComponentType } from "react";

export type NavKey =
  | "dashboard"
  | "classes"
  | "attendance"
  | "history"
  | "profile"
  | "face_id"
  | "settings";

export type NavStatus = "ready" | "coming_soon";

export interface NavItem {
  key: NavKey;
  label: string;
  icon: ComponentType<{ className?: string }>;
  href?: string;
  status: NavStatus;
  tooltip?: string;
}

export interface NavGroup {
  id: string;
  label?: string;
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    id: "overview",
    label: "Overview",
    items: [
      {
        key: "dashboard",
        label: "Dashboard",
        icon: LayoutDashboard,
        href: "/dashboard",
        status: "ready",
      },
    ],
  },
  {
    id: "workspace",
    label: "Workspace",
    items: [
      {
        key: "classes",
        label: "Classes",
        icon: Users2,
        href: "/classes",
        status: "ready",
      },
      {
        key: "attendance",
        label: "Attendance",
        icon: CalendarCheck2,
        status: "coming_soon",
        tooltip: "Attendance sessions arrive in a later phase.",
      },
      {
        key: "history",
        label: "History",
        icon: History,
        status: "coming_soon",
        tooltip: "Attendance history arrives in a later phase.",
      },
    ],
  },
  {
    id: "account",
    label: "Account",
    items: [
      {
        key: "profile",
        label: "Profile",
        icon: UserCircle2,
        href: "/profile",
        status: "ready",
      },
      {
        key: "face_id",
        label: "Face ID",
        icon: ScanFace,
        href: "/face-id",
        status: "ready",
      },
      {
        key: "settings",
        label: "Settings",
        icon: Settings,
        status: "coming_soon",
        tooltip: "Settings arrive in a later phase.",
      },
    ],
  },
];

/**
 * Role-aware labels for items that have alternate display names
 * between student and teacher.
 */
export const ROLE_LABELS = {
  student: {
    classes: "My Classes",
    classesIcon: GraduationCap,
    attendance: "Join Class",
    attendanceIcon: ClipboardList,
  },
  teacher: {
    classes: "Classes",
    classesIcon: Building2,
    attendance: "Attendance",
    attendanceIcon: Wand2,
  },
} as const;
