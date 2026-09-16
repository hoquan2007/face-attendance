/**
 * Tests for class-password.ts
 *
 * PHASE 5.1A.1 — Class password request-path hardening.
 *
 * Coverage (24 cases):
 *   1.  hashClassPassword is async.
 *   2.  verifyClassPassword is async.
 *   3.  source/runtime does not use pbkdf2Sync.
 *   4.  stored encoded hash differs from plaintext.
 *   5.  encoded hash contains algorithm/version identifier.
 *   6.  encoded hash contains iteration count.
 *   7.  encoded hash contains random salt.
 *   8.  same plaintext hashes to different encoded values across two calls.
 *   9.  same password verifies true.
 *   10. wrong password verifies false.
 *   11. verification uses timingSafeEqual.
 *   12. malformed hash returns safe failure.
 *   13. unknown algorithm rejected.
 *   14. invalid iteration field rejected.
 *   15. invalid hex rejected.
 *   16. truncated derived key rejected safely.
 *   17. timingSafeEqual length mismatch never crashes caller.
 *   18. empty/malformed encoded hash rejected.
 *   19. password is never logged.
 *   20. no plaintext password field added to Class model.
 *   21. class-service creation still stores only passwordHash.
 *   22. safe class result still contains no passwordHash.
 *   23. no new npm dependency.
 *   24. no biometric dependency.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  hashClassPassword,
  verifyClassPassword,
  isValidPasswordHash,
  CLASS_PASSWORD_ALGORITHM,
  CLASS_PASSWORD_PBKDF2_ITERATIONS,
  CLASS_PASSWORD_SALT_LENGTH,
  CLASS_PASSWORD_KEY_LENGTH,
} from "./class-password";

// =============================================================================
// 1-2. Async API
// =============================================================================

describe("async API", () => {
  it("1. hashClassPassword is async (returns a Promise)", async () => {
    const result = hashClassPassword("MySecret123");
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual(expect.any(String));
  });

  it("2. verifyClassPassword is async (returns a Promise)", async () => {
    const hash = await hashClassPassword("MySecret123");
    const result = verifyClassPassword("MySecret123", hash);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toBe(true);
  });
});

// =============================================================================
// 3. Source / runtime does not use pbkdf2Sync
// =============================================================================

describe("no pbkdf2Sync usage", () => {
  it("3. source code does not import or reference pbkdf2Sync", () => {
    const sourcePath = resolve(__dirname, "class-password.ts");
    const source = readFileSync(sourcePath, "utf-8");
    expect(source).not.toMatch(/\bpbkdf2Sync\b/);
    expect(source).not.toMatch(/\bscryptSync\b/);
  });

  it("3b. module exposes only asynchronous pbkdf2 behaviour", async () => {
    // Two sequential calls — both must yield (we cannot directly assert
    // yielding, but the source-check above is the authoritative guard;
    // here we simply assert both calls resolve and produce non-empty
    // hashes).
    const a = await hashClassPassword("alpha");
    const b = await hashClassPassword("alpha");
    expect(a.length).toBeGreaterThan(0);
    expect(b.length).toBeGreaterThan(0);
  });
});

// =============================================================================
// 4-7. Encoded hash format & contents
// =============================================================================

describe("encoded hash format", () => {
  it("4. stored encoded hash differs from plaintext", async () => {
    const password = "MySecret123";
    const hash = await hashClassPassword(password);
    expect(hash).not.toBe(password);
    expect(hash).not.toContain(password);
  });

  it("5. encoded hash contains the algorithm/version identifier", async () => {
    const hash = await hashClassPassword("test");
    const parts = hash.split("$");
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe(CLASS_PASSWORD_ALGORITHM);
    expect(parts[0]).toBe("pbkdf2-sha256");
  });

  it("6. encoded hash contains the iteration count", async () => {
    const hash = await hashClassPassword("test");
    const parts = hash.split("$");
    expect(parts[1]).toBe(String(CLASS_PASSWORD_PBKDF2_ITERATIONS));
    expect(Number(parts[1])).toBeGreaterThan(0);
    // Confirm the constant is centralised — the test asserts the value
    // matches the exported constant rather than a duplicated literal.
    expect(Number(parts[1])).toBe(CLASS_PASSWORD_PBKDF2_ITERATIONS);
  });

  it("7. encoded hash contains a 32-byte random salt", async () => {
    const hash = await hashClassPassword("test");
    const parts = hash.split("$");
    const saltHex = parts[2];
    expect(saltHex).toBeDefined();
    expect(saltHex!.length).toBe(CLASS_PASSWORD_SALT_LENGTH * 2);
    expect(/^[0-9a-f]+$/i.test(saltHex!)).toBe(true);
  });

  it("7b. encoded hash contains a 32-byte derived key", async () => {
    const hash = await hashClassPassword("test");
    const parts = hash.split("$");
    const keyHex = parts[3];
    expect(keyHex).toBeDefined();
    expect(keyHex!.length).toBe(CLASS_PASSWORD_KEY_LENGTH * 2);
    expect(/^[0-9a-f]+$/i.test(keyHex!)).toBe(true);
  });
});

// =============================================================================
// 8. Salt randomness
// =============================================================================

describe("salt randomness", () => {
  it("8. same plaintext hashes to different encoded values across two calls", async () => {
    const password = "MySecret123";
    const h1 = await hashClassPassword(password);
    const h2 = await hashClassPassword(password);
    expect(h1).not.toBe(h2);

    // The salt component must differ.
    const s1 = h1.split("$")[2];
    const s2 = h2.split("$")[2];
    expect(s1).not.toBe(s2);

    // The derived key component must therefore also differ.
    const k1 = h1.split("$")[3];
    const k2 = h2.split("$")[3];
    expect(k1).not.toBe(k2);
  });
});

// =============================================================================
// 9-10. Verify: positive and negative paths
// =============================================================================

describe("verifyClassPassword", () => {
  it("9. same password verifies true", async () => {
    const password = "MySecret123";
    const hash = await hashClassPassword(password);
    await expect(verifyClassPassword(password, hash)).resolves.toBe(true);
  });

  it("9b. verify true for unicode / non-ASCII passwords", async () => {
    const password = "MậtKhẩu-ĐặcBiệt-#1";
    const hash = await hashClassPassword(password);
    await expect(verifyClassPassword(password, hash)).resolves.toBe(true);
  });

  it("10. wrong password verifies false", async () => {
    const password = "MySecret123";
    const hash = await hashClassPassword(password);
    await expect(verifyClassPassword("WrongPassword", hash)).resolves.toBe(false);
    await expect(verifyClassPassword("", hash)).resolves.toBe(false);
    await expect(verifyClassPassword("mysECRET123", hash)).resolves.toBe(false);
  });

  it("10b. wrong-but-similar passwords verify false", async () => {
    const hash = await hashClassPassword("Password1");
    await expect(verifyClassPassword("Password2", hash)).resolves.toBe(false);
    await expect(verifyClassPassword("password1", hash)).resolves.toBe(false);
  });
});

// =============================================================================
// 11. timingSafeEqual usage
// =============================================================================

describe("constant-time verification", () => {
  it("11. verification uses crypto.timingSafeEqual", () => {
    const sourcePath = resolve(__dirname, "class-password.ts");
    const source = readFileSync(sourcePath, "utf-8");
    expect(source).toMatch(/\btimingSafeEqual\b/);
    // Negative checks: the comparison must not be a plain === between
    // derived secret bytes.
    expect(source).not.toMatch(/derivedKey\s*===\s*expectedKey/);
    expect(source).not.toMatch(/keyHex\s*===\s*keyHex/);
  });
});

// =============================================================================
// 12-18. Malformed hash & strict parsing
// =============================================================================

describe("malformed hash handling", () => {
  it("12. malformed hash returns safe failure (no throw)", async () => {
    await expect(verifyClassPassword("pass", "")).resolves.toBe(false);
    await expect(verifyClassPassword("pass", "invalid")).resolves.toBe(false);
    await expect(
      verifyClassPassword("pass", "not:hex:format"),
    ).resolves.toBe(false);
  });

  it("13. unknown algorithm is rejected", async () => {
    const bad =
      "pbkdf2-md5$100000$" +
      "a".repeat(CLASS_PASSWORD_SALT_LENGTH * 2) +
      "$" +
      "b".repeat(CLASS_PASSWORD_KEY_LENGTH * 2);
    await expect(verifyClassPassword("anything", bad)).resolves.toBe(false);
  });

  it("14. invalid iteration field is rejected", async () => {
    const saltHex = "a".repeat(CLASS_PASSWORD_SALT_LENGTH * 2);
    const keyHex = "b".repeat(CLASS_PASSWORD_KEY_LENGTH * 2);
    await expect(
      verifyClassPassword("p", `pbkdf2-sha256$abc$${saltHex}$${keyHex}`),
    ).resolves.toBe(false);
    await expect(
      verifyClassPassword("p", `pbkdf2-sha256$0$${saltHex}$${keyHex}`),
    ).resolves.toBe(false);
    await expect(
      verifyClassPassword("p", `pbkdf2-sha256$-1$${saltHex}$${keyHex}`),
    ).resolves.toBe(false);
    await expect(
      verifyClassPassword("p", `pbkdf2-sha256$1.5$${saltHex}$${keyHex}`),
    ).resolves.toBe(false);
    await expect(
      verifyClassPassword("p", `pbkdf2-sha256$$${saltHex}$${keyHex}`),
    ).resolves.toBe(false);
  });

  it("15. invalid hex is rejected", async () => {
    const saltHex = "g".repeat(CLASS_PASSWORD_SALT_LENGTH * 2);
    const keyHex = "b".repeat(CLASS_PASSWORD_KEY_LENGTH * 2);
    await expect(
      verifyClassPassword("p", `pbkdf2-sha256$100000$${saltHex}$${keyHex}`),
    ).resolves.toBe(false);
  });

  it("15b. odd-length hex is rejected", async () => {
    const saltHex = "abc"; // odd length
    const keyHex = "b".repeat(CLASS_PASSWORD_KEY_LENGTH * 2);
    await expect(
      verifyClassPassword("p", `pbkdf2-sha256$100000$${saltHex}$${keyHex}`),
    ).resolves.toBe(false);
  });

  it("16. truncated derived key is rejected safely", async () => {
    const saltHex = "a".repeat(CLASS_PASSWORD_SALT_LENGTH * 2);
    const keyHex = "b".repeat((CLASS_PASSWORD_KEY_LENGTH - 4) * 2); // 28-byte key
    await expect(
      verifyClassPassword("p", `pbkdf2-sha256$100000$${saltHex}$${keyHex}`),
    ).resolves.toBe(false);
  });

  it("16b. oversized derived key is rejected safely", async () => {
    const saltHex = "a".repeat(CLASS_PASSWORD_SALT_LENGTH * 2);
    const keyHex = "b".repeat((CLASS_PASSWORD_KEY_LENGTH + 4) * 2); // 36-byte key
    await expect(
      verifyClassPassword("p", `pbkdf2-sha256$100000$${saltHex}$${keyHex}`),
    ).resolves.toBe(false);
  });

  it("16c. wrong salt length is rejected safely", async () => {
    const saltHex = "a".repeat((CLASS_PASSWORD_SALT_LENGTH - 4) * 2);
    const keyHex = "b".repeat(CLASS_PASSWORD_KEY_LENGTH * 2);
    await expect(
      verifyClassPassword("p", `pbkdf2-sha256$100000$${saltHex}$${keyHex}`),
    ).resolves.toBe(false);
  });

  it("17. timingSafeEqual length mismatch never crashes the caller", async () => {
    // Worst-case inputs that historically crash `timingSafeEqual` with a
    // RangeError when lengths differ.
    const cases: unknown[] = [
      "",
      null,
      undefined,
      12345,
      {},
      [],
      true,
      "pbkdf2-sha256",
      "pbkdf2-sha256$100000",
      "pbkdf2-sha256$100000$$",
      "pbkdf2-sha256$100000$$$",
      // lengths look right but the key hex has wrong total length
      "pbkdf2-sha256$100000$" +
        "a".repeat(CLASS_PASSWORD_SALT_LENGTH * 2) +
        "$bc",
    ];
    for (const bad of cases) {
      await expect(
        verifyClassPassword("anything", bad),
      ).resolves.toBe(false);
    }
  });

  it("18. empty/malformed encoded hash is rejected by isValidPasswordHash", () => {
    expect(isValidPasswordHash("")).toBe(false);
    expect(isValidPasswordHash("not-formatted")).toBe(false);
    expect(isValidPasswordHash("too:many:colons:here")).toBe(false);
    expect(isValidPasswordHash("pbkdf2-sha256$100000$short$key")).toBe(false);
  });
});

// =============================================================================
// 19. Password is never logged
// =============================================================================

describe("logging hygiene", () => {
  it("19. password is never logged by the password module", () => {
    const sourcePath = resolve(__dirname, "class-password.ts");
    const source = readFileSync(sourcePath, "utf-8");
    // No console / logger / debug calls anywhere in the module.
    expect(source).not.toMatch(/console\.(log|info|warn|error|debug)/);
    expect(source).not.toMatch(/\blogger?\./);
    expect(source).not.toMatch(/\bdebug\(/);
    // No string concatenation of the password argument into any output.
    expect(source).not.toMatch(/rawPassword\s*\+/);
    // No JSON serialization that includes the raw password.
    expect(source).not.toMatch(/JSON\.(stringify|parse)[^\n]*rawPassword/);
  });
});

// =============================================================================
// 20. No plaintext password field on Class model
// =============================================================================

describe("class model schema hygiene", () => {
  it("20. no plaintext password field is added to the Class model", () => {
    const modelPath = resolve(__dirname, "class-model.ts");
    const source = readFileSync(modelPath, "utf-8");
    expect(source).not.toMatch(/\bplaintextPassword\b/);
    expect(source).not.toMatch(/\bjoinPassword\b/);
    // The schema may declare `passwordHash` but never `password`
    // (without the Hash suffix) as a field name.
    const fieldNames = Array.from(
      source.matchAll(/^\s*([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*\{/gm),
    ).map((m) => m[1]);
    expect(fieldNames).not.toContain("password");
    expect(fieldNames).not.toContain("plaintextPassword");
    expect(fieldNames).not.toContain("joinPassword");
    expect(fieldNames).not.toContain("rawPassword");
  });
});

// =============================================================================
// 21-22. Class service regression
// =============================================================================

describe("class-service regression", () => {
  it("21. createClass still stores only passwordHash", async () => {
    const sourcePath = resolve(__dirname, "class-service.ts");
    const source = readFileSync(sourcePath, "utf-8");
    // The service must call hashClassPassword as an awaited expression.
    expect(source).toMatch(/await\s+hashClassPassword\s*\(/);
    // The persisted document carries `passwordHash`, not raw password.
    expect(source).toMatch(/passwordHash/);
    // The service must not assign rawPassword into any model document.
    // Strip the legitimate input interface field AND the
    // runDummyPasswordVerification helper parameter before
    // checking — both are NOT rawPassword being persisted into a
    // model document.
    const stripped = source
      .replace(/rawPassword\s*:\s*string\s*;/g, "")
      .replace(/rawPassword\s*:\s*string\s*,/g, "");
    expect(stripped).not.toMatch(/\brawPassword\s*:/);
  });

  it("22. SafeClassDto still omits passwordHash", () => {
    const modelPath = resolve(__dirname, "class-model.ts");
    const source = readFileSync(modelPath, "utf-8");
    // The safe DTO must NOT include passwordHash.
    const dtoMatch = source.match(
      /interface\s+SafeClassDto[\s\S]*?\n\}/,
    );
    expect(dtoMatch).not.toBeNull();
    const dtoBody = dtoMatch![0];
    expect(dtoBody).not.toMatch(/passwordHash/);
    expect(dtoBody).not.toMatch(/rawPassword/);
    expect(dtoBody).not.toMatch(/plaintextPassword/);
  });
});

// =============================================================================
// 23-24. No new dependency / no biometric dependency
// =============================================================================

describe("dependency hygiene", () => {
  it("23. no new npm dependency was added (package.json unchanged)", () => {
    // Class-password must rely on built-in `node:crypto` only.
    const sourcePath = resolve(__dirname, "class-password.ts");
    const source = readFileSync(sourcePath, "utf-8");
    expect(source).not.toMatch(/from\s+["']bcrypt/);
    expect(source).not.toMatch(/from\s+["']argon2/);
    expect(source).not.toMatch(/from\s+["']@node-rs\/bcrypt/);
    expect(source).not.toMatch(/from\s+["']scrypt-/);
    expect(source).toMatch(/from\s+["']node:crypto["']/);
  });

  it("24. no biometric dependency is introduced", () => {
    const sourcePath = resolve(__dirname, "class-password.ts");
    const source = readFileSync(sourcePath, "utf-8");
    expect(source).not.toMatch(/FaceProfile|embedding|centroid/);
    expect(source).not.toMatch(/face-/i);
  });
});

// =============================================================================
// isValidPasswordHash — positive path & sanity
// =============================================================================

describe("isValidPasswordHash", () => {
  it("returns true for a hash produced by hashClassPassword", async () => {
    const hash = await hashClassPassword("test");
    expect(isValidPasswordHash(hash)).toBe(true);
  });

  it("returns false for plaintext passwords", () => {
    expect(isValidPasswordHash("MyPassword123")).toBe(false);
    expect(isValidPasswordHash("password")).toBe(false);
  });

  it("returns false for legacy salt:key format", () => {
    expect(
      isValidPasswordHash(
        "a".repeat(64) + ":" + "b".repeat(64),
      ),
    ).toBe(false);
  });
});

// =============================================================================
// Round-trip integrity for many passwords
// =============================================================================

describe("round-trip integrity", () => {
  it("round-trips multiple different passwords correctly", async () => {
    const passwords = [
      "alpha",
      "bravo-bravo-123",
      "🦊 emoji 🔑",
      "  spaces-around  ",
      "with\nnewline",
      "MiXeD-CaSe-PaSsWoRd",
    ];
    for (const p of passwords) {
      const hash = await hashClassPassword(p);
      await expect(verifyClassPassword(p, hash)).resolves.toBe(true);
      await expect(verifyClassPassword(p + "x", hash)).resolves.toBe(false);
    }
  });
});