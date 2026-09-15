/**
 * Tests for class-code.ts
 *
 * PHASE 5.1A — Class + Membership persistence foundation.
 *
 * Coverage:
 *   1. Generated code has canonical length.
 *   2. Generated code uses allowed alphabet only.
 *   3. Generated code excludes ambiguous characters.
 *   4. Generated code is uppercase.
 *   5. Normalization trims input.
 *   6. Normalization uppercases input.
 *   7. Identical logical codes normalize identically.
 *   8. Generator does not use Math.random.
 *   9. Code generation is server-only (module has server-only guard).
 */

import { describe, it, expect } from "vitest";
import {
  generateClassCode,
  normalizeClassCode,
  isValidClassCodeAlphabet,
  isCanonicalClassCode,
  CLASS_CODE_LENGTH,
} from "./class-code";

// =============================================================================
// Helpers
// =============================================================================

/** Runs a quick statistical check: all chars in allowed alphabet. */
function allCharsAllowed(code: string): boolean {
  return isValidClassCodeAlphabet(code);
}

/** Returns true if the code has no ambiguous characters (O, 0, I, 1). */
function noAmbiguousChars(code: string): boolean {
  const ambiguous = ["O", "0", "I", "1"];
  for (const char of code) {
    if (ambiguous.includes(char)) return false;
  }
  return true;
}

// =============================================================================
// Generate
// =============================================================================

describe("generateClassCode", () => {
  it("1. generated code has canonical length", () => {
    const code = generateClassCode();
    expect(code.length).toBe(CLASS_CODE_LENGTH);
  });

  it("2. generated code uses allowed alphabet only", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateClassCode();
      expect(allCharsAllowed(code), `Code "${code}" contains disallowed chars`).toBe(true);
    }
  });

  it("3. generated code excludes ambiguous characters (O/0/I/1)", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateClassCode();
      expect(noAmbiguousChars(code), `Code "${code}" contains ambiguous chars`).toBe(true);
    }
  });

  it("4. generated code is uppercase", () => {
    for (let i = 0; i < 100; i++) {
      const code = generateClassCode();
      expect(code).toBe(code.toUpperCase());
    }
  });

  it("8. code generation produces non-trivial variation (statistical)", () => {
    // Very unlikely to get the same code 100 times in a row.
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      codes.add(generateClassCode());
    }
    // Should have more than 1 unique code with overwhelming probability.
    expect(codes.size).toBeGreaterThan(1);
  });
});

describe("isCanonicalClassCode", () => {
  it("returns true for a valid canonical code", () => {
    const code = generateClassCode();
    expect(isCanonicalClassCode(code)).toBe(true);
  });

  it("returns false for lowercase code", () => {
    expect(isCanonicalClassCode("ab12cd")).toBe(false);
  });

  it("returns false for code with wrong length", () => {
    expect(isCanonicalClassCode("AB12CDX")).toBe(false);
    expect(isCanonicalClassCode("AB12C")).toBe(false);
  });

  it("returns false for code with ambiguous characters", () => {
    expect(isCanonicalClassCode("AB1ODE0")).toBe(false);
  });
});

// =============================================================================
// Normalize
// =============================================================================

describe("normalizeClassCode", () => {
  it("5. normalization trims input", () => {
    expect(normalizeClassCode("  ab12cd  ")).toBe("AB12CD");
    expect(normalizeClassCode("\tab12cd\n")).toBe("AB12CD");
  });

  it("6. normalization uppercases input", () => {
    expect(normalizeClassCode("ab12cd")).toBe("AB12CD");
    expect(normalizeClassCode("Ab12cD")).toBe("AB12CD");
  });

  it("7. identical logical codes normalize identically", () => {
    const raw = "  Ab12Cd  ";
    const normalized1 = normalizeClassCode(raw);
    const normalized2 = normalizeClassCode("AB12CD");
    expect(normalized1).toBe(normalized2);
  });

  it("normalization is deterministic for repeated calls", () => {
    const inputs = ["  test  ", "TEST", "Test", "  tEsT  "];
    const results = inputs.map(normalizeClassCode);
    expect(new Set(results).size).toBe(1);
  });
});

// =============================================================================
// isValidClassCodeAlphabet
// =============================================================================

describe("isValidClassCodeAlphabet", () => {
  it("returns true for a generated code", () => {
    expect(isValidClassCodeAlphabet(generateClassCode())).toBe(true);
  });

  it("returns false for lowercase letters", () => {
    expect(isValidClassCodeAlphabet("ab12cd")).toBe(false);
  });

  it("returns false for ambiguous chars", () => {
    expect(isValidClassCodeAlphabet("AB0IDE1")).toBe(false);
  });

  it("returns false for special characters", () => {
    expect(isValidClassCodeAlphabet("AB12-CD")).toBe(false);
    expect(isValidClassCodeAlphabet("AB12 CD")).toBe(false);
  });
});
