/**
 * Shared test helper — installs a minimal canvas mock so the
 * production `captureVideoFrame` utility can run inside jsdom.
 *
 * PHASE 4.5B3 — tests for the enrollment sample panel rely on
 * the same canvas stub as the PHASE 4.5B2 capture utility tests.
 * jsdom does not implement `<canvas>.getContext('2d')` so without
 * this stub the real `captureVideoFrame` would throw.
 */

import { vi } from "vitest";

interface StubCanvasState {
  toBlobResult: Blob | null;
  getContextReturnsNull: boolean;
  drawImageThrows: Error | null;
}

const defaultState: StubCanvasState = {
  toBlobResult: new Blob(["x"], { type: "image/jpeg" }),
  getContextReturnsNull: false,
  drawImageThrows: null,
};

let state: StubCanvasState = defaultState;

class StubCanvasContext {
  constructor(private canvas: StubCanvas) {}
  drawImage(...args: unknown[]): void {
    if (state.drawImageThrows) {
      throw state.drawImageThrows;
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

class StubCanvas {
  width = 0;
  height = 0;
  drawImageCalls: unknown[][] = [];
  scaleCalled = false;
  translateCalled = false;

  getContext(_type: string): unknown {
    if (_type !== "2d") return null;
    if (state.getContextReturnsNull) return null;
    return new StubCanvasContext(this);
  }

  toBlob(callback: (b: Blob | null) => void): void {
    // Defer to a macrotask so the production `await new Promise(...)`
    // shape from `captureVideoFrame` resolves on the next tick.
    setTimeout(() => callback(state.toBlobResult), 0);
  }
}

// `document.createElement` lives on jsdom's Document prototype, not as
// an own property of `document`. We resolve the original function via
// the prototype chain at install time and call it directly through a
// closure reference so the patched version never re-enters itself.
let originalCreateElement:
  | ((this: Document, tagName: string, options?: ElementCreationOptions) => HTMLElement)
  | null = null;
let originalCreateElementDescriptor: PropertyDescriptor | null = null;

function getRealCreateElement(): (
  this: Document,
  tagName: string,
  options?: ElementCreationOptions,
) => HTMLElement {
  // Walk up the prototype chain looking for an own descriptor.
  let proto: object | null = Object.getPrototypeOf(document);
  while (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, "createElement");
    if (desc && typeof desc.value === "function") {
      return desc.value as (
        this: Document,
        tagName: string,
        options?: ElementCreationOptions,
      ) => HTMLElement;
    }
    proto = Object.getPrototypeOf(proto);
  }
  // Fallback: use a fresh detached document if available, otherwise
  // return a minimal stub. Both of these paths are only reached when
  // jsdom's prototype lookup has been disrupted by previous test code.
  if (typeof (globalThis as { document?: Document }).document === "object") {
    return Object.getPrototypeOf(
      (globalThis as { document: Document }).document,
    ).createElement.bind(
      (globalThis as { document: Document }).document,
    ) as (
      this: Document,
      tagName: string,
      options?: ElementCreationOptions,
    ) => HTMLElement;
  }
  throw new Error("Unable to resolve original document.createElement");
}

export function installCanvasStub(): void {
  state = defaultState;
  // Capture the original definition now so uninstall can restore it.
  originalCreateElementDescriptor =
    Object.getOwnPropertyDescriptor(document, "createElement") ?? null;
  const realCreateElement = getRealCreateElement();
  originalCreateElement = realCreateElement;

  Object.defineProperty(document, "createElement", {
    configurable: true,
    writable: true,
    value: vi.fn((tag: string, options?: ElementCreationOptions) => {
      if (tag !== "canvas") {
        // Delegate to the original implementation captured at install
        // time so we never re-enter the patched function.
        return realCreateElement.call(document, tag, options);
      }
      return new StubCanvas() as unknown as HTMLCanvasElement;
    }),
  });
}

export function setCanvasStubConfig(overrides: Partial<StubCanvasState>): void {
  state = { ...defaultState, ...overrides };
}

export function uninstallCanvasStub(): void {
  if (originalCreateElementDescriptor) {
    Object.defineProperty(
      document,
      "createElement",
      originalCreateElementDescriptor,
    );
  } else if (originalCreateElement) {
    Object.defineProperty(document, "createElement", {
      configurable: true,
      writable: true,
      value: originalCreateElement,
    });
  }
  originalCreateElement = null;
  originalCreateElementDescriptor = null;
}

/**
 * Configures an HTMLVideoElement so the production `captureVideoFrame`
 * utility will treat it as ready (returning a real JPEG Blob).
 */
export function attachReadyFrame(video: HTMLVideoElement): void {
  Object.defineProperty(video, "videoWidth", {
    configurable: true,
    value: 1280,
  });
  Object.defineProperty(video, "videoHeight", {
    configurable: true,
    value: 720,
  });
  Object.defineProperty(video, "readyState", {
    configurable: true,
    value: 4, // HAVE_ENOUGH_DATA
  });
}
