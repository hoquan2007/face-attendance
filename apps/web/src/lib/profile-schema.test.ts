/**
 * Tests for the Profile Zod schemas.
 *
 * These schemas are the source of truth for what the profile form
 * accepts and what the database stores. The tests cover:
 *
 *   1. profile Zod schema accepts valid student
 *   2. profile Zod schema accepts valid teacher
 *   3. invalid role rejected
 *   4. empty full name rejected
 *   5. empty identification code rejected
 */

import { describe, expect, it } from "vitest";

import {
  OnboardingSchema,
  ProfileUpdateSchema,
  ROLES,
} from "@/lib/profile-schema";

describe("profile-schema / OnboardingSchema", () => {
  it("accepts a valid student onboarding payload", () => {
    const result = OnboardingSchema.safeParse({
      role: "student",
      fullName: "Alice Nguyen",
      identificationCode: "STU-001",
      phone: "+84 901 234 567",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe("student");
      expect(result.data.fullName).toBe("Alice Nguyen");
      expect(result.data.identificationCode).toBe("STU-001");
      expect(result.data.phone).toBe("+84 901 234 567");
    }
  });

  it("accepts a valid teacher onboarding payload", () => {
    const result = OnboardingSchema.safeParse({
      role: "teacher",
      fullName: "Bob Tran",
      identificationCode: "TEA-001",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.role).toBe("teacher");
      expect(result.data.phone).toBeUndefined();
    }
  });

  it("rejects an invalid role", () => {
    const result = OnboardingSchema.safeParse({
      role: "admin",
      fullName: "Mallory",
      identificationCode: "X-1",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.role).toBeDefined();
    }
  });

  it("rejects an empty full name", () => {
    const result = OnboardingSchema.safeParse({
      role: "student",
      fullName: "   ",
      identificationCode: "STU-002",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.flatten().fieldErrors.fullName).toBeDefined();
    }
  });

  it("rejects an empty identification code", () => {
    const result = OnboardingSchema.safeParse({
      role: "student",
      fullName: "Alice Nguyen",
      identificationCode: "   ",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.flatten().fieldErrors.identificationCode,
      ).toBeDefined();
    }
  });

  it("trims string inputs", () => {
    const result = OnboardingSchema.safeParse({
      role: "student",
      fullName: "  Alice  ",
      identificationCode: "  STU-100  ",
      phone: "  +84 901 234 567  ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.fullName).toBe("Alice");
      expect(result.data.identificationCode).toBe("STU-100");
      expect(result.data.phone).toBe("+84 901 234 567");
    }
  });

  it("enumerates exactly the two Phase 2 roles", () => {
    expect(ROLES).toEqual(["student", "teacher"]);
  });
});

describe("profile-schema / ProfileUpdateSchema", () => {
  it("accepts a valid update", () => {
    const result = ProfileUpdateSchema.safeParse({
      fullName: "Alice",
      identificationCode: "STU-001",
      phone: "+84 901 234 567",
    });
    expect(result.success).toBe(true);
  });

  it("does NOT accept a role field (role mutation is forbidden)", () => {
    const result = ProfileUpdateSchema.safeParse({
      role: "teacher",
      fullName: "Alice",
      identificationCode: "STU-001",
    });
    // Zod's default behavior with `z.object({...})` strips unknown keys
    // rather than rejecting. We assert that the parsed object does NOT
    // contain a role field.
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).role).toBeUndefined();
    }
  });

  it("does NOT accept userId or emailSnapshot (server-controlled fields)", () => {
    const result = ProfileUpdateSchema.safeParse({
      userId: "attacker-controlled",
      emailSnapshot: "attacker@example.com",
      fullName: "Alice",
      identificationCode: "STU-001",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>).userId).toBeUndefined();
      expect(
        (result.data as Record<string, unknown>).emailSnapshot,
      ).toBeUndefined();
    }
  });

  it("treats empty phone as undefined", () => {
    const result = ProfileUpdateSchema.safeParse({
      fullName: "Alice",
      identificationCode: "STU-001",
      phone: "   ",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.phone).toBeUndefined();
    }
  });

  it("rejects identification code longer than 50 characters", () => {
    const result = ProfileUpdateSchema.safeParse({
      fullName: "Alice",
      identificationCode: "X".repeat(51),
    });
    expect(result.success).toBe(false);
  });
});