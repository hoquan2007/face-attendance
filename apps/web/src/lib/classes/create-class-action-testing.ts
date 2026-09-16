/**
 * Test-only exports for the PHASE 5.1B create-class Server Action.
 *
 * This module lives OUTSIDE the `"use server"` boundary so tests
 * can import the internal schemas + helpers without Next.js 16.3.4
 * rejecting the import. The corresponding action module
 * (`create-class-action.ts`) only ships `async` exports — see the
 * file header for the rationale.
 *
 * This is a server-only module. Tests import it directly because
 * the Vitest environment aliases `server-only` to a no-op stub
 * (see `apps/web/tests/stubs/server-only.ts`).
 */

import "server-only";

import {
  ClassNameSchema,
  ClassPasswordSchema,
  CreateClassInputSchema,
} from "./create-class-action-schemas";
import {
  CREATE_CLASS_ACTION_ERROR_MESSAGES,
  CREATE_CLASS_ACTION_RETRYABLE,
} from "./create-class-action-types";
import {
  assertAttemptsCeiling as _assertAttemptsCeiling,
  buildError as _buildError,
  toSafeError as _toSafeError,
} from "./create-class-action-helpers";

/**
 * Test-only surface. The shape mirrors the original `__testing`
 * export that lived in the action module before PHASE 5.1E2 split
 * it out to satisfy the `"use server"` boundary.
 */
export const __testing = {
  CreateClassInputSchema,
  ClassNameSchema,
  ClassPasswordSchema,
  ERROR_MESSAGES: CREATE_CLASS_ACTION_ERROR_MESSAGES,
  RETRYABLE: CREATE_CLASS_ACTION_RETRYABLE,
  buildError: _buildError,
  toSafeError: _toSafeError,
  assertAttemptsCeiling: _assertAttemptsCeiling,
};
