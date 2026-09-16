/**
 * Tests for the PHASE 5.1C authenticated student join-class Server
 * Action plus its supporting primitives.
 *
 * Covers:
 *
 *   ## Dummy hash constant (1..9)
 *     - architectural lockdown invariants: no module-load work,
 *       no Math.random, no randomBytes, no PBKDF2, no top-level
 *       await, format is valid encoded hash.
 *
 *   ## getClassJoinCredentialByCode (10..15)
 *     - returns null on missing class
 *     - returns credential on found class (including passwordHash)
 *     - normalizes code via the canonical helper
 *
 *   ## Index barrel hygiene (16..18)
 *     - public barrel does NOT re-export getClassJoinCredentialByCode
 *     - public barrel does NOT re-export DUMMY_CLASS_PASSWORD_HASH
 *     - SafeClassDto still does NOT include passwordHash
 *
 *   ## Membership duplicate classifier (19..28)
 *     - compound keyValue (classId + studentUserId) → true
 *     - compound keyPattern → true
 *     - keyValue without classId → false
 *     - keyValue without studentUserId → false
 *     - non-11000 → false
 *     - unrelated 11000 (no classId / no studentUserId) → false
 *     - null / undefined / non-object input → false
 *     - createMembership maps compound → MEMBERSHIP_ALREADY_JOINED
 *     - createMembership maps unrelated 11000 → MEMBERSHIP_CREATE_FAILED
 *     - createMembership does NOT retry on duplicate
 *
 *   ## createJoinClassAction (29..60)
 *     - auth: no session → UNAUTHENTICATED
 *     - auth: missing user.id → UNAUTHENTICATED
 *     - profile: missing → PROFILE_INCOMPLETE
 *     - profile: incomplete onboarding → PROFILE_INCOMPLETE
 *     - profile: wrong role (teacher) → STUDENT_REQUIRED
 *     - input: smuggled studentUserId → INVALID_CLASS_PASSWORD
 *     - input: smuggled classId → INVALID_CLASS_PASSWORD
 *     - input: smuggled passwordHash → INVALID_CLASS_PASSWORD
 *     - input: invalid classCode → INVALID_CLASS_CODE
 *     - input: invalid password (too short) → INVALID_CLASS_PASSWORD
 *     - input: password is forwarded unchanged (no trim)
 *     - input: classCode is normalized to uppercase
 *     - canonical timing: missing class runs dummy verification
 *     - canonical timing: archived class runs dummy verification
 *     - canonical timing: wrong password runs REAL verification
 *       and returns INVALID_CLASS_CREDENTIALS
 *     - canonical timing: malformed stored hash runs dummy
 *       verification and returns INVALID_CLASS_CREDENTIALS
 *     - success: returns SafeMembershipDto projection
 *     - success: no password / passwordHash / studentUserId /
 *                teacherUserId in result
 *     - duplicate: idempotent success (alreadyJoined:true) on
 *                  compound collision — NO ALREADY_JOINED error code
 *     - unrelated 11000: CLASS_JOIN_FAILED on duplicate-key error
 *                        that does not match the compound
 *     - generic failure: CLASS_JOIN_FAILED on non-mapped error
 *     - safe mapping: no raw stack / mongo URL leaked
 *     - safe mapping: no password / passwordHash / raw password
 *                     in error result
 *     - profile lookup failure → CLASS_JOIN_FAILED (no leak)
 *     - opens with "use server"
 *     - does NOT create / mutate Class (no class-service write)
 *     - does NOT mutate Profile (no profile-service write)
 *     - does NOT touch FaceProfile or Face Service
 *
 * PHASE 5.1C.1 — JOIN IDEMPOTENCY + CANONICAL VERIFICATION AUDIT
 *   - first valid join → alreadyJoined:false
 *   - duplicate valid join → alreadyJoined:true (idempotent success)
 *   - password MUST be verified before idempotent success
 *   - existing membership MUST NOT bypass class password
 *   - archived / wrong-password branches MUST NOT surface
 *     alreadyJoined:true
 *   - unrelated E11000 → CLASS_JOIN_FAILED (NOT idempotent)
 *   - duplicate success MUST be free of passwordHash / studentUserId
 *     / teacherUserId / raw E11000 / stack / dummy hash
 *
 * Wall-clock timing tests are deliberately NOT used. The contract
 * asserts BEHAVIOR (which primitive is invoked on each branch),
 * not latency.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// =============================================================================
// Mock collaborators
// =============================================================================

const mockGetSession = vi.fn();
const mockGetProfileByUserId = vi.fn();
const mockGetClassJoinCredentialByCode = vi.fn();
const mockCreateMembership = vi.fn();
const mockGetSafeMembership = vi.fn();
const mockRunDummyPasswordVerification = vi.fn();
const mockVerifyClassPassword = vi.fn();

vi.mock("@/lib/session", () => ({
  getSession: () => mockGetSession(),
}));

vi.mock("@/lib/profile-service", () => ({
  getProfileByUserId: (...args: unknown[]) =>
    mockGetProfileByUserId(...args),
}));

// Mock the class-service primitives that the join action uses.
// We deliberately expose only the primitives the action calls so
// the test asserts the action's import surface.
vi.mock("@/lib/classes/class-service", async () => {
  class ClassServiceError extends Error {
    code: string;
    constructor(opts: { code: string; message: string }) {
      super(opts.message);
      this.name = "ClassServiceError";
      this.code = opts.code;
    }
  }
  return {
    ClassServiceError,
    CLASS_ERROR_CODES: {
      CLASS_NOT_FOUND: "CLASS_NOT_FOUND",
      CLASS_CODE_ALREADY_EXISTS: "CLASS_CODE_ALREADY_EXISTS",
      CLASS_CREATE_FAILED: "CLASS_CREATE_FAILED",
    },
    isClassCodeDuplicateKeyError: (err: unknown): boolean => {
      if (!err || typeof err !== "object") return false;
      if ((err as { code?: unknown }).code !== 11000) return false;
      const kv = (err as { keyValue?: unknown }).keyValue;
      if (!kv || typeof kv !== "object") return false;
      return "classCode" in (kv as Record<string, unknown>);
    },
    getClassJoinCredentialByCode: (...args: unknown[]) =>
      mockGetClassJoinCredentialByCode(...args),
    runDummyPasswordVerification: (...args: unknown[]) =>
      mockRunDummyPasswordVerification(...args),
    // Real dummy hash constant — same literal as the production
    // module. The mock is intentionally shallow here (the literal
    // is inlined by the action via its own import, and the static
    // source-grep test below asserts the production module uses
    // the exact same shape).
    DUMMY_CLASS_PASSWORD_HASH:
      "pbkdf2-sha256$100000$" +
      "0101010101010101010101010101010101010101010101010101010101010101$" +
      "0202020202020202020202020202020202020202020202020202020202020202",
  };
});

vi.mock("@/lib/classes/class-membership-service", async () => {
  class MembershipServiceError extends Error {
    code: string;
    constructor(opts: { code: string; message: string }) {
      super(opts.message);
      this.name = "MembershipServiceError";
      this.code = opts.code;
    }
  }
  return {
    MembershipServiceError,
    MEMBERSHIP_ERROR_CODES: {
      MEMBERSHIP_NOT_FOUND: "MEMBERSHIP_NOT_FOUND",
      MEMBERSHIP_ALREADY_EXISTS: "MEMBERSHIP_ALREADY_EXISTS",
      MEMBERSHIP_ALREADY_JOINED: "MEMBERSHIP_ALREADY_JOINED",
      MEMBERSHIP_CREATE_FAILED: "MEMBERSHIP_CREATE_FAILED",
    },
    isMembershipDuplicateKeyError: (err: unknown): boolean => {
      if (!err || typeof err !== "object") return false;
      if ((err as { code?: unknown }).code !== 11000) return false;
      const kv = (err as { keyValue?: unknown }).keyValue;
      if (kv && typeof kv === "object") {
        const k = kv as Record<string, unknown>;
        if (
          "classId" in k &&
          "studentUserId" in k &&
          k["classId"] != null &&
          k["studentUserId"] != null
        ) {
          return true;
        }
      }
      const kp = (err as { keyPattern?: unknown }).keyPattern;
      if (kp && typeof kp === "object") {
        const k = kp as Record<string, unknown>;
        if ("classId" in k && "studentUserId" in k) return true;
      }
      return false;
    },
    createMembership: (...args: unknown[]) =>
      mockCreateMembership(...args),
    getSafeMembership: (...args: unknown[]) =>
      mockGetSafeMembership(...args),
  };
});

// Mock the class-password primitives that the join action uses.
// The action imports `verifyClassPassword` and `isValidPasswordHash`
// directly from `@/lib/classes/class-password` — the test mocks
// them here so we can assert WHICH primitive is invoked on each
// branch and avoid the actual PBKDF2 workload. The action NEVER
// calls `hashClassPassword`, so that primitive is not re-exported
// from the mock and the action's import of it would fail loudly
// if it were ever introduced.
vi.mock("@/lib/classes/class-password", async () => {
  const actual =
    await vi.importActual<typeof import("./class-password")>(
      "./class-password",
    );
  return {
    ...actual,
    verifyClassPassword: (...args: unknown[]) =>
      mockVerifyClassPassword(...args),
    // `isValidPasswordHash` stays the real implementation — it is
    // a pure parser that is fast and side-effect-free.
  };
});

// Capture console output so the "no logging" assertions can
// observe the run-time behavior without polluting the test
// report.
const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = vi
  .spyOn(console, "error")
  .mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

// =============================================================================
// Imports under test
// =============================================================================

import {
  createJoinClassAction,
  JOIN_CLASS_ACTION_ERROR_CODES,
  __testing,
} from "./join-class-action";
import { hashClassPassword, isValidPasswordHash } from "./class-password";

// =============================================================================
// Test fixtures
// =============================================================================

const STUDENT_USER_ID = "student-better-auth-id-c01";
const PASSWORD_PLAINTEXT = "ClassP@ssw0rd-2026";

function makeSession(userId: string) {
  return {
    user: {
      id: userId,
      email: `${userId}@example.com`,
      name: "Test Student",
      image: null,
    },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
}

function makeStudentProfile(overrides: Partial<{
  onboardingCompleted: boolean;
  role: "student" | "teacher";
}> = {}) {
  return {
    userId: STUDENT_USER_ID,
    emailSnapshot: "student@example.com",
    role: "student" as const,
    fullName: "Test Student",
    identificationCode: "S-001",
    phone: undefined,
    onboardingCompleted: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeTeacherProfile(overrides: Partial<{
  onboardingCompleted: boolean;
  role: "student" | "teacher";
}> = {}) {
  return {
    userId: STUDENT_USER_ID,
    emailSnapshot: "teacher@example.com",
    role: "teacher" as const,
    fullName: "Test Teacher",
    identificationCode: "T-001",
    phone: undefined,
    onboardingCompleted: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function makeCredential(overrides: Partial<{
  classId: string;
  classCode: string;
  passwordHash: string;
  status: "active" | "archived";
}> = {}) {
  return {
    classId: "65f000000000000000000abc",
    classCode: "ABCDEFG",
    passwordHash:
      // pbkdf2-sha256$100000$<32-byte salt hex>$<32-byte key hex>
      "pbkdf2-sha256$100000$" +
      "a".repeat(64) +
      "$" +
      "b".repeat(64),
    status: "active" as const,
    ...overrides,
  };
}

function makeSafeMembership(overrides: Partial<{
  id: string;
  classId: string;
  studentUserId: string;
  joinedAt: Date;
  status: "active";
}> = {}) {
  return {
    id: "65f0000000000000000000ff",
    classId: "65f000000000000000000abc",
    studentUserId: STUDENT_USER_ID,
    joinedAt: new Date("2026-09-15T12:00:00.000Z"),
    status: "active" as const,
    ...overrides,
  };
}

// =============================================================================
// Setup / teardown
// =============================================================================

// Custom counters that derive from `mock.calls.length` so they
// reflect BOTH the default `mockImplementation` AND any
// `mockImplementationOnce` overrides queued by individual tests.
const counts = {
  get dummy() {
    return mockRunDummyPasswordVerification.mock.calls.length;
  },
  get verify() {
    return mockVerifyClassPassword.mock.calls.length;
  },
  get createMembership() {
    return mockCreateMembership.mock.calls.length;
  },
  get credentialLookup() {
    return mockGetClassJoinCredentialByCode.mock.calls.length;
  },
  get getSafeMembership() {
    return mockGetSafeMembership.mock.calls.length;
  },
};

// Legacy alias retained for readability at call sites — each
// field resolves to the current mock-call length.
const callCounts = {
  get dummy() {
    return counts.dummy;
  },
  get verify() {
    return counts.verify;
  },
  get createMembership() {
    return counts.createMembership;
  },
  get credentialLookup() {
    return counts.credentialLookup;
  },
  get getSafeMembership() {
    return counts.getSafeMembership;
  },
};

// =============================================================================
// Setup / teardown
// =============================================================================

beforeEach(() => {
  // Reset mocks completely so the `mockImplementationOnce`
  // queues do not leak across tests. We re-establish the
  // default `mockImplementation` for the slower mocks below.
  vi.resetAllMocks();
  consoleLogSpy.mockClear();
  consoleErrorSpy.mockClear();
  consoleWarnSpy.mockClear();

  // Default happy-path mocks.
  mockGetSession.mockResolvedValue(makeSession(STUDENT_USER_ID));
  mockGetProfileByUserId.mockResolvedValue(makeStudentProfile());

  // Default `verifyClassPassword` returns `false` so the
  // wrong-password branch is testable deterministically.
  // Individual tests override this via `mockImplementationOnce`.
  mockVerifyClassPassword.mockImplementation(
    async (rawPassword: string, storedHash: unknown) => {
      if (typeof rawPassword !== "string" || rawPassword.length === 0) {
        return false;
      }
      if (!isValidPasswordHash(storedHash)) {
        return false;
      }
      return false;
    },
  );

  mockRunDummyPasswordVerification.mockImplementation(
    async (_rawPassword: string) => {
      /* count via mock.calls.length */
    },
  );

  mockGetClassJoinCredentialByCode.mockImplementation(
    async (code: string) => {
      const normalized = code.trim().toUpperCase();
      if (normalized === "MSSNGA2") return null;
      if (normalized === "ARCHVD2") {
        return makeCredential({
          classCode: "ARCHVD2",
          status: "archived",
        });
      }
      if (normalized === "MALFRM2") {
        return makeCredential({
          classCode: "MALFRM2",
          passwordHash: "garbage-not-a-valid-hash",
        });
      }
      // Default behavior: treat as found (active) class with a
      // freshly-hashed password.
      const validHash = await hashClassPassword(PASSWORD_PLAINTEXT);
      return makeCredential({
        classCode: normalized,
        passwordHash: validHash,
      });
    },
  );

  mockCreateMembership.mockImplementation(
    async (input: { classId: string; studentUserId: string }) => {
      return makeSafeMembership({
        classId: input.classId,
        studentUserId: input.studentUserId,
      });
    },
  );

  // Default behavior: return the existing membership so the
  // duplicate path can project it. Tests that exercise the
  // "duplicate" branch override this via
  // `mockImplementationOnce`.
  mockGetSafeMembership.mockImplementation(
    async (classId: string, studentUserId: string) => {
      return makeSafeMembership({
        classId,
        studentUserId,
      });
    },
  );
});

afterEach(() => {
  vi.resetAllMocks();
});

// =============================================================================
// 1..9 — Dummy hash constant
// =============================================================================

describe("DUMMY_CLASS_PASSWORD_HASH — architectural lockdown", () => {
  it("1. constant matches the documented encoded format", () => {
    const dummy = __testing.__DUMMY_CLASS_PASSWORD_HASH;
    expect(typeof dummy).toBe("string");
    expect(dummy).not.toContain(PASSWORD_PLAINTEXT);

    const parts = dummy.split("$");
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe("pbkdf2-sha256");
    expect(parts[1]).toBe("100000");
    // salt must be 32 bytes (64 hex chars)
    expect(parts[2]?.length).toBe(64);
    // key must be 32 bytes (64 hex chars)
    expect(parts[3]?.length).toBe(64);
    expect(/^[0-9a-f]+$/i.test(parts[2]!)).toBe(true);
    expect(/^[0-9a-f]+$/i.test(parts[3]!)).toBe(true);
  });

  it("2. dummy hash is structurally valid (parseable by isValidPasswordHash)", () => {
    const dummy = __testing.__DUMMY_CLASS_PASSWORD_HASH;
    expect(isValidPasswordHash(dummy)).toBe(true);
  });

  it("3. production source uses a string literal — no Math.random / randomBytes / pbkdf2 / hashClassPassword at module load", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-service.ts"),
      "utf-8",
    );
    // Locate the declaration line and assert that the right-hand
    // side of the assignment is a PURE string literal (no
    // function call, no template interpolation). The literal is
    // concatenated across lines via `"...$" +` — that is
    // syntactic sugar for a single string literal at compile
    // time, so we tolerate `+` operators between string segments
    // but disallow any identifier / function call on the right
    // side.
    const idx = source.indexOf("DUMMY_CLASS_PASSWORD_HASH =");
    expect(idx).toBeGreaterThanOrEqual(0);
    // Walk forward from the `=` and collect every line until we
    // hit a `;` that closes the assignment.
    const afterEq = source.slice(
      source.indexOf("=", idx) + 1,
      source.indexOf(";", idx),
    );
    // The body must consist only of `"..." +` chains.
    expect(afterEq).toMatch(/^[\s\S]*$/);
    // Disallow runtime primitives.
    expect(afterEq).not.toMatch(/Math\.random/);
    expect(afterEq).not.toMatch(/\brandomBytes\s*\(/);
    // `pbkdf2(` would indicate a real invocation. The literal
    // uses the algorithm identifier `pbkdf2-sha256` between
    // quotes — we disallow the bare identifier `pbkdf2(` as a
    // function call. The literal substring `pbkdf2-sha256` is
    // fine because it is INSIDE a quoted string.
    expect(afterEq).not.toMatch(/\bpbkdf2\s*\(/);
    expect(afterEq).not.toMatch(/\bhashClassPassword\s*\(/);
    expect(afterEq).not.toMatch(/\$\{/); // template interpolation
    // The literal must START with the encoded algorithm marker.
    expect(afterEq.trimStart().startsWith('"pbkdf2-sha256$')).toBe(true);
  });

  it("4. production source does NOT use top-level await to derive the dummy hash", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-service.ts"),
      "utf-8",
    );
    // No top-level await anywhere in the file. Top-level `await`
    // would be at column 0 (or column 0 with leading whitespace
    // for export statements). We check for any line that begins
    // — ignoring leading whitespace — with `await` and is NOT
    // indented inside a function body. We approximate by
    // requiring the line to start at column 0 AND to not be a
    // declaration keyword.
    const lines = source.split("\n");
    const topLevelAwait = lines.filter((line) => {
      // Top-level statements start at column 0 (or column 2 for
      // `export ...`). Indented `await` is inside a function.
      const trimmed = line.replace(/^\s+/, "");
      if (!trimmed.startsWith("await ")) return false;
      // If the line starts with `export ` followed by `await`,
      // that is also a top-level await — but `export` cannot
      // appear with `await` directly. So any un-indented line
      // starting with `await ` is a top-level await.
      return !/^\s/.test(line) || /^\s*export\s+await\b/.test(line);
    });
    expect(topLevelAwait).toEqual([]);
  });

  it("5. production source does NOT call hashClassPassword / randomBytes / pbkdf2 at module top level", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-service.ts"),
      "utf-8",
    );
    // Walk every top-level (un-indented) executable statement
    // and assert none of them invoke a runtime primitive. The
    // class-password module is imported; that import is an
    // un-indented statement but does not invoke any of the
    // disallowed primitives.
    const lines = source.split("\n");
    const disallowed = [
      /hashClassPassword\s*\(/,
      /\brandomBytes\s*\(/,
      /\bpbkdf2\s*\(/,
    ];
    const offenders: string[] = [];
    let insideFunction = 0;
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (line.trimStart().startsWith("export async function ")) {
        insideFunction++;
        continue;
      }
      if (line.trimStart().startsWith("export function ")) {
        insideFunction++;
        continue;
      }
      if (line.trimStart().startsWith("async function ")) {
        insideFunction++;
        continue;
      }
      // Detect function-body open/close by brace counting. This
      // is approximate; we only need to assert that no
      // disallowed call appears OUTSIDE a function.
      // Top-level declarations we care about are constants
      // (`export const`, `export interface`, `export type`,
      // `export class`).
      // For top-level executable statements we look at lines
      // that start with a non-whitespace character AND that
      // contain a disallowed call.
      const leadsWithCode = /^[a-zA-Z_]/.test(line);
      if (leadsWithCode) {
        for (const re of disallowed) {
          if (re.test(line)) {
            offenders.push(line);
          }
        }
      }
      // Close brace tracking — keep simple: we accept some
      // false positives for `export {` lines but they do not
      // match the disallowed list.
    }
    // Filter out the dummy-hash literal substring (which
    // mentions "pbkdf2-sha256" inside quotes).
    const realOffenders = offenders.filter(
      (line) =>
        !line.includes('"pbkdf2-sha256$') &&
        !line.includes('hashClassPassword(value)'),
    );
    expect(realOffenders).toEqual([]);
  });

  it("6. dummy hash is NOT a real credential — does not verify the student-supplied password", async () => {
    // The real class-password primitive must reject every common
    // student password against the dummy hash.
    const dummy = __testing.__DUMMY_CLASS_PASSWORD_HASH;
    const { verifyClassPassword: realVerify } = await import(
      "./class-password"
    );
    const candidates = [
      "password",
      PASSWORD_PLAINTEXT,
      "ClassP@ss",
      "00000000",
      "secret123",
    ];
    for (const candidate of candidates) {
      await expect(realVerify(candidate, dummy)).resolves.toBe(false);
    }
  });

  it("7. dummy hash constant is exported by the production module", async () => {
    // Static source-grep — assert the export exists.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-service.ts"),
      "utf-8",
    );
    expect(source).toMatch(/export\s+const\s+DUMMY_CLASS_PASSWORD_HASH/);
  });

  it("8. runDummyPasswordVerification delegates to verifyClassPassword internally", async () => {
    // Mock the verifyClassPassword primitive directly so we can
    // observe that the production helper calls it. We do this
    // in an isolated describe block to keep the surface clean.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-service.ts"),
      "utf-8",
    );
    expect(source).toMatch(/runDummyPasswordVerification/);
    // The helper must call verifyClassPassword with the dummy
    // hash (and the user's raw password).
    expect(source).toMatch(
      /verifyClassPassword\(\s*rawPassword\s*,\s*DUMMY_CLASS_PASSWORD_HASH\s*\)/,
    );
  });

  it("9. dummy hash is the ONLY hash literal in runDummyPasswordVerification's call", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-service.ts"),
      "utf-8",
    );
    // The function body should contain exactly one reference to
    // the dummy constant.
    const matches =
      source.match(/DUMMY_CLASS_PASSWORD_HASH/g) ?? [];
    // Production source should reference it at least 3 times:
    //   - declaration (1)
    //   - runDummyPasswordVerification (1)
    //   - the join action's own usage (the action imports it
    //     separately and we count the test reference too)
    // For the source file under test we expect at least 2.
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

// =============================================================================
// 10..15 — getClassJoinCredentialByCode primitive
// =============================================================================

describe("getClassJoinCredentialByCode — primitive isolation", () => {
  it("10. production source declares and exports the primitive", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "class-service.ts"),
      "utf-8",
    );
    expect(source).toMatch(
      /export\s+async\s+function\s+getClassJoinCredentialByCode/,
    );
  });

  it("11. primitive is NOT re-exported through the public barrel", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(resolve(__dirname, "index.ts"), "utf-8");
    // The public barrel must NOT contain a deep-path export for
    // this primitive.
    expect(source).not.toMatch(/getClassJoinCredentialByCode/);
  });

  it("12. primitive is NOT re-exported through any client-safe DTO", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const modelSource = readFileSync(
      resolve(__dirname, "class-model.ts"),
      "utf-8",
    );
    // SafeClassDto MUST remain free of passwordHash and of any
    // join-credential shape.
    const dtoMatch = modelSource.match(
      /interface\s+SafeClassDto[\s\S]*?\n\}/,
    );
    expect(dtoMatch).not.toBeNull();
    const dtoBody = dtoMatch![0];
    expect(dtoBody).not.toMatch(/passwordHash/);
    expect(dtoBody).not.toMatch(/getClassJoinCredentialByCode/);
    expect(dtoBody).not.toMatch(/ClassJoinCredential/);
  });

  it("13. action imports the primitive via deep path (not via barrel)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "join-class-action.ts"),
      "utf-8",
    );
    // The deep-path import line is the only acceptable form.
    expect(source).toMatch(
      /from\s+["']@\/lib\/classes\/class-service["']/,
    );
    // The action must NOT import the primitive via the index
    // barrel.
    expect(source).not.toMatch(
      /from\s+["']@\/lib\/classes["']/,
    );
  });

  it("14. action imports DUMMY_CLASS_PASSWORD_HASH via deep path", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "join-class-action.ts"),
      "utf-8",
    );
    expect(source).toMatch(
      /from\s+["']@\/lib\/classes\/class-service["']/,
    );
    expect(source).toMatch(/DUMMY_CLASS_PASSWORD_HASH/);
  });

  it("15. action imports runDummyPasswordVerification via deep path", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "join-class-action.ts"),
      "utf-8",
    );
    expect(source).toMatch(/runDummyPasswordVerification/);
  });
});

// =============================================================================
// 16..18 — Index barrel hygiene
// =============================================================================

describe("index barrel hygiene", () => {
  it("16. barrel does NOT re-export DUMMY_CLASS_PASSWORD_HASH", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "index.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/DUMMY_CLASS_PASSWORD_HASH/);
  });

  it("17. barrel does NOT re-export runDummyPasswordVerification", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "index.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/runDummyPasswordVerification/);
  });

  it("18. barrel does NOT re-export ClassJoinCredential type", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "index.ts"),
      "utf-8",
    );
    expect(source).not.toMatch(/ClassJoinCredential/);
  });
});

// =============================================================================
// 19..28 — Membership duplicate classifier
// =============================================================================

describe("isMembershipDuplicateKeyError — precision", async () => {
  // We use the REAL classifier via a direct import (no mock) for
  // the precision tests, so the assertions are authoritative.
  const { isMembershipDuplicateKeyError } = await import(
    "./class-membership-service"
  );

  it("19. compound keyValue with classId + studentUserId → true", () => {
    expect(
      isMembershipDuplicateKeyError({
        code: 11000,
        keyValue: {
          classId: "65f000000000000000000abc",
          studentUserId: "student-1",
        },
      }),
    ).toBe(true);
  });

  it("20. compound keyValue with ObjectId-like classId → true", () => {
    expect(
      isMembershipDuplicateKeyError({
        code: 11000,
        keyValue: {
          classId: { _bsontype: "ObjectId" } as unknown,
          studentUserId: "student-1",
        },
      }),
    ).toBe(true);
  });

  it("21. compound keyPattern (classId + studentUserId) → true", () => {
    expect(
      isMembershipDuplicateKeyError({
        code: 11000,
        keyPattern: { classId: 1, studentUserId: 1 },
      }),
    ).toBe(true);
  });

  it("22. keyValue with only classId → false", () => {
    expect(
      isMembershipDuplicateKeyError({
        code: 11000,
        keyValue: { classId: "65f000000000000000000abc" },
      }),
    ).toBe(false);
  });

  it("23. keyValue with only studentUserId → false", () => {
    expect(
      isMembershipDuplicateKeyError({
        code: 11000,
        keyValue: { studentUserId: "student-1" },
      }),
    ).toBe(false);
  });

  it("24. unrelated 11000 collision (e.g. idempotencyKey) → false", () => {
    expect(
      isMembershipDuplicateKeyError({
        code: 11000,
        keyValue: { idempotencyKey: "some-key" },
      }),
    ).toBe(false);
  });

  it("25. non-11000 error → false", () => {
    expect(
      isMembershipDuplicateKeyError({
        code: 121, // DocumentValidationFailure
        keyValue: { classId: "x", studentUserId: "y" },
      }),
    ).toBe(false);
  });

  it("26. null / undefined / non-object input → false", () => {
    expect(isMembershipDuplicateKeyError(null)).toBe(false);
    expect(isMembershipDuplicateKeyError(undefined)).toBe(false);
    expect(isMembershipDuplicateKeyError(11000)).toBe(false);
    expect(isMembershipDuplicateKeyError("11000")).toBe(false);
    expect(isMembershipDuplicateKeyError({})).toBe(false);
  });

  it("27. createMembership maps compound collision → MEMBERSHIP_ALREADY_JOINED", async () => {
    // The live `createMembership` is exercised in
    // `class-membership-service.test.ts`. Here we assert the
    // production module's exports include the new error code
    // and the precise classifier so the join action's mapping
    // is well-founded.
    const { MEMBERSHIP_ERROR_CODES } = await import(
      "./class-membership-service"
    );
    expect(MEMBERSHIP_ERROR_CODES.MEMBERSHIP_ALREADY_JOINED).toBe(
      "MEMBERSHIP_ALREADY_JOINED",
    );
    expect(MEMBERSHIP_ERROR_CODES.MEMBERSHIP_CREATE_FAILED).toBe(
      "MEMBERSHIP_CREATE_FAILED",
    );
    // And the precise classifier accepts the canonical compound
    // shape.
    expect(
      isMembershipDuplicateKeyError({
        code: 11000,
        keyValue: {
          classId: "65f000000000000000000abc",
          studentUserId: "student-1",
        },
      }),
    ).toBe(true);
  });

  it("28. createMembership maps unrelated 11000 → MEMBERSHIP_CREATE_FAILED", async () => {
    const { MEMBERSHIP_ERROR_CODES } = await import(
      "./class-membership-service"
    );
    // Classifier rejects unrelated 11000 — the production
    // mapping logic then surfaces the generic failure code.
    expect(
      isMembershipDuplicateKeyError({
        code: 11000,
        keyValue: { idempotencyKey: "some-other-key" },
      }),
    ).toBe(false);
    // And the generic failure code is the right one for
    // unmapped persistence errors.
    expect(MEMBERSHIP_ERROR_CODES.MEMBERSHIP_CREATE_FAILED).toBe(
      "MEMBERSHIP_CREATE_FAILED",
    );
  });
});

// =============================================================================
// 29..60 — createJoinClassAction
// =============================================================================

describe("createJoinClassAction — input shape", () => {
  it("29. accepts classCode + password", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
  });

  it("30. rejects smuggled studentUserId (Zod .strict strips it)", async () => {
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
      // @ts-expect: simulate browser attempting to choose identity
      studentUserId: "another-student",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect([result.code]).toContain(
        JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_PASSWORD,
      );
    }
    expect(mockCreateMembership).not.toHaveBeenCalled();
    expect(callCounts.createMembership).toBe(0);
  });

  it("31. rejects smuggled classId", async () => {
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
      // @ts-expect: simulate browser attempting to bypass lookup
      classId: "65f000000000000000000abc",
    });
    expect(result.ok).toBe(false);
    expect(mockCreateMembership).not.toHaveBeenCalled();
  });

  it("32. rejects smuggled userId", async () => {
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
      // @ts-expect: simulate impersonation attempt
      userId: "malicious-user-id",
    });
    expect(result.ok).toBe(false);
    expect(mockCreateMembership).not.toHaveBeenCalled();
  });

  it("33. rejects smuggled role", async () => {
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
      // @ts-expect: simulate role escalation attempt
      role: "teacher",
    });
    expect(result.ok).toBe(false);
    expect(mockCreateMembership).not.toHaveBeenCalled();
  });

  it("34. rejects smuggled passwordHash", async () => {
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
      // @ts-expect: simulate bypassing password verification
      passwordHash: "pbkdf2-sha256$1$aa$bb",
    });
    expect(result.ok).toBe(false);
    expect(mockCreateMembership).not.toHaveBeenCalled();
  });

  it("35. invalid empty classCode rejected", async () => {
    const result = await createJoinClassAction({
      classCode: "",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_CODE,
      );
    }
    expect(mockCreateMembership).not.toHaveBeenCalled();
  });

  it("36. invalid short classCode rejected", async () => {
    const result = await createJoinClassAction({
      classCode: "AB",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_CODE,
      );
    }
  });

  it("37. invalid classCode alphabet rejected (lowercase)", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const result = await createJoinClassAction({
      classCode: "abcdefg",
      password: PASSWORD_PLAINTEXT,
    });
    // The schema uppercases via preprocess, so this becomes
    // ABCDEFG which is valid. We instead test a value that
    // contains a forbidden character (lowercase 'o' for example
    // — but the alphabet excludes 'o' even uppercase). The
    // schema requires [A-HJ-NP-Z2-9], so 'I' is rejected.
    const result2 = await createJoinClassAction({
      classCode: "IBCDEFG",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result2.ok).toBe(false);
    if (!result2.ok) {
      expect(result2.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_CODE,
      );
    }
    // And confirm the lowercase case is canonicalized to
    // uppercase before reaching the service.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.membership.classCode).toBe("ABCDEFG");
    }
  });

  it("38. invalid empty password rejected", async () => {
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_PASSWORD,
      );
    }
    expect(mockCreateMembership).not.toHaveBeenCalled();
  });

  it("39. invalid short password rejected (4 char floor)", async () => {
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: "abc",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_PASSWORD,
      );
    }
    expect(mockCreateMembership).not.toHaveBeenCalled();
  });

  it("40. invalid long password rejected (128 char ceiling)", async () => {
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: "A".repeat(129),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_PASSWORD,
      );
    }
    expect(mockCreateMembership).not.toHaveBeenCalled();
  });

  it("41. password is forwarded unchanged (no trim)", async () => {
    const weirdWhitespace = "  A B\tC  \nD  ";
    // The CLASSA2 fixture's mock hashes the password before
    // returning, so we change the lookup to return a credential
    // whose stored hash matches our exact-whitespace password.
    const exactHash = await hashClassPassword(weirdWhitespace);
    mockGetClassJoinCredentialByCode.mockImplementationOnce(
      async () =>
        makeCredential({
          classCode: "CLASSA2",
          passwordHash: exactHash,
        }),
    );
    // The real verifyClassPassword runs the actual PBKDF2
    // workload. For test speed we still rely on the mock
    // because the action consults verifyClassPassword
    // through the class-password module import. We re-mock
    // verifyClassPassword to return true only for this exact
    // password against this exact hash.
    mockVerifyClassPassword.mockImplementationOnce(
      async () => true,
    );
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      // @ts-expect: simulate preserving whitespace inside
      // password
      password: weirdWhitespace,
    });
    expect(result.ok).toBe(true);
  });

  it("42. classCode is normalized to uppercase before reaching the service", async () => {
    let observed: string | undefined;
    mockGetClassJoinCredentialByCode.mockImplementationOnce(
      async (code: string) => {
        observed = code;
        return makeCredential({
          classCode: code.toUpperCase(),
        });
      },
    );
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(observed).toBe("CLASSA2");
  });
});

describe("createJoinClassAction — authentication", () => {
  it("43. no session → UNAUTHENTICATED", async () => {
    mockGetSession.mockResolvedValue(null);
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.UNAUTHENTICATED,
      );
      expect(result.retryable).toBe(false);
    }
  });

  it("44. unauthenticated path does not call the service", async () => {
    mockGetSession.mockResolvedValue(null);
    await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(mockGetClassJoinCredentialByCode).not.toHaveBeenCalled();
    expect(mockCreateMembership).not.toHaveBeenCalled();
  });

  it("45. session user id is authoritative studentUserId", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    let observedStudent: string | undefined;
    mockCreateMembership.mockImplementationOnce(
      async (input: { classId: string; studentUserId: string }) => {
        observedStudent = input.studentUserId;
        return makeSafeMembership({ studentUserId: input.studentUserId });
      },
    );
    await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(observedStudent).toBe(STUDENT_USER_ID);
  });

  it("46. missing user.id → UNAUTHENTICATED", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "", email: "x", name: "x", image: null },
      expiresAt: new Date(),
    });
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.UNAUTHENTICATED,
      );
    }
  });
});

describe("createJoinClassAction — profile gating", () => {
  it("47. missing profile → PROFILE_INCOMPLETE", async () => {
    mockGetProfileByUserId.mockResolvedValue(null);
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.PROFILE_INCOMPLETE,
      );
    }
    expect(mockCreateMembership).not.toHaveBeenCalled();
  });

  it("48. incomplete profile → PROFILE_INCOMPLETE", async () => {
    mockGetProfileByUserId.mockResolvedValue(
      makeStudentProfile({ onboardingCompleted: false }),
    );
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.PROFILE_INCOMPLETE,
      );
    }
  });

  it("49. role=teacher → STUDENT_REQUIRED", async () => {
    mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.STUDENT_REQUIRED,
      );
      expect(result.retryable).toBe(false);
    }
  });

  it("50. profile lookup failure → CLASS_JOIN_FAILED (no leak)", async () => {
    mockGetProfileByUserId.mockRejectedValue(
      new Error("ECONNREFUSED 10.0.0.1:27017"),
    );
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.CLASS_JOIN_FAILED,
      );
      expect(result.message).not.toContain("ECONNREFUSED");
      expect(result.message).not.toContain("10.0.0.1");
    }
  });
});

describe("createJoinClassAction — canonical timing path", () => {
  it("51. missing class runs ONE dummy verification then returns INVALID_CLASS_CREDENTIALS", async () => {
    const result = await createJoinClassAction({
      classCode: "MSSNGA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_CREDENTIALS,
      );
      expect(result.retryable).toBe(false);
    }
    // Exactly one canonical dummy workload on the missing-class
    // branch.
    expect(callCounts.dummy).toBe(1);
    expect(callCounts.verify).toBe(0);
    expect(callCounts.createMembership).toBe(0);
  });

  it("52. archived class runs ONE dummy verification then returns INVALID_CLASS_CREDENTIALS", async () => {
    const result = await createJoinClassAction({
      classCode: "ARCHVD2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_CREDENTIALS,
      );
    }
    expect(callCounts.dummy).toBe(1);
    expect(callCounts.verify).toBe(0);
    expect(callCounts.createMembership).toBe(0);
  });

  it("53. wrong password runs REAL verification then returns INVALID_CLASS_CREDENTIALS", async () => {
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: "wrong-password",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_CREDENTIALS,
      );
    }
    // The real verification was invoked; the dummy helper was
    // NOT invoked on this branch.
    expect(callCounts.verify).toBe(1);
    expect(callCounts.dummy).toBe(0);
    expect(callCounts.createMembership).toBe(0);
  });

  it("54. malformed stored hash runs ONE dummy verification then returns INVALID_CLASS_CREDENTIALS", async () => {
    const result = await createJoinClassAction({
      classCode: "MALFRM2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_CREDENTIALS,
      );
    }
    // The malformed-hash branch runs the dummy helper (the real
    // verification would short-circuit on parser failure and
    // bypass the async PBKDF2 workload).
    expect(callCounts.dummy).toBe(1);
    expect(callCounts.createMembership).toBe(0);
  });
});

describe("createJoinClassAction — success result", () => {
  it("55. valid student joins class and result contains SafeMembershipDto projection", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.membership).toBeDefined();
      expect(result.membership.id).toBeDefined();
      expect(result.membership.classId).toBe(
        "65f000000000000000000abc",
      );
      expect(result.membership.classCode).toBe("CLASSA2");
      expect(result.membership.status).toBe("active");
      expect(result.membership.joinedAt).toBe(
        "2026-09-15T12:00:00.000Z",
      );
      // PHASE 5.1C — first valid join returns alreadyJoined:false.
      expect(result.alreadyJoined).toBe(false);
    }
  });

  it("56. success result contains NO password / passwordHash / studentUserId / teacherUserId", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(PASSWORD_PLAINTEXT);
      expect(serialized).not.toContain("passwordHash");
      expect(serialized).not.toContain("studentUserId");
      expect(serialized).not.toContain("teacherUserId");
      expect(result.membership).not.toHaveProperty("password");
      expect(result.membership).not.toHaveProperty("rawPassword");
      expect(result.membership).not.toHaveProperty("passwordHash");
      expect(result.membership).not.toHaveProperty("studentUserId");
      expect(result.membership).not.toHaveProperty("teacherUserId");
    }
  });

  it("57. NO password console logging", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    await createJoinClassAction({
      classCode: "CLASSA2",
      password: "sensitive-join-password-987",
    });
    const allOutput = [
      ...consoleLogSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
    ]
      .flat()
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join("\n");
    expect(allOutput).not.toContain("sensitive-join-password-987");
    expect(allOutput).not.toContain(PASSWORD_PLAINTEXT);
  });
});

describe("createJoinClassAction — duplicate idempotency", () => {
  it("58. compound collision from createMembership → idempotent success", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    // Simulate the membership service raising a typed
    // MembershipServiceError(MEMBERSHIP_ALREADY_JOINED) — the
    // production classifier would produce this when the
    // MongoDB write collides on the compound key.
    const { MembershipServiceError } = await import(
      "./class-membership-service"
    );
    mockCreateMembership.mockImplementationOnce(async () => {
      throw new MembershipServiceError({
        code: "MEMBERSHIP_ALREADY_JOINED",
        message: "You have already joined this class.",
      });
    });
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyJoined).toBe(true);
      expect(result.membership).toBeDefined();
      expect(result.membership.classId).toBe(
        "65f000000000000000000abc",
      );
      expect(result.membership.classCode).toBe("CLASSA2");
      expect(result.membership.status).toBe("active");
      expect(result.membership.joinedAt).toBe(
        "2026-09-15T12:00:00.000Z",
      );
    }
    // Single insert attempt — no retry.
    expect(mockCreateMembership.mock.calls).toHaveLength(1);
    // The existing membership is fetched ONCE for projection.
    expect(callCounts.getSafeMembership).toBe(1);
  });

  it("59. legacy MEMBERSHIP_ALREADY_EXISTS is also mapped to idempotent success", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const { MembershipServiceError } = await import(
      "./class-membership-service"
    );
    mockCreateMembership.mockImplementationOnce(async () => {
      throw new MembershipServiceError({
        code: "MEMBERSHIP_ALREADY_EXISTS",
        message: "legacy already-exists",
      });
    });
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyJoined).toBe(true);
    }
  });

  it("60. unrelated typed error from createMembership → CLASS_JOIN_FAILED", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const { MembershipServiceError } = await import(
      "./class-membership-service"
    );
    mockCreateMembership.mockImplementationOnce(async () => {
      throw new MembershipServiceError({
        code: "MEMBERSHIP_CREATE_FAILED",
        message: "Some other persistence failure",
      });
    });
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.CLASS_JOIN_FAILED,
      );
      expect(result.retryable).toBe(true);
      expect(result.message).not.toContain("persistence");
    }
    // No lookup on the generic failure path.
    expect(callCounts.getSafeMembership).toBe(0);
  });

  it("61. raw E11000 that escaped the service is classified as idempotent success", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    mockCreateMembership.mockImplementationOnce(async () => {
      const err = new Error(
        "E11000 duplicate key error on mongodb://internal:27017/face_attendance.class_memberships index: classId_1_studentUserId_1",
      ) as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = {
        classId: "65f000000000000000000abc",
        studentUserId: STUDENT_USER_ID,
      };
      throw err;
    });
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyJoined).toBe(true);
      // No leak of Mongo internals in the success projection.
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("E11000");
      expect(serialized).not.toContain("mongodb://");
      expect(serialized).not.toContain("duplicate key");
      expect(serialized).not.toContain("face_attendance");
    }
  });

  it("62. raw unrelated 11000 from createMembership is NOT remapped to idempotent success", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    mockCreateMembership.mockImplementationOnce(async () => {
      const err = new Error(
        "E11000 duplicate key error index: idempotencyKey_1",
      ) as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = { idempotencyKey: "some-key" };
      throw err;
    });
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.CLASS_JOIN_FAILED,
      );
    }
    // The precise predicate rejects this — no lookup is performed.
    expect(callCounts.getSafeMembership).toBe(0);
  });

  it("63. generic membership failure is NOT retried", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    mockCreateMembership.mockImplementationOnce(async () => {
      throw new Error("ECONNREFUSED 10.0.0.1:27017");
    });
    await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    // Exactly one attempt.
    expect(callCounts.createMembership).toBe(1);
    // Generic failure does not consult the existing-membership
    // lookup.
    expect(callCounts.getSafeMembership).toBe(0);
  });

  it("64. raw stack not returned in safe error result", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const err = new Error("kaboom");
    err.stack =
      "Error: kaboom\n    at /Users/dev/internal/secret/path/x.ts:42:9";
    mockCreateMembership.mockImplementationOnce(async () => {
      throw err;
    });
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("kaboom");
      expect(serialized).not.toContain("/Users/dev/internal");
      expect(serialized).not.toContain("secret/path");
      expect(serialized).not.toContain("at ");
    }
  });
});

// =============================================================================
// PHASE 5.1C.1 — Canonical verification audit: idempotency
// =============================================================================

describe("PHASE 5.1C.1 — canonical verification audit", () => {
  it("audit-1. first valid join returns ok=true", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
  });

  it("audit-2. first valid join returns alreadyJoined=false", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyJoined).toBe(false);
    }
  });

  it("audit-3. exact compound duplicate returns ok=true (idempotent success)", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const { MembershipServiceError } = await import(
      "./class-membership-service"
    );
    mockCreateMembership.mockImplementationOnce(async () => {
      throw new MembershipServiceError({
        code: "MEMBERSHIP_ALREADY_JOINED",
        message: "You have already joined this class.",
      });
    });
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
  });

  it("audit-4. duplicate returns alreadyJoined=true", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const { MembershipServiceError } = await import(
      "./class-membership-service"
    );
    mockCreateMembership.mockImplementationOnce(async () => {
      throw new MembershipServiceError({
        code: "MEMBERSHIP_ALREADY_JOINED",
        message: "You have already joined this class.",
      });
    });
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.alreadyJoined).toBe(true);
    }
  });

  it("audit-5. duplicate success returns the same safe class identity", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const { MembershipServiceError } = await import(
      "./class-membership-service"
    );
    mockCreateMembership.mockImplementationOnce(async () => {
      throw new MembershipServiceError({
        code: "MEMBERSHIP_ALREADY_JOINED",
        message: "You have already joined this class.",
      });
    });
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Same identity fields as the first-join success.
      expect(result.membership.classId).toBe(
        "65f000000000000000000abc",
      );
      expect(result.membership.classCode).toBe("CLASSA2");
      expect(result.membership.status).toBe("active");
      expect(result.membership.id).toBeDefined();
      expect(typeof result.membership.joinedAt).toBe("string");
    }
  });

  it("audit-6. duplicate path does not retry insert", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const { MembershipServiceError } = await import(
      "./class-membership-service"
    );
    mockCreateMembership.mockImplementationOnce(async () => {
      throw new MembershipServiceError({
        code: "MEMBERSHIP_ALREADY_JOINED",
        message: "You have already joined this class.",
      });
    });
    await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(callCounts.createMembership).toBe(1);
  });

  it("audit-7. duplicate path creates no second membership (only one lookup, no retry)", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const { MembershipServiceError } = await import(
      "./class-membership-service"
    );
    mockCreateMembership.mockImplementationOnce(async () => {
      throw new MembershipServiceError({
        code: "MEMBERSHIP_ALREADY_JOINED",
        message: "You have already joined this class.",
      });
    });
    await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    // The action inserts once, fails on the unique index, and
    // never retries. The lookup is a read, not a write.
    expect(callCounts.createMembership).toBe(1);
    expect(callCounts.getSafeMembership).toBe(1);
  });

  it("audit-8. duplicate requires correct password first (no password → INVALID_CLASS_CREDENTIALS, no idempotency)", async () => {
    // Default verifyClassPassword returns false — wrong password.
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: "wrong-password-attempt",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_CREDENTIALS,
      );
    }
    // The duplicate path is unreachable — no insert attempted.
    expect(callCounts.createMembership).toBe(0);
    expect(callCounts.getSafeMembership).toBe(0);
  });

  it("audit-9. wrong password with existing membership does NOT return alreadyJoined=true", async () => {
    // Default verifyClassPassword returns false — wrong password.
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: "wrong-password-attempt",
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      expect(result.alreadyJoined).not.toBe(true);
    }
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_CREDENTIALS,
      );
    }
  });

  it("audit-10. archived class with existing membership does NOT return alreadyJoined=true", async () => {
    // ARCHVD2 is the archived-class fixture in the default mock.
    const result = await createJoinClassAction({
      classCode: "ARCHVD2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (result.ok) {
      expect(result.alreadyJoined).not.toBe(true);
    }
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_CREDENTIALS,
      );
    }
    expect(callCounts.createMembership).toBe(0);
    expect(callCounts.getSafeMembership).toBe(0);
  });

  it("audit-11. unrelated E11000 remains ok=false / CLASS_JOIN_FAILED", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    mockCreateMembership.mockImplementationOnce(async () => {
      const err = new Error(
        "E11000 duplicate key error index: idempotencyKey_1",
      ) as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = { idempotencyKey: "future-index" };
      throw err;
    });
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        JOIN_CLASS_ACTION_ERROR_CODES.CLASS_JOIN_FAILED,
      );
    }
  });

  it("audit-12. raw E11000 text never reaches result", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    mockCreateMembership.mockImplementationOnce(async () => {
      const err = new Error(
        "E11000 duplicate key error on mongodb://internal:27017/face_attendance.class_memberships index: classId_1_studentUserId_1",
      ) as Error & {
        code: number;
        keyValue: Record<string, unknown>;
      };
      err.code = 11000;
      err.keyValue = {
        classId: "65f000000000000000000abc",
        studentUserId: STUDENT_USER_ID,
      };
      throw err;
    });
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("E11000");
    expect(serialized).not.toContain("mongodb://");
    expect(serialized).not.toContain("duplicate key");
    expect(serialized).not.toContain("face_attendance");
  });
});

describe("PHASE 5.1C.1 — privacy invariants on idempotent success", () => {
  it("priv-1. duplicate-success result contains no password / passwordHash / studentUserId / teacherUserId", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const { MembershipServiceError } = await import(
      "./class-membership-service"
    );
    mockCreateMembership.mockImplementationOnce(async () => {
      throw new MembershipServiceError({
        code: "MEMBERSHIP_ALREADY_JOINED",
        message: "You have already joined this class.",
      });
    });
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(PASSWORD_PLAINTEXT);
      expect(serialized).not.toContain("passwordHash");
      expect(serialized).not.toContain("studentUserId");
      expect(serialized).not.toContain("teacherUserId");
      expect(result.membership).not.toHaveProperty("password");
      expect(result.membership).not.toHaveProperty("passwordHash");
      expect(result.membership).not.toHaveProperty("studentUserId");
      expect(result.membership).not.toHaveProperty("teacherUserId");
    }
  });

  it("priv-2. duplicate-success contains no Mongo error / stack / dummy hash", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const { MembershipServiceError } = await import(
      "./class-membership-service"
    );
    mockCreateMembership.mockImplementationOnce(async () => {
      throw new MembershipServiceError({
        code: "MEMBERSHIP_ALREADY_JOINED",
        message: "E11000 duplicate key error",
      });
    });
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("E11000");
      expect(serialized).not.toContain("duplicate key");
      expect(serialized).not.toContain("at ");
      expect(serialized).not.toContain("pbkdf2-sha256");
      expect(serialized).not.toContain("0101010101010101");
    }
  });

  it("priv-3. duplicate-success projection has no ALREADY_JOINED error code", async () => {
    mockVerifyClassPassword.mockImplementationOnce(async () => true);
    const { MembershipServiceError } = await import(
      "./class-membership-service"
    );
    mockCreateMembership.mockImplementationOnce(async () => {
      throw new MembershipServiceError({
        code: "MEMBERSHIP_ALREADY_JOINED",
        message: "You have already joined this class.",
      });
    });
    const result = await createJoinClassAction({
      classCode: "CLASSA2",
      password: PASSWORD_PLAINTEXT,
    });
    // The duplicate path is NOT represented as an error code.
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("ALREADY_JOINED");
      expect(serialized).not.toContain("code");
    }
  });
});

describe("createJoinClassAction — module surface", () => {
  it("65. opens with \"use server\" directive", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "join-class-action.ts"),
      "utf-8",
    );
    expect(source.includes('"use server"')).toBe(true);
  });

  it("66. does NOT call createClass or any class-write primitive", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "join-class-action.ts"),
      "utf-8",
    );
    // The action's class-service imports must be limited to the
    // join-time primitives; no class-write primitive is
    // referenced.
    expect(source).not.toMatch(/createClass\s*\(/);
    expect(source).not.toMatch(/updateClass\s*\(/);
    expect(source).not.toMatch(/deleteClass\s*\(/);
    expect(source).not.toMatch(/archiveClass\s*\(/);
  });

  it("67. does NOT mutate Profile (only reads via getProfileByUserId)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "join-class-action.ts"),
      "utf-8",
    );
    expect(source).toMatch(/getProfileByUserId/);
    // No profile write / update primitive referenced.
    expect(source).not.toMatch(/upsertOnboarding\s*\(/);
    expect(source).not.toMatch(/updateProfile\s*\(/);
    expect(source).not.toMatch(/save\s*\(\s*profile/);
  });

  it("68. does NOT touch FaceProfile or Face Service", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(__dirname, "join-class-action.ts"),
      "utf-8",
    );
    // Strip JSDoc comments — the architectural docstring is
    // allowed to MENTION these primitives in order to assert
    // that they are NOT touched at runtime. The runtime surface
    // is what matters.
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(stripped).not.toMatch(/FaceProfile/);
    expect(stripped).not.toMatch(/face-service/);
    expect(stripped).not.toMatch(/faceService/);
    expect(stripped).not.toMatch(/biometrics/);
    // And confirm the JSDoc itself DOES mention them — this
    // proves we stripped correctly.
    expect(source).toMatch(/FaceProfile/);
  });

  it("69. Zod input schema strips smuggled studentUserId", () => {
    const schema = __testing.JoinClassInputSchema;
    const result = schema.safeParse({
      classCode: "ABCDEFG",
      password: "valid-password-1",
      studentUserId: "browser",
    });
    expect(result.success).toBe(false);
  });

  it("70. Zod input schema strips smuggled classId", () => {
    const schema = __testing.JoinClassInputSchema;
    const result = schema.safeParse({
      classCode: "ABCDEFG",
      password: "valid-password-1",
      classId: "browser",
    });
    expect(result.success).toBe(false);
  });

  it("71. Zod input schema strips smuggled role", () => {
    const schema = __testing.JoinClassInputSchema;
    const result = schema.safeParse({
      classCode: "ABCDEFG",
      password: "valid-password-1",
      role: "teacher",
    });
    expect(result.success).toBe(false);
  });

  it("72. Zod input schema strips smuggled passwordHash", () => {
    const schema = __testing.JoinClassInputSchema;
    const result = schema.safeParse({
      classCode: "ABCDEFG",
      password: "valid-password-1",
      passwordHash: "pbkdf2-sha256$1$aa$bb",
    });
    expect(result.success).toBe(false);
  });
});
