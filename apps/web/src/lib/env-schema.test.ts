import { describe, expect, it } from "vitest";

import { buildEnvSchema, emptyStringToUndefined } from "@/lib/env-schema";

/**
 * Tests for the boot-time environment schema.
 *
 * Phase 1: authentication-required variables are validated as non-empty strings.
 * Empty/whitespace values now fail validation for Better Auth, Google OAuth,
 * and MongoDB variables.
 */

/**
 * Helper: a fully-populated Phase 1 environment that passes validation.
 * Tests should merge overrides into this baseline.
 */
function validPhase1Env() {
  return {
    NODE_ENV: "test" as const,
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    APP_NAME: "Face Attendance System",
    MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/face_attendance",
    BETTER_AUTH_URL: "http://localhost:3000",
    BETTER_AUTH_SECRET: "super-secret-key",
    GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
    GOOGLE_CLIENT_SECRET: "google-client-secret",
    FACE_SERVICE_URL: undefined as string | undefined,
    FACE_SERVICE_SECRET: undefined as string | undefined,
  };
}

describe("env-schema", () => {
  describe("emptyStringToUndefined", () => {
    it("returns undefined for empty string", () => {
      expect(emptyStringToUndefined("")).toBeUndefined();
    });

    it("returns undefined for whitespace-only strings", () => {
      expect(emptyStringToUndefined("   ")).toBeUndefined();
      expect(emptyStringToUndefined("\t")).toBeUndefined();
      expect(emptyStringToUndefined("\n")).toBeUndefined();
      expect(emptyStringToUndefined(" \t\n ")).toBeUndefined();
    });

    it("passes through non-empty strings unchanged", () => {
      expect(emptyStringToUndefined("hello")).toBe("hello");
      expect(emptyStringToUndefined("  hello  ")).toBe("  hello  ");
    });

    it("passes through undefined and non-string values unchanged", () => {
      expect(emptyStringToUndefined(undefined)).toBeUndefined();
      expect(emptyStringToUndefined(null)).toBeNull();
      expect(emptyStringToUndefined(0)).toBe(0);
      expect(emptyStringToUndefined(false)).toBe(false);
    });
  });

  describe("buildEnvSchema — Phase 1 required URL variables", () => {
    const schema = buildEnvSchema();

    it("BETTER_AUTH_URL accepts a proper http URL", () => {
      const result = schema.safeParse({
        ...validPhase1Env(),
        BETTER_AUTH_URL: "http://localhost:3000",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.BETTER_AUTH_URL).toBe("http://localhost:3000");
      }
    });

    it("BETTER_AUTH_URL accepts a proper https URL", () => {
      const result = schema.safeParse({
        ...validPhase1Env(),
        BETTER_AUTH_URL: "https://example.vercel.app",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.BETTER_AUTH_URL).toBe("https://example.vercel.app");
      }
    });

    it("BETTER_AUTH_URL rejects empty string", () => {
      const result = schema.safeParse({ ...validPhase1Env(), BETTER_AUTH_URL: "" });
      expect(result.success).toBe(false);
    });

    it("BETTER_AUTH_URL rejects whitespace", () => {
      const result = schema.safeParse({ ...validPhase1Env(), BETTER_AUTH_URL: "   " });
      expect(result.success).toBe(false);
    });

    it("BETTER_AUTH_URL rejects malformed non-empty URL", () => {
      const result = schema.safeParse({ ...validPhase1Env(), BETTER_AUTH_URL: "abc" });
      expect(result.success).toBe(false);
    });

    it("FACE_SERVICE_URL accepts undefined as missing (optional)", () => {
      const result = schema.safeParse({
        ...validPhase1Env(),
        FACE_SERVICE_URL: undefined,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.FACE_SERVICE_URL).toBeUndefined();
      }
    });

    it("FACE_SERVICE_URL accepts empty string as missing (optional)", () => {
      const result = schema.safeParse({
        ...validPhase1Env(),
        FACE_SERVICE_URL: "",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.FACE_SERVICE_URL).toBeUndefined();
      }
    });

    it("FACE_SERVICE_URL accepts a proper http URL", () => {
      const result = schema.safeParse({
        ...validPhase1Env(),
        FACE_SERVICE_URL: "http://localhost:8001",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.FACE_SERVICE_URL).toBe("http://localhost:8001");
      }
    });

    it("FACE_SERVICE_URL rejects malformed non-empty URL", () => {
      const result = schema.safeParse({ ...validPhase1Env(), FACE_SERVICE_URL: "abc" });
      expect(result.success).toBe(false);
    });
  });

  describe("buildEnvSchema — NEXT_PUBLIC_APP_URL", () => {
    const schema = buildEnvSchema();

    it("defaults to http://localhost:3000 when undefined", () => {
      const env = validPhase1Env();
      // Remove NEXT_PUBLIC_APP_URL to exercise the default
      const { NEXT_PUBLIC_APP_URL: _, ...rest } = env;
      const result = schema.safeParse(rest);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
      }
    });

    it("defaults to http://localhost:3000 when the value is an empty string", () => {
      const result = schema.safeParse({ ...validPhase1Env(), NEXT_PUBLIC_APP_URL: "" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
      }
    });

    it("defaults to http://localhost:3000 when the value is whitespace", () => {
      const result = schema.safeParse({
        ...validPhase1Env(),
        NEXT_PUBLIC_APP_URL: "   ",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
      }
    });

    it("accepts a proper https URL and still validates it as a URL", () => {
      const result = schema.safeParse({
        ...validPhase1Env(),
        NEXT_PUBLIC_APP_URL: "https://face-attendance.vercel.app",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NEXT_PUBLIC_APP_URL).toBe(
          "https://face-attendance.vercel.app",
        );
      }
    });

    it("rejects a malformed non-empty URL", () => {
      const result = schema.safeParse({
        ...validPhase1Env(),
        NEXT_PUBLIC_APP_URL: "abc",
      });
      expect(result.success).toBe(false);
    });
  });

  describe("buildEnvSchema — APP_NAME", () => {
    const schema = buildEnvSchema();

    it("defaults to the standard application name when undefined", () => {
      const env = validPhase1Env();
      const { APP_NAME: _, ...rest } = env;
      const result = schema.safeParse(rest);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.APP_NAME).toBe("Face Attendance System");
      }
    });

    it("accepts a custom application name", () => {
      const result = schema.safeParse({ ...validPhase1Env(), APP_NAME: "Acme Attendance" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.APP_NAME).toBe("Acme Attendance");
      }
    });
  });

  describe("buildEnvSchema — Phase 1 required string variables", () => {
    const schema = buildEnvSchema();

    // Phase 1: these are now required (non-empty strings)
    const requiredStrings = [
      "MONGODB_URI",
      "BETTER_AUTH_SECRET",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ] as const;

    for (const name of requiredStrings) {
      it(`${name}: empty string fails validation`, () => {
        const result = schema.safeParse({ ...validPhase1Env(), [name]: "" });
        expect(result.success).toBe(false);
      });

      it(`${name}: whitespace fails validation`, () => {
        const result = schema.safeParse({ ...validPhase1Env(), [name]: "   " });
        expect(result.success).toBe(false);
      });

      it(`${name}: a real value passes through unchanged`, () => {
        const result = schema.safeParse({ ...validPhase1Env(), [name]: "real-value" });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data[name]).toBe("real-value");
        }
      });
    }

    describe("FACE_SERVICE_SECRET (optional)", () => {
      it("empty string is treated as undefined", () => {
        const result = schema.safeParse({
          ...validPhase1Env(),
          FACE_SERVICE_SECRET: "",
        });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.FACE_SERVICE_SECRET).toBeUndefined();
        }
      });

      it("a real value passes through unchanged", () => {
        const result = schema.safeParse({
          ...validPhase1Env(),
          FACE_SERVICE_SECRET: "real-secret",
        });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.FACE_SERVICE_SECRET).toBe("real-secret");
        }
      });
    });
  });

  describe("buildEnvSchema — complete Phase 1 config", () => {
    const schema = buildEnvSchema();

    it("parses a complete Phase 1 configuration", () => {
      const result = schema.safeParse({
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "https://face-attendance.vercel.app",
        APP_NAME: "Face Attendance",
        MONGODB_URI: "mongodb+srv://user:pass@cluster.mongodb.net/face_attendance",
        BETTER_AUTH_URL: "https://face-attendance.vercel.app",
        BETTER_AUTH_SECRET: "super-secret-key",
        GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "google-client-secret",
        FACE_SERVICE_URL: "https://face-service.example.com",
        FACE_SERVICE_SECRET: "face-service-secret",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.MONGODB_URI).toBe(
          "mongodb+srv://user:pass@cluster.mongodb.net/face_attendance",
        );
        expect(result.data.BETTER_AUTH_URL).toBe(
          "https://face-attendance.vercel.app",
        );
        expect(result.data.GOOGLE_CLIENT_ID).toBe(
          "client-id.apps.googleusercontent.com",
        );
      }
    });

    it("fails when required auth variables are missing", () => {
      const result = schema.safeParse({
        NODE_ENV: "production",
        NEXT_PUBLIC_APP_URL: "https://face-attendance.vercel.app",
        // Missing MONGODB_URI, BETTER_AUTH_SECRET, GOOGLE_CLIENT_ID, etc.
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const issues = result.error.issues.map((i) => i.path.join("."));
        expect(issues).toContain("MONGODB_URI");
        expect(issues).toContain("BETTER_AUTH_URL");
        expect(issues).toContain("BETTER_AUTH_SECRET");
        expect(issues).toContain("GOOGLE_CLIENT_ID");
        expect(issues).toContain("GOOGLE_CLIENT_SECRET");
      }
    });
  });
});
