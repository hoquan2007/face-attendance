/**
 * Class password hashing utilities.
 *
 * PHASE 5.1A.1 — Class password request-path hardening.
 *
 * Class passwords are hashed with PBKDF2-SHA256 using `node:crypto`'s
 * asynchronous `pbkdf2`. The model stores only `passwordHash` — never
 * plaintext.
 *
 * Design decisions:
 *   - PBKDF2-SHA256 is an established, widely-analyzed KDF.
 *   - Salt is unique per hash to defeat rainbow tables.
 *   - Iteration count is a single, centralized constant.
 *   - Verification uses `crypto.timingSafeEqual` for constant-time
 *     comparison of derived key bytes.
 *   - The encoded hash is a self-describing, versioned string so that
 *     future work-factor changes do not break old hashes.
 *   - The raw password is discarded immediately after hashing;
 *     it is NEVER stored, logged, serialized, or cached.
 *
 * This module is server-only.
 */

import "server-only";

import {
  pbkdf2 as pbkdf2Cb,
  randomBytes as cryptoRandomBytes,
  timingSafeEqual as cryptoTimingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const pbkdf2 = promisify(pbkdf2Cb);

// =============================================================================
// Constants
// =============================================================================

/**
 * PBKDF2 iteration count for class password hashing.
 *
 * This is the single source of truth for the work factor. It is encoded
 * into every produced hash so the value can be evolved safely in the
 * future without breaking verification of older hashes.
 *
 * PHASE 5.1A.1 keeps the effective work factor unchanged from the
 * synchronous prototype.
 */
export const CLASS_PASSWORD_PBKDF2_ITERATIONS = 100_000;

/** Salt byte length. 32 bytes = 256 bits. */
export const CLASS_PASSWORD_SALT_LENGTH = 32;

/** Derived key byte length. 32 bytes = 256 bits. */
export const CLASS_PASSWORD_KEY_LENGTH = 32;

/**
 * Self-describing algorithm identifier encoded at the head of every
 * produced hash. The shape is `pbkdf2-sha256$<iter>$<saltHex>$<keyHex>`.
 */
export const CLASS_PASSWORD_ALGORITHM = "pbkdf2-sha256";

// =============================================================================
// Internal helpers
// =============================================================================

/**
 * Hex encoding predicate. Accepts only lowercase + uppercase hex digits
 * with an even length so a `Buffer.from(..., "hex")` call cannot be
 * tricked into partial / padded garbage.
 */
function isValidHex(value: string): boolean {
  if (value.length === 0 || (value.length % 2) !== 0) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const isDigit = c >= 0x30 && c <= 0x39;          // 0-9
    const isLower = c >= 0x61 && c <= 0x66;         // a-f
    const isUpper = c >= 0x41 && c <= 0x46;         // A-F
    if (!isDigit && !isLower && !isUpper) return false;
  }
  return true;
}

/**
 * Returns a positive integer parsed from `value`, or `null` if `value`
 * is not a strictly positive base-10 integer string.
 *
 * Rejects empty strings, leading whitespace, signs, decimals, and
 * exponential notation.
 */
function parsePositiveInteger(value: string): number | null {
  if (value.length === 0) return null;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
    return null;
  }
  return parsed;
}

/**
 * Parses a stored encoded hash into its structural fields without
 * performing any cryptographic comparison.
 *
 * Returns `null` for any malformed value. The function is total — it
 * never throws on input — so callers can safely invoke it from
 * `verifyClassPassword` and `isValidPasswordHash` without leaking
 * parser internals to future browser callers.
 */
function parseEncodedHash(encoded: unknown): {
  algorithm: string;
  iterations: number;
  salt: Buffer;
  derivedKey: Buffer;
} | null {
  if (typeof encoded !== "string") return null;
  if (encoded.length === 0) return null;

  const parts = encoded.split("$");
  if (parts.length !== 4) return null;

  const [algorithm, iterationsRaw, saltHex, keyHex] = parts;
  if (!algorithm || !iterationsRaw || !saltHex || !keyHex) return null;
  if (algorithm !== CLASS_PASSWORD_ALGORITHM) return null;

  const iterations = parsePositiveInteger(iterationsRaw);
  if (iterations === null) return null;

  if (!isValidHex(saltHex) || !isValidHex(keyHex)) return null;

  const salt = Buffer.from(saltHex, "hex");
  const derivedKey = Buffer.from(keyHex, "hex");

  // Length revalidation: ensure the buffer is exactly the expected size.
  // A `Buffer.from("ab", "hex")` returns a 1-byte buffer, so the string
  // length check above is necessary but not sufficient — assert bytes too.
  if (salt.length !== CLASS_PASSWORD_SALT_LENGTH) return null;
  if (derivedKey.length !== CLASS_PASSWORD_KEY_LENGTH) return null;

  return { algorithm, iterations, salt, derivedKey };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Hashes a class password.
 *
 * Returns a self-describing encoded hash of the form
 * `pbkdf2-sha256$<iterations>$<saltHex>$<derivedKeyHex>`.
 *
 * The implementation is asynchronous; on a server event loop this
 * yields the thread during the expensive PBKDF2 work.
 *
 * The raw password is never stored, logged, cached, or returned. It
 * exists only as a function argument for the lifetime of the awaited
 * call.
 */
export async function hashClassPassword(rawPassword: string): Promise<string> {
  if (typeof rawPassword !== "string" || rawPassword.length === 0) {
    // Defensive: never encode an empty / non-string password. Future
    // Server Actions are expected to validate upstream; this guard
    // ensures the primitive itself cannot produce a meaningless hash.
    throw new Error("hashClassPassword: rawPassword must be a non-empty string");
  }

  const salt = cryptoRandomBytes(CLASS_PASSWORD_SALT_LENGTH);
  const derivedKey = await pbkdf2(
    rawPassword,
    salt,
    CLASS_PASSWORD_PBKDF2_ITERATIONS,
    CLASS_PASSWORD_KEY_LENGTH,
    "sha256",
  );

  return [
    CLASS_PASSWORD_ALGORITHM,
    CLASS_PASSWORD_PBKDF2_ITERATIONS,
    salt.toString("hex"),
    derivedKey.toString("hex"),
  ].join("$");
}

/**
 * Verifies a raw password against a stored encoded hash.
 *
 * Returns `true` only when `rawPassword` reproduces the exact derived
 * key bytes encoded in `encodedHash`, computed with the exact salt,
 * iteration count, and algorithm that were used at hashing time.
 *
 * Returns `false` when:
 *   - the raw password is not a non-empty string,
 *   - the stored value is malformed in any way (wrong field count,
 *     unknown algorithm, invalid hex, invalid iteration count, wrong
 *     salt length, wrong key length),
 *   - the derived key bytes do not match.
 *
 * The comparison of derived key bytes uses `crypto.timingSafeEqual`
 * with explicit length validation, so the function never crashes on
 * a malformed value and never leaks a `===` short-circuit to a timing
 * attacker.
 *
 * The function never throws on input — malformed input maps to a
 * controlled `false` so future Server Actions can map verification
 * failures to safe domain codes without leaking parser internals.
 */
export async function verifyClassPassword(
  rawPassword: string,
  encodedHash: unknown,
): Promise<boolean> {
  if (typeof rawPassword !== "string" || rawPassword.length === 0) {
    return false;
  }

  const parsed = parseEncodedHash(encodedHash);
  if (parsed === null) return false;

  const actualKey = await pbkdf2(
    rawPassword,
    parsed.salt,
    parsed.iterations,
    CLASS_PASSWORD_KEY_LENGTH,
    "sha256",
  );

  // Both buffers have been length-validated above, but a defensive
  // runtime length check still avoids `timingSafeEqual` ever throwing
  // a `RangeError` from the underlying crypto primitive.
  if (actualKey.length !== parsed.derivedKey.length) return false;

  return cryptoTimingSafeEqual(actualKey, parsed.derivedKey);
}

/**
 * Returns `true` when the encoded value is non-empty and conforms to the
 * `pbkdf2-sha256$<iter>$<saltHex>$<keyHex>` shape with the expected
 * salt/key lengths and a strictly positive integer iteration count.
 *
 * Used by tests and any future service-layer diagnostic that needs to
 * assert that a stored value is well-formed before attempting
 * verification. This function is total and never throws.
 */
export function isValidPasswordHash(encoded: unknown): boolean {
  return parseEncodedHash(encoded) !== null;
}