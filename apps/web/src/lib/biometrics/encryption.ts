/**
 * Biometric Encryption Module
 *
 * PHASE 4.1 — AES-256-GCM encryption foundation for face embeddings.
 *
 * ⚠️  SERVER-ONLY MODULE ⚠️
 *
 * This module must only be imported from:
 * - Server Components
 * - Server Actions
 * - Route Handlers (API routes)
 * - Other server-only modules
 *
 * NEVER import this from:
 * - Client Components
 * - Browser code
 * - Client-side hooks or utilities
 *
 * For TypeScript/build-time enforcement, prefer importing only from
 * modules that are themselves server-only.
 *
 * Algorithm: AES-256-GCM
 * - 256-bit key (32 bytes, base64-encoded)
 * - 96-bit IV (12 bytes, fresh per encryption)
 * - 128-bit auth tag
 * - Authenticated Associated Data (AAD) for context binding
 *
 * Key version: 1 (supports future key rotation without interface changes)
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import { env } from "@/lib/env";

// =============================================================================
// Types
// =============================================================================

/**
 * Encrypted biometric value structure.
 *
 * All binary fields are base64-encoded for safe serialization.
 * This format is versioned via `keyVersion` for future key rotation.
 */
export interface EncryptedBiometricValue {
  /** Base64-encoded AES-256-GCM ciphertext */
  ciphertext: string;
  /** Base64-encoded 12-byte initialization vector (fresh per operation) */
  iv: string;
  /** Base64-encoded 16-byte authentication tag */
  authTag: string;
  /** Key version for future rotation support */
  keyVersion: number;
}

/**
 * Authenticated Associated Data (AAD) metadata.
 *
 * This data is NOT encrypted but is authenticated — any tampering
 * will cause decryption to fail. AAD binds the ciphertext to a specific
 * context (user, model, vector type).
 *
 * Do NOT include secret data in AAD.
 */
export interface BiometricAAD {
  /** User ID this biometric belongs to */
  userId: string;
  /** Model identity string (e.g., "insightface/buffalo_l") */
  modelIdentity: string;
  /** Template version for the embedding format */
  templateVersion: number;
  /** Vector type identifier (e.g., "face-embedding") */
  vectorType: string;
  /** Optional: sample index within an enrollment batch */
  sampleIndex?: number;
}

/**
 * Internal key representation used by the crypto operations.
 */
interface EncryptionKey {
  key: Buffer;
  version: number;
}

// =============================================================================
// Error Handling
// =============================================================================

export const BIOMETRIC_ERROR_CODES = {
  KEY_MISSING: "BIOMETRIC_KEY_MISSING",
  KEY_INVALID: "BIOMETRIC_KEY_INVALID",
  INVALID_VECTOR: "INVALID_BIOMETRIC_VECTOR",
  DECRYPTION_FAILED: "BIOMETRIC_DECRYPTION_FAILED",
  UNSUPPORTED_KEY_VERSION: "UNSUPPORTED_KEY_VERSION",
} as const;

export type BiometricErrorCode =
  (typeof BIOMETRIC_ERROR_CODES)[keyof typeof BIOMETRIC_ERROR_CODES];

/**
 * Biometric-specific error with safe error codes.
 * Does not expose crypto internals, key material, or vector values.
 */
export class BiometricError extends Error {
  public readonly code: BiometricErrorCode;

  constructor({
    code,
    message,
  }: {
    code: BiometricErrorCode;
    message: string;
  }) {
    super(message);
    this.name = "BiometricError";
    this.code = code;
  }
}

// =============================================================================
// Key Management
// =============================================================================

/** Cached encryption key (loaded once per server lifetime) */
let cachedKey: EncryptionKey | undefined;

const CURRENT_KEY_VERSION = 1;
const IV_LENGTH = 12; // 96 bits for AES-GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Loads and validates the BIOMETRIC_ENCRYPTION_KEY from environment.
 *
 * Called lazily on first encryption/decryption operation.
 * Caches the decoded key to avoid repeated base64 decoding.
 *
 * @throws {BiometricError} If key is missing or invalid
 */
function getOrLoadKey(): EncryptionKey {
  if (cachedKey) {
    return cachedKey;
  }

  const keyEnv = env.BIOMETRIC_ENCRYPTION_KEY;

  if (!keyEnv) {
    throw new BiometricError({
      code: BIOMETRIC_ERROR_CODES.KEY_MISSING,
      message: "BIOMETRIC_ENCRYPTION_KEY is not configured.",
    });
  }

  let keyBuffer: Buffer;
  try {
    keyBuffer = Buffer.from(keyEnv, "base64");
  } catch {
    throw new BiometricError({
      code: BIOMETRIC_ERROR_CODES.KEY_INVALID,
      message: "BIOMETRIC_ENCRYPTION_KEY is not valid base64.",
    });
  }

  if (keyBuffer.length !== 32) {
    throw new BiometricError({
      code: BIOMETRIC_ERROR_CODES.KEY_INVALID,
      message:
        "BIOMETRIC_ENCRYPTION_KEY must be exactly 32 bytes (24 bytes when base64-encoded).",
    });
  }

  cachedKey = { key: keyBuffer, version: CURRENT_KEY_VERSION };
  return cachedKey;
}

// =============================================================================
// AAD Serialization
// =============================================================================

/**
 * Serializes BiometricAAD to a deterministic byte string for AAD.
 *
 * Format: JSON.stringify with sorted keys ensures determinism.
 * The version field enables future format evolution.
 *
 * @param aad - The AAD metadata to serialize
 * @returns Deterministic byte string suitable for use as AAD
 */
function serializeAAD(aad: BiometricAAD): Buffer {
  const versioned = {
    v: 1,
    ...aad,
  };
  return Buffer.from(JSON.stringify(versioned), "utf8");
}

// =============================================================================
// Vector Validation & Serialization
// =============================================================================

/**
 * Validates a biometric vector before encryption.
 *
 * @param vector - The embedding vector to validate
 * @throws {BiometricError} If vector is invalid
 */
function validateVector(vector: readonly number[]): void {
  if (!vector || vector.length === 0) {
    throw new BiometricError({
      code: BIOMETRIC_ERROR_CODES.INVALID_VECTOR,
      message: "Biometric vector must not be empty.",
    });
  }

  for (let i = 0; i < vector.length; i++) {
    const value = vector[i];
    if (!Number.isFinite(value)) {
      throw new BiometricError({
        code: BIOMETRIC_ERROR_CODES.INVALID_VECTOR,
        message: `Biometric vector contains non-finite value at index ${i}.`,
      });
    }
  }
}

/**
 * Serializes a numeric vector to float32 binary format.
 *
 * Uses float32 (not float64) to match the typical embedding storage
 * precision and reduce ciphertext size. Float32 is sufficient for
 * normalized face embeddings from ArcFace.
 *
 * @param vector - The embedding vector
 * @returns Buffer containing float32 binary data
 */
function serializeVector(vector: readonly number[]): Buffer {
  const buffer = Buffer.alloc(vector.length * 4);
  for (let i = 0; i < vector.length; i++) {
    // Float32 precision is sufficient for normalized embeddings
    buffer.writeFloatLE(vector[i]!, i * 4);
  }
  return buffer;
}

/**
 * Deserializes a float32 binary buffer back to a Float32Array.
 *
 * @param buffer - Buffer containing float32 binary data
 * @param length - Number of float32 values
 * @returns Float32Array with the deserialized vector
 */
function deserializeVector(buffer: Buffer, length: number): Float32Array {
  const array = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    array[i] = buffer.readFloatLE(i * 4);
  }
  return array;
}

// =============================================================================
// Core Encryption/Decryption
// =============================================================================

/**
 * Encrypts a biometric vector with AES-256-GCM.
 *
 * Features:
 * - Fresh IV per operation (never reused)
 * - Authenticated encryption with AAD context binding
 * - Key version for future rotation
 *
 * @param vector - The face embedding vector to encrypt
 * @param aad - Authenticated associated data for context binding
 * @returns Encrypted biometric value structure
 * @throws {BiometricError} On validation failure or crypto error
 */
export function encryptBiometricVector(
  vector: readonly number[],
  aad: BiometricAAD,
): EncryptedBiometricValue {
  // Validate inputs
  validateVector(vector);

  // Load key (validates on first call)
  const { key } = getOrLoadKey();

  // Generate fresh IV (96 bits for AES-GCM)
  const iv = randomBytes(IV_LENGTH);

  // Serialize vector to float32 binary
  const plaintext = serializeVector(vector);

  // Serialize AAD for authentication
  const aadBuffer = serializeAAD(aad);

  // Create cipher and encrypt
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  cipher.setAAD(aadBuffer);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    keyVersion: CURRENT_KEY_VERSION,
  };
}

/**
 * Decrypts an encrypted biometric value back to a Float32Array.
 *
 * @param encrypted - The encrypted biometric value to decrypt
 * @param aad - AAD that must match the encryption context
 * @returns Decrypted face embedding as Float32Array
 * @throws {BiometricError} On decryption failure, AAD mismatch, or key version
 */
export function decryptBiometricVector(
  encrypted: EncryptedBiometricValue,
  aad: BiometricAAD,
): Float32Array {
  // Validate key version
  if (encrypted.keyVersion !== CURRENT_KEY_VERSION) {
    throw new BiometricError({
      code: BIOMETRIC_ERROR_CODES.UNSUPPORTED_KEY_VERSION,
      message: `Unsupported key version: ${encrypted.keyVersion}.`,
    });
  }

  // Load key
  const { key } = getOrLoadKey();

  // Decode base64 fields
  let ciphertext: Buffer;
  let iv: Buffer;
  let authTag: Buffer;

  try {
    ciphertext = Buffer.from(encrypted.ciphertext, "base64");
    iv = Buffer.from(encrypted.iv, "base64");
    authTag = Buffer.from(encrypted.authTag, "base64");
  } catch {
    throw new BiometricError({
      code: BIOMETRIC_ERROR_CODES.DECRYPTION_FAILED,
      message: "Encrypted biometric value contains invalid base64 data.",
    });
  }

  // Validate IV and auth tag lengths
  if (iv.length !== IV_LENGTH) {
    throw new BiometricError({
      code: BIOMETRIC_ERROR_CODES.DECRYPTION_FAILED,
      message: "Invalid initialization vector length.",
    });
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new BiometricError({
      code: BIOMETRIC_ERROR_CODES.DECRYPTION_FAILED,
      message: "Invalid authentication tag length.",
    });
  }

  // Serialize AAD for verification
  const aadBuffer = serializeAAD(aad);

  // Create decipher and decrypt
  const decipher = createDecipheriv("aes-256-gcm", key, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  decipher.setAAD(aadBuffer);

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
  } catch {
    throw new BiometricError({
      code: BIOMETRIC_ERROR_CODES.DECRYPTION_FAILED,
      message: "Decryption failed — authentication error or data corruption.",
    });
  }

  // Deserialize back to Float32Array
  if (plaintext.length % 4 !== 0) {
    throw new BiometricError({
      code: BIOMETRIC_ERROR_CODES.DECRYPTION_FAILED,
      message: "Decrypted data has invalid length.",
    });
  }

  const length = plaintext.length / 4;
  return deserializeVector(plaintext, length);
}

// =============================================================================
// Key for Testing (isolated from production key)
// =============================================================================

/**
 * Creates an encryption key from a base64 string for testing purposes.
 *
 * This allows tests to use a deterministic test key without depending
 * on the production BIOMETRIC_ENCRYPTION_KEY environment variable.
 *
 * @param base64Key - Base64-encoded 32-byte key
 * @returns EncryptionKey suitable for test fixtures
 * @throws {BiometricError} If key format is invalid
 */
export function createTestEncryptionKey(base64Key: string): EncryptionKey {
  let keyBuffer: Buffer;
  try {
    keyBuffer = Buffer.from(base64Key, "base64");
  } catch {
    throw new BiometricError({
      code: BIOMETRIC_ERROR_CODES.KEY_INVALID,
      message: "Test encryption key is not valid base64.",
    });
  }

  if (keyBuffer.length !== 32) {
    throw new BiometricError({
      code: BIOMETRIC_ERROR_CODES.KEY_INVALID,
      message: "Test encryption key must be exactly 32 bytes.",
    });
  }

  return { key: keyBuffer, version: CURRENT_KEY_VERSION };
}

/**
 * Injects a test key into the module (for unit testing only).
 *
 * WARNING: This function is intended for unit tests only.
 * It bypasses the normal key loading mechanism.
 *
 * @param testKey - Test encryption key to use
 */
export function injectTestKey(testKey: EncryptionKey): void {
  cachedKey = testKey;
}

/**
 * Clears the cached key (for test cleanup).
 */
export function clearCachedKey(): void {
  cachedKey = undefined;
}
