/**
 * Tests for the video frame capture utility.
 *
 * PHASE 4.5B2 — Video Frame Capture → JPEG Blob Foundation.
 *
 * jsdom does not provide a real canvas encoder. A lightweight
 * in-test fake is used so tests are deterministic and fast.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  calculateCaptureDimensions,
  captureVideoFrame,
  CAPTURE_ERROR_CODES,
  type CaptureErrorShape,
} from "@/components/face-id/capture-video-frame";

// =============================================================================
// Canvas mock factory
// =============================================================================

interface CanvasConfig {
  toBlobResult: Blob | null;
  getContextReturnsNull: boolean;
  drawImageThrows: Error | null;
}

const defaultConfig = (): CanvasConfig => ({
  toBlobResult: new Blob(["x"], { type: "image/jpeg" }),
  getContextReturnsNull: false,
  drawImageThrows: null,
});

let currentConfig: CanvasConfig = defaultConfig();
const allCanvases: TestCanvas[] = [];

class TestCanvas {
  // Internal storage
  private _width = 0;
  private _height = 0;

  get width(): number {
    return this._width;
  }
  set width(v: number) {
    this._width = v;
    if (v > this._maxWidth) this._maxWidth = v;
  }

  get height(): number {
    return this._height;
  }
  set height(v: number) {
    this._height = v;
    if (v > this._maxHeight) this._maxHeight = v;
  }

  private _maxWidth = 0;
  private _maxHeight = 0;

  /** Maximum width ever observed on this canvas (survives post-encode reset). */
  get maxWidth(): number {
    return this._maxWidth;
  }
  /** Maximum height ever observed on this canvas (survives post-encode reset). */
  get maxHeight(): number {
    return this._maxHeight;
  }

  drawImageCalls: unknown[][] = [];
  scaleCalled = false;
  translateCalled = false;

  getContext(_type: string): CanvasRenderingContext2D | null {
    if (_type !== "2d") return null;
    if (currentConfig.getContextReturnsNull) return null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new TestContext(this) as unknown as any;
  }

  toBlob(callback: BlobCallback): void {
    setTimeout(() => callback(currentConfig.toBlobResult), 0);
  }
}

class TestContext {
  constructor(private canvas: TestCanvas) {}
  drawImage(...args: unknown[]): void {
    if (currentConfig.drawImageThrows) {
      throw currentConfig.drawImageThrows;
    }
    this.canvas.drawImageCalls.push(args);
  }
  scale(): void {
    this.canvas.scaleCalled = true;
  }
  translate(): void {
    this.canvas.translateCalled = true;
  }
}

const originalCreateElement = Object.getOwnPropertyDescriptor(
  document,
  "createElement",
);

function installCanvasMocks(): void {
  allCanvases.length = 0;
  currentConfig = defaultConfig();
  Object.defineProperty(document, "createElement", {
    configurable: true,
    value: vi.fn((tag: string) => {
      if (tag !== "canvas") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (document as any).createElement.call(document, tag);
      }
      const c = new TestCanvas();
      allCanvases.push(c);
      return c as unknown as HTMLCanvasElement;
    }),
  });
}

function uninstallCanvasMocks(): void {
  if (originalCreateElement) {
    Object.defineProperty(document, "createElement", originalCreateElement);
  } else {
    delete (document as unknown as { createElement?: unknown }).createElement;
  }
  allCanvases.length = 0;
}

// =============================================================================
// Helpers
// =============================================================================

async function expectRejectCode(
  fn: () => Promise<unknown>,
  expected: string,
): Promise<CaptureErrorShape> {
  try {
    await fn();
  } catch (err) {
    const e = err as CaptureErrorShape;
    expect(e.code).toBe(expected);
    return e;
  }
  throw new Error(`Expected promise to reject with code ${expected}`);
}

function makeFakeVideo(
  width: number,
  height: number,
  readyState = 4,
): HTMLVideoElement {
  return {
    videoWidth: width,
    videoHeight: height,
    readyState,
  } as unknown as HTMLVideoElement;
}

// =============================================================================
// Tests
// =============================================================================

beforeEach(() => {
  installCanvasMocks();
});

afterEach(() => {
  uninstallCanvasMocks();
});

// =============================================================================
// calculateCaptureDimensions tests
// =============================================================================

describe("calculateCaptureDimensions — dimension scaling", () => {
  it("1920×1080 → 1280×720 (landscape downscale)", () => {
    expect(calculateCaptureDimensions(1920, 1080, 1280)).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it("1080×1920 → 720×1280 (portrait downscale)", () => {
    expect(calculateCaptureDimensions(1080, 1920, 1280)).toEqual({
      width: 720,
      height: 1280,
    });
  });

  it("1280×720 stays 1280×720 (no upscale on long edge)", () => {
    expect(calculateCaptureDimensions(1280, 720, 1280)).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it("640×480 is NOT upscaled", () => {
    expect(calculateCaptureDimensions(640, 480, 1280)).toEqual({
      width: 640,
      height: 480,
    });
  });

  it("square frame 1000×1000 preserves dimensions", () => {
    expect(calculateCaptureDimensions(1000, 1000, 1280)).toEqual({
      width: 1000,
      height: 1000,
    });
  });

  it("rejects zero width", () => {
    expect(() => calculateCaptureDimensions(0, 720, 1280)).toThrow(
      /sourceWidth must be a positive integer/i,
    );
  });

  it("rejects negative width", () => {
    expect(() => calculateCaptureDimensions(-1, 720, 1280)).toThrow(
      /sourceWidth must be a positive integer/i,
    );
  });

  it("rejects zero height", () => {
    expect(() => calculateCaptureDimensions(1280, 0, 1280)).toThrow(
      /sourceHeight must be a positive integer/i,
    );
  });

  it("rejects negative height", () => {
    expect(() => calculateCaptureDimensions(1280, -1, 1280)).toThrow(
      /sourceHeight must be a positive integer/i,
    );
  });

  it("rejects NaN width", () => {
    expect(() => calculateCaptureDimensions(NaN, 720, 1280)).toThrow(
      /sourceWidth must be a positive integer/i,
    );
  });

  it("rejects NaN height", () => {
    expect(() => calculateCaptureDimensions(1280, NaN, 1280)).toThrow(
      /sourceHeight must be a positive integer/i,
    );
  });

  it("rejects Infinity width", () => {
    expect(() => calculateCaptureDimensions(Infinity, 720, 1280)).toThrow(
      /sourceWidth must be a positive integer/i,
    );
  });

  it("rejects Infinity height", () => {
    expect(() => calculateCaptureDimensions(1280, Infinity, 1280)).toThrow(
      /sourceHeight must be a positive integer/i,
    );
  });

  it("rejects non-integer width", () => {
    expect(() => calculateCaptureDimensions(1280.5, 720, 1280)).toThrow(
      /sourceWidth must be a positive integer/i,
    );
  });
});

// =============================================================================
// captureVideoFrame tests — video readiness validation
// =============================================================================

describe("captureVideoFrame — video readiness validation", () => {
  it("rejects video with videoWidth=0 as FRAME_NOT_READY", async () => {
    await expectRejectCode(
      () => captureVideoFrame(makeFakeVideo(0, 720)),
      CAPTURE_ERROR_CODES.FRAME_NOT_READY,
    );
  });

  it("rejects video with videoHeight=0 as FRAME_NOT_READY", async () => {
    await expectRejectCode(
      () => captureVideoFrame(makeFakeVideo(1280, 0)),
      CAPTURE_ERROR_CODES.FRAME_NOT_READY,
    );
  });

  it("rejects video with readyState < HAVE_CURRENT_DATA as FRAME_NOT_READY", async () => {
    await expectRejectCode(
      () => captureVideoFrame(makeFakeVideo(1280, 720, 1)),
      CAPTURE_ERROR_CODES.FRAME_NOT_READY,
    );
  });

  it("rejects video with readyState=0 (HAVE_NOTHING) as FRAME_NOT_READY", async () => {
    await expectRejectCode(
      () => captureVideoFrame(makeFakeVideo(1280, 720, 0)),
      CAPTURE_ERROR_CODES.FRAME_NOT_READY,
    );
  });
});

// =============================================================================
// captureVideoFrame tests — canvas lifecycle
// =============================================================================

describe("captureVideoFrame — canvas lifecycle", () => {
  it("creates exactly one ephemeral canvas for a ready video", async () => {
    await captureVideoFrame(makeFakeVideo(1920, 1080));
    expect(allCanvases).toHaveLength(1);
  });

  it("canvas width matches calculated output width (1280 for 1920×1080)", async () => {
    await captureVideoFrame(makeFakeVideo(1920, 1080));
    expect(allCanvases[0]!.maxWidth).toBe(1280);
  });

  it("canvas height matches calculated output height (720 for 1920×1080)", async () => {
    await captureVideoFrame(makeFakeVideo(1920, 1080));
    expect(allCanvases[0]!.maxHeight).toBe(720);
  });

  it("canvas width is NOT upscaled for 640×480 source", async () => {
    await captureVideoFrame(makeFakeVideo(640, 480));
    expect(allCanvases[0]!.maxWidth).toBe(640);
    expect(allCanvases[0]!.maxHeight).toBe(480);
  });
});

// =============================================================================
// captureVideoFrame tests — 2D context
// =============================================================================

describe("captureVideoFrame — 2D context", () => {
  it("getContext returning null rejects as FRAME_CANVAS_UNAVAILABLE", async () => {
    currentConfig.getContextReturnsNull = true;
    await expectRejectCode(
      () => captureVideoFrame(makeFakeVideo(1920, 1080)),
      CAPTURE_ERROR_CODES.FRAME_CANVAS_UNAVAILABLE,
    );
  });
});

// =============================================================================
// captureVideoFrame tests — drawImage
// =============================================================================

describe("captureVideoFrame — drawImage", () => {
  it("drawImage is called exactly once", async () => {
    const video = makeFakeVideo(1920, 1080);
    await captureVideoFrame(video);
    expect(allCanvases[0]!.drawImageCalls).toHaveLength(1);
  });

  it("drawImage is called with the source video as first argument", async () => {
    const video = makeFakeVideo(1920, 1080);
    await captureVideoFrame(video);
    expect(allCanvases[0]!.drawImageCalls[0]![0]).toBe(video);
  });

  it("drawImage destination dimensions match calculated capture dimensions", async () => {
    const video = makeFakeVideo(1920, 1080);
    await captureVideoFrame(video);
    expect(allCanvases[0]!.drawImageCalls[0]).toEqual([video, 0, 0, 1280, 720]);
  });

  it("NO ctx.scale mirror transform is applied", async () => {
    await captureVideoFrame(makeFakeVideo(1920, 1080));
    expect(allCanvases[0]!.scaleCalled).toBe(false);
  });

  it("NO ctx.translate mirror transform is applied", async () => {
    await captureVideoFrame(makeFakeVideo(1920, 1080));
    expect(allCanvases[0]!.translateCalled).toBe(false);
  });

  it("drawImage exception rejects as FRAME_ENCODING_FAILED", async () => {
    currentConfig.drawImageThrows = new Error("GPU crash during drawImage");
    await expectRejectCode(
      () => captureVideoFrame(makeFakeVideo(1920, 1080)),
      CAPTURE_ERROR_CODES.FRAME_ENCODING_FAILED,
    );
  });

  it("drawImage exception output does NOT expose raw stack", async () => {
    currentConfig.drawImageThrows = new Error("INTERNAL-GPU-DETAIL");
    const err = await expectRejectCode(
      () => captureVideoFrame(makeFakeVideo(1920, 1080)),
      CAPTURE_ERROR_CODES.FRAME_ENCODING_FAILED,
    );
    const serialized = JSON.stringify(err);
    expect(serialized).not.toContain("INTERNAL-GPU-DETAIL");
    expect(serialized).not.toContain("Error");
  });
});

// =============================================================================
// captureVideoFrame tests — toBlob
// =============================================================================

describe("captureVideoFrame — toBlob", () => {
  it("successful toBlob returns the blob", async () => {
    const fakeBlob = new Blob(["fake-jpeg"], { type: "image/jpeg" });
    currentConfig.toBlobResult = fakeBlob;
    const result = await captureVideoFrame(makeFakeVideo(1920, 1080));
    expect(result.blob).toBe(fakeBlob);
  });

  it("returned mimeType is image/jpeg", async () => {
    currentConfig.toBlobResult = new Blob(["x"], { type: "image/jpeg" });
    const result = await captureVideoFrame(makeFakeVideo(1920, 1080));
    expect(result.mimeType).toBe("image/jpeg");
  });

  it("returned size equals blob.size", async () => {
    const fakeBlob = new Blob(["x".repeat(42)], { type: "image/jpeg" });
    currentConfig.toBlobResult = fakeBlob;
    const result = await captureVideoFrame(makeFakeVideo(1920, 1080));
    expect(result.size).toBe(fakeBlob.size);
  });

  it("returned width/height match canvas output dimensions", async () => {
    // 1920×1080 → 1280×720
    currentConfig.toBlobResult = new Blob(["x"], { type: "image/jpeg" });
    const result = await captureVideoFrame(makeFakeVideo(1920, 1080));
    expect(result.width).toBe(1280);
    expect(result.height).toBe(720);
  });

  it("toBlob returning null rejects as FRAME_ENCODING_FAILED", async () => {
    currentConfig.toBlobResult = null;
    await expectRejectCode(
      () => captureVideoFrame(makeFakeVideo(1920, 1080)),
      CAPTURE_ERROR_CODES.FRAME_ENCODING_FAILED,
    );
  });
});

// =============================================================================
// captureVideoFrame tests — canvas memory cleanup
// =============================================================================

describe("captureVideoFrame — canvas memory cleanup", () => {
  it("canvas width cleared to 0 after successful encoding", async () => {
    currentConfig.toBlobResult = new Blob(["x"], { type: "image/jpeg" });
    await captureVideoFrame(makeFakeVideo(1920, 1080));
    expect(allCanvases[0]!.width).toBe(0);
  });

  it("canvas height cleared to 0 after successful encoding", async () => {
    currentConfig.toBlobResult = new Blob(["x"], { type: "image/jpeg" });
    await captureVideoFrame(makeFakeVideo(1920, 1080));
    expect(allCanvases[0]!.height).toBe(0);
  });

  it("canvas dimensions cleared after toBlob null (encoding failure)", async () => {
    currentConfig.toBlobResult = null;
    await expectRejectCode(
      () => captureVideoFrame(makeFakeVideo(1920, 1080)),
      CAPTURE_ERROR_CODES.FRAME_ENCODING_FAILED,
    );
    expect(allCanvases[0]!.width).toBe(0);
    expect(allCanvases[0]!.height).toBe(0);
  });

  it("canvas dimensions cleared after drawImage exception", async () => {
    currentConfig.drawImageThrows = new Error("GPU error");
    await expectRejectCode(
      () => captureVideoFrame(makeFakeVideo(1920, 1080)),
      CAPTURE_ERROR_CODES.FRAME_ENCODING_FAILED,
    );
    expect(allCanvases[0]!.width).toBe(0);
    expect(allCanvases[0]!.height).toBe(0);
  });

  it("canvas dimensions cleared after getContext returns null", async () => {
    currentConfig.getContextReturnsNull = true;
    await expectRejectCode(
      () => captureVideoFrame(makeFakeVideo(1920, 1080)),
      CAPTURE_ERROR_CODES.FRAME_CANVAS_UNAVAILABLE,
    );
    expect(allCanvases[0]!.width).toBe(0);
    expect(allCanvases[0]!.height).toBe(0);
  });
});

// =============================================================================
// captureVideoFrame tests — network / storage hygiene
// =============================================================================

describe("captureVideoFrame — network / storage hygiene", () => {
  it("NEVER calls fetch (no network request)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await captureVideoFrame(makeFakeVideo(1920, 1080));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("NEVER calls the enrollment-sample API", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));
    await captureVideoFrame(makeFakeVideo(1920, 1080));
    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(
      calledUrls.some((u) => u.includes("/api/face-id/enrollment/sample")),
    ).toBe(false);
  });

  it("NEVER produces a base64 string (returns Blob, not string)", async () => {
    const fakeBlob = new Blob(["fake"], { type: "image/jpeg" });
    currentConfig.toBlobResult = fakeBlob;
    const result = await captureVideoFrame(makeFakeVideo(1920, 1080));
    expect(result.blob).toBeInstanceOf(Blob);
    expect(typeof result.blob).toBe("object");
  });

  it("NEVER writes to localStorage", async () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    await captureVideoFrame(makeFakeVideo(1920, 1080));
    expect(setItemSpy).not.toHaveBeenCalled();
  });
});
