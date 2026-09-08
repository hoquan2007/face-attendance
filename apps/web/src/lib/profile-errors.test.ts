/**
 * Tests for the profile-errors module.
 *
 * Verifies that duplicate-key errors from MongoDB are mapped to safe,
 * user-facing ProfileError instances with stable error codes.
 */

import { describe, expect, it } from "vitest";

import {
  PROFILE_ERROR_CODES,
  ProfileError,
  mapMongoDuplicateKeyError,
  mapZodError,
} from "@/lib/profile-errors";

describe("profile-errors / mapMongoDuplicateKeyError", () => {
  it("maps a 11000 duplicate on identificationCode to IDENTIFICATION_CODE_TAKEN", () => {
    const err = {
      code: 11000,
      keyValue: { identificationCode: "STU-001" },
    };
    const mapped = mapMongoDuplicateKeyError(err);
    expect(mapped).toBeInstanceOf(ProfileError);
    expect(mapped.code).toBe(PROFILE_ERROR_CODES.IDENTIFICATION_CODE_TAKEN);
    expect(mapped.message).toMatch(/identification code/i);
    // The error must NOT expose Mongo internals.
    expect(mapped.message).not.toContain("11000");
    expect(mapped.message).not.toContain("MongoServerError");
  });

  it("maps a 11000 duplicate on userId to PROFILE_ALREADY_EXISTS", () => {
    const mapped = mapMongoDuplicateKeyError({
      code: 11000,
      keyValue: { userId: "user-1" },
    });
    expect(mapped.code).toBe(PROFILE_ERROR_CODES.PROFILE_ALREADY_EXISTS);
  });

  it("maps a 11000 duplicate without a known keyValue to a generic PROFILE_ALREADY_EXISTS", () => {
    const mapped = mapMongoDuplicateKeyError({ code: 11000 });
    expect(mapped.code).toBe(PROFILE_ERROR_CODES.PROFILE_ALREADY_EXISTS);
  });

  it("maps any other error to UNKNOWN_ERROR", () => {
    const mapped = mapMongoDuplicateKeyError(new Error("connection string mongodb://..."));
    expect(mapped.code).toBe(PROFILE_ERROR_CODES.UNKNOWN_ERROR);
    // Must not leak the original message verbatim.
    expect(mapped.message).not.toContain("mongodb://");
  });
});

describe("profile-errors / mapZodError", () => {
  it("flattens a Zod error into a fieldErrors object", () => {
    const fakeZodError = {
      flatten: () => ({
        fieldErrors: { fullName: ["Full name is required."] },
      }),
    };
    const mapped = mapZodError(fakeZodError);
    expect(mapped.code).toBe(PROFILE_ERROR_CODES.INVALID_PROFILE_DATA);
    expect(mapped.fieldErrors?.fullName).toEqual(["Full name is required."]);
  });

  it("tolerates a missing `flatten` method gracefully", () => {
    const mapped = mapZodError({});
    expect(mapped.code).toBe(PROFILE_ERROR_CODES.INVALID_PROFILE_DATA);
  });
});

describe("profile-errors / ProfileError", () => {
  it("serializes to a stable JSON shape", () => {
    const err = new ProfileError({
      code: PROFILE_ERROR_CODES.IDENTIFICATION_CODE_TAKEN,
      message: "This identification code is already in use.",
      fieldErrors: { identificationCode: ["Taken."] },
    });
    expect(err.toJSON()).toEqual({
      code: PROFILE_ERROR_CODES.IDENTIFICATION_CODE_TAKEN,
      message: "This identification code is already in use.",
      fieldErrors: { identificationCode: ["Taken."] },
    });
  });

  it("omits fieldErrors when not provided", () => {
    const err = new ProfileError({
      code: PROFILE_ERROR_CODES.UNAUTHENTICATED,
      message: "No session.",
    });
    expect(err.toJSON()).toEqual({
      code: PROFILE_ERROR_CODES.UNAUTHENTICATED,
      message: "No session.",
    });
  });
});