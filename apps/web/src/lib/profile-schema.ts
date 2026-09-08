/**
 * Zod validation schemas for the Profile model.
 *
 * Phase 2: the application owns the `profiles` collection and the
 * onboarding / profile-edit mutations. Server-side validation is the
 * source of truth — never trust HTML form validation alone.
 *
 * These schemas are imported by:
 *   - the Profile service (server-side normalization)
 *   - the Server Actions that handle form submissions
 *   - tests
 */

import { z } from "zod";

/**
 * Role enum shared between the schema and the Mongoose model.
 *
 * Phase 2 supports two roles. Teacher self-selection is allowed for
 * the MVP; production deployments will need a teacher invite / admin
 * verification flow (documented in `docs/architecture.md`).
 */
export const ROLES = ["student", "teacher"] as const;
export const RoleSchema = z.enum(ROLES);
export type Role = (typeof ROLES)[number];

/**
 * Trim leading and trailing whitespace before further validation.
 *
 * We apply this to every free-text field so that values such as
 * "  Alice  " are persisted as " Alice " → "Alice".
 */
const trimString = (value: unknown) =>
  typeof value === "string" ? value.trim() : value;

/**
 * Full name: 2–100 characters after trimming.
 */
export const FullNameSchema = z.preprocess(
  trimString,
  z
    .string()
    .min(1, "Full name is required.")
    .max(100, "Full name must be at most 100 characters."),
);

/**
 * Identification code: 2–50 characters after trimming.
 *
 * This is a generic field that may represent a student code, teacher
 * code, or — later — an employee code. We enforce a unique index on
 * this field in the database layer.
 */
export const IdentificationCodeSchema = z.preprocess(
  trimString,
  z
    .string()
    .min(1, "Identification code is required.")
    .max(50, "Identification code must be at most 50 characters."),
);

/**
 * Phone: optional. We trim and bound the length, but we deliberately
 * avoid country-specific or format-specific validation. Future phases
 * can add stricter rules without changing the schema name.
 */
export const PhoneSchema = z.preprocess(
  trimString,
  z
    .string()
    .max(32, "Phone number must be at most 32 characters.")
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),
);

/**
 * Onboarding payload submitted by the user when they first complete
 * their profile.
 *
 * `role`, `fullName`, and `identificationCode` are required.
 * `phone` is optional.
 *
 * This schema explicitly does NOT accept `userId` or `email`. The
 * server derives authoritative identity from the Better Auth session.
 */
export const OnboardingSchema = z.object({
  role: RoleSchema,
  fullName: FullNameSchema,
  identificationCode: IdentificationCodeSchema,
  phone: PhoneSchema,
});

export type OnboardingInput = z.infer<typeof OnboardingSchema>;

/**
 * Profile update payload.
 *
 * `role` is intentionally absent: in Phase 2 the role is fixed once
 * chosen during onboarding. Changing the role must go through a
 * dedicated controlled flow that does not exist yet.
 *
 * `userId` / `emailSnapshot` are also intentionally absent — the
 * server controls those fields from the session, never the browser.
 */
export const ProfileUpdateSchema = z.object({
  fullName: FullNameSchema,
  identificationCode: IdentificationCodeSchema,
  phone: PhoneSchema,
});

export type ProfileUpdateInput = z.infer<typeof ProfileUpdateSchema>;