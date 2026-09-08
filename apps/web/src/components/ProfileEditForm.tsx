/**
 * Profile edit form (client component).
 *
 * Allows the user to edit their fullName, identificationCode, and
 * phone. The role is intentionally rendered read-only here: Phase 2
 * does not support role changes from the regular profile-edit page.
 *
 * The Google avatar and email are displayed read-only.
 *
 * The action result drives both inline field errors and the top-level
 * banner.
 */

"use client";

import { useActionState } from "react";

import {
  submitProfileUpdate,
  type ActionResult,
} from "@/lib/profile-actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";

interface ProfileEditFormProps {
  email: string;
  fullName: string;
  role: "student" | "teacher";
  identificationCode: string;
  phone: string | null;
  avatarUrl: string | null;
}

const initialState: ActionResult | undefined = undefined;

export function ProfileEditForm({
  email,
  fullName,
  role,
  identificationCode,
  phone,
  avatarUrl,
}: ProfileEditFormProps) {
  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    submitProfileUpdate,
    initialState,
  );

  return (
    <form action={formAction} className="flex flex-col gap-6">
      {/* Identity card — Google email, avatar, read-only */}
      <div className="flex items-center gap-4 rounded-xl border border-border bg-muted/60 p-4">
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt={`${fullName} avatar`}
            width={56}
            height={56}
            className="h-14 w-14 rounded-full border border-border object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex h-14 w-14 items-center justify-center rounded-full border border-border bg-muted text-xl font-semibold text-muted-foreground">
            {fullName.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">
            {fullName}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {email}
          </span>
          <span className="mt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            {role}
          </span>
        </div>
      </div>

      <Separator />

      <div className="flex flex-col gap-5">
        <Field
          label="Full name"
          name="fullName"
          required
          defaultValue={fullName}
          error={
            state && !state.ok ? state.error.fieldErrors?.fullName?.[0] : undefined
          }
        />

        <Field
          label="Identification code"
          name="identificationCode"
          required
          defaultValue={identificationCode}
          hint="Must be unique across all users."
          error={
            state && !state.ok
              ? state.error.fieldErrors?.identificationCode?.[0]
              : undefined
          }
        />

        <Field
          label="Phone"
          name="phone"
          type="tel"
          required={false}
          defaultValue={phone ?? ""}
          hint="Optional."
          error={
            state && !state.ok ? state.error.fieldErrors?.phone?.[0] : undefined
          }
        />

        {state && !state.ok && !state.error.fieldErrors && (
          <p
            role="alert"
            className="rounded-md border border-destructive/30 bg-destructive-soft px-3 py-2.5 text-sm text-destructive"
          >
            {state.error.message}
          </p>
        )}

        {state && state.ok && (
          <p
            role="status"
            className="rounded-md border border-success/30 bg-success-soft px-3 py-2.5 text-sm text-success"
          >
            Profile updated.
          </p>
        )}
      </div>

      <Separator />

      <div className="flex justify-end">
        <Button
          type="submit"
          size="lg"
          loading={pending}
          disabled={pending}
        >
          {pending ? "Saving..." : "Save changes"}
        </Button>
      </div>
    </form>
  );
}
