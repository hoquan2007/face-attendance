import { describe, expect, it } from "vitest";

import { buildEnvSchema, emptyStringToUndefined } from "@/lib/env-schema";

/**
 * Tests for the boot-time environment schema.
 *
 * Phase 0.6 hardening: empty / whitespace-only environment values from
 * deployment providers (notably Vercel) must NOT crash the build. We
 * pre-process them to `undefined` so `.optional()` defaults kick in.
 * Real, non-empty invalid values must still fail loudly.
 */
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

  describe("buildEnvSchema — URL variables (optional)", () => {
    const schema = buildEnvSchema();

    // The two optional URL-typed env vars must follow the exact same rules.
    const urlVars = ["BETTER_AUTH_URL", "FACE_SERVICE_URL"] as const;

    for (const name of urlVars) {
      describe(name, () => {
        it("accepts undefined as missing (valid)", () => {
          const result = schema.safeParse({ [name]: undefined });
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data[name]).toBeUndefined();
          }
        });

        it("accepts empty string as missing (valid, undefined)", () => {
          const result = schema.safeParse({ [name]: "" });
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data[name]).toBeUndefined();
          }
        });

        it("accepts whitespace-only string as missing (valid, undefined)", () => {
          const result = schema.safeParse({ [name]: "   " });
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data[name]).toBeUndefined();
          }
        });

        it("accepts a proper http URL", () => {
          const result = schema.safeParse({ [name]: "http://localhost:3000" });
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data[name]).toBe("http://localhost:3000");
          }
        });

        it("accepts a proper https URL", () => {
          const result = schema.safeParse({
            [name]: "https://example.vercel.app",
          });
          expect(result.success).toBe(true);
          if (result.success) {
            expect(result.data[name]).toBe("https://example.vercel.app");
          }
        });

        it("rejects a malformed non-empty URL", () => {
          const result = schema.safeParse({ [name]: "abc" });
          expect(result.success).toBe(false);
        });
      });
    }
  });

  describe("buildEnvSchema — NEXT_PUBLIC_APP_URL", () => {
    const schema = buildEnvSchema();

    it("defaults to http://localhost:3000 when undefined", () => {
      const result = schema.safeParse({ NEXT_PUBLIC_APP_URL: undefined });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
      }
    });

    it("defaults to http://localhost:3000 when the value is an empty string", () => {
      const result = schema.safeParse({ NEXT_PUBLIC_APP_URL: "" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
      }
    });

    it("defaults to http://localhost:3000 when the value is whitespace", () => {
      const result = schema.safeParse({ NEXT_PUBLIC_APP_URL: "   " });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
      }
    });

    it("accepts a proper https URL and still validates it as a URL", () => {
      const result = schema.safeParse({
        NEXT_PUBLIC_APP_URL: "https://face-attendance.vercel.app",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NEXT_PUBLIC_APP_URL).toBe(
          "https://face-attendance.vercel.app",
        );
      }
    });

    it("rejects a malformed non-empty URL even with the default in mind", () => {
      const result = schema.safeParse({ NEXT_PUBLIC_APP_URL: "abc" });
      expect(result.success).toBe(false);
    });
  });

  describe("buildEnvSchema — APP_NAME", () => {
    const schema = buildEnvSchema();

    it("defaults to the standard application name when undefined", () => {
      const result = schema.safeParse({ APP_NAME: undefined });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.APP_NAME).toBe("Face Attendance System");
      }
    });

    it("accepts a custom application name", () => {
      const result = schema.safeParse({ APP_NAME: "Acme Attendance" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.APP_NAME).toBe("Acme Attendance");
      }
    });
  });

  describe("buildEnvSchema — plain optional strings", () => {
    const schema = buildEnvSchema();

    const stringVars = [
      "MONGODB_URI",
      "BETTER_AUTH_SECRET",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
      "FACE_SERVICE_SECRET",
    ] as const;

    for (const name of stringVars) {
      it(`${name}: empty string is treated as undefined`, () => {
        const result = schema.safeParse({ [name]: "" });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data[name]).toBeUndefined();
        }
      });

      it(`${name}: whitespace is treated as undefined`, () => {
        const result = schema.safeParse({ [name]: "   " });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data[name]).toBeUndefined();
        }
      });

      it(`${name}: a real value passes through unchanged`, () => {
        const result = schema.safeParse({ [name]: "real-value" });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data[name]).toBe("real-value");
        }
      });
    }
  });

  describe("buildEnvSchema — combined empty-string scenario", () => {
    // Reproduces the original Vercel build failure where every optional env
    // var is exposed as an empty string. The full schema must still parse.
    it("parses cleanly when every optional var is an empty string", () => {
      const result = schema_with_all_empty_optionals();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.NEXT_PUBLIC_APP_URL).toBe("http://localhost:3000");
        expect(result.data.APP_NAME).toBe("Face Attendance System");
        expect(result.data.MONGODB_URI).toBeUndefined();
        expect(result.data.BETTER_AUTH_URL).toBeUndefined();
        expect(result.data.BETTER_AUTH_SECRET).toBeUndefined();
        expect(result.data.GOOGLE_CLIENT_ID).toBeUndefined();
        expect(result.data.GOOGLE_CLIENT_SECRET).toBeUndefined();
        expect(result.data.FACE_SERVICE_URL).toBeUndefined();
        expect(result.data.FACE_SERVICE_SECRET).toBeUndefined();
      }
    });
  });
});

// Helper that mimics what `env.ts` does when every optional var is exposed
// as an empty string (the exact Vercel scenario that broke the build).
function schema_with_all_empty_optionals() {
  return buildEnvSchema().safeParse({
    NODE_ENV: "production",
    NEXT_PUBLIC_APP_URL: "",
    APP_NAME: "",
    MONGODB_URI: "",
    BETTER_AUTH_URL: "",
    BETTER_AUTH_SECRET: "",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    FACE_SERVICE_URL: "",
    FACE_SERVICE_SECRET: "",
  });
}
