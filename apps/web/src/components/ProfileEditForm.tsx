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
    <form action={formAction} className="flex flex-col gap-5">
      {/* Identity card */}
      <div className="flex items-center gap-4 rounded-md border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/40">
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt={`${fullName} avatar`}
            width={56}
            height={56}
            className="h-14 w-14 rounded-full border border-slate-200 object-cover dark:border-slate-700"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-14 w-14 items-center justify-center rounded-full bg-slate-200 text-xl font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300"
          >
            {fullName.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="flex flex-col">
          <span className="text-base font-medium text-slate-900 dark:text-slate-50">
            {fullName}
          </span>
          <span className="text-sm text-slate-500 dark:text-slate-400">
            {email}
          </span>
          <span className="mt-1 text-xs uppercase tracking-widest text-slate-400 dark:text-slate-500">
            Role: {role}
          </span>
        </div>
      </div>

      <Field
        label="Full name"
        name="fullName"
        required
        defaultValue={fullName}
        error={state && !state.ok ? state.error.fieldErrors?.fullName?.[0] : undefined}
      />

      <Field
        label="Identification code"
        name="identificationCode"
        required
        defaultValue={identificationCode}
        error={
          state && !state.ok
            ? state.error.fieldErrors?.identificationCode?.[0]
            : undefined
        }
      />

      <Field
        label="Phone"
        name="phone"
        required={false}
        defaultValue={phone ?? ""}
        helpText="Optional."
        error={state && !state.ok ? state.error.fieldErrors?.phone?.[0] : undefined}
      />

      {state && !state.ok && !state.error.fieldErrors && (
        <p
          role="alert"
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
        >
          {state.error.message}
        </p>
      )}

      {state && state.ok && (
        <p
          role="status"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-200"
        >
          Profile updated.
        </p>
      )}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className="inline-flex items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
        >
          {pending ? "Saving..." : "Save changes"}
        </button>
      </div>
    </form>
  );
}

interface FieldProps {
  label: string;
  name: string;
  required: boolean;
  defaultValue?: string;
  helpText?: string;
  error?: string;
}

function Field({
  label,
  name,
  required,
  defaultValue,
  helpText,
  error,
}: FieldProps) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={name} className="text-sm font-medium text-slate-700 dark:text-slate-300">
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <input
        id={name}
        name={name}
        type="text"
        required={required}
        defaultValue={defaultValue}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${name}-error` : helpText ? `${name}-help` : undefined}
        className={`rounded-md border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 dark:bg-slate-900 dark:text-slate-50 ${
          error
            ? "border-red-400 dark:border-red-500"
            : "border-slate-300 dark:border-slate-700"
        }`}
      />
      {error ? (
        <p id={`${name}-error`} className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      ) : helpText ? (
        <p id={`${name}-help`} className="text-xs text-slate-500 dark:text-slate-400">
          {helpText}
        </p>
      ) : null}
    </div>
  );
}