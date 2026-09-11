/**
 * Unit tests for the Face Service HTTP Client.
 *
 * PHASE 4.4A — Server-only client for FastAPI Face Service communication.
 *
 * These tests mock global fetch and do NOT depend on the real Face Service.
 * They use fake secrets and do NOT read or print real .env.local credentials.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// =============================================================================
// Test Constants
// =============================================================================

/** Fake Face Service URL for testing. */
const FAKE_FACE_SERVICE_URL = "http://127.0.0.1:8001";

/** Fake secret for testing. */
const FAKE_SECRET = "fake-service-secret-for-testing";

/** A valid 512-D embedding fixture. */
function createValidEmbedding(): number[] {
  const embedding: number[] = [];
  for (let i = 0; i < 512; i++) {
    embedding.push(Math.sin(i * 0.1) * 0.5);
  }
  return embedding;
}

// =============================================================================
// Mock Helpers
// =============================================================================

/**
 * Creates a mock Response for a successful JSON response.
 */
function mockJsonResponse(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

/**
 * Creates a mock Response for an error with JSON body.
 */
function mockErrorResponse(
  status: number,
  code: string,
  message: string,
  init: ResponseInit = {},
): Response {
  return mockJsonResponse(
    { error: { code, message } },
    { status, ...init },
  );
}

/**
 * Creates a mock Response for invalid JSON.
 */
function mockInvalidJsonResponse(status = 200): Response {
  return new Response("not valid json {{{", {
    status,
    headers: { "Content-Type": "text/plain" },
  });
}

// =============================================================================
// Setup / Teardown
// =============================================================================

let mockFetch: ReturnType<typeof vi.fn>;

// =============================================================================
// Tests - Import constants for assertions
// =============================================================================

import { FACE_SERVICE_ERROR_CODES } from "@/lib/biometrics/face-service-client";

// =============================================================================
// URL Construction Tests
// =============================================================================

describe("URL construction", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("constructs /health URL correctly", async () => {
    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));

    const { getFaceServiceHealth: health } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        status: "ok",
        engine: "insightface",
        model: "buffalo_l",
        provider: "CPUExecutionProvider",
        ready: true,
        embedding_dimension: 512,
      }),
    );

    await health();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe(`${FAKE_FACE_SERVICE_URL}/health`);
  });

  it("handles URL without trailing slash", async () => {
    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: "http://127.0.0.1:8001",
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));

    const { getFaceServiceHealth: health } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        status: "ok",
        engine: "insightface",
        model: "buffalo_l",
        provider: "CPUExecutionProvider",
        ready: true,
        embedding_dimension: 512,
      }),
    );

    await health();

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8001/health");
  });

  it("handles URL with trailing slash (normalizes it)", async () => {
    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: "http://127.0.0.1:8001/",
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));

    const { getFaceServiceHealth: health } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        status: "ok",
        engine: "insightface",
        model: "buffalo_l",
        provider: "CPUExecutionProvider",
        ready: true,
        embedding_dimension: 512,
      }),
    );

    await health();

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:8001/health");
  });

  it("avoids double slash in URL", async () => {
    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));

    const { getFaceServiceHealth: health } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        status: "ok",
        engine: "insightface",
        model: "buffalo_l",
        provider: "CPUExecutionProvider",
        ready: true,
        embedding_dimension: 512,
      }),
    );

    await health();

    const [url] = mockFetch.mock.calls[0]!;
    expect(url).not.toContain("//health");
  });
});

// =============================================================================
// Health Response Tests
// =============================================================================

describe("getFaceServiceHealth", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns typed valid response", async () => {
    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));

    const { getFaceServiceHealth: health } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const healthResponse = {
      status: "ok",
      engine: "insightface",
      model: "buffalo_l",
      provider: "CPUExecutionProvider",
      ready: true,
      embedding_dimension: 512,
    };

    mockFetch.mockResolvedValueOnce(mockJsonResponse(healthResponse));

    const result = await health();

    expect(result).toEqual(healthResponse);
    expect(result.ready).toBe(true);
    expect(result.embedding_dimension).toBe(512);
  });

  it("handles ready=false as valid health response", async () => {
    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));

    const { getFaceServiceHealth: health } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const healthResponse = {
      status: "degraded",
      engine: "insightface",
      model: "buffalo_l",
      provider: "CPUExecutionProvider",
      ready: false,
      embedding_dimension: null,
    };

    mockFetch.mockResolvedValueOnce(mockJsonResponse(healthResponse));

    const result = await health();

    expect(result.ready).toBe(false);
    expect(result.embedding_dimension).toBeNull();
  });

  it("handles error_code and error_message", async () => {
    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));

    const { getFaceServiceHealth: health } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const healthResponse = {
      status: "degraded",
      engine: "insightface",
      model: null,
      provider: null,
      ready: false,
      embedding_dimension: null,
      error_code: "MODEL_LOAD_FAILED",
      error_message: "Failed to load model",
    };

    mockFetch.mockResolvedValueOnce(mockJsonResponse(healthResponse));

    const result = await health();

    expect(result.error_code).toBe("MODEL_LOAD_FAILED");
    expect(result.error_message).toBe("Failed to load model");
  });
});

// =============================================================================
// Missing Configuration Tests
// =============================================================================

describe("missing configuration", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails safely when FACE_SERVICE_URL is missing", async () => {
    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: undefined,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));

    const { getFaceServiceHealth: health } = await import(
      "@/lib/biometrics/face-service-client"
    );

    try {
      await health();
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_NOT_CONFIGURED,
      );
    }

    // fetch should not be called
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("fails safely when FACE_SERVICE_SECRET is missing for protected endpoint", async () => {
    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: undefined,
      },
    }));

    const { analyzeEnrollmentSample: sample } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const fakeImage = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]);

    try {
      await sample(fakeImage, "image/jpeg");
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_NOT_CONFIGURED,
      );
    }

    // fetch should not be called
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Enrollment Sample Tests
// =============================================================================

describe("analyzeEnrollmentSample", () => {
  const validEmbedding = createValidEmbedding();

  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    vi.resetModules();

    // Default mock
    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("POST request", () => {
    it("sends POST request to enrollment/sample endpoint", async () => {
      const { analyzeEnrollmentSample: sample } = await import(
        "@/lib/biometrics/face-service-client"
      );

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          accepted: true,
          quality: {
            detection_score: 0.95,
            face_width: 120,
            face_height: 120,
            relative_face_area: 0.06,
            blur_score: 400,
            brightness: 0.5,
            near_edge: false,
          },
          embedding: validEmbedding,
          rejection_reasons: [],
          model: {
            identity: "insightface-buffalo-l",
            name: "buffalo_l",
            embedding_dimension: 512,
            normalization: "l2",
          },
          processing_ms: 165.1,
        }),
      );

      await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, options] = mockFetch.mock.calls[0]!;

      expect(url).toBe(
        `${FAKE_FACE_SERVICE_URL}/v1/faces/enrollment/sample`,
      );
      expect(options.method).toBe("POST");
    });

    it("sends multipart image data", async () => {
      const { analyzeEnrollmentSample: sample } = await import(
        "@/lib/biometrics/face-service-client"
      );

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          accepted: true,
          quality: {
            detection_score: 0.95,
            face_width: 120,
            face_height: 120,
            relative_face_area: 0.06,
            blur_score: 400,
            brightness: 0.5,
            near_edge: false,
          },
          embedding: validEmbedding,
          rejection_reasons: [],
          model: {
            identity: "insightface-buffalo-l",
            name: "buffalo_l",
            embedding_dimension: 512,
            normalization: "l2",
          },
          processing_ms: 165.1,
        }),
      );

      const imageData = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]);
      await sample(imageData, "image/jpeg");

      const [, options] = mockFetch.mock.calls[0]!;
      expect(options.body).toBeDefined();
    });

    it("sends X-Service-Token header", async () => {
      const { analyzeEnrollmentSample: sample } = await import(
        "@/lib/biometrics/face-service-client"
      );

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          accepted: true,
          quality: {
            detection_score: 0.95,
            face_width: 120,
            face_height: 120,
            relative_face_area: 0.06,
            blur_score: 400,
            brightness: 0.5,
            near_edge: false,
          },
          embedding: validEmbedding,
          rejection_reasons: [],
          model: {
            identity: "insightface-buffalo-l",
            name: "buffalo_l",
            embedding_dimension: 512,
            normalization: "l2",
          },
          processing_ms: 165.1,
        }),
      );

      await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");

      const [, options] = mockFetch.mock.calls[0]!;
      expect(options.headers).toHaveProperty(
        "X-Service-Token",
        FAKE_SECRET,
      );
    });
  });

  describe("accepted response", () => {
    it("parses accepted response correctly", async () => {
      const { analyzeEnrollmentSample: sample } = await import(
        "@/lib/biometrics/face-service-client"
      );

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          accepted: true,
          quality: {
            detection_score: 0.95,
            face_width: 120,
            face_height: 120,
            relative_face_area: 0.06,
            blur_score: 400,
            brightness: 0.5,
            near_edge: false,
          },
          embedding: validEmbedding,
          rejection_reasons: [],
          model: {
            identity: "insightface-buffalo-l",
            name: "buffalo_l",
            embedding_dimension: 512,
            normalization: "l2",
          },
          processing_ms: 165.1,
        }),
      );

      const result = await sample(
        new Uint8Array([0xFF, 0xD8, 0xFF]),
        "image/jpeg",
      );

      expect(result.accepted).toBe(true);
      expect(result.embedding).toHaveLength(512);
      expect(result.model?.identity).toBe("insightface-buffalo-l");
    });

    it("validates embedding dimension matches model", async () => {
      const { analyzeEnrollmentSample: sample } = await import(
        "@/lib/biometrics/face-service-client"
      );

      // Return wrong dimension
      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          accepted: true,
          quality: {
            detection_score: 0.95,
            face_width: 120,
            face_height: 120,
            relative_face_area: 0.06,
            blur_score: 400,
            brightness: 0.5,
            near_edge: false,
          },
          embedding: createValidEmbedding(),
          rejection_reasons: [],
          model: {
            identity: "insightface-buffalo-l",
            name: "buffalo_l",
            embedding_dimension: 256, // Wrong dimension!
            normalization: "l2",
          },
          processing_ms: 165.1,
        }),
      );

      try {
        await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect((error as { code: string }).code).toBe(
          FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        );
        expect((error as { message: string }).message).toContain(
          "dimension mismatch",
        );
      }
    });

    it("rejects non-finite embedding values", async () => {
      const { analyzeEnrollmentSample: sample } = await import(
        "@/lib/biometrics/face-service-client"
      );

      const badEmbedding = [...createValidEmbedding()];
      badEmbedding[0] = NaN; // Inject NaN

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          accepted: true,
          quality: {
            detection_score: 0.95,
            face_width: 120,
            face_height: 120,
            relative_face_area: 0.06,
            blur_score: 400,
            brightness: 0.5,
            near_edge: false,
          },
          embedding: badEmbedding,
          rejection_reasons: [],
          model: {
            identity: "insightface-buffalo-l",
            name: "buffalo_l",
            embedding_dimension: 512,
            normalization: "l2",
          },
          processing_ms: 165.1,
        }),
      );

      try {
        await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");
        expect.fail("Should have thrown an error");
      } catch (error) {
        // Zod catches NaN (serialized as null) before our validation
        expect((error as { code: string }).code).toBe(
          FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        );
        // Message comes from Zod schema validation
        expect((error as { message: string }).message).toBeTruthy();
      }
    });

    it("rejects wrong normalization", async () => {
      const { analyzeEnrollmentSample: sample } = await import(
        "@/lib/biometrics/face-service-client"
      );

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          accepted: true,
          quality: {
            detection_score: 0.95,
            face_width: 120,
            face_height: 120,
            relative_face_area: 0.06,
            blur_score: 400,
            brightness: 0.5,
            near_edge: false,
          },
          embedding: createValidEmbedding(),
          rejection_reasons: [],
          model: {
            identity: "insightface-buffalo-l",
            name: "buffalo_l",
            embedding_dimension: 512,
            normalization: "cosine", // Wrong normalization!
          },
          processing_ms: 165.1,
        }),
      );

      try {
        await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect((error as { code: string }).code).toBe(
          FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        );
        expect((error as { message: string }).message).toContain(
          "normalization",
        );
      }
    });
  });

  describe("rejected response", () => {
    it("parses rejected response correctly", async () => {
      const { analyzeEnrollmentSample: sample } = await import(
        "@/lib/biometrics/face-service-client"
      );

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          accepted: false,
          quality: {
            detection_score: 0.95,
            face_width: 120,
            face_height: 120,
            relative_face_area: 0.06,
            blur_score: 400,
            brightness: 0.5,
            near_edge: false,
          },
          embedding: null,
          rejection_reasons: ["TOO_BLURRY"],
          model: null,
          processing_ms: 80.2,
        }),
      );

      const result = await sample(
        new Uint8Array([0xFF, 0xD8, 0xFF]),
        "image/jpeg",
      );

      expect(result.accepted).toBe(false);
      expect(result.embedding).toBeNull();
      expect(result.rejection_reasons).toContain("TOO_BLURRY");
    });

    it("accepts embedding=null on rejected response (current contract)", async () => {
      const { analyzeEnrollmentSample: sample } = await import(
        "@/lib/biometrics/face-service-client"
      );

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          accepted: false,
          quality: {
            detection_score: 0.5,
            face_width: 80,
            face_height: 80,
            relative_face_area: 0.01,
            blur_score: 30,
            brightness: 0.2,
            near_edge: false,
          },
          embedding: null,
          rejection_reasons: ["LOW_DETECTION_CONFIDENCE", "FACE_TOO_SMALL"],
          model: null,
          processing_ms: 60.0,
        }),
      );

      const result = await sample(
        new Uint8Array([0xFF, 0xD8, 0xFF]),
        "image/jpeg",
      );

      expect(result.accepted).toBe(false);
      expect(result.embedding).toBeNull();
      expect(result.rejection_reasons).toHaveLength(2);
    });

    it("rejects rejected response that contains embedding", async () => {
      const { analyzeEnrollmentSample: sample } = await import(
        "@/lib/biometrics/face-service-client"
      );

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({
          accepted: false,
          quality: {
            detection_score: 0.5,
            face_width: 80,
            face_height: 80,
            relative_face_area: 0.01,
            blur_score: 30,
            brightness: 0.2,
            near_edge: false,
          },
          embedding: validEmbedding, // Should be null!
          rejection_reasons: ["LOW_DETECTION_CONFIDENCE"],
          model: null,
          processing_ms: 60.0,
        }),
      );

      try {
        await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");
        expect.fail("Should have thrown an error");
      } catch (error) {
        // Zod catches this because rejected schema expects embedding: z.null()
        expect((error as { code: string }).code).toBe(
          FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        );
        // Message comes from Zod schema validation
        expect((error as { message: string }).message).toBeTruthy();
      }
    });
  });
});

// =============================================================================
// HTTP Error Mapping Tests
// =============================================================================

describe("HTTP error mapping", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    vi.resetModules();

    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("HTTP 401", () => {
    it("maps 401 to FACE_SERVICE_UNAUTHORIZED", async () => {
      const { analyzeEnrollmentSample: sample } = await import(
        "@/lib/biometrics/face-service-client"
      );

      mockFetch.mockResolvedValueOnce(
        mockErrorResponse(
          401,
          "FACE_SERVICE_UNAUTHORIZED",
          "Invalid service token",
        ),
      );

      try {
        await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect((error as { code: string }).code).toBe(
          FACE_SERVICE_ERROR_CODES.FACE_SERVICE_UNAUTHORIZED,
        );
      }
    });
  });

  describe("domain errors", () => {
    it("preserves NO_FACE error", async () => {
      const { analyzeEnrollmentSample: sample } = await import(
        "@/lib/biometrics/face-service-client"
      );

      mockFetch.mockResolvedValueOnce(
        mockErrorResponse(
          422,
          "NO_FACE",
          "No face detected in the image",
        ),
      );

      try {
        await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect((error as { code: string }).code).toBe(
          FACE_SERVICE_ERROR_CODES.FACE_SERVICE_REJECTED_REQUEST,
        );
        expect(
          (error as { domainError?: { code: string } }).domainError?.code,
        ).toBe("NO_FACE");
      }
    });

    it("preserves MULTIPLE_FACES error", async () => {
      const { analyzeEnrollmentSample: sample } = await import(
        "@/lib/biometrics/face-service-client"
      );

      mockFetch.mockResolvedValueOnce(
        mockErrorResponse(
          422,
          "MULTIPLE_FACES",
          "Multiple faces detected, exactly one required",
        ),
      );

      try {
        await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect((error as { code: string }).code).toBe(
          FACE_SERVICE_ERROR_CODES.FACE_SERVICE_REJECTED_REQUEST,
        );
        expect(
          (error as { domainError?: { code: string } }).domainError?.code,
        ).toBe("MULTIPLE_FACES");
      }
    });
  });

  describe("invalid JSON", () => {
    it("maps invalid JSON to FACE_SERVICE_INVALID_RESPONSE", async () => {
      const { analyzeEnrollmentSample: sample } = await import(
        "@/lib/biometrics/face-service-client"
      );

      mockFetch.mockResolvedValueOnce(mockInvalidJsonResponse());

      try {
        await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect((error as { code: string }).code).toBe(
          FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        );
      }
    });
  });

  describe("malformed success response", () => {
    it("rejects malformed success response", async () => {
      const { analyzeEnrollmentSample: sample } = await import(
        "@/lib/biometrics/face-service-client"
      );

      mockFetch.mockResolvedValueOnce(
        mockJsonResponse({ status: "ok" }),
      ); // Missing required fields

      try {
        await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");
        expect.fail("Should have thrown an error");
      } catch (error) {
        expect((error as { code: string }).code).toBe(
          FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
        );
      }
    });
  });
});

// =============================================================================
// Network Failure Tests
// =============================================================================

describe("network failures", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    vi.resetModules();

    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps network failure to FACE_SERVICE_UNAVAILABLE", async () => {
    const { analyzeEnrollmentSample: sample } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

    try {
      await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_UNAVAILABLE,
      );
    }
  });
});

// =============================================================================
// Timeout Tests
// =============================================================================

describe("timeout handling", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    vi.resetModules();

    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps timeout to FACE_SERVICE_TIMEOUT", async () => {
    const { analyzeEnrollmentSample: sample } = await import(
      "@/lib/biometrics/face-service-client"
    );

    // Mock AbortError by rejecting with an Error with name "AbortError"
    mockFetch.mockImplementationOnce(() => {
      return new Promise<Response>((_, reject) => {
        setTimeout(() => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        }, 10); // Short timeout for test
      });
    });

    try {
      await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");
      expect.fail("Should have thrown an error");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_TIMEOUT,
      );
      expect((error as { message: string }).message).toContain("timed out");
    }
  });
});

// =============================================================================
// No Automatic Retry Tests
// =============================================================================

describe("no automatic retry", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    vi.resetModules();

    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not automatically retry enrollment POST", async () => {
    const { analyzeEnrollmentSample: sample } = await import(
      "@/lib/biometrics/face-service-client"
    );

    // Return an error response (not a network error that might trigger retry)
    mockFetch.mockResolvedValueOnce(
      mockErrorResponse(
        422,
        "MULTIPLE_FACES",
        "Multiple faces detected",
      ),
    );

    try {
      await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");
    } catch {
      // Expected
    }

    // Should only be called once - no retry
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not retry on network failure", async () => {
    const { analyzeEnrollmentSample: sample } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockRejectedValue(new TypeError("Failed to fetch"));

    try {
      await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");
    } catch {
      // Expected
    }

    // Should only be called once - no retry
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Security Tests
// =============================================================================

describe("security", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    vi.resetModules();

    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("secret never appears in safe error messages", async () => {
    const { analyzeEnrollmentSample: sample } = await import(
      "@/lib/biometrics/face-service-client"
    );

    // Test with a 401 error - the secret should not be exposed
    mockFetch.mockResolvedValueOnce(
      mockErrorResponse(
        401,
        "FACE_SERVICE_UNAUTHORIZED",
        "Invalid service token",
      ),
    );

    try {
      await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");
    } catch (error) {
      const errorMessage = (error as { message: string }).message;
      // Secret should not appear in error message
      expect(errorMessage).not.toContain(FAKE_SECRET);
      expect(errorMessage).not.toContain(
        "bwxOx3Mx9YBOkWKBAk1AkdE2m01wOdFRLu1E85GWN5M=",
      );
    }
  });

  it("embedding never appears in error messages", async () => {
    const { analyzeEnrollmentSample: sample } = await import(
      "@/lib/biometrics/face-service-client"
    );

    // First test an accepted response
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        accepted: true,
        quality: {
          detection_score: 0.95,
          face_width: 120,
          face_height: 120,
          relative_face_area: 0.06,
          blur_score: 400,
          brightness: 0.5,
          near_edge: false,
        },
        embedding: createValidEmbedding(),
        rejection_reasons: [],
        model: {
          identity: "insightface-buffalo-l",
          name: "buffalo_l",
          embedding_dimension: 512,
          normalization: "l2",
        },
        processing_ms: 165.1,
      }),
    );

    const result = await sample(
      new Uint8Array([0xFF, 0xD8, 0xFF]),
      "image/jpeg",
    );

    expect(result.accepted).toBe(true);

    // Now test an error path - dimension mismatch
    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        accepted: true,
        quality: {
          detection_score: 0.95,
          face_width: 120,
          face_height: 120,
          relative_face_area: 0.06,
          blur_score: 400,
          brightness: 0.5,
          near_edge: false,
        },
        embedding: createValidEmbedding(),
        rejection_reasons: [],
        model: {
          identity: "insightface-buffalo-l",
          name: "buffalo_l",
          embedding_dimension: 256, // Wrong!
          normalization: "l2",
        },
        processing_ms: 165.1,
      }),
    );

    try {
      await sample(new Uint8Array([0xFF, 0xD8, 0xFF]), "image/jpeg");
    } catch (error) {
      const errorMessage = (error as { message: string }).message;
      // Embedding values should not appear in error message
      expect(errorMessage).not.toContain("[");
      expect(errorMessage).not.toContain("0.5");
    }
  });
});

// =============================================================================
// Type Tests
// =============================================================================

describe("types", () => {
  it("FACE_SERVICE_ERROR_CODES has all expected codes", () => {
    const expectedCodes = [
      "FACE_SERVICE_NOT_CONFIGURED",
      "FACE_SERVICE_UNAVAILABLE",
      "FACE_SERVICE_TIMEOUT",
      "FACE_SERVICE_UNAUTHORIZED",
      "FACE_SERVICE_INVALID_RESPONSE",
      "FACE_SERVICE_REJECTED_REQUEST",
    ] as const;

    expectedCodes.forEach((code) => {
      expect(FACE_SERVICE_ERROR_CODES).toHaveProperty(code);
      expect(FACE_SERVICE_ERROR_CODES[code]).toBe(code);
    });
  });
});

// =============================================================================
// Enrollment Finalization (PHASE 4.6B1A)
// =============================================================================

import {
  finalizeFaceEnrollment,
  FINALIZATION_ERROR_CODES,
} from "@/lib/biometrics/face-service-client";

const FINALIZE_MODEL = {
  identity: "insightface-buffalo-l",
  name: "buffalo_l",
  embeddingDimension: 512,
  normalization: "l2",
} as const;

/** Builds a deterministic, L2-normalised embedding of the given dimension. */
function buildNormalizedEmbedding(dimension: number, seed: number): number[] {
  const raw: number[] = [];
  let sumSquares = 0;
  for (let i = 0; i < dimension; i++) {
    const v = Math.sin(seed * 0.1 + i * 0.013) * 0.5 + 0.001 * i;
    raw.push(v);
    sumSquares += v * v;
  }
  const norm = Math.sqrt(sumSquares) || 1;
  return raw.map((v) => v / norm);
}

/** Builds a finalized-success response body (consistent=true, valid centroid). */
function buildFinalizeSuccessBody(): {
  consistent: true;
  sample_count: number;
  pair_count: number;
  min_self_similarity: number;
  mean_self_similarity: number;
  threshold: number;
  centroid: number[];
  model: {
    identity: string;
    name: string;
    embedding_dimension: number;
    normalization: string;
  };
} {
  const centroid = buildNormalizedEmbedding(512, 7);
  return {
    consistent: true,
    sample_count: 5,
    pair_count: 10,
    min_self_similarity: 0.82,
    mean_self_similarity: 0.87,
    threshold: 0.7,
    centroid,
    model: {
      identity: FINALIZE_MODEL.identity,
      name: FINALIZE_MODEL.name,
      embedding_dimension: FINALIZE_MODEL.embeddingDimension,
      normalization: FINALIZE_MODEL.normalization,
    },
  };
}

/** Builds a default valid finalize input with `n` samples. */
function buildFinalizeInput(sampleCount = 5) {
  return {
    model: { ...FINALIZE_MODEL },
    requiredSampleCount: sampleCount,
    embeddings: Array.from({ length: sampleCount }, (_, i) =>
      buildNormalizedEmbedding(512, i + 1),
    ),
  };
}

describe("finalizeFaceEnrollment — request shape", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    vi.resetModules();

    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends POST to /v1/faces/enrollment/finalize", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(mockJsonResponse(buildFinalizeSuccessBody()));

    await finalize(buildFinalizeInput());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0]!;
    expect(url).toBe(`${FAKE_FACE_SERVICE_URL}/v1/faces/enrollment/finalize`);
    expect(options.method).toBe("POST");
  });

  it("sends X-Service-Token header using existing auth mechanism", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(mockJsonResponse(buildFinalizeSuccessBody()));

    await finalize(buildFinalizeInput());

    const [, options] = mockFetch.mock.calls[0]!;
    expect(options.headers).toHaveProperty("X-Service-Token", FAKE_SECRET);
  });

  it("sends Content-Type: application/json", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(mockJsonResponse(buildFinalizeSuccessBody()));

    await finalize(buildFinalizeInput());

    const [, options] = mockFetch.mock.calls[0]!;
    expect((options.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("sends exactly the requested number of embeddings", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(mockJsonResponse(buildFinalizeSuccessBody()));

    const input = buildFinalizeInput(5);
    await finalize(input);

    const [, options] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(options.body as string);
    expect(body.embeddings).toHaveLength(5);
  });

  it("sends runtime model metadata", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(mockJsonResponse(buildFinalizeSuccessBody()));

    await finalize(buildFinalizeInput());

    const [, options] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(options.body as string);
    expect(body.model).toEqual({
      identity: FINALIZE_MODEL.identity,
      name: FINALIZE_MODEL.name,
      embedding_dimension: FINALIZE_MODEL.embeddingDimension,
      normalization: FINALIZE_MODEL.normalization,
    });
  });

  it("sends required_sample_count", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(mockJsonResponse(buildFinalizeSuccessBody()));

    await finalize(buildFinalizeInput(7));

    const [, options] = mockFetch.mock.calls[0]!;
    const body = JSON.parse(options.body as string);
    expect(body.required_sample_count).toBe(7);
  });

  it("sends no userId", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(mockJsonResponse(buildFinalizeSuccessBody()));

    await finalize(buildFinalizeInput());

    const [, options] = mockFetch.mock.calls[0]!;
    const bodyStr = options.body as string;
    expect(bodyStr).not.toContain("userId");
    expect(bodyStr).not.toContain("user_id");
    expect(bodyStr).not.toContain("userid");
  });

  it("sends no generationId", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(mockJsonResponse(buildFinalizeSuccessBody()));

    await finalize(buildFinalizeInput());

    const [, options] = mockFetch.mock.calls[0]!;
    const bodyStr = options.body as string;
    expect(bodyStr).not.toContain("generationId");
    expect(bodyStr).not.toContain("generation_id");
  });

  it("sends no MongoDB id", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(mockJsonResponse(buildFinalizeSuccessBody()));

    await finalize(buildFinalizeInput());

    const [, options] = mockFetch.mock.calls[0]!;
    const bodyStr = options.body as string;
    expect(bodyStr).not.toContain("_id");
    expect(bodyStr).not.toContain("ObjectId");
    expect(bodyStr).not.toContain("$oid");
  });

  it("fires exactly one fetch per client invocation", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(mockJsonResponse(buildFinalizeSuccessBody()));

    await finalize(buildFinalizeInput());

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not automatically retry on transport failure", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    try {
      await finalize(buildFinalizeInput());
    } catch {
      // Expected
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not automatically retry on domain rejection", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(
      mockErrorResponse(
        422,
        FINALIZATION_ERROR_CODES.INCONSISTENT_FACE_SAMPLES,
        "Enrollment batch is internally inconsistent.",
      ),
    );

    try {
      await finalize(buildFinalizeInput());
    } catch {
      // Expected
    }

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe("finalizeFaceEnrollment — input validation", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    vi.resetModules();

    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects requiredSampleCount < 2 before fetch", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    try {
      await finalize(buildFinalizeInput(1));
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects requiredSampleCount = 0 before fetch", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    try {
      await finalize(buildFinalizeInput(0));
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects empty embeddings list before fetch", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const input = {
      model: { ...FINALIZE_MODEL },
      requiredSampleCount: 2,
      embeddings: [] as number[][],
    };

    try {
      await finalize(input);
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects embedding count mismatch before fetch", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const input = {
      model: { ...FINALIZE_MODEL },
      requiredSampleCount: 5,
      embeddings: [
        buildNormalizedEmbedding(512, 1),
        buildNormalizedEmbedding(512, 2),
        buildNormalizedEmbedding(512, 3),
      ],
    };

    try {
      await finalize(input);
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects mixed embedding dimensions before fetch", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const input = {
      model: { ...FINALIZE_MODEL },
      requiredSampleCount: 2,
      embeddings: [
        buildNormalizedEmbedding(512, 1),
        buildNormalizedEmbedding(128, 2),
      ],
    };

    try {
      await finalize(input);
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects NaN in embedding vector before fetch", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const emb = buildNormalizedEmbedding(512, 1);
    emb[10] = Number.NaN;

    const input = {
      model: { ...FINALIZE_MODEL },
      requiredSampleCount: 2,
      embeddings: [emb, buildNormalizedEmbedding(512, 2)],
    };

    try {
      await finalize(input);
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects Infinity in embedding vector before fetch", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const emb = buildNormalizedEmbedding(512, 1);
    emb[5] = Number.POSITIVE_INFINITY;

    const input = {
      model: { ...FINALIZE_MODEL },
      requiredSampleCount: 2,
      embeddings: [emb, buildNormalizedEmbedding(512, 2)],
    };

    try {
      await finalize(input);
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects embedding dimension != metadata dimension before fetch", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const input = {
      model: { ...FINALIZE_MODEL, embeddingDimension: 512 },
      requiredSampleCount: 2,
      embeddings: [
        buildNormalizedEmbedding(256, 1),
        buildNormalizedEmbedding(256, 2),
      ],
    };

    try {
      await finalize(input);
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported normalization before fetch", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const input = {
      model: { ...FINALIZE_MODEL, normalization: "cosine" },
      requiredSampleCount: 2,
      embeddings: [
        buildNormalizedEmbedding(512, 1),
        buildNormalizedEmbedding(512, 2),
      ],
    };

    try {
      await finalize(input);
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }

    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("finalizeFaceEnrollment — success path", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    vi.resetModules();

    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses a valid A2 success response", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(mockJsonResponse(buildFinalizeSuccessBody()));

    const result = await finalize(buildFinalizeInput());

    expect(result.consistent).toBe(true);
    expect(result.sampleCount).toBe(5);
    expect(result.pairCount).toBe(10);
    expect(result.minSelfSimilarity).toBe(0.82);
    expect(result.meanSelfSimilarity).toBe(0.87);
    expect(result.threshold).toBe(0.7);
  });

  it("returns the centroid", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    const result = await finalize(buildFinalizeInput());

    expect(result.centroid).toHaveLength(512);
    expect(result.centroid).toEqual(success.centroid);
  });

  it("validates centroid values are finite", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    success.centroid[0] = Number.NaN;
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });

  it("validates centroid dimension", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    success.centroid = buildNormalizedEmbedding(256, 9);
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });

  it("validates centroid is L2-normalised", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    // Double the centroid magnitude to push norm to ~2.
    success.centroid = success.centroid.map((v) => v * 2);
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });

  it("parses pair_count", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    success.pair_count = 21;
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    const result = await finalize(buildFinalizeInput(7));
    expect(result.pairCount).toBe(21);
  });

  it("parses min_self_similarity", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    success.min_self_similarity = 0.5;
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    const result = await finalize(buildFinalizeInput());
    expect(result.minSelfSimilarity).toBe(0.5);
  });

  it("parses mean_self_similarity", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    success.mean_self_similarity = 0.9;
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    const result = await finalize(buildFinalizeInput());
    expect(result.meanSelfSimilarity).toBe(0.9);
  });

  it("parses threshold", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    success.threshold = 0.6;
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    const result = await finalize(buildFinalizeInput());
    expect(result.threshold).toBe(0.6);
  });

  it("parses response model metadata", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(mockJsonResponse(buildFinalizeSuccessBody()));

    const result = await finalize(buildFinalizeInput());

    expect(result.model).toEqual({
      identity: FINALIZE_MODEL.identity,
      name: FINALIZE_MODEL.name,
      embeddingDimension: FINALIZE_MODEL.embeddingDimension,
      normalization: FINALIZE_MODEL.normalization,
    });
  });

  it("enforces exact response model compatibility", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    success.model.identity = "some-other-model";
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });
});

describe("finalizeFaceEnrollment — invalid success response", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    vi.resetModules();

    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects missing centroid", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    // @ts-expect-error: intentionally delete a required field
    delete success.centroid;
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });

  it("rejects empty centroid", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    success.centroid = [];
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });

  it("rejects NaN in centroid", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    success.centroid[3] = Number.NaN;
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });

  it("rejects Infinity in centroid", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    success.centroid[3] = Number.POSITIVE_INFINITY;
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });

  it("rejects wrong centroid dimension", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    success.centroid = buildNormalizedEmbedding(128, 9);
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });

  it("rejects non-normalised centroid", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    success.centroid = success.centroid.map((v) => v * 5);
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });

  it("rejects response model identity mismatch", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    success.model.identity = "different-identity";
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });

  it("rejects response model name mismatch", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    success.model.name = "different-name";
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });

  it("rejects response embedding dimension mismatch", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    success.model.embedding_dimension = 256;
    // Re-derive centroid at the new dimension so only the metadata mismatch
    // is observable.
    success.centroid = buildNormalizedEmbedding(256, 9);
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });

  it("rejects response normalization mismatch", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    const success = buildFinalizeSuccessBody();
    success.model.normalization = "cosine";
    mockFetch.mockResolvedValueOnce(mockJsonResponse(success));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });

  it("rejects malformed JSON safely", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(mockInvalidJsonResponse(200));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });

  it("rejects unexpected success schema safely", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    // Missing fields.
    mockFetch.mockResolvedValueOnce(mockJsonResponse({ consistent: true }));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_INVALID_RESPONSE,
      );
    }
  });
});

describe("finalizeFaceEnrollment — domain errors", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    vi.resetModules();

    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("preserves INCONSISTENT_FACE_SAMPLES", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(
      mockErrorResponse(
        422,
        FINALIZATION_ERROR_CODES.INCONSISTENT_FACE_SAMPLES,
        "Enrollment batch is internally inconsistent.",
      ),
    );

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_REJECTED_REQUEST,
      );
      expect(
        (error as { domainError?: { code: string } }).domainError?.code,
      ).toBe(FINALIZATION_ERROR_CODES.INCONSISTENT_FACE_SAMPLES);
    }
  });

  it("inconsistent error exposes no centroid", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(
      mockErrorResponse(
        422,
        FINALIZATION_ERROR_CODES.INCONSISTENT_FACE_SAMPLES,
        "Enrollment batch is internally inconsistent.",
      ),
    );

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      // The thrown error is a FaceServiceClientError whose JSON shape must
      // not contain a centroid.
      const json = (error as { toJSON: () => unknown }).toJSON();
      const jsonStr = JSON.stringify(json);
      expect(jsonStr).not.toContain("centroid");
      expect(jsonStr).not.toContain("embedding");
    }
  });

  it("preserves MODEL_MISMATCH", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(
      mockErrorResponse(
        422,
        FINALIZATION_ERROR_CODES.MODEL_MISMATCH,
        "Request model metadata is incompatible.",
      ),
    );

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect(
        (error as { domainError?: { code: string } }).domainError?.code,
      ).toBe(FINALIZATION_ERROR_CODES.MODEL_MISMATCH);
    }
  });

  it("preserves INVALID_SAMPLE_COUNT", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(
      mockErrorResponse(
        422,
        FINALIZATION_ERROR_CODES.INVALID_SAMPLE_COUNT,
        "required_sample_count must be >= 2.",
      ),
    );

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect(
        (error as { domainError?: { code: string } }).domainError?.code,
      ).toBe(FINALIZATION_ERROR_CODES.INVALID_SAMPLE_COUNT);
    }
  });

  it("preserves INVALID_EMBEDDING", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(
      mockErrorResponse(
        422,
        FINALIZATION_ERROR_CODES.INVALID_EMBEDDING,
        "Embedding is not a list of floats.",
      ),
    );

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect(
        (error as { domainError?: { code: string } }).domainError?.code,
      ).toBe(FINALIZATION_ERROR_CODES.INVALID_EMBEDDING);
    }
  });

  it("preserves EMBEDDING_DIMENSION_MISMATCH", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(
      mockErrorResponse(
        422,
        FINALIZATION_ERROR_CODES.EMBEDDING_DIMENSION_MISMATCH,
        "Embedding dimension mismatch.",
      ),
    );

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect(
        (error as { domainError?: { code: string } }).domainError?.code,
      ).toBe(FINALIZATION_ERROR_CODES.EMBEDDING_DIMENSION_MISMATCH);
    }
  });

  it("preserves EMBEDDING_NOT_NORMALIZED", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(
      mockErrorResponse(
        422,
        FINALIZATION_ERROR_CODES.EMBEDDING_NOT_NORMALIZED,
        "Embedding is not L2-normalised.",
      ),
    );

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect(
        (error as { domainError?: { code: string } }).domainError?.code,
      ).toBe(FINALIZATION_ERROR_CODES.EMBEDDING_NOT_NORMALIZED);
    }
  });

  it("preserves INVALID_CENTROID", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(
      mockErrorResponse(
        422,
        FINALIZATION_ERROR_CODES.INVALID_CENTROID,
        "Centroid is not L2-normalised.",
      ),
    );

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect(
        (error as { domainError?: { code: string } }).domainError?.code,
      ).toBe(FINALIZATION_ERROR_CODES.INVALID_CENTROID);
    }
  });
});

describe("finalizeFaceEnrollment — transport errors", () => {
  beforeEach(() => {
    mockFetch = vi.fn();
    global.fetch = mockFetch;
    vi.resetModules();

    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("maps timeout safely", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockImplementationOnce(() => {
      return new Promise<Response>((_, reject) => {
        setTimeout(() => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, 5);
      });
    });

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_TIMEOUT,
      );
    }
  });

  it("maps network failure safely", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_UNAVAILABLE,
      );
    }
  });

  it("maps 401 to FACE_SERVICE_UNAUTHORIZED", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(
      mockErrorResponse(
        401,
        "FACE_SERVICE_UNAUTHORIZED",
        "Invalid service token",
      ),
    );

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_UNAUTHORIZED,
      );
    }
  });

  it("preserves not-configured behaviour for missing URL", async () => {
    vi.resetModules();
    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: undefined,
        FACE_SERVICE_SECRET: FAKE_SECRET,
      },
    }));

    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_NOT_CONFIGURED,
      );
    }

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("preserves not-configured behaviour for missing secret", async () => {
    vi.resetModules();
    vi.doMock("@/lib/env", () => ({
      env: {
        FACE_SERVICE_URL: FAKE_FACE_SERVICE_URL,
        FACE_SERVICE_SECRET: undefined,
      },
    }));

    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    try {
      await finalize(buildFinalizeInput());
      expect.fail("Should have thrown");
    } catch (error) {
      expect((error as { code: string }).code).toBe(
        FACE_SERVICE_ERROR_CODES.FACE_SERVICE_NOT_CONFIGURED,
      );
    }

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("does not leak raw secret in thrown error", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(
      mockErrorResponse(
        401,
        "FACE_SERVICE_UNAUTHORIZED",
        "Invalid service token",
      ),
    );

    try {
      await finalize(buildFinalizeInput());
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).not.toContain(FAKE_SECRET);
    }
  });

  it("does not expose raw response body in error messages", async () => {
    const { finalizeFaceEnrollment: finalize } = await import(
      "@/lib/biometrics/face-service-client"
    );

    mockFetch.mockResolvedValueOnce(
      mockErrorResponse(
        422,
        FINALIZATION_ERROR_CODES.INCONSISTENT_FACE_SAMPLES,
        "raw upstream text",
      ),
    );

    try {
      await finalize(buildFinalizeInput());
    } catch (error) {
      const msg = (error as Error).message;
      // Generic safe message — never the raw upstream body verbatim.
      expect(msg).not.toContain("raw upstream text");
    }
  });
});

describe("finalizeFaceEnrollment — FINALIZATION_ERROR_CODES export", () => {
  it("exposes the documented stable codes", () => {
    const expectedCodes = [
      "MODEL_MISMATCH",
      "INVALID_SAMPLE_COUNT",
      "INVALID_EMBEDDING",
      "EMBEDDING_DIMENSION_MISMATCH",
      "EMBEDDING_NOT_NORMALIZED",
      "INCONSISTENT_FACE_SAMPLES",
      "INVALID_CENTROID",
    ] as const;

    expectedCodes.forEach((code) => {
      expect(FINALIZATION_ERROR_CODES).toHaveProperty(code);
      expect(FINALIZATION_ERROR_CODES[code]).toBe(code);
    });
  });
});
