import * as React from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * StatusBadge — semantic badge used for attendance-style states
 * and other role-aware identity pills.
 *
 * Tones are deliberately aligned with the future attendance status
 * colours documented in `docs/frontend-design.md` so the colour
 * language is consistent before attendance is implemented:
 *   - present   → success
 *   - late      → warning
 *   - absent    → destructive
 *   - active    → info
 *   - pending   → neutral
 *   - unknown   → neutral
 */
export type StatusTone =
  | "present"
  | "late"
  | "absent"
  | "active"
  | "pending"
  | "unknown"
  | "success"
  | "warning"
  | "info"
  | "destructive";

const toneToVariant: Record<
  StatusTone,
  "success" | "warning" | "destructive" | "info" | "neutral"
> = {
  present: "success",
  success: "success",
  late: "warning",
  warning: "warning",
  absent: "destructive",
  destructive: "destructive",
  active: "info",
  info: "info",
  pending: "neutral",
  unknown: "neutral",
};

export interface StatusBadgeProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, "children"> {
  tone: StatusTone;
  label: React.ReactNode;
  icon?: React.ReactNode;
}

export function StatusBadge({
  tone,
  label,
  icon,
  className,
  ...props
}: StatusBadgeProps) {
  return (
    <Badge tone={toneToVariant[tone]} className={cn(className)} {...props}>
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      <span>{label}</span>
    </Badge>
  );
}
