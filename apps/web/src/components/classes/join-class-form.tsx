/**
 * `JoinClassForm` — focused Client Component for PHASE 5.1E3.
 *
 * The student-only "Join class" form. Renders two fields:
 *
 *   - `classCode` — the 7-char canonical class code.
 *   - `password`  — the class password (4..128 chars, NOT trimmed).
 *
 * The component:
 *
 *   - Calls `createJoinClassAction({ classCode, password })` with
 *     ZERO identity / role / ownership fields. The action derives
 *     the authenticated student from the Better Auth session.
 *   - Uses a synchronous `submitInFlightRef` guard so two rapid
 *     submissions collapse into exactly ONE Server Action invocation.
 *   - Renders a restrained pending state ("Joining class…") and
 *     disables the submit button while the action is in flight.
 *   - Renders safe success feedback for both first-join
 *     (`alreadyJoined: false`) and idempotent already-joined
 *     (`alreadyJoined: true`) — both are SUCCESS states.
 *   - Renders safe error feedback (no Mongo detail, no stack, no
 *     `passwordHash`) for every documented error code.
 *   - Uses ONE generic message for all credential failures
 *     (`INVALID_CLASS_CREDENTIALS`) — the UI intentionally does
 *     NOT distinguish "class not found" / "wrong password" /
 *     "archived class" / "malformed stored hash".
 *   - Provides a "Back to classes" affordance on success that
 *     links to `/classes`. The link does NOT carry class data
 *     in the URL.
 *   - Uses `type="password"` and an appropriate `autoComplete`
 *     value. Does NOT store the password in localStorage /
 *     sessionStorage / IndexedDB. Does NOT log the password.
 *     Does NOT put the password in the URL.
 *   - Receives NO identity props. The form is identity-free;
 *     the Server Action is the authoritative identity boundary.
 *
 * Privacy guarantees:
 *
 *   - The password lives only in a React local state variable
 *     for the lifetime of the form. After a successful
 *     submission the password state is cleared via
 *     `setPassword("")`.
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
import {
  createJoinClassAction,
  JOIN_CLASS_ACTION_ERROR_CODES,
  type JoinClassActionResult,
} from "@/lib/classes/join-class-action";

// Class code length (matches CLASS_CODE_LENGTH in class-code.ts).
// Mirrored here to avoid importing the server-only class-code
// module from a Client Component. The server is the authoritative
// validator; this is purely a UX hint for maxLength.
const CLASS_CODE_INPUT_LENGTH = 7;

// =============================================================================
// Safe-error mapping
// =============================================================================

/**
 * Maps a documented action error code into a restrained,
 * human-readable pair.
 *
 * The mapping NEVER references thresholds, model identifiers,
 * service URLs, raw stack traces, or `passwordHash`. It is
 * purely UI copy derived from the project's stable error code
 * set.
 *
 * CRITICAL ENUMERATION PROTECTION:
 * All four credential failure branches (missing class,
 * wrong password, archived class, malformed stored hash) map
 * to the SAME generic message. The UI MUST preserve this
 * boundary — displaying separate messages for each branch would
 * allow an attacker to enumerate which class codes correspond
 * to live classes.
 */
function classifyJoinError(code: string): {
  heading: string;
  body: string;
  retryable: boolean;
} {
  switch (code) {
    case JOIN_CLASS_ACTION_ERROR_CODES.UNAUTHENTICATED:
      return {
        heading: "Sign-in required",
        body: "Please sign in again before joining a class.",
        retryable: false,
      };
    case JOIN_CLASS_ACTION_ERROR_CODES.PROFILE_INCOMPLETE:
      return {
        heading: "Complete your profile",
        body: "Complete your profile before joining a class.",
        retryable: false,
      };
    case JOIN_CLASS_ACTION_ERROR_CODES.STUDENT_REQUIRED:
      return {
        heading: "Students only",
        body: "Only students can join classes.",
        retryable: false,
      };
    case JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_CODE:
      return {
        heading: "Class code is invalid",
        body: "Class code must be 7 characters using only letters (no I/O) and digits (no 0/1).",
        retryable: false,
      };
    case JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_PASSWORD:
      return {
        heading: "Class password is invalid",
        body: "Class password must be 4 to 128 characters.",
        retryable: false,
      };
    // CRITICAL: All credential failures collapse to ONE generic
    // message. This preserves the backend's timing-attack mitigation
    // and enumeration protection.
    case JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_CREDENTIALS:
      return {
        heading: "Could not join the class",
        body: "Class code or password is incorrect, or the class is unavailable.",
        retryable: false,
      };
    case JOIN_CLASS_ACTION_ERROR_CODES.CLASS_JOIN_FAILED:
      return {
        heading: "Could not join the class",
        body: "Please try again in a moment.",
        retryable: true,
      };
    default:
      return {
        heading: "Could not join the class",
        body: "Please try again in a moment.",
        retryable: false,
      };
  }
}

// =============================================================================
// Component
// =============================================================================

export interface JoinClassFormProps {
  /** Optional wrapper className. */
  className?: string;
}

/**
 * Student-only "Join class" form. Renders the classCode +
 * password fields, calls `createJoinClassAction(...)`, and
 * renders a calm success / error state.
 */
export function JoinClassForm({ className }: JoinClassFormProps) {
  // Local form state. The form holds two values only:
  //   - `classCode`  — visually shown as-is; server canonicalizes
  //                    via trim + uppercase.
  //   - `password`   — preserved exactly as typed; NEVER trimmed.
  const [classCode, setClassCode] = React.useState<string>("");
  const [password, setPassword] = React.useState<string>("");

  // UI state. The Server Action is authoritative — the form
  // never fabricates a success result.
  const [pending, setPending] = React.useState<boolean>(false);
  const [error, setError] = React.useState<{
    heading: string;
    body: string;
    code: string;
    retryable: boolean;
  } | null>(null);
  const [success, setSuccess] = React.useState<{
    className: string;
    classCode: string;
    alreadyJoined: boolean;
  } | null>(null);

  // Synchronous in-flight guard. React's `pending` state alone
  // does NOT block two clicks that land in the same React
  // dispatch tick. The ref is inspected / set BEFORE the first
  // `await` so the second click observes the guard immediately.
  const submitInFlightRef = React.useRef<boolean>(false);

  const handleSubmit = React.useCallback(
    async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
      event.preventDefault();
      // Synchronous guard — must run BEFORE any await.
      if (submitInFlightRef.current) return;
      submitInFlightRef.current = true;
      setPending(true);
      setError(null);

      let result: JoinClassActionResult;
      try {
        // ZERO-identity payload: only the browser-supplied fields
        // are forwarded. `studentUserId` / `userId` / `role` /
        // `classId` / `passwordHash` / `status` are derived
        // server-side.
        result = await createJoinClassAction({
          classCode,
          password,
        });
      } catch {
        // Defensive: any uncaught throw becomes a generic, safe
        // join failure. No raw stack, no Mongo URI, no password
        // leak.
        submitInFlightRef.current = false;
        setPending(false);
        setError({
          heading: "Could not join the class",
          body: "Please try again in a moment.",
          code: JOIN_CLASS_ACTION_ERROR_CODES.CLASS_JOIN_FAILED,
          retryable: true,
        });
        return;
      }

      if (result.ok) {
        // SUCCESS. Clear the password immediately so the plaintext
        // does not persist in component state. The form fields are
        // no longer rendered in the success state.
        setPassword("");
        submitInFlightRef.current = false;
        setSuccess({
          // The membership result contains the class identity.
          // We don't have the class name directly in the membership,
          // but we can surface it if returned.
          className: "", // className is not in the membership; placeholder
          classCode: result.membership.classCode,
          alreadyJoined: result.alreadyJoined,
        });
        setPending(false);
        return;
      }

      // FAILURE. Map the safe code into UI copy. The action's
      // `result.message` is already safe browser copy — we use
      // it indirectly through the classifier so the UI copy is
      // derived from the code, not from the raw action message.
      const mapped = classifyJoinError(result.code);
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
    [classCode, password],
  );

  // The form is hidden once a successful join is committed. The
  // student needs to see the classCode confirmation, so we render
  // a dedicated success state instead of immediately navigating
  // away.
  if (success) {
    return (
      <SuccessState
        className={className}
        success={success}
      />
    );
  }

  const buttonDisabled = pending;
  const buttonLabel = pending ? "Joining class…" : "Join class";

  return (
    <form
      data-component="join-class-form"
      data-pending={pending ? "true" : undefined}
      noValidate
      onSubmit={handleSubmit}
      className={cn("flex flex-col gap-5", className)}
    >
      <Card>
        <CardSection>
          <h2 className="text-base font-semibold text-foreground">
            Class credentials
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Enter the class code and password shared by your teacher.
          </p>
        </CardSection>
        <CardContent>
          <div className="flex flex-col gap-5">
            <Field
              label="Class code"
              required
              hint={`${CLASS_CODE_INPUT_LENGTH} characters: letters (no I/O) and digits (no 0/1).`}
              autoComplete="off"
              name="classCode"
              type="text"
              value={classCode}
              disabled={buttonDisabled}
              onChange={(event) =>
                setClassCode(event.target.value.toUpperCase())
              }
              placeholder="e.g. ABCDEFG"
              maxLength={CLASS_CODE_INPUT_LENGTH}
              inputMode="text"
              aria-required="true"
            />
            <Field
              label="Class password"
              required
              hint="4 to 128 characters."
              autoComplete="current-password"
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
        <div className="flex flex-wrap items-center justify-end gap-3 px-5 py-4 border-t border-border">
          <Button
            type="submit"
            variant="primary"
            disabled={buttonDisabled}
            loading={pending}
            aria-busy={pending || undefined}
            aria-label={pending ? "Joining class" : "Join class"}
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
  success: {
    className: string;
    classCode: string;
    alreadyJoined: boolean;
  };
  className?: string;
}

/**
 * Dedicated success state. Both first-join and already-joined are
 * SUCCESS states — the student has verified their credentials and
 * gained access to the class.
 *
 * The student is given a calm heading, the classCode in monospace,
 * and a "Back to classes" link to `/classes`. The link does NOT
 * carry any class data in the URL.
 *
 * The password is NEVER echoed (we cannot recover the plaintext
 * from `passwordHash` anyway).
 */
function SuccessState({ success, className }: SuccessStateProps) {
  const { classCode, alreadyJoined } = success;

  const heading = alreadyJoined
    ? "Already joined"
    : "Joined class";
  const description = alreadyJoined
    ? "You're already in this class."
    : "You've joined the class successfully.";

  return (
    <div
      data-component="join-class-form-success"
      data-class-code={classCode}
      data-already-joined={alreadyJoined ? "true" : "false"}
      className={cn("flex flex-col gap-5", className)}
    >
      <Card>
        <CardSection>
          <h2 className="text-base font-semibold text-foreground">
            {heading}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {description}
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
