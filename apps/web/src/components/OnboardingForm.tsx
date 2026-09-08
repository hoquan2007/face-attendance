/**
 * Onboarding multi-step form (client component).
 *
 * Renders a two-step flow:
 *   1. Choose role (student or teacher).
 *   2. Enter personal information (full name, identification code, phone).
 *
 * Uses `useActionState` to surface server validation errors,
 * duplicate-identification-code errors, and generic server errors.
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

import { submitOnboarding, type ActionResult } from "@/lib/profile-actions";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Separator } from "@/components/ui/separator";
import { Stepper } from "@/components/layout/Stepper";
import { cn } from "@/lib/utils";

type Role = "student" | "teacher";

interface OnboardingFormProps {
  email: string;
  fullName: string;
  avatarUrl: string | null;
}

const STEPS = ["Role", "Information"] as const;
const initialState: ActionResult | undefined = undefined;

export function OnboardingForm({
  email,
  fullName,
  avatarUrl,
}: OnboardingFormProps) {
  const [role, setRole] = useState<Role | null>(null);
  const [step, setStep] = useState<0 | 1>(0);

  const [state, formAction, pending] = useActionState<ActionResult | undefined, FormData>(
    submitOnboarding,
    initialState,
  );

  const goNext = () => {
    if (role !== null) setStep(1);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Step indicator */}
      <Stepper steps={[...STEPS]} currentStep={step} />

      <Separator />

      {step === 0 ? (
        <RoleStep
          role={role}
          onSelect={(r) => setRole(r)}
          onNext={goNext}
        />
      ) : (
        <InformationStep
          role={role!}
          email={email}
          fullName={fullName}
          avatarUrl={avatarUrl}
          state={state}
          formAction={formAction}
          pending={pending}
          onBack={() => setStep(0)}
        />
      )}
    </div>
  );
}

function RoleStep({
  role,
  onSelect,
  onNext,
}: {
  role: Role | null;
  onSelect: (r: Role) => void;
  onNext: () => void;
}) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h2 className="text-[18px] leading-[26px] font-semibold tracking-tight text-foreground">
          Choose your role
        </h2>
        <p className="text-sm leading-[21px] text-muted-foreground">
          You will use Face Attendance differently depending on whether
          you join classes or create them.
        </p>
      </div>

      <fieldset className="flex flex-col gap-3">
        <legend className="sr-only">Select your role</legend>

        <RoleCard
          name="role"
          value="student"
          title="Student"
          description="Join classes created by teachers and track your own attendance."
          checked={role === "student"}
          onSelect={() => onSelect("student")}
        />
        <RoleCard
          name="role"
          value="teacher"
          title="Teacher"
          description="Create classes, run attendance sessions, and review attendance history."
          checked={role === "teacher"}
          onSelect={() => onSelect("teacher")}
        />
      </fieldset>

      <div className="flex justify-end">
        <Button
          type="button"
          onClick={onNext}
          disabled={role === null}
          size="lg"
        >
          Continue
        </Button>
      </div>
    </div>
  );
}

function RoleCard({
  name,
  value,
  title,
  description,
  checked,
  onSelect,
}: {
  name: string;
  value: Role;
  title: string;
  description: string;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <label
      className={cn(
        "group flex cursor-pointer items-start gap-3 rounded-xl border p-4",
        "transition-colors duration-[var(--motion-base)] ease-[var(--easing-standard)]",
        checked
          ? "border-primary bg-accent"
          : "border-border bg-surface hover:border-border-strong",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onSelect}
        className="sr-only"
      />
      <span
        className={cn(
          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2",
          checked
            ? "border-primary bg-primary"
            : "border-border-strong bg-surface",
          "transition-colors duration-[var(--motion-base)]",
        )}
        aria-hidden="true"
      >
        {checked && (
          <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
        )}
      </span>
      <span className="flex flex-col gap-1">
        <span className="text-sm font-semibold text-foreground">{title}</span>
        <span className="text-sm leading-[21px] text-muted-foreground">
          {description}
        </span>
      </span>
    </label>
  );
}

function InformationStep({
  role,
  email,
  fullName,
  avatarUrl,
  state,
  formAction,
  pending,
  onBack,
}: {
  role: Role;
  email: string;
  fullName: string;
  avatarUrl: string | null;
  state: ActionResult | undefined;
  formAction: (formData: FormData) => void;
  pending: boolean;
  onBack: () => void;
}) {
  return (
    <form action={formAction} className="flex flex-col gap-6">
      {/* Google identity summary — read-only */}
      <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/60 p-4">
        {avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={avatarUrl}
            alt={`${fullName} avatar`}
            width={44}
            height={44}
            className="h-11 w-11 rounded-full border border-border object-cover"
            referrerPolicy="no-referrer"
          />
        ) : (
          <div className="flex h-11 w-11 items-center justify-center rounded-full border border-border bg-muted text-base font-semibold text-muted-foreground">
            {fullName.charAt(0).toUpperCase()}
          </div>
        )}
        <div className="flex flex-col gap-0.5 min-w-0">
          <span className="truncate text-sm font-medium text-foreground">
            {fullName}
          </span>
          <span className="truncate text-xs text-muted-foreground">
            {email}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-5">
        <h2 className="text-[18px] leading-[26px] font-semibold tracking-tight text-foreground">
          Personal information
        </h2>

        {/* Hidden field that carries the selected role to the server */}
        <input type="hidden" name="role" value={role} />

        <Field
          label="Full name"
          name="fullName"
          required
          placeholder="e.g. Nguyen Van A"
          error={
            state && !state.ok ? state.error.fieldErrors?.fullName?.[0] : undefined
          }
        />

        <Field
          label="Identification code"
          name="identificationCode"
          required
          placeholder="Student or teacher code"
          hint="Used to identify you inside your classes. Must be unique."
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
          placeholder="Optional"
          hint="Optional. We never share this with other users."
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
      </div>

      <Separator />

      <div className="flex items-center justify-between gap-3">
        <Button
          type="button"
          variant="ghost"
          onClick={onBack}
          disabled={pending}
        >
          Back
        </Button>
        <Button type="submit" size="lg" loading={pending}>
          {pending ? "Saving..." : "Complete onboarding"}
        </Button>
      </div>
    </form>
  );
}
