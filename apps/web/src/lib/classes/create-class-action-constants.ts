/**
 * Server-side constant for the PHASE 5.1B create-class action.
 *
 * This module exists ONLY to host non-`async` exports from the
 * Server Action family. Next.js 16.3.4's `"use server"` boundary
 * only allows `async` functions to be exported from such a module;
 * this companion file lives outside the `"use server"` boundary
 * and re-exports the constant for non-action callers (tests,
 * helper utilities).
 *
 * The action module itself still owns the runtime constant — see
 * `apps/web/src/lib/classes/create-class-action.ts`.
 */

/**
 * Maximum number of insert attempts the action will perform for a
 * single teacher invocation. The first attempt is unconditional;
 * the remaining `MAX_CLASS_CODE_ATTEMPTS - 1` slots are reserved
 * for retried `classCode` collisions only.
 *
 * The unique index on `classCode` plus the 32-symbol alphabet make
 * collisions astronomically unlikely (≈1 in 32⁷ ≈ 1 in 3.4×10¹⁰),
 * so this small ceiling is more than enough headroom. If every
 * attempt collides we surface `CLASS_CODE_GENERATION_FAILED` —
 * the loop is intentionally bounded and never unbounded.
 */
export const MAX_CLASS_CODE_ATTEMPTS = 5;
