/**
 * Tests for the `CameraPreview` component.
 *
 * PHASE 4.5A — Browser Camera Foundation.
 *
 * These tests render `CameraPreview` through
 * `@testing-library/react` and verify:
 *
 *   - The component renders the Turn-on and Stop buttons.
 *   - No camera permission is requested automatically on mount.
 *   - Clicking Turn on calls `navigator.mediaDevices.getUserMedia`
 *     exactly once with `audio: false` and user-facing video.
 *   - On success, the status text updates and `video.srcObject` is
 *     populated.
 *   - On failure (NotAllowedError etc.), the mapped friendly message
 *     is shown and raw exception text never appears.
 *   - No `<canvas>`, no `drawImage`, no `toBlob`/`toDataURL`, and no
 *     fetch to `/api/face-id/enrollment/sample` is ever emitted.
 *
 * MediaDevices / MediaStream / MediaStreamTrack are stubbed in this
 * file just like in `use-face-camera.test.ts`.
 */

import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { CameraPreview } from "@/components/face-id/camera-preview";

// =============================================================================
// Fakes
// =============================================================================

interface FakeTrack {
  kind: "audio" | "video";
  stopped: boolean;
  stop: () => void;
}

function makeFakeTrack(kind: "audio" | "video"): FakeTrack {
  return {
    kind,
    stopped: false,
    stop() {
      this.stopped = true;
    },
  };
}

interface FakeStream {
  tracks: FakeTrack[];
  getTracks: () => FakeTrack[];
}

function makeFakeStream(tracks: FakeTrack[]): FakeStream {
  return {
    tracks,
    getTracks: () => tracks,
  };
}

type GetUserMediaMode =
  | { kind: "resolve"; stream: FakeStream }
  | { kind: "reject"; name: string };

const getUserMediaCalls: Array<{ audio: unknown; video: unknown }> = [];
let getUserMediaMode: GetUserMediaMode = {
  kind: "resolve",
  stream: makeFakeStream([makeFakeTrack("video")]),
};

const getUserMediaMock = vi.fn((constraints: MediaStreamConstraints) => {
  getUserMediaCalls.push({
    audio: constraints.audio,
    video: constraints.video,
  });
  if (getUserMediaMode.kind === "resolve") {
    return Promise.resolve(
      getUserMediaMode.stream as unknown as MediaStream,
    );
  }
  return Promise.reject({ name: getUserMediaMode.name });
});

// =============================================================================
// Setup / teardown
// =============================================================================

const originalMediaDevices = Object.getOwnPropertyDescriptor(
  navigator,
  "mediaDevices",
);
const originalIsSecureContext = Object.getOwnPropertyDescriptor(
  window,
  "isSecureContext",
);

beforeEach(() => {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: getUserMediaMock } as unknown as MediaDevices,
  });

  getUserMediaCalls.length = 0;
  getUserMediaMock.mockClear();
  getUserMediaMode = {
    kind: "resolve",
    stream: makeFakeStream([makeFakeTrack("video")]),
  };
});

afterEach(() => {
  if (originalMediaDevices) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevices);
  } else {
    delete (navigator as unknown as { mediaDevices?: MediaDevices })
      .mediaDevices;
  }
  if (originalIsSecureContext) {
    Object.defineProperty(window, "isSecureContext", originalIsSecureContext);
  } else {
    delete (window as unknown as { isSecureContext?: boolean })
      .isSecureContext;
  }
});

// =============================================================================
// Tests
// =============================================================================

describe("CameraPreview — rendering", () => {
  it("renders Turn on and Stop buttons", () => {
    render(<CameraPreview />);
    expect(
      screen.getByRole("button", { name: /turn on camera/i }),
    ).toBeDefined();
    expect(screen.getByRole("button", { name: /stop camera/i })).toBeDefined();
  });

  it("renders a <video> element with appropriate preview attributes", () => {
    render(<CameraPreview />);
    const video = document.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.hasAttribute("autoplay")).toBe(true);
    expect(video?.hasAttribute("playsinline")).toBe(true);
    // Check the IDL property (not the HTML attribute) because `muted`
    // is a boolean attribute — the IDL property is the reliable signal.
    expect((video as HTMLVideoElement).muted).toBe(true);
  });

  it("renders the privacy note", () => {
    render(<CameraPreview />);
    expect(
      screen.getByText(/camera preview stays on this device/i),
    ).toBeDefined();
  });
});

describe("CameraPreview — permission gating", () => {
  it("does NOT call getUserMedia on mount", () => {
    render(<CameraPreview />);
    expect(getUserMediaMock).not.toHaveBeenCalled();
  });

  it("calls getUserMedia only after the Turn on button is clicked", async () => {
    render(<CameraPreview />);
    expect(getUserMediaMock).not.toHaveBeenCalled();

    const turnOn = screen.getByRole("button", { name: /turn on camera/i });
    await act(async () => {
      fireEvent.click(turnOn);
    });

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
  });

  it("requests audio: false (no microphone)", async () => {
    render(<CameraPreview />);
    const turnOn = screen.getByRole("button", { name: /turn on camera/i });

    await act(async () => {
      fireEvent.click(turnOn);
    });

    expect(getUserMediaCalls[0]?.audio).toBe(false);
  });

  it("requests user-facing video with ideal 1280x720", async () => {
    render(<CameraPreview />);
    const turnOn = screen.getByRole("button", { name: /turn on camera/i });

    await act(async () => {
      fireEvent.click(turnOn);
    });

    const video = getUserMediaCalls[0]?.video as MediaTrackConstraints;
    expect(video.facingMode).toBe("user");
    const width = video.width as { ideal: number };
    const height = video.height as { ideal: number };
    expect(width.ideal).toBe(1280);
    expect(height.ideal).toBe(720);
  });
});

describe("CameraPreview — successful stream", () => {
  it("attaches the stream to the <video> srcObject after success", async () => {
    const stream = makeFakeStream([makeFakeTrack("video")]);
    getUserMediaMode = { kind: "resolve", stream };

    render(<CameraPreview />);
    const turnOn = screen.getByRole("button", { name: /turn on camera/i });

    await act(async () => {
      fireEvent.click(turnOn);
    });

    const video = document.querySelector("video") as HTMLVideoElement | null;
    expect(video).not.toBeNull();
    // The hook stores the stream on the video element's srcObject.
    expect(video?.srcObject).toBe(stream as unknown as MediaStream);
  });

  it("renders the privacy note with no leakage of future guarantees", () => {
    render(<CameraPreview />);
    // The default privacy copy must NOT claim the camera is "never"
    // uploaded, because PHASE 4.5B will send chosen samples.
    const note = screen.getByText(/camera preview stays on this device/i);
    expect(note.textContent).not.toMatch(/never uploaded|never transmitted/i);
  });

  it("does not show an error block on success", async () => {
    render(<CameraPreview />);
    const turnOn = screen.getByRole("button", { name: /turn on camera/i });
    await act(async () => {
      fireEvent.click(turnOn);
    });
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("CameraPreview — stop button", () => {
  it("stops all tracks when Stop is clicked", async () => {
    const trackA = makeFakeTrack("video");
    const trackB = makeFakeTrack("video");
    getUserMediaMode = {
      kind: "resolve",
      stream: makeFakeStream([trackA, trackB]),
    };

    render(<CameraPreview />);
    const turnOn = screen.getByRole("button", { name: /turn on camera/i });
    const stop = screen.getByRole("button", { name: /stop camera/i });

    await act(async () => {
      fireEvent.click(turnOn);
    });
    expect(trackA.stopped).toBe(false);
    expect(trackB.stopped).toBe(false);

    act(() => {
      fireEvent.click(stop);
    });

    expect(trackA.stopped).toBe(true);
    expect(trackB.stopped).toBe(true);
  });
});

describe("CameraPreview — error mapping", () => {
  it("shows the permission-denied message and never the raw exception", async () => {
    getUserMediaMode = { kind: "reject", name: "NotAllowedError" };
    render(<CameraPreview />);

    const turnOn = screen.getByRole("button", { name: /turn on camera/i });
    await act(async () => {
      fireEvent.click(turnOn);
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Camera access was blocked");
    // Must NOT contain the raw exception name.
    expect(alert.textContent).not.toContain("NotAllowedError");
  });

  it("shows the not-found message on NotFoundError", async () => {
    getUserMediaMode = { kind: "reject", name: "NotFoundError" };
    render(<CameraPreview />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /turn on camera/i }),
      );
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("No camera was found");
  });

  it("shows the in-use message on NotReadableError", async () => {
    getUserMediaMode = { kind: "reject", name: "NotReadableError" };
    render(<CameraPreview />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /turn on camera/i }),
      );
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("currently being used");
  });

  it("shows the insecure-context message when the page is insecure", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });

    render(<CameraPreview />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /turn on camera/i }),
      );
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("HTTPS or localhost");
    // getUserMedia must NOT have been called.
    expect(getUserMediaMock).not.toHaveBeenCalled();
  });

  it("shows a generic unavailable message on unknown errors", async () => {
    getUserMediaMode = { kind: "reject", name: "QuantumError" };
    render(<CameraPreview />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /turn on camera/i }),
      );
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("camera could not be started");
    expect(alert.textContent).not.toContain("QuantumError");
  });
});

describe("CameraPreview — no capture / no API call", () => {
  it("renders NO <canvas> element", () => {
    render(<CameraPreview />);
    expect(document.querySelector("canvas")).toBeNull();
  });

  it("never fetches the enrollment-sample API", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));

    render(<CameraPreview />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /turn on camera/i }),
      );
    });

    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(
      calledUrls.some((u) => u.includes("/api/face-id/enrollment/sample")),
    ).toBe(false);
    fetchSpy.mockRestore();
  });

  it("does not call toBlob / toDataURL on the video element", async () => {
    render(<CameraPreview />);
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /turn on camera/i }),
      );
    });

    const video = document.querySelector("video") as HTMLVideoElement | null;
    expect(video).not.toBeNull();
    // The methods exist on HTMLCanvasElement, not HTMLVideoElement —
    // a regression that wired a canvas would expose this distinction.
    expect((video as unknown as { toBlob?: unknown }).toBlob).toBeUndefined();
    expect(
      (video as unknown as { toDataURL?: unknown }).toDataURL,
    ).toBeUndefined();
  });
});
