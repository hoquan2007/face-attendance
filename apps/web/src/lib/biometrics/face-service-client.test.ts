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
