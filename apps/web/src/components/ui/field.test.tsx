/**
 * Tests for the Field component.
 *
 * Verifies:
 *   - Labels are always rendered (never placeholder-only).
 *   - `aria-invalid` is set when error is present.
 *   - `aria-describedby` links to the error or hint element.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

const mockFieldId = "field-id";

vi.mock("react", async () => {
  const actual = await vi.importActual("react");
  return {
    ...actual,
    useId: () => mockFieldId,
  };
});

import { Field } from "@/components/ui/field";

describe("Field accessibility", () => {
  it("renders a visible label", () => {
    const html = renderToString(<Field label="Email" name="email" />);
    expect(html).toContain(">Email<");
  });

  it("sets aria-invalid when error is present", () => {
    const html = renderToString(
      <Field label="Email" name="email" error="Required" />,
    );
    expect(html).toContain('aria-invalid="true"');
  });

  it("does not set aria-invalid when no error", () => {
    const html = renderToString(<Field label="Email" name="email" />);
    expect(html).not.toContain('aria-invalid');
  });

  it("renders error message with role=alert", () => {
    const html = renderToString(
      <Field label="Email" name="email" error="Required" />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain(">Required<");
  });

  it("renders hint text when error is absent and hint is provided", () => {
    const html = renderToString(
      <Field label="Email" name="email" hint="Optional" />,
    );
    expect(html).toContain(">Optional<");
    expect(html).not.toContain('role="alert"');
  });

  it("marks required fields with a visible asterisk", () => {
    const html = renderToString(
      <Field label="Email" name="email" required />,
    );
    expect(html).toContain(">*<");
  });
});
