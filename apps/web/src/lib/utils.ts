import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * `cn` — conditional className builder used across the design system.
 *
 * Combines `clsx` (conditional resolution) with `tailwind-merge` (removes
 * conflicting Tailwind classes so the last declaration wins). This is
 * the standard shadcn/ui helper.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
