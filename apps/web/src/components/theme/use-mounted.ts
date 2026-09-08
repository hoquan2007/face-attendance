"use client";

import { useSyncExternalStore } from "react";

/**
 * `useMounted` — returns `true` after the component has mounted on
 * the client. Useful for guarding theme-dependent UI to avoid
 * hydration mismatches.
 *
 * Uses `useSyncExternalStore` (React 18+ stable API) so no effect
 * is needed and the lint rule does not fire.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(
    () => () => {
      /* no-op unsubscribe */
    },
    () => true, // client snapshot: always true
    () => false, // server snapshot: always false
  );
}
