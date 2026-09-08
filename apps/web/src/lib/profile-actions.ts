"use server";

/**
 * Server Actions for Phase 2 profile mutations.
 *
 * These actions are invoked from the onboarding form and the profile
 * edit form. They:
 *
 *   1. Validate the real Better Auth session server-side.
 *   2. Parse form data with the appropriate Zod schema.
 *   3. Use `session.user.id` and `session.user.email` as the
 *      authoritative identity — never client-supplied values.
 *   4. Delegate to the Profile service for persistence.
 *   5. Return a serializable result object that the client form can
 *      render (errors or success).
 *
 * Onboarding success redirects via `redirect('/dashboard')`. Profile
 * update success returns a result; the page calls `router.refresh()`.
 *
 * Server Actions run as POST requests and are protected by Next.js's
 * built-in CSRF / encrypted-action-id mechanisms, but we still verify
 * the session inside each action (treat the action as an untrusted
 * entry point).
 */

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { getSession } from "@/lib/session";
import {
  updateProfile,
  upsertOnboarding,
} from "@/lib/profile-service";
import {
  PROFILE_ERROR_CODES,
  ProfileError,
  type ProfileErrorShape,
} from "@/lib/profile-errors";

/**
 * Action result shape shared by the onboarding and profile-edit
 * client components.
 */
export type ActionResult =
  | { ok: true }
  | {
      ok: false;
      error: ProfileErrorShape;
    };

/**
 * Converts an arbitrary thrown value into a serializable action result.
 *
 * `redirect()` throws a `NEXT_REDIRECT` control-flow exception that
 * Next.js handles internally; we must let it bubble up.
 */
function toErrorResult(err: unknown): ActionResult {
  if (err instanceof ProfileError) {
    return { ok: false, error: err.toJSON() };
  }
  // `redirect()` throws an Error with a `digest` starting with
  // "NEXT_REDIRECT". Re-throw so Next.js can complete the redirect.
  if (
    err &&
    typeof err === "object" &&
    "digest" in err &&
    typeof (err as { digest?: unknown }).digest === "string" &&
    ((err as { digest: string }).digest as string).startsWith("NEXT_REDIRECT")
  ) {
    throw err;
  }
  return {
    ok: false,
    error: {
      code: PROFILE_ERROR_CODES.UNKNOWN_ERROR,
      message: "An unexpected error occurred. Please try again.",
    },
  };
}

/**
 * Reads and validates the current Better Auth session.
 *
 * Returns `null` when the session is missing or invalid. Action
 * functions use this to decide between UNAUTHENTICATED and the rest
 * of the validation pipeline.
 */
async function requireSessionUser() {
  const session = await getSession();
  if (!session) return null;
  return session.user;
}

/**
 * Onboarding Server Action.
 *
 * Accepts a `FormData` payload produced by the multi-step onboarding
 * form. Required fields:
 *   - `role`           ("student" | "teacher")
 *   - `fullName`       (string, 2–100)
 *   - `identificationCode` (string, 2–50)
 *   - `phone`          (string, optional, max 32)
 *
 * On success, redirects to `/dashboard`. On failure, returns an
 * ActionResult that the client form can render.
 */
export async function submitOnboarding(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireSessionUser();
  if (!user) {
    return {
      ok: false,
      error: {
        code: PROFILE_ERROR_CODES.UNAUTHENTICATED,
        message: "You must be signed in to complete onboarding.",
      },
    };
  }

  const raw = {
    role: formData.get("role"),
    fullName: formData.get("fullName"),
    identificationCode: formData.get("identificationCode"),
    phone: formData.get("phone") || undefined,
  };

  try {
    await upsertOnboarding(user.id, user.email, raw);
  } catch (err) {
    return toErrorResult(err);
  }

  // Re-render the dashboard with the freshly persisted profile.
  revalidatePath("/dashboard");
  revalidatePath("/onboarding");
  redirect("/dashboard");
}

/**
 * Profile edit Server Action.
 *
 * Accepts a `FormData` payload from the profile edit form. Required:
 *   - `fullName`, `identificationCode`, `phone?`.
 *
 * The role is intentionally NOT editable via this action.
 *
 * On success, returns `{ ok: true }`; the client form is expected to
 * call `router.refresh()` to re-render.
 */
export async function submitProfileUpdate(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireSessionUser();
  if (!user) {
    return {
      ok: false,
      error: {
        code: PROFILE_ERROR_CODES.UNAUTHENTICATED,
        message: "You must be signed in to update your profile.",
      },
    };
  }

  const raw = {
    fullName: formData.get("fullName"),
    identificationCode: formData.get("identificationCode"),
    phone: formData.get("phone") || undefined,
  };

  try {
    await updateProfile(user.id, raw);
  } catch (err) {
    return toErrorResult(err);
  }

  revalidatePath("/profile");
  revalidatePath("/dashboard");
  return { ok: true };
}