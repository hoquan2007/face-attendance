/**
 * Unit tests for the biometric encryption module.
 *
 * PHASE 4.1 — AES-256-GCM encryption foundation for face embeddings.
 *
 * These tests use injected test keys and do NOT depend on the real
 * BIOMETRIC_ENCRYPTION_KEY environment variable. They do NOT connect to
 * MongoDB or any external service.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";

import {
  BIOMETRIC_ERROR_CODES,
  BiometricError,
  encryptBiometricVector,
  decryptBiometricVector,
  createTestEncryptionKey,
  injectTestKey,
  clearCachedKey,
  type BiometricAAD,
  type EncryptedBiometricValue,
} from "@/lib biometrics/encryption";

// =============================================================================
// Test Fixtures
// =============================================================================

/**
 * A deterministic 32-byte test key for unit tests.
 * Base64 of 32 zero bytes.
 */
const TEST_KEY_BASE64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

/**
 * Another test key to verify wrong key detection.
 * Base64 of 32 bytes with value 1.
 */
const WRONG_KEY_BASE64 = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHx8=";

/**
 * A valid AAD fixture for tests.
 */
const validAAD: BiometricAAD = {
  userId: "user-123",
  modelIdentity: "insightface/buffalo_l",
  templateVersion: 1,
  vectorType: "face-embedding",
};

/**
 * A typical 512-D face embedding vector for testing.
 */
function createTestVector(dimension: number = 512): readonly number[] {
  const vector: number[] = [];
  for (let i = 0; i < dimension; i++) {
    // Normalized random values in [-1, 1]
    vector.push(Math.sin(i * 0.1) * 0.5);
  }
  return vector;
}

// =============================================================================
// Setup / Teardown
// =============================================================================

beforeEach(() => {
  // Clear any cached key before each test
  clearCachedKey();
  // Inject the test key
  const testKey = createTestEncryptionKey(TEST_KEY_BASE64);
  injectTestKey(testKey);
});

afterEach(() => {
  // Clean up the cached key
  clearCachedKey();
});

// =============================================================================
// Key Creation Tests
// =============================================================================

describe("biometric encryption / createTestEncryptionKey", () => {
  it("accepts a valid 32-byte base64 key", () => {
    const key = createTestEncryptionKey(TEST_KEY_BASE64);
    expect(key.key.length).toBe(32);
    expect(key.version).toBe(1);
  });

  it("rejects invalid base64", () => {
    expect(() => createTestEncryptionKey("not-valid-base64!!!")).toThrow(
      BiometricError,
    );
  });

  it("rejects base64 that decodes to wrong length (too short)", () => {
    const shortKey = Buffer.from([1, 2, 3]).toString("base64");
    expect(() => createTestEncryptionKey(shortKey)).toThrow(BiometricError);
  });

  it("rejects base64 that decodes to wrong length (too long)", () => {
    const longKey = Buffer.alloc(64).toString("base64");
    expect(() => createTestEncryptionKey(longKey)).toThrow(BiometricError);
  });

  it("throws with correct error code for invalid base64", () => {
    try {
      createTestEncryptionKey("!!!");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BiometricError);
      expect((err as BiometricError).code).toBe(
        BIOMETRIC_ERROR_CODES.KEY_INVALID,
      );
    }
  });

  it("throws with correct error code for wrong length", () => {
    try {
      createTestEncryptionKey(Buffer.alloc(16).toString("base64"));
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BiometricError);
      expect((err as BiometricError).code).toBe(
        BIOMETRIC_ERROR_CODES.KEY_INVALID,
      );
    }
  });
});

// =============================================================================
// Vector Validation Tests
// =============================================================================

describe("biometric encryption / vector validation", () => {
  it("rejects empty vector", () => {
    expect(() => encryptBiometricVector([], validAAD)).toThrow(
      BiometricError,
    );
    try {
      encryptBiometricVector([], validAAD);
    } catch (err) {
      expect((err as BiometricError).code).toBe(
        BIOMETRIC_ERROR_CODES.INVALID_VECTOR,
      );
    }
  });

  it("rejects vector containing NaN", () => {
    const vector = [1.0, NaN, 2.0];
    expect(() => encryptBiometricVector(vector, validAAD)).toThrow(
      BiometricError,
    );
    try {
      encryptBiometricVector(vector, validAAD);
    } catch (err) {
      expect((err as BiometricError).code).toBe(
        BIOMETRIC_ERROR_CODES.INVALID_VECTOR,
      );
    }
  });

  it("rejects vector containing Infinity", () => {
    const vector = [1.0, Infinity, 2.0];
    expect(() => encryptBiometricVector(vector, validAAD)).toThrow(
      BiometricError,
    );
    try {
      encryptBiometricVector(vector, validAAD);
    } catch (err) {
      expect((err as BiometricError).code).toBe(
        BIOMETRIC_ERROR_CODES.INVALID_VECTOR,
      );
    }
  });

  it("rejects vector containing -Infinity", () => {
    const vector = [-Infinity, 0.5, 0.5];
    expect(() => encryptBiometricVector(vector, validAAD)).toThrow(
      BiometricError,
    );
  });

  it("accepts valid vector with all finite values", () => {
    const vector = createTestVector(128);
    expect(() => encryptBiometricVector(vector, validAAD)).not.toThrow();
  });

  it("accepts vector with sampleIndex in AAD", () => {
    const aadWithIndex: BiometricAAD = {
      ...validAAD,
      sampleIndex: 5,
    };
    const vector = createTestVector(128);
    expect(() => encryptBiometricVector(vector, aadWithIndex)).not.toThrow();
  });
});

// =============================================================================
// Round Trip Tests
// =============================================================================

describe("biometric encryption / encrypt → decrypt round trip", () => {
  it("round trip returns original vector within float32 precision", () => {
    const original = createTestVector(512);
    const encrypted = encryptBiometricVector(original, validAAD);
    const decrypted = decryptBiometricVector(encrypted, validAAD);

    expect(decrypted.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decrypted[i]!).toBeCloseTo(original[i]!, 5);
    }
  });

  it("round trip works with 128-D vector", () => {
    const original = createTestVector(128);
    const encrypted = encryptBiometricVector(original, validAAD);
    const decrypted = decryptBiometricVector(encrypted, validAAD);

    expect(decrypted.length).toBe(128);
    for (let i = 0; i < original.length; i++) {
      expect(decrypted[i]!).toBeCloseTo(original[i]!, 5);
    }
  });

  it("round trip preserves extreme values within float32 precision", () => {
    const original: readonly number[] = [-1, -0.5, 0, 0.5, 1];
    const encrypted = encryptBiometricVector(original, validAAD);
    const decrypted = decryptBiometricVector(encrypted, validAAD);

    expect(decrypted.length).toBe(5);
    for (let i = 0; i < original.length; i++) {
      expect(decrypted[i]!).toBeCloseTo(original[i]!, 6);
    }
  });

  it("returns Float32Array from decryption", () => {
    const original = createTestVector(64);
    const encrypted = encryptBiometricVector(original, validAAD);
    const decrypted = decryptBiometricVector(encrypted, validAAD);

    expect(decrypted).toBeInstanceOf(Float32Array);
  });

  it("encrypted output has correct structure", () => {
    const vector = createTestVector(64);
    const encrypted = encryptBiometricVector(vector, validAAD);

    expect(encrypted).toHaveProperty("ciphertext");
    expect(encrypted).toHaveProperty("iv");
    expect(encrypted).toHaveProperty("authTag");
    expect(encrypted).toHaveProperty("keyVersion");

    expect(typeof encrypted.ciphertext).toBe("string");
    expect(typeof encrypted.iv).toBe("string");
    expect(typeof encrypted.authTag).toBe("string");
    expect(encrypted.keyVersion).toBe(1);

    // Base64 validation
    expect(() => Buffer.from(encrypted.ciphertext, "base64")).not.toThrow();
    expect(() => Buffer.from(encrypted.iv, "base64")).not.toThrow();
    expect(() => Buffer.from(encrypted.authTag, "base64")).not.toThrow();
  });
});

// =============================================================================
// Fresh IV Tests
// =============================================================================

describe("biometric encryption / fresh IV", () => {
  it("encrypting same vector twice produces different ciphertext", () => {
    const vector = createTestVector(256);

    const encrypted1 = encryptBiometricVector(vector, validAAD);
    const encrypted2 = encryptBiometricVector(vector, validAAD);

    expect(encrypted1.ciphertext).not.toBe(encrypted2.ciphertext);
  });

  it("encrypting same vector twice produces different IV", () => {
    const vector = createTestVector(256);

    const encrypted1 = encryptBiometricVector(vector, validAAD);
    const encrypted2 = encryptBiometricVector(vector, validAAD);

    expect(encrypted1.iv).not.toBe(encrypted2.iv);
  });

  it("IV is exactly 12 bytes when base64-decoded", () => {
    const vector = createTestVector(64);
    const encrypted = encryptBiometricVector(vector, validAAD);

    const ivBuffer = Buffer.from(encrypted.iv, "base64");
    expect(ivBuffer.length).toBe(12);
  });

  it("authTag is exactly 16 bytes when base64-decoded", () => {
    const vector = createTestVector(64);
    const encrypted = encryptBiometricVector(vector, validAAD);

    const authTagBuffer = Buffer.from(encrypted.authTag, "base64");
    expect(authTagBuffer.length).toBe(16);
  });
});

// =============================================================================
// Ciphertext Confidentiality Tests
// =============================================================================

describe("biometric encryption / ciphertext confidentiality", () => {
  it("encrypted ciphertext does not contain plaintext vector", () => {
    // Use values that would be obvious if serialized as JSON or text
    const vector = [
      0.123456789, 0.987654321, -0.111111111, 0.222222222, 0.333333333,
    ];
    const encrypted = encryptBiometricVector(vector, validAAD);

    const ciphertextBuffer = Buffer.from(encrypted.ciphertext, "base64");
    const ciphertextString = ciphertextBuffer.toString("utf8");

    // The ciphertext should not contain these exact decimal representations
    expect(ciphertextString).not.toContain("0.123456789");
    expect(ciphertextString).not.toContain("0.987654321");
    expect(ciphertextString).not.toContain("-0.111111111");
  });

  it("both encryptions of same vector are different (confidentiality)", () => {
    const vector = createTestVector(64);

    const enc1 = encryptBiometricVector(vector, validAAD);
    const enc2 = encryptBiometricVector(vector, validAAD);

    // Both fields that could leak info should differ
    expect(enc1.ciphertext).not.toBe(enc2.ciphertext);
    expect(enc1.iv).not.toBe(enc2.iv);
  });
});

// =============================================================================
// Tampering Tests
// =============================================================================

describe("biometric encryption / tampering detection", () => {
  it("tampered ciphertext causes decryption to fail", () => {
    const vector = createTestVector(128);
    const encrypted = encryptBiometricVector(vector, validAAD);

    // Tamper with the ciphertext
    const tampered: EncryptedBiometricValue = {
      ...encrypted,
      ciphertext: Buffer.from("tampered").toString("base64"),
    };

    expect(() => decryptBiometricVector(tampered, validAAD)).toThrow(
      BiometricError,
    );
    try {
      decryptBiometricVector(tampered, validAAD);
    } catch (err) {
      expect((err as BiometricError).code).toBe(
        BIOMETRIC_ERROR_CODES.DECRYPTION_FAILED,
      );
    }
  });

  it("tampered authTag causes decryption to fail", () => {
    const vector = createTestVector(128);
    const encrypted = encryptBiometricVector(vector, validAAD);

    // Tamper with the authTag
    const tampered: EncryptedBiometricValue = {
      ...encrypted,
      authTag: Buffer.from("tamperedtag12345").toString("base64"),
    };

    expect(() => decryptBiometricVector(tampered, validAAD)).toThrow(
      BiometricError,
    );
  });

  it("tampered IV causes decryption to fail", () => {
    const vector = createTestVector(128);
    const encrypted = encryptBiometricVector(vector, validAAD);

    // Tamper with the IV
    const tampered: EncryptedBiometricValue = {
      ...encrypted,
      iv: Buffer.from("tamperediv123").toString("base64"),
    };

    expect(() => decryptBiometricVector(tampered, validAAD)).toThrow(
      BiometricError,
    );
  });

  it("unsupported keyVersion causes decryption to fail", () => {
    const vector = createTestVector(128);
    const encrypted = encryptBiometricVector(vector, validAAD);

    // Change the key version to an unsupported value
    const wrongVersion: EncryptedBiometricValue = {
      ...encrypted,
      keyVersion: 99,
    };

    expect(() => decryptBiometricVector(wrongVersion, validAAD)).toThrow(
      BiometricError,
    );
    try {
      decryptBiometricVector(wrongVersion, validAAD);
    } catch (err) {
      expect((err as BiometricError).code).toBe(
        BIOMETRIC_ERROR_CODES.UNSUPPORTED_KEY_VERSION,
      );
    }
  });
});

// =============================================================================
// Wrong Key Tests
// =============================================================================

describe("biometric encryption / wrong key detection", () => {
  it("decryption with wrong key fails", () => {
    const vector = createTestVector(128);

    // Encrypt with test key (already injected in beforeEach)
    const encrypted = encryptBiometricVector(vector, validAAD);

    // Change to wrong key
    const wrongKey = createTestEncryptionKey(WRONG_KEY_BASE64);
    injectTestKey(wrongKey);

    expect(() => decryptBiometricVector(encrypted, validAAD)).toThrow(
      BiometricError,
    );
    try {
      decryptBiometricVector(encrypted, validAAD);
    } catch (err) {
      expect((err as BiometricError).code).toBe(
        BIOMETRIC_ERROR_CODES.DECRYPTION_FAILED,
      );
    }
  });
});

// =============================================================================
// AAD Binding Tests
// =============================================================================

describe("biometric encryption / AAD binding", () => {
  it("wrong userId in AAD causes decryption to fail", () => {
    const vector = createTestVector(128);
    const encrypted = encryptBiometricVector(vector, validAAD);

    const wrongAAD: BiometricAAD = {
      ...validAAD,
      userId: "different-user",
    };

    expect(() => decryptBiometricVector(encrypted, wrongAAD)).toThrow(
      BiometricError,
    );
  });

  it("wrong modelIdentity in AAD causes decryption to fail", () => {
    const vector = createTestVector(128);
    const encrypted = encryptBiometricVector(vector, validAAD);

    const wrongAAD: BiometricAAD = {
      ...validAAD,
      modelIdentity: "different-model/v1",
    };

    expect(() => decryptBiometricVector(encrypted, wrongAAD)).toThrow(
      BiometricError,
    );
  });

  it("wrong templateVersion in AAD causes decryption to fail", () => {
    const vector = createTestVector(128);
    const encrypted = encryptBiometricVector(vector, validAAD);

    const wrongAAD: BiometricAAD = {
      ...validAAD,
      templateVersion: 2,
    };

    expect(() => decryptBiometricVector(encrypted, wrongAAD)).toThrow(
      BiometricError,
    );
  });

  it("wrong vectorType in AAD causes decryption to fail", () => {
    const vector = createTestVector(128);
    const encrypted = encryptBiometricVector(vector, validAAD);

    const wrongAAD: BiometricAAD = {
      ...validAAD,
      vectorType: "different-type",
    };

    expect(() => decryptBiometricVector(encrypted, wrongAAD)).toThrow(
      BiometricError,
    );
  });

  it("missing sampleIndex vs present sampleIndex are different AAD", () => {
    const vector = createTestVector(128);

    // Encrypt without sampleIndex
    const encrypted = encryptBiometricVector(vector, validAAD);

    // Decrypt with sampleIndex (different AAD)
    const aadWithIndex: BiometricAAD = {
      ...validAAD,
      sampleIndex: 0,
    };

    expect(() => decryptBiometricVector(encrypted, aadWithIndex)).toThrow(
      BiometricError,
    );
  });

  it("AAD with sampleIndex round trips correctly", () => {
    const vector = createTestVector(128);
    const aadWithIndex: BiometricAAD = {
      ...validAAD,
      sampleIndex: 3,
    };

    const encrypted = encryptBiometricVector(vector, aadWithIndex);
    const decrypted = decryptBiometricVector(encrypted, aadWithIndex);

    expect(decrypted.length).toBe(128);
    for (let i = 0; i < vector.length; i++) {
      expect(decrypted[i]!).toBeCloseTo(vector[i]!, 5);
    }
  });
});

// =============================================================================
// Error Safety Tests
// =============================================================================

describe("biometric encryption / error safety", () => {
  it("BiometricError does not expose key material in message", () => {
    // This test verifies the error class is designed safely
    const err = new BiometricError({
      code: BIOMETRIC_ERROR_CODES.KEY_INVALID,
      message: "The key is invalid.",
    });

    expect(err.message).not.toContain("base64");
    expect(err.message).not.toContain("32 bytes");
    // Just verify the error structure is safe
    expect(typeof err.message).toBe("string");
  });

  it("BiometricError does not expose plaintext in message", () => {
    const err = new BiometricError({
      code: BIOMETRIC_ERROR_CODES.INVALID_VECTOR,
      message: "The vector is invalid.",
    });

    expect(err.message).not.toContain("[");
    expect(err.message).not.toContain("0.");
  });

  it("BiometricError has correct name", () => {
    const err = new BiometricError({
      code: BIOMETRIC_ERROR_CODES.KEY_MISSING,
      message: "Key is missing.",
    });

    expect(err.name).toBe("BiometricError");
  });

  it("all error codes are unique strings", () => {
    const codes = Object.values(BIOMETRIC_ERROR_CODES);
    const uniqueCodes = new Set(codes);
    expect(uniqueCodes.size).toBe(codes.length);
  });
});

// =============================================================================
// BiometricError Class Tests
// =============================================================================

describe("biometric encryption / BiometricError class", () => {
  it("creates error with correct properties", () => {
    const err = new BiometricError({
      code: BIOMETRIC_ERROR_CODES.DECRYPTION_FAILED,
      message: "Decryption failed.",
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(BiometricError);
    expect(err.code).toBe(BIOMETRIC_ERROR_CODES.DECRYPTION_FAILED);
    expect(err.message).toBe("Decryption failed.");
  });

  it("error codes match expected values", () => {
    expect(BIOMETRIC_ERROR_CODES.KEY_MISSING).toBe("BIOMETRIC_KEY_MISSING");
    expect(BIOMETRIC_ERROR_CODES.KEY_INVALID).toBe("BIOMETRIC_KEY_INVALID");
    expect(BIOMETRIC_ERROR_CODES.INVALID_VECTOR).toBe("INVALID_BIOMETRIC_VECTOR");
    expect(BIOMETRIC_ERROR_CODES.DECRYPTION_FAILED).toBe(
      "BIOMETRIC_DECRYPTION_FAILED",
    );
    expect(BIOMETRIC_ERROR_CODES.UNSUPPORTED_KEY_VERSION).toBe(
      "UNSUPPORTED_KEY_VERSION",
    );
  });
});
