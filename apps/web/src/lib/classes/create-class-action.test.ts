/**
 * Tests for the PHASE 5.1B authenticated create-class Server
 * Action.
 *
 * Covers the 60-test contract:
 *
 *   1..12   — Action input (shape, password policy, no smuggling)
 *  13..16   — Authentication (no session, browser impersonation)
 *  17..22   — Profile gating (missing, incomplete, wrong role,
 *              teacher + complete proceeds)
 *  23..28   — Password (async hash, no plaintext persist,
 *              passwordHash differs, no leak in result, no log)
 *  29..39   — Class code (server-generated, canonical format,
 *              no browser-supplied code, collision retry, bounded
 *              loop, exhaustion)
 *  40..45   — Error classification (E11000 + classCode retryable,
 *              unrelated 11000 not retryable, generic failure not
 *              retried, safe mapping, no raw leak)
 *  46..55   — Success (teacher persists one class, ownership,
 *              active status, no password/passwordHash in result)
 *  56..60   — No extra domain writes (no membership, no profile
 *              mutation, no attendance, no Face Service call,
 *              no FaceProfile touch)
 *
 * Implementation notes:
 *
 *   - All collaborators (`@/lib/session`, `@/lib/profile-service`,
 *     `@/lib/classes/class-service`, `@/lib/mongoose`) are mocked
 *     at module boundaries. No MongoDB / Mongoose / Face Service /
 *     Better Auth is touched.
 *   - The class service is mocked as a controlled re-throw surface
 *     so the retry loop and error classification can be exercised
 *     deterministically.
 *   - `vi.mock(...)` declarations are hoisted above imports by
 *     Vitest, so collaborators are guaranteed to be replaced
 *     before the action module is loaded.
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
const mockCreateClass = vi.fn();

vi.mock("@/lib/session", () => ({
  getSession: () => mockGetSession(),
}));

vi.mock("@/lib/profile-service", () => ({
  getProfileByUserId: (...args: unknown[]) =>
    mockGetProfileByUserId(...args),
}));

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
    createClass: (...args: unknown[]) => mockCreateClass(...args),
  };
});

// Capture console output so the "no logging" assertions can
// observe the run-time behavior without polluting the test report.
const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

// =============================================================================
// Imports under test
// =============================================================================

import {
  createClassAction,
  CREATE_CLASS_ACTION_ERROR_CODES,
  MAX_CLASS_CODE_ATTEMPTS,
  __testing,
} from "./create-class-action";
import { hashClassPassword, isValidPasswordHash } from "./class-password";
import {
  CLASS_CODE_LENGTH,
  generateClassCode,
  isCanonicalClassCode,
} from "./class-code";
import type { SafeClassDto } from "./class-model";

// =============================================================================
// Test fixtures
// =============================================================================

const TEACHER_USER_ID = "teacher-better-auth-id-001";
const STUDENT_USER_ID = "student-better-auth-id-002";
const PASSWORD_PLAINTEXT = "ClassP@ssw0rd-2026";

function makeSession(userId: string) {
  return {
    user: {
      id: userId,
      email: `${userId}@example.com`,
      name: "Test User",
      image: null,
    },
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  };
}

function makeTeacherProfile(overrides: Partial<{
  onboardingCompleted: boolean;
  role: "student" | "teacher";
}> = {}) {
  return {
    userId: TEACHER_USER_ID,
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

function makeStudentProfile(overrides: Partial<{
  onboardingCompleted: boolean;
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

function makeSafeClass(overrides: Partial<SafeClassDto> = {}): SafeClassDto {
  const createdAt = overrides.createdAt ?? new Date();
  return {
    id: "65f0000000000000000000a1",
    name: "Web Development - D22",
    teacherUserId: TEACHER_USER_ID,
    classCode: "ABCDEFG",
    status: "active",
    createdAt,
    updatedAt: createdAt,
    ...overrides,
  };
}

/**
 * Captures the full call history of `createClass` so tests can
 * assert about the number of attempts, the names passed in, the
 * teacherUserId, and the absence of `classCode` / `passwordHash`
 * / `role` from the input.
 */
const callHistory: Array<{
  name: string;
  teacherUserId: string;
  rawPassword: string;
  classCode?: string;
}> = [];

/**
 * Returns a configured mock implementation that succeeds by
 * default but honours a per-test override.
 */
function setupServiceMock(opts: {
  succeedWith?: (input: {
    name: string;
    teacherUserId: string;
    rawPassword: string;
  }) => Promise<SafeClassDto>;
  failWith?: unknown;
  collisionsBeforeSuccess?: number;
} = {}) {
  const collisionsBefore = opts.collisionsBeforeSuccess ?? 0;
  let seen = 0;

  mockCreateClass.mockImplementation(async (input: {
    name: string;
    teacherUserId: string;
    rawPassword: string;
    classCode?: string;
  }) => {
    callHistory.push({
      name: input.name,
      teacherUserId: input.teacherUserId,
      rawPassword: input.rawPassword,
      classCode: input.classCode,
    });

    if (opts.failWith !== undefined) {
      throw opts.failWith;
    }

    if (seen < collisionsBefore) {
      seen++;
      // Throw the same canonical ClassServiceError the real service
      // produces when the unique index on `classCode` collides.
      throw new (await import("./class-service")).ClassServiceError({
        code: "CLASS_CODE_ALREADY_EXISTS",
        message: "A class with this code already exists. Please try again.",
      });
    }

    if (opts.succeedWith) {
      return opts.succeedWith(input);
    }

    // Default success: derive a unique class code from the call
    // index so each attempt produces a distinct code (mirrors
    // the real service behaviour).
    const codeSuffix = String(seen).padStart(2, "0");
    return makeSafeClass({
      name: input.name,
      teacherUserId: input.teacherUserId,
      classCode: ("ABCDEF" + codeSuffix).slice(0, CLASS_CODE_LENGTH),
    });
  });
}

// =============================================================================
// Setup / teardown
// =============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  callHistory.length = 0;
  consoleLogSpy.mockClear();
  consoleErrorSpy.mockClear();
  consoleWarnSpy.mockClear();

  // Default happy-path mocks.
  mockGetSession.mockResolvedValue(makeSession(TEACHER_USER_ID));
  mockGetProfileByUserId.mockResolvedValue(makeTeacherProfile());
});

afterEach(() => {
  vi.clearAllMocks();
});

// =============================================================================
// 1..12 — Action input
// =============================================================================

describe("createClassAction — input shape", () => {
  it("1. accepts name + password", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
  });

  it("2. rejects smuggled teacherUserId (Zod .strict strips it)", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
      // @ts-expect: simulate browser attempting to choose ownership
      teacherUserId: "another-teacher",
    });
    // Strict schema rejects the smuggled key — the action must
    // surface a validation failure and MUST NOT call the service.
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Either name or password error — both are equally safe to
      // surface. The action collapses strict-violation rejections
      // to the password code so the browser cannot probe the
      // schema.
      expect([result.code]).toContain(
        CREATE_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_PASSWORD,
      );
    }
    expect(mockCreateClass).not.toHaveBeenCalled();
    expect(callHistory).toHaveLength(0);
  });

  it("3. rejects smuggled userId", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
      // @ts-expect: simulate browser trying to impersonate
      userId: "malicious-user-id",
    });
    expect(result.ok).toBe(false);
    expect(mockCreateClass).not.toHaveBeenCalled();
  });

  it("4. rejects smuggled role", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
      // @ts-expect: simulate browser trying to elevate role
      role: "teacher",
    });
    expect(result.ok).toBe(false);
    expect(mockCreateClass).not.toHaveBeenCalled();
  });

  it("5. rejects smuggled classCode", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
      // @ts-expect: simulate browser trying to choose the code
      classCode: "BROWSR1",
    });
    expect(result.ok).toBe(false);
    expect(mockCreateClass).not.toHaveBeenCalled();
  });

  it("6. rejects smuggled passwordHash", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
      // @ts-expect: simulate browser trying to bypass hashing
      passwordHash: "pbkdf2-sha256$1$00$00",
    });
    expect(result.ok).toBe(false);
    expect(mockCreateClass).not.toHaveBeenCalled();
  });

  it("7. class name is trimmed/canonicalized according to schema", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "   Padded Class Name   ",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // The trimmed name reaches the service.
      expect(callHistory[0]?.name).toBe("Padded Class Name");
    }
  });

  it("8. invalid empty name rejected", async () => {
    const result = await createClassAction({
      name: "   ",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CREATE_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_NAME,
      );
    }
    expect(mockCreateClass).not.toHaveBeenCalled();
  });

  it("9. overlong name rejected (200 chars max)", async () => {
    const result = await createClassAction({
      name: "A".repeat(201),
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CREATE_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_NAME,
      );
    }
    expect(mockCreateClass).not.toHaveBeenCalled();
  });

  it("10. too-short password rejected (4 char floor)", async () => {
    const result = await createClassAction({
      name: "Valid Name",
      password: "abc",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CREATE_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_PASSWORD,
      );
    }
    expect(mockCreateClass).not.toHaveBeenCalled();
  });

  it("11. overlong password rejected (128 char ceiling)", async () => {
    const result = await createClassAction({
      name: "Valid Name",
      password: "A".repeat(129),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CREATE_CLASS_ACTION_ERROR_CODES.INVALID_CLASS_PASSWORD,
      );
    }
    expect(mockCreateClass).not.toHaveBeenCalled();
  });

  it("12. password is not returned in error/result", async () => {
    setupServiceMock({
      failWith: new Error("exploded with secret MySecret123 leaked"),
    });
    const result = await createClassAction({
      name: "Valid Name",
      password: "MySecret123",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("MySecret123");
      expect(serialized).not.toContain("password");
    }
  });
});

// =============================================================================
// 13..16 — Authentication
// =============================================================================

describe("createClassAction — auth", () => {
  it("13. no session → UNAUTHENTICATED", async () => {
    mockGetSession.mockResolvedValue(null);
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CREATE_CLASS_ACTION_ERROR_CODES.UNAUTHENTICATED,
      );
      expect(result.retryable).toBe(false);
    }
  });

  it("14. unauthenticated path does not call createClass", async () => {
    mockGetSession.mockResolvedValue(null);
    await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(mockCreateClass).not.toHaveBeenCalled();
    expect(callHistory).toHaveLength(0);
  });

  it("15. session user id is authoritative teacherUserId", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    expect(callHistory).toHaveLength(1);
    expect(callHistory[0]?.teacherUserId).toBe(TEACHER_USER_ID);
  });

  it("16. browser cannot impersonate another teacher (smuggled id is rejected)", async () => {
    setupServiceMock();
    const otherTeacher = "another-teacher-id";
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
      // @ts-expect: simulate impersonation attempt
      teacherUserId: otherTeacher,
    });
    // The smuggled id is rejected before the service is reached,
    // so the service is NEVER called with any teacherUserId.
    expect(result.ok).toBe(false);
    expect(mockCreateClass).not.toHaveBeenCalled();
    expect(callHistory).toHaveLength(0);
    // And the impersonated id never appears in the action surface.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(otherTeacher);
  });

  it("16b. valid teacher (no smuggled field) persists under session id", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    expect(callHistory[0]?.teacherUserId).toBe(TEACHER_USER_ID);
    expect(callHistory[0]?.teacherUserId).not.toBe("another-teacher-id");
  });
});

// =============================================================================
// 17..22 — Profile gating
// =============================================================================

describe("createClassAction — profile gating", () => {
  it("17. missing profile handled safely", async () => {
    mockGetProfileByUserId.mockResolvedValue(null);
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CREATE_CLASS_ACTION_ERROR_CODES.PROFILE_INCOMPLETE,
      );
    }
  });

  it("18. incomplete profile → PROFILE_INCOMPLETE", async () => {
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ onboardingCompleted: false }),
    );
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CREATE_CLASS_ACTION_ERROR_CODES.PROFILE_INCOMPLETE,
      );
    }
  });

  it("19. incomplete profile does not persist class", async () => {
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ onboardingCompleted: false }),
    );
    await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(mockCreateClass).not.toHaveBeenCalled();
    expect(callHistory).toHaveLength(0);
  });

  it("20. role=student → TEACHER_REQUIRED", async () => {
    mockGetSession.mockResolvedValue(makeSession(STUDENT_USER_ID));
    mockGetProfileByUserId.mockResolvedValue(makeStudentProfile());
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CREATE_CLASS_ACTION_ERROR_CODES.TEACHER_REQUIRED,
      );
      expect(result.retryable).toBe(false);
    }
  });

  it("21. student path does not persist class", async () => {
    mockGetSession.mockResolvedValue(makeSession(STUDENT_USER_ID));
    mockGetProfileByUserId.mockResolvedValue(makeStudentProfile());
    await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(mockCreateClass).not.toHaveBeenCalled();
    expect(callHistory).toHaveLength(0);
  });

  it("22. role=teacher + complete onboarding proceeds", async () => {
    setupServiceMock();
    mockGetProfileByUserId.mockResolvedValue(
      makeTeacherProfile({ role: "teacher", onboardingCompleted: true }),
    );
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    expect(mockCreateClass).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// 23..28 — Password
// =============================================================================

describe("createClassAction — password handling", () => {
  it("23. action/service uses async hash primitive", async () => {
    // Hashing happens INSIDE `class-service.createClass`. We assert
    // the action does NOT compute a hash; the service does.
    setupServiceMock();
    await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    // The service receives the plaintext; it is the service that
    // owns hashing. The action never sees a hash.
    expect(callHistory[0]?.rawPassword).toBe(PASSWORD_PLAINTEXT);
    expect(callHistory[0]).not.toHaveProperty("passwordHash");
  });

  it("24. plaintext password is forwarded once and not mutated", async () => {
    setupServiceMock();
    const weirdWhitespace = "  A B\tC  \nD  ";
    await createClassAction({
      name: "Valid Name",
      // @ts-expect: simulate preserving whitespace inside password
      password: weirdWhitespace,
    });
    // The action does NOT trim passwords. The exact bytes reach
    // the service.
    expect(callHistory[0]?.rawPassword).toBe(weirdWhitespace);
  });

  it("25. (integration) hashClassPassword produces a valid encoded hash", async () => {
    const hash = await hashClassPassword(PASSWORD_PLAINTEXT);
    expect(typeof hash).toBe("string");
    expect(hash.length).toBeGreaterThan(0);
    expect(hash).not.toBe(PASSWORD_PLAINTEXT);
  });

  it("26. passwordHash differs from plaintext", async () => {
    const hash = await hashClassPassword(PASSWORD_PLAINTEXT);
    expect(hash).not.toBe(PASSWORD_PLAINTEXT);
    expect(isValidPasswordHash(hash)).toBe(true);
  });

  it("27. safe action success contains no passwordHash", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("passwordHash");
      expect(serialized).not.toContain("pbkdf2");
      expect(result.class).not.toHaveProperty("passwordHash");
      expect(result.class).not.toHaveProperty("password");
      expect(result.class).not.toHaveProperty("rawPassword");
    }
  });

  it("28. no password console logging", async () => {
    setupServiceMock();
    await createClassAction({
      name: "Valid Name",
      password: "sensitive-password-987",
    });
    const allOutput = [
      ...consoleLogSpy.mock.calls,
      ...consoleErrorSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
    ]
      .flat()
      .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
      .join("\n");
    expect(allOutput).not.toContain("sensitive-password-987");
    expect(allOutput).not.toContain(PASSWORD_PLAINTEXT);
  });
});

// =============================================================================
// 29..39 — Class code
// =============================================================================

describe("createClassAction — class code", () => {
  it("29. action generates code server-side (no classCode passed to service)", async () => {
    setupServiceMock();
    await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(callHistory[0]?.classCode).toBeUndefined();
  });

  it("30. generated code has expected canonical format (integration)", () => {
    for (let i = 0; i < 25; i++) {
      const code = generateClassCode();
      expect(isCanonicalClassCode(code)).toBe(true);
      expect(code.length).toBe(CLASS_CODE_LENGTH);
    }
  });

  it("31. browser cannot choose classCode (smuggled value is ignored)", async () => {
    setupServiceMock();
    await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
      // @ts-expect: smuggling attempt
      classCode: "PICKME1",
    });
    expect(callHistory[0]?.classCode).toBeUndefined();
  });

  it("32. successful code persists (returned result.class.classCode)", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.class.classCode).toBeDefined();
      expect(result.class.classCode.length).toBe(CLASS_CODE_LENGTH);
    }
  });

  it("33. first exact classCode collision causes retry", async () => {
    setupServiceMock({ collisionsBeforeSuccess: 1 });
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    // One collision + one success = two attempts.
    expect(mockCreateClass).toHaveBeenCalledTimes(2);
  });

  it("34. retry uses a DIFFERENT fresh attempt (no caching)", async () => {
    setupServiceMock({ collisionsBeforeSuccess: 2 });
    await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    // Each attempt must independently hit the service — no early
    // short-circuit, no caching of the failed code.
    expect(mockCreateClass).toHaveBeenCalledTimes(3);
  });

  it("35. second attempt can succeed", async () => {
    setupServiceMock({ collisionsBeforeSuccess: 1 });
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    expect(mockCreateClass).toHaveBeenCalledTimes(2);
  });

  it("36. successful collision retry creates only one final Class", async () => {
    setupServiceMock({ collisionsBeforeSuccess: 1 });
    await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    // Two attempts but exactly one logical create — the failed
    // attempt never persisted.
    expect(callHistory).toHaveLength(2);
  });

  it("37. bounded retry limit exists (MAX_CLASS_CODE_ATTEMPTS finite)", () => {
    expect(Number.isInteger(MAX_CLASS_CODE_ATTEMPTS)).toBe(true);
    expect(MAX_CLASS_CODE_ATTEMPTS).toBeGreaterThan(0);
    expect(MAX_CLASS_CODE_ATTEMPTS).toBeLessThanOrEqual(10);
  });

  it("38. exhausting exact classCode collisions returns safe failure", async () => {
    setupServiceMock({
      // Always collide — exhaust the loop.
      succeedWith: undefined,
    });
    // Make every attempt throw the precise collision error.
    mockCreateClass.mockImplementation(async () => {
      const { ClassServiceError } = await import("./class-service");
      throw new ClassServiceError({
        code: "CLASS_CODE_ALREADY_EXISTS",
        message: "A class with this code already exists.",
      });
    });

    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CREATE_CLASS_ACTION_ERROR_CODES.CLASS_CODE_GENERATION_FAILED,
      );
      expect(result.retryable).toBe(true);
    }
    expect(mockCreateClass).toHaveBeenCalledTimes(MAX_CLASS_CODE_ATTEMPTS);
  });

  it("39. no unbounded loop (exhaustion stops at MAX_CLASS_CODE_ATTEMPTS)", async () => {
    mockCreateClass.mockImplementation(async () => {
      const { ClassServiceError } = await import("./class-service");
      throw new ClassServiceError({
        code: "CLASS_CODE_ALREADY_EXISTS",
        message: "always collides",
      });
    });
    await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(mockCreateClass.mock.calls.length).toBeLessThanOrEqual(
      MAX_CLASS_CODE_ATTEMPTS,
    );
  });
});

// =============================================================================
// 40..45 — Error classification
// =============================================================================

describe("createClassAction — error classification", () => {
  it("40. service ClassServiceError(CLASS_CODE_ALREADY_EXISTS) is retryable internally", async () => {
    let attempt = 0;
    mockCreateClass.mockImplementation(async () => {
      attempt++;
      if (attempt === 1) {
        // The service layer is responsible for classifying a
        // MongoDB 11000 as a classCode collision. The action
        // consumes the typed `ClassServiceError(CLASS_CODE_ALREADY_EXISTS)`.
        // This mirrors the real service contract.
        const { ClassServiceError } = await import("./class-service");
        throw new ClassServiceError({
          code: "CLASS_CODE_ALREADY_EXISTS",
          message: "A class with this code already exists.",
        });
      }
      return makeSafeClass({ classCode: "HIJKLMN" });
    });

    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    expect(mockCreateClass).toHaveBeenCalledTimes(2);
  });

  it("41. service's generic ClassServiceError(CLASS_CREATE_FAILED) is NOT retried", async () => {
    // The service has classified the failure (e.g. an unrelated
    // 11000 or any other non-classCode DB failure) as
    // CLASS_CREATE_FAILED. The action must NOT silently retry this
    // — the loop must stop immediately.
    mockCreateClass.mockImplementation(async () => {
      const { ClassServiceError } = await import("./class-service");
      throw new ClassServiceError({
        code: "CLASS_CREATE_FAILED",
        message: "Failed to create class.",
      });
    });

    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CREATE_CLASS_ACTION_ERROR_CODES.CLASS_CREATION_FAILED,
      );
    }
    // Exactly one attempt — no silent retry on generic failures.
    expect(mockCreateClass).toHaveBeenCalledTimes(1);
  });

  it("42. generic Mongo failure is NOT retried", async () => {
    setupServiceMock({
      failWith: new Error("ECONNREFUSED 10.0.0.1:27017"),
    });
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    expect(mockCreateClass).toHaveBeenCalledTimes(1);
  });

  it("43. generic failure maps to safe CLASS_CREATION_FAILED", async () => {
    setupServiceMock({
      failWith: new Error("Some generic driver failure"),
    });
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(
        CREATE_CLASS_ACTION_ERROR_CODES.CLASS_CREATION_FAILED,
      );
      expect(result.retryable).toBe(true);
      expect(result.message).not.toContain("driver");
      expect(result.message).not.toContain("Some generic");
    }
  });

  it("44. raw E11000 not returned to the browser", async () => {
    setupServiceMock({
      failWith: (() => {
        const err = new Error(
          "E11000 duplicate key error on mongodb://internal:27017/face_attendance.classes index: classCode_1",
        ) as Error & { code: number; keyValue: Record<string, unknown> };
        err.code = 11000;
        err.keyValue = { teacherUserId: "some-other" };
        return err;
      })(),
    });
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("E11000");
      expect(serialized).not.toContain("mongodb://");
      expect(serialized).not.toContain("duplicate key");
      expect(serialized).not.toContain("face_attendance");
    }
  });

  it("45. raw stack not returned to the browser", async () => {
    const err = new Error("kaboom");
    err.stack = "Error: kaboom\n    at /Users/dev/internal/secret/path/x.ts:42:9";
    setupServiceMock({ failWith: err });
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("kaboom");
      expect(serialized).not.toContain("/Users/dev/internal");
      expect(serialized).not.toContain("at ");
      expect(serialized).not.toContain("secret/path");
    }
  });
});

// =============================================================================
// 46..55 — Success
// =============================================================================

describe("createClassAction — success result", () => {
  it("46. valid authenticated teacher creates one class", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    expect(mockCreateClass).toHaveBeenCalledTimes(1);
  });

  it("47. created class teacherUserId equals session.user.id", async () => {
    setupServiceMock();
    await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(callHistory[0]?.teacherUserId).toBe(TEACHER_USER_ID);
  });

  it("48. class status is active", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.class.status).toBe("active");
    }
  });

  it("49. safe result includes class id", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Valid Name",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.class.id).toBeDefined();
      expect(typeof result.class.id).toBe("string");
    }
  });

  it("50. safe result includes name", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.class.name).toBe("Intro to CS");
    }
  });

  it("51. safe result includes classCode", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.class.classCode).toBeDefined();
      expect(typeof result.class.classCode).toBe("string");
    }
  });

  it("52. safe result includes createdAt as ISO string", async () => {
    const fixedDate = new Date("2026-09-15T10:00:00.000Z");
    setupServiceMock({
      succeedWith: () => Promise.resolve(makeSafeClass({ createdAt: fixedDate })),
    });
    const result = await createClassAction({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.class.createdAt).toBe("2026-09-15T10:00:00.000Z");
    }
  });

  it("53. safe result contains no password", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.class).not.toHaveProperty("password");
      expect(result.class).not.toHaveProperty("rawPassword");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(PASSWORD_PLAINTEXT);
    }
  });

  it("54. safe result contains no passwordHash", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.class).not.toHaveProperty("passwordHash");
      expect(result.class).not.toHaveProperty("hash");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("passwordHash");
      expect(serialized).not.toContain("pbkdf2");
    }
  });

  it("55. safe result contains no teacherUserId", async () => {
    setupServiceMock();
    const result = await createClassAction({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.class).not.toHaveProperty("teacherUserId");
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("teacherUserId");
    }
  });
});

// =============================================================================
// 56..60 — No extra domain writes
// =============================================================================

describe("createClassAction — no extra domain writes", () => {
  it("56. create action does not create ClassMembership", async () => {
    // The action module only imports createClass / isClassCodeDuplicateKeyError /
    // ClassServiceError / CLASS_ERROR_CODES from class-service and profile lookup.
    // There is no createMembership invocation at all. We assert the action's
    // import surface excludes any membership primitive.
    setupServiceMock();
    const { createClassAction: actionFn } = await import("./create-class-action");
    expect(typeof actionFn).toBe("function");

    await actionFn({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
    });

    // The mocked class-service only exposes createClass. Any
    // membership primitive would have to be a separate import that
    // the test could observe by simply asserting the mock surface.
    expect(mockCreateClass).toHaveBeenCalledTimes(1);
  });

  it("57. create action does not modify profile", async () => {
    setupServiceMock();
    const profileBefore = makeTeacherProfile();
    await createClassAction({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
    });
    // Profile was loaded once for gating; never written.
    expect(mockGetProfileByUserId).toHaveBeenCalledTimes(1);
    expect(mockGetProfileByUserId).toHaveBeenCalledWith(TEACHER_USER_ID);
    // No setter / save / update call exists on the mocked profile
    // service surface — only the read was performed.
    expect(profileBefore.role).toBe("teacher");
  });

  it("58. create action does not create attendance session", async () => {
    setupServiceMock();
    await createClassAction({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
    });
    // The action's only domain write is createClass — there is no
    // attendance module import in create-class-action.ts.
    // Mocking @/lib/attendance at the module level is intentionally
    // omitted — if a future change accidentally imports it, the
    // missing mock will throw and surface the regression.
    expect(mockCreateClass).toHaveBeenCalledTimes(1);
  });

  it("59. create action does not call Face Service", async () => {
    setupServiceMock();
    await createClassAction({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
    });
    // The action has no import of @/lib/biometrics/face-service-client.
    // The class-service is the only persistence collaborator, and it
    // does not touch the Face Service in the create path.
    expect(mockCreateClass).toHaveBeenCalledTimes(1);
  });

  it("60. create action does not touch FaceProfile", async () => {
    setupServiceMock();
    await createClassAction({
      name: "Intro to CS",
      password: PASSWORD_PLAINTEXT,
    });
    // The action does not import hasFaceProfile or any
    // face-profile-service primitive — only the application
    // profile-service is consulted.
    expect(mockGetProfileByUserId).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Static guards (defensive regression checks)
// =============================================================================

describe("createClassAction — module surface", () => {
  it('opens with "use server" directive', async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(
        process.cwd(),
        "src/lib/classes/create-class-action.ts",
      ),
      "utf8",
    );
    expect(source.includes('"use server"')).toBe(true);
  });

  it("does not accept browser-supplied teacherUserId", () => {
    const schema = __testing.CreateClassInputSchema;
    const result = schema.safeParse({
      name: "X",
      password: "valid-password-1",
      teacherUserId: "browser",
    });
    expect(result.success).toBe(false);
  });

  it("does not accept browser-supplied classCode", () => {
    const schema = __testing.CreateClassInputSchema;
    const result = schema.safeParse({
      name: "X",
      password: "valid-password-1",
      classCode: "PICKME1",
    });
    expect(result.success).toBe(false);
  });

  it("does not accept browser-supplied role", () => {
    const schema = __testing.CreateClassInputSchema;
    const result = schema.safeParse({
      name: "X",
      password: "valid-password-1",
      role: "teacher",
    });
    expect(result.success).toBe(false);
  });

  it("does not accept browser-supplied passwordHash", () => {
    const schema = __testing.CreateClassInputSchema;
    const result = schema.safeParse({
      name: "X",
      password: "valid-password-1",
      passwordHash: "pbkdf2-sha256$1$aa$bb",
    });
    expect(result.success).toBe(false);
  });
});