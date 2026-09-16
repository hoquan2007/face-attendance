/**
 * `CreateClassForm` — focused Client Component for PHASE 5.1E2.
 *
 * The teacher-only "Create class" form. Renders two fields:
 *
 *   - `name`     — the visible class name (trimmed by the server).
 *   - `password` — the join password (4..128 chars, NEVER trimmed
 *                  by the server).
 *
 * The component:
 *
 *   - Calls `createClassAction({ name, password })` with ZERO
 *     identity / role / ownership fields. The action derives the
 *     authenticated teacher from the Better Auth session.
 *   - Uses a synchronous `submitInFlightRef` guard so two rapid
 *     submissions collapse into exactly ONE Server Action
 *     invocation.
 *   - Renders a restrained pending state ("Creating class…") and
 *     disables the submit button while the action is in flight.
 *   - Renders the safe action result on success — name, classCode,
 *     createdAt. The plaintext password is NEVER echoed. The form
 *     fields are hidden once the action succeeds and the password
 *     state is cleared immediately.
 *   - Renders safe error feedback (no Mongo detail, no stack, no
 *     `passwordHash`) for every documented error code.
 *   - Provides a "Back to classes" affordance on success that links
 *     to `/classes`. The link does NOT carry class data in the URL.
 *   - Uses `type="password"` and an appropriate `autoComplete`
 *     value. Does NOT store the password in localStorage /
 *     sessionStorage / IndexedDB. Does NOT log the password. Does
 *     NOT put the password in the URL.
 *   - Receives NO identity props. The form is identity-free; the
 *     Server Action is the authoritative identity boundary.
 *
 * Privacy guarantees:
 *
 *   - The password lives only in a React local state variable for
 *     the lifetime of the form. After a successful submission the
 *     password state is cleared via `setPassword("")`.
 *   - The component never writes `localStorage`, `sessionStorage`,
 *     IndexedDB, or the Cache API.
 *   - The component never calls `fetch()` to any HTTP route.
 *   - The component never calls `console.log` / `console.error`
 *     with the password or `passwordHash`.
 */

"use client";

import * as React from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Card, CardContent, CardSection } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { createClassAction } from "@/lib/classes/create-class-action";
import {
  CREATE_CLASS_ACTION_ERROR_CODES,
  type CreateClassActionResult,
} from "@/lib/classes/create-class-action-types";

// =============================================================================
// Safe-error mapping
// =============================================================================

/**
 * Maps a documented action error code into a restrained,
 * human-readable pair.
 *
 * The mapping NEVER references thresholds, model identifiers,
 * service URLs, raw stack traces, or `passwordHash`. It is purely
 * UI copy derived from the project's stable error code set.
 */
function classifyCreateError(code: string): {
  heading: string;
  body: string;
  retryable: boolean;
} {
  switch (code) {
    case CREATE_CLASS_ACTION_ERROR_CODES.UNAUTHENTICATED:
      return {
        heading: "Sign-in required",
        body: "Please sign in again before creating a class.",
        retryable: false,
      };
    case CREATE_CLASS_ACTION_ERROR_CODES.PROFILE_INCOMPLETE:
      return {
        heading: "Complete your profile",
        body: "Complete your profile before creating a class.",
        retryable: false,
      };
    case CREATE_CLASS_ACTION_ERROR_CODES.TEACHER_REQUIRED:
      return {
        heading: "Teachers only",
        body: "Only teachers can create classes.",
        retryable: false,
      };
    case CREATE_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_NAME:
      return {
        heading: "Class name is invalid",
        body: "Class name must be 1 to 200 characters.",
        retryable: false,
      };
    case CREATE_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_PASSWORD:
      return {
        heading: "Class password is invalid",
        body: "Class password must be 4 to 128 characters.",
        retryable: false,
      };
    case CREATE_CLASS_ACTION_ERROR_CODES.CLASS_CODE_GENERATION_FAILED:
      return {
        heading: "Could not generate a class code",
        body: "Please try again in a moment.",
        retryable: true,
      };
    case CREATE_CLASS_ACTION_ERROR_CODES.CLASS_CREATION_FAILED:
      return {
        heading: "Could not create the class",
        body: "Please try again in a moment.",
        retryable: true,
      };
    default:
      return {
        heading: "Could not create the class",
        body: "Please try again in a moment.",
        retryable: false,
      };
  }
}

/**
 * Stable, locale-friendly, ISO-based date formatter for the
 * success-state `createdAt` field.
 */
function formatCreatedAt(iso: string): string {
  try {
    const date = new Date(iso);
    return date.toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

// =============================================================================
// Component
// =============================================================================

export interface CreateClassFormProps {
  /** Optional wrapper className. */
  className?: string;
}

/**
 * Teacher-only "Create class" form. Renders the name + password
 * fields, calls `createClassAction(...)`, and renders a calm
 * success / error state.
 */
export function CreateClassForm({ className }: CreateClassFormProps) {
  // Local form state. The form holds two values only:
  //   - `name`     — visually trimmed client-side for display only;
  //                  the server is the authoritative trim boundary.
  //   - `password` — preserved exactly as typed; NEVER trimmed by
  //                  the server.
  const [name, setName] = React.useState<string>("");
  const [password, setPassword] = React.useState<string>("");

  // UI state. The Server Action is authoritative — the form never
  // fabricates a success result.
  const [pending, setPending] = React.useState<boolean>(false);
  const [error, setError] = React.useState<{
    heading: string;
    body: string;
    code: string;
    retryable: boolean;
  } | null>(null);
  const [success, setSuccess] = React.useState<{
    name: string;
    classCode: string;
    createdAt: string;
  } | null>(null);

  // Synchronous in-flight guard. React's `pending` state alone does
  // NOT block two clicks that land in the same React dispatch tick.
  // The ref is inspected / set BEFORE the first `await` so the
  // second click observes the guard immediately.
  const submitInFlightRef = React.useRef<boolean>(false);

  const handleSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      // Synchronous guard — must run BEFORE any await.
      if (submitInFlightRef.current) return;
      submitInFlightRef.current = true;
      setPending(true);
      setError(null);

      let result: CreateClassActionResult;
      try {
        // ZERO-identity payload: only the browser-supplied fields
        // are forwarded. `teacherUserId` / `userId` / `role` /
        // `classCode` / `passwordHash` / `status` are derived
        // server-side.
        result = await createClassAction({
          name,
          password,
        });
      } catch {
        // Defensive: any uncaught throw becomes a generic, safe
        // creation failure. No raw stack, no Mongo URI, no
        // password leak.
        submitInFlightRef.current = false;
        setPending(false);
        setError({
          heading: "Could not create the class",
          body: "Please try again in a moment.",
          code: CREATE_CLASS_ACTION_ERROR_CODES.CLASS_CREATION_FAILED,
          retryable: true,
        });
        return;
      }

      if (result.ok) {
        // SUCCESS. The password state is cleared immediately so
        // the plaintext does not persist in component state. The
        // form fields are no longer rendered in the success state.
        setPassword("");
        submitInFlightRef.current = false;
        setSuccess({
          name: result.class.name,
          classCode: result.class.classCode,
          createdAt: result.class.createdAt,
        });
        setPending(false);
        return;
      }

      // FAILURE. Map the safe code into UI copy. The action's
      // `result.message` is already safe browser copy — we use it
      // indirectly through the classifier so the UI copy is
      // derived from the code, not from the raw action message.
      const mapped = classifyCreateError(result.code);
      setError({
        heading: mapped.heading,
        body: mapped.body,
        code: result.code,
        retryable: mapped.retryable,
      });
      // Release the guard so the user may retry explicitly when
      // the contract allows it. There is no automatic retry.
      submitInFlightRef.current = false;
      setPending(false);
    },
    [name, password],
  );

  // The form is hidden once a successful create is committed. The
  // teacher still needs to see `classCode` so they can share it
  // with students, so we render a dedicated success state instead
  // of immediately navigating away.
  if (success) {
    return (
      <SuccessState
        className={className}
        success={success}
        formatCreatedAt={formatCreatedAt}
      />
    );
  }

  const buttonDisabled = pending;
  const buttonLabel = pending ? "Creating class…" : "Create class";

  return (
    <form
      data-component="create-class-form"
      data-pending={pending ? "true" : undefined}
      noValidate
      onSubmit={handleSubmit}
      className={cn("flex flex-col gap-5", className)}
    >
      <Card>
        <CardSection>
          <h2 className="text-base font-semibold text-foreground">
            Class details
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a name and a class password. Share the class code with
            your students.
          </p>
        </CardSection>
        <CardContent>
          <div className="flex flex-col gap-5">
            <Field
              label="Class name"
              required
              hint="1 to 200 characters."
              autoComplete="off"
              name="name"
              type="text"
              value={name}
              disabled={buttonDisabled}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Algebra 101"
              maxLength={200}
              aria-required="true"
            />
            <Field
              label="Class password"
              required
              hint="4 to 128 characters. Students will enter this password to join."
              autoComplete="new-password"
              name="password"
              type="password"
              value={password}
              disabled={buttonDisabled}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Class password"
              minLength={4}
              maxLength={128}
              aria-required="true"
            />
          </div>
        </CardContent>
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 border-t border-border">
          <p className="text-xs leading-[18px] text-muted-foreground">
            A class code is generated for you after the class is created.
          </p>
          <Button
            type="submit"
            variant="primary"
            disabled={buttonDisabled}
            loading={pending}
            aria-busy={pending || undefined}
            aria-label={pending ? "Creating class" : "Create class"}
          >
            {buttonLabel}
          </Button>
        </div>
      </Card>

      {error ? (
        <div
          role="alert"
          aria-live={error.retryable ? "polite" : "assertive"}
          data-tone="warning"
          data-error-code={error.code}
          className={cn(
            "rounded-md border border-warning/30 bg-warning-soft",
            "px-3 py-2.5 text-sm text-warning",
          )}
        >
          <p className="font-medium">{error.heading}</p>
          <p className="mt-0.5">{error.body}</p>
        </div>
      ) : null}
    </form>
  );
}

// =============================================================================
// Success state
// =============================================================================

interface SuccessStateProps {
  success: { name: string; classCode: string; createdAt: string };
  className?: string;
  formatCreatedAt: (iso: string) => string;
}

/**
 * Dedicated success state. Renders ONLY safe fields returned by
 * the action: `name`, `classCode`, `createdAt`. The password is
 * NEVER echoed (we cannot recover the plaintext from `passwordHash`
 * anyway).
 *
 * The teacher is given a calm heading, the prominent classCode in
 * monospace, and a "Back to classes" link to `/classes`. The link
 * does NOT carry any class data in the URL.
 */
function SuccessState({
  success,
  className,
  formatCreatedAt,
}: SuccessStateProps) {
  const { name, classCode, createdAt } = success;
  return (
    <div
      data-component="create-class-form-success"
      data-class-code={classCode}
      className={cn("flex flex-col gap-5", className)}
    >
      <Card>
        <CardSection>
          <h2 className="text-base font-semibold text-foreground">
            Class created
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Share the class code below with your students.
          </p>
        </CardSection>
        <CardContent>
          <dl className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Class code
              </dt>
              <dd className="select-all font-mono text-2xl font-semibold leading-tight text-foreground">
                {classCode}
              </dd>
              <p className="mt-1 text-xs leading-[18px] text-muted-foreground">
                Share this code and the class password with students you
                want to invite.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-border pt-4 text-sm">
              <div className="flex items-center gap-2">
                <dt className="text-muted-foreground">Name</dt>
                <dd className="font-medium text-foreground">{name}</dd>
              </div>
              <div className="flex items-center gap-2">
                <dt className="text-muted-foreground">Created</dt>
                <dd className="text-foreground">
                  {formatCreatedAt(createdAt)}
                </dd>
              </div>
            </div>
          </dl>
        </CardContent>
        <div className="flex flex-wrap items-center justify-end gap-3 px-5 py-4 border-t border-border">
          <Button asChild variant="primary">
            <Link href="/classes">Back to classes</Link>
          </Button>
        </div>
      </Card>
    </div>
  );
}
