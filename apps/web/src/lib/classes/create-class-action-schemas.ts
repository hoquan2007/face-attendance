/**
 * Validation schemas for the PHASE 5.1B create-class Server
 * Action.
 *
 * PHASE 5.1E2 — split out of `create-class-action.ts` so the
 * action module only exports `async` functions (the
 * `"use server"` boundary constraint imposed by Next.js 16.3.4).
 *
 * The schema definitions are server-only — they validate
 * browser-supplied input against the canonical constraints defined
 * in `apps/web/src/lib/classes/class-model.ts`. The schemas never
 * run in a Client Component bundle; the action imports them and
 * applies them inside the Server Action body.
 */

import "server-only";

import { z } from "zod";

/**
 * Class name validation.
 *
 * Mirrors the model-level constraints (trim + 1..200 chars). The
 * schema accepts whatever the browser supplies and emits the
 * canonical trimmed representation to the service. The browser
 * cannot bypass the trim because the schema runs `trim` first via
 * `z.preprocess`.
 */
export const ClassNameSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z
    .string({ error: "Class name is required." })
    .min(1, "Class name must not be empty.")
    .max(200, "Class name must be at most 200 characters."),
);

/**
 * Class password validation.
 *
 * Deliberately restrained:
 *
 *   - must be a non-empty string,
 *   - must be at least 4 characters (a trivial floor that blocks
 *     accidental empty / single-character submissions; the
 *     cryptography is bounded by PBKDF2 not by length),
 *   - must be at most 128 characters (an explicit cap that
 *     protects the async PBKDF2 path from pathological inputs).
 *
 * The password is NEVER trimmed or transformed by this action.
 * Whitespace, casing, and any other byte are preserved exactly so
 * that the teacher's choice is the persisted choice.
 */
export const ClassPasswordSchema = z
  .string({ error: "Class password is required." })
  .min(4, "Class password must be at least 4 characters.")
  .max(128, "Class password must be at most 128 characters.");

/**
 * Browser-supplied input shape.
 *
 * Only `name` and `password` are accepted. The schema strips any
 * other keys via `.strict()`, so a hand-crafted client cannot
 * smuggle `teacherUserId`, `classCode`, `role`, `passwordHash`,
 * `status`, `createdAt`, or `_id` through this action.
 */
export const CreateClassInputSchema = z
  .object({
    name: ClassNameSchema,
    password: ClassPasswordSchema,
  })
  .strict();

export type CreateClassBrowserInput = z.infer<typeof CreateClassInputSchema>;
