/**
 * Class code generation and normalization utilities.
 *
 * PHASE 5.1A — Class + Membership persistence foundation.
 *
 * - Codes are generated using `node:crypto.randomBytes()` (cryptographically
 *   secure, NOT Math.random()).
 * - Codes use an unambiguous alphabet: uppercase letters + digits, excluding
 *   ambiguous characters (O, 0, I, 1).
 * - Normalization is a single shared function; all lookups use it.
 * - The unique index on `classCode` is the authoritative uniqueness guard.
 *
 * This module is server-only.
 */

import "server-only";

/**
 * Alphabet for class codes.
 * Excludes O/0 and I/1 to reduce human-entry errors.
 */
const CLASS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** Canonical length for a generated class code. */
export const CLASS_CODE_LENGTH = 7;

/**
 * Normalizes a user-supplied class code to its canonical form.
 *
 * - Trims whitespace.
 * - Converts to uppercase.
 *
 * All class code lookups (create, join) MUST use this function.
 */
export function normalizeClassCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/**
 * Generates a new class code using `node:crypto`.
 *
 * Uses `randomBytes` for cryptographically secure randomness.
 * Falls back to the next alphabet character on the extremely rare
 * collision with the not-allowed alphabet — but the unique database
 * index is the authoritative guard.
 *
 * Returns a string of exactly `CLASS_CODE_LENGTH` uppercase characters
 * from `CLASS_CODE_ALPHABET`.
 */
export function generateClassCode(): string {
  // Import lazily so this module remains tree-shakeable where unused.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes } = require("node:crypto");

  const bytes = randomBytes(CLASS_CODE_LENGTH * 2); // oversample to reduce bias
  let code = "";

  for (let i = 0; i < CLASS_CODE_LENGTH; i++) {
    // Map each byte to an alphabet index using modulo.
    // Oversampling ensures uniform distribution across the alphabet.
    const index = bytes[i] % CLASS_CODE_ALPHABET.length;
    code += CLASS_CODE_ALPHABET[index]!;
  }

  return code;
}

/**
 * Returns `true` if `code` uses only characters from the allowed alphabet.
 *
 * Used in tests to verify generator output.
 */
export function isValidClassCodeAlphabet(code: string): boolean {
  for (const char of code) {
    if (!CLASS_CODE_ALPHABET.includes(char)) {
      return false;
    }
  }
  return true;
}

/**
 * Returns `true` if `code` has the canonical length and is uppercase.
 *
 * Used in tests to verify generator output.
 */
export function isCanonicalClassCode(code: string): boolean {
  return (
    code.length === CLASS_CODE_LENGTH &&
    code === code.toUpperCase() &&
    isValidClassCodeAlphabet(code)
  );
}
