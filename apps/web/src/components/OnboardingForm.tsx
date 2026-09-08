/**
 * Onboarding multi-step form (client component).
 *
 * Renders a two-step flow:
 *   1. Choose role (student or teacher).
 *   2. Enter personal information (full name, identification code, phone).
 *
 * Uses the `useActionState` React hook to surface server validation
 * errors, duplicate-identification-code errors, and generic server
 * errors.
 *
 * The Google email is rendered read-only. The user can NEVER edit the
 * authenticated email from this form.
 *
 * All identity-bearing fields (`userId`, `email`) are derived server-
 * side from the Better Auth session. The browser only submits role /
 * fullName / identificationCode / phone.
 */

"use client";

import { useActionState, useState } from "react";

import {
  submitOnboarding,
  type ActionResult,
} from "@/lib/profile-actions";

type Role = "student" | "teacher";

interface OnboardingFormProps {
  email: string;
  fullName: string;
  avatarUrl: string | null;
}

const initialState: ActionResult | undefined = undefined;

export function OnboardingForm({
  email,
  fullName,
  avatarUrl,
}: OnboardingFormProps) {
  const [role, setRole] = useState<Role | null>(null);
  const [step, setStep] = useState<1 | 2>(1);

  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    submitOnboarding,
    initialState,
  );

  function nextStep() {
    if (role) setStep(2);
  }

  function backStep() {
    setStep(1);
  }

  return (
    <form action={formAction} className="flex flex-col gap-8">
      {step === 1 ? (
        <section className="flex flex-col gap-4" aria-labelledby="role-heading">
          <header>
            <h2 id="role-heading" className="text-lg font-semibold">
              Choose your role
            </h2>
            <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
              You will use Face Attendance differently depending on whether
              you join classes or create them.
            </p>
          </header>

          <fieldset className="flex flex-col gap-3">
            <legend className="sr-only">Select your role</legend>

            <RoleCard
              name="role"
              value="student"
              title="Student"
              description="Join classes and track attendance."
              checked={role === "student"}
              onSelect={() => setRole("student")}
            />
            <RoleCard
              name="role"
              value="teacher"
              title="Teacher"
              description="Create classes and manage attendance."
              checked={role === "teacher"}
              onSelect={() => setRole("teacher")}
            />
          </fieldset>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={nextStep}
              disabled={!role}
              className="inline-flex items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
            >
              Continue
            </button>
          </div>
        </section>
      ) : (
        <section className="flex flex-col gap-4" aria-labelledby="profile-heading">
          <header className="flex items-center gap-3">
            {avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={avatarUrl}
                alt={`${fullName} avatar`}
                width={40}
                height={40}
                className="h-10 w-10 rounded-full border border-slate-200 object-cover dark:border-slate-700"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div
                aria-hidden="true"
                className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-200 text-base font-semibold text-slate-600 dark:bg-slate-700 dark:text-slate-300"
              >
                {fullName.charAt(0).toUpperCase()}
              </div>
            )}
            <div className="flex flex-col">
              <span className="text-sm font-medium text-slate-900 dark:text-slate-50">
                {fullName}
              </span>
              <span className="text-xs text-slate-500 dark:text-slate-400">
                {email}
              </span>
            </div>
          </header>

          <h2 id="profile-heading" className="text-lg font-semibold">
            Personal information
          </h2>

          {/* Hidden field that carries the selected role to the server */}
          <input type="hidden" name="role" value={role ?? ""} />

          <Field
            label="Full name"
            name="fullName"
            required
            defaultValue=""
            placeholder="e.g. Nguyen Van A"
            error={state && !state.ok ? state.error.fieldErrors?.fullName?.[0] : undefined}
          />

          <Field
            label="Identification code"
            name="identificationCode"
            required
            placeholder="Student or teacher code"
            helpText="Used to identify you inside your classes."
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
            placeholder="Optional"
            helpText="Optional. We never share this with other users."
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

          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={backStep}
              disabled={pending}
              className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-900 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-50 dark:hover:bg-slate-800"
            >
              Back
            </button>
            <button
              type="submit"
              disabled={pending}
              aria-busy={pending}
              className="inline-flex items-center justify-center rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-60 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
            >
              {pending ? "Saving..." : "Complete onboarding"}
            </button>
          </div>
        </section>
      )}
    </form>
  );
}

interface RoleCardProps {
  name: string;
  value: Role;
  title: string;
  description: string;
  checked: boolean;
  onSelect: () => void;
}

function RoleCard({
  name,
  value,
  title,
  description,
  checked,
  onSelect,
}: RoleCardProps) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 transition ${
        checked
          ? "border-slate-900 bg-slate-50 dark:border-slate-100 dark:bg-slate-800"
          : "border-slate-200 bg-white hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:hover:border-slate-600"
      }`}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        className="mt-1 h-4 w-4 cursor-pointer accent-slate-900"
      />
      <span className="flex flex-col">
        <span className="text-sm font-semibold text-slate-900 dark:text-slate-50">
          {title}
        </span>
        <span className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          {description}
        </span>
      </span>
    </label>
  );
}

interface FieldProps {
  label: string;
  name: string;
  required: boolean;
  defaultValue?: string;
  placeholder?: string;
  helpText?: string;
  error?: string;
}

function Field({
  label,
  name,
  required,
  defaultValue,
  placeholder,
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
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${name}-error` : helpText ? `${name}-help` : undefined}
        className={`rounded-md border bg-white px-3 py-2 text-sm text-slate-900 shadow-sm placeholder:text-slate-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-500 dark:bg-slate-900 dark:text-slate-50 ${
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