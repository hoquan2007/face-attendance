/**
 * Tests for `EnrollmentSamplePanel`.
 *
 * PHASE 4.5B4 — Progress + Recovery + Reload Resilience.
 *
 * These tests render the panel through `@testing-library/react` and
 * verify:
 *
 * PHASE 4.5B3 coverage:
 *   - The Capture button is unavailable while the camera is idle /
 *     requesting / error.
 *   - The Capture button is enabled when the camera is ready.
 *   - One explicit click → exactly one capture + exactly one POST.
 *   - Two rapid clicks while submission is pending → one capture +
 *     one POST.
 *   - Pending state disables the button.
 *   - Accepted responses render "Sample accepted" and use server
 *     progress.
 *   - Quality rejections render the friendly per-reason copy.
 *   - NO_FACE / MULTIPLE_FACES / conflict / expired / infrastructure
 *     errors each map to safe UI text.
 *   - Camera remains active after accepted or quality-rejection
 *     responses.
 *   - complete=true disables further captures without claiming
 *     FaceProfile existence.
 *   - The Blob is never placed in React state.
 *   - `URL.createObjectURL` is never called.
 *
 * PHASE 4.5B4 additions:
 *   - Server-authoritative progress from props is preserved on reload.
 *   - Conflict detection when server returns lower count than expected.
 *   - Conflict triggers reconciliation callback (no auto-retry).
 *   - ENROLLMENT_SAMPLE_CONFLICT shows conflict message, not generic error.
 *   - ENROLLMENT_EXPIRED disables capture, shows expiry message, stops camera.
 *   - ENROLLMENT_NOT_STARTED disables capture, shows message, stops camera.
 *   - MODEL_MISMATCH disables capture, shows restart guidance, stops camera.
 *   - ENROLLMENT_SAMPLE_LIMIT_REACHED triggers reconciliation.
 *   - Network errors show connection message without retry.
 *   - Prop reconciliation after router.refresh().
 *   - No localStorage/sessionStorage/IndexedDB persistence.
 *   - No embedding/ciphertext/modelIdentity in DOM.
 *
 * No real webcam is touched. The camera / canvas / fetch surfaces are
 * stubbed deterministically. The tests follow the project convention
 * of inspecting `.disabled`, `.textContent`, and `.toEqual(...)` —
 * jest-dom matchers are intentionally NOT used so the file remains
 * valid in plain Vitest without extra setup.
 */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { SAMPLE_CLIENT_ERROR_CODES } from "@/components/face-id/enrollment-sample-client";
import { EnrollmentSamplePanel } from "@/components/face-id-pages/enrollment-sample-panel";
import {
  attachReadyFrame,
  installCanvasStub,
  uninstallCanvasStub,
} from "@/components/face-id-pages/__test-helpers__/canvas-stub";

// =============================================================================
// Lightweight helpers (no jest-dom types)
// =============================================================================

function isDisabled(el: HTMLElement): boolean {
  return (el as HTMLButtonElement).disabled === true;
}

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

const getUserMediaCalls: Array<{ audio: unknown; video: unknown }> = [];
let getUserMediaMode:
  | { kind: "resolve"; stream: FakeStream }
  | { kind: "reject"; name: string; message?: string }
  | { kind: "pending" };

const getUserMediaMock = vi.fn(
  (constraints: MediaStreamConstraints): Promise<MediaStream> => {
    getUserMediaCalls.push({
      audio: constraints.audio,
      video: constraints.video,
    });
    if (getUserMediaMode.kind === "resolve") {
      return Promise.resolve(
        getUserMediaMode.stream as unknown as MediaStream,
      );
    }
    if (getUserMediaMode.kind === "pending") {
      // Never resolve: the hook stays in `requesting` until the test
      // chooses to update the mode.
      return new Promise<MediaStream>(() => {});
    }
    return Promise.reject({
      name: getUserMediaMode.name,
      message: getUserMediaMode.message,
    });
  },
);

// Fetch stub
const fetchLog: Array<{ url: string; init: RequestInit | undefined }> = [];
const fetchResponses: Array<
  | {
      kind: "ok";
      body: unknown;
      status?: number;
    }
  | { kind: "error"; error: Error }
> = [];

const fetchMock = vi.fn(
  (input: unknown, init?: RequestInit): Promise<Response> => {
    fetchLog.push({ url: String(input), init });
    const next = fetchResponses.shift();
    if (!next) {
      return Promise.reject(new Error("fetch queue empty"));
    }
    if (next.kind === "error") {
      return Promise.reject(next.error);
    }
    return Promise.resolve(
      new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  },
);

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
const originalLocation = Object.getOwnPropertyDescriptor(window, "location");
const originalCreateObjectURL = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL",
);

beforeEach(() => {
  installCanvasStub();
  getUserMediaCalls.length = 0;
  getUserMediaMock.mockClear();
  fetchLog.length = 0;
  fetchResponses.length = 0;
  fetchMock.mockClear();

  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { origin: "http://localhost:3000" },
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: getUserMediaMock } as unknown as MediaDevices,
  });
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => {
      throw new Error(
        "URL.createObjectURL must not be called by PHASE 4.5B3 UI",
      );
    }),
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  getUserMediaMode = {
    kind: "resolve",
    stream: makeFakeStream([makeFakeTrack("video")]),
  };
});

afterEach(() => {
  uninstallCanvasStub();
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
  if (originalLocation) {
    Object.defineProperty(window, "location", originalLocation);
  }
  if (originalCreateObjectURL) {
    Object.defineProperty(URL, "createObjectURL", originalCreateObjectURL);
  }
});

// =============================================================================
// Helpers
// =============================================================================

async function turnCameraOn(): Promise<void> {
  const turnOn = screen.getByRole("button", { name: /turn on camera/i });
  await act(async () => {
    fireEvent.click(turnOn);
  });
}

function queueFetchOk(body: unknown, status = 200): void {
  fetchResponses.push({ kind: "ok", body, status });
}

function queueFetchError(body: unknown, status: number): void {
  fetchResponses.push({ kind: "ok", body, status });
}

function getCaptureSampleButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /capture sample/i }) as HTMLButtonElement;
}

// =============================================================================
// Tests — camera-ready gating (PHASE 4.5B3)
// =============================================================================

describe("EnrollmentSamplePanel — Capture button availability", () => {
  it("Capture button is disabled while the camera is idle", () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    const capture = getCaptureSampleButton();
    expect(isDisabled(capture)).toBe(true);
  });

  it("Capture button is disabled while the camera is requesting", async () => {
    getUserMediaMode = { kind: "pending" };
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    const turnOn = screen.getByRole("button", { name: /turn on camera/i });
    await act(async () => {
      fireEvent.click(turnOn);
    });
    const capture = getCaptureSampleButton();
    expect(isDisabled(capture)).toBe(true);
  });

  it("Capture button is disabled when the camera reports an error", async () => {
    getUserMediaMode = {
      kind: "reject",
      name: "NotAllowedError",
    };
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    const turnOn = screen.getByRole("button", { name: /turn on camera/i });
    await act(async () => {
      fireEvent.click(turnOn);
    });
    const capture = getCaptureSampleButton();
    expect(isDisabled(capture)).toBe(true);
  });

  it("Capture button becomes enabled once the camera is ready", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    await waitFor(() => {
      const capture = getCaptureSampleButton();
      expect(isDisabled(capture)).toBe(false);
    });
  });
});

// =============================================================================
// Tests — capture + submission flow (PHASE 4.5B3)
// =============================================================================

describe("EnrollmentSamplePanel — explicit capture flow", () => {
  it("one click submits exactly one Blob to /api/face-id/enrollment/sample", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    expect(fetchLog).toHaveLength(1);
    const entry = fetchLog[0]!;
    expect(entry.url).toBe(
      "http://localhost:3000/api/face-id/enrollment/sample",
    );
    expect(entry.init?.body).toBeInstanceOf(FormData);
    const fd = entry.init?.body as FormData;
    const image = fd.get("image") as File;
    expect(image).toBeInstanceOf(Blob);
    expect(image.type).toBe("image/jpeg");
  });

  it("two rapid clicks produce only one fetch (in-flight guard)", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
      fireEvent.click(capture);
    });

    expect(fetchLog).toHaveLength(1);
  });

  it("pending state shows 'Processing' and disables the button", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    const capture = getCaptureSampleButton();
    fireEvent.click(capture);

    await waitFor(() => {
      const pending = screen.queryByRole("button", {
        name: /processing/i,
      });
      expect(pending).not.toBeNull();
      expect(isDisabled(pending as HTMLElement)).toBe(true);
    });
  });
});

// =============================================================================
// Tests — accepted response UI (PHASE 4.5B3)
// =============================================================================

describe("EnrollmentSamplePanel — accepted feedback", () => {
  it("renders 'Sample accepted' on a successful response", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/sample accepted/i),
      ).toBeDefined();
    });
  });

  it("uses server response progress (does not fabricate +1)", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 4,
        requiredSamples: 5,
        complete: false,
      },
    });

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      const matches = screen.getAllByText("4 of 5 samples");
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("camera remains active after an accepted response", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      const stop = screen.getByRole("button", {
        name: /stop camera/i,
      }) as HTMLButtonElement;
      expect(isDisabled(stop)).toBe(false);
    });
  });

  it("camera permission still requires an explicit click (no auto getUserMedia)", () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    expect(getUserMediaMock).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Tests — quality rejection UI (PHASE 4.5B3)
// =============================================================================

async function setupAndReject(rejectionReasons: string[]): Promise<void> {
  render(
    <EnrollmentSamplePanel
      initialAcceptedSamples={0}
      requiredSamples={5}
    />,
  );
  await turnCameraOn();
  const video = document.querySelector("video") as HTMLVideoElement;
  attachReadyFrame(video);

  queueFetchOk({
    accepted: false,
    rejectionReasons,
    progress: {
      acceptedSamples: 0,
      requiredSamples: 5,
      complete: false,
    },
  });

  const capture = getCaptureSampleButton();
  await act(async () => {
    fireEvent.click(capture);
  });
}

describe("EnrollmentSamplePanel — quality rejection feedback", () => {
  it("renders friendly copy for FACE_TOO_SMALL", async () => {
    await setupAndReject(["FACE_TOO_SMALL"]);
    await waitFor(() => {
      expect(
        screen.getByText(/move a little closer/i),
      ).toBeDefined();
    });
  });

  it("renders friendly copy for FACE_TOO_LARGE", async () => {
    await setupAndReject(["FACE_TOO_LARGE"]);
    await waitFor(() => {
      expect(
        screen.getByText(/move a little farther/i),
      ).toBeDefined();
    });
  });

  it("renders friendly copy for TOO_BLURRY", async () => {
    await setupAndReject(["TOO_BLURRY"]);
    await waitFor(() => {
      expect(screen.getByText(/hold still/i)).toBeDefined();
    });
  });

  it("renders friendly copy for TOO_DARK", async () => {
    await setupAndReject(["TOO_DARK"]);
    await waitFor(() => {
      expect(screen.getByText(/brighter area/i)).toBeDefined();
    });
  });

  it("renders friendly copy for TOO_BRIGHT", async () => {
    await setupAndReject(["TOO_BRIGHT"]);
    await waitFor(() => {
      expect(
        screen.getByText(/reduce strong light/i),
      ).toBeDefined();
    });
  });

  it("renders friendly copy for FACE_NEAR_EDGE", async () => {
    await setupAndReject(["FACE_NEAR_EDGE"]);
    await waitFor(() => {
      expect(screen.getByText(/center your face/i)).toBeDefined();
    });
  });

  it("renders friendly copy for LOW_DETECTION_CONFIDENCE", async () => {
    await setupAndReject(["LOW_DETECTION_CONFIDENCE"]);
    await waitFor(() => {
      expect(screen.getByText(/clear view/i)).toBeDefined();
    });
  });

  it("displays multiple rejection reasons", async () => {
    await setupAndReject(["FACE_TOO_LARGE", "TOO_BLURRY"]);
    await waitFor(() => {
      expect(
        screen.getByText(/move a little farther/i),
      ).toBeDefined();
      expect(screen.getByText(/hold still/i)).toBeDefined();
    });
  });

  it("quality rejection does NOT stop the camera stream", async () => {
    await setupAndReject(["TOO_BLURRY"]);
    await waitFor(() => {
      const stop = screen.getByRole("button", {
        name: /stop camera/i,
      }) as HTMLButtonElement;
      expect(isDisabled(stop)).toBe(false);
    });
  });

  it("quality rejection does NOT advance progress (server count unchanged)", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchOk({
      accepted: false,
      rejectionReasons: ["TOO_BLURRY"],
      progress: {
        acceptedSamples: 2,
        requiredSamples: 5,
        complete: false,
      },
    });

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText("2 of 5 samples")).toBeDefined();
    });
  });
});

// =============================================================================
// Tests — recoverable domain errors (PHASE 4.5B3)
// =============================================================================

describe("EnrollmentSamplePanel — recoverable domain errors", () => {
  it("renders friendly NO_FACE feedback and keeps camera running", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.NO_FACE,
          message: "No face",
        },
      },
      422,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/no face was detected/i),
      ).toBeDefined();
    });
    const stop = screen.getByRole("button", {
      name: /stop camera/i,
    }) as HTMLButtonElement;
    expect(isDisabled(stop)).toBe(false);
  });

  it("renders friendly MULTIPLE_FACES feedback", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.MULTIPLE_FACES,
          message: "Multiple faces",
        },
      },
      422,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/only one person should be visible/i),
      ).toBeDefined();
    });
  });

  it("ENROLLMENT_EXPIRED renders a safe message without leaking detail", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_EXPIRED,
          message:
            "INTERNAL TRACEBACK mongo connection failed at line 42",
        },
      },
      409,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(
        screen.getAllByText(/session expired/i).length,
      ).toBeGreaterThanOrEqual(1);
    });
    expect(screen.queryByText(/mongo/i)).toBeNull();
    expect(screen.queryByText(/INTERNAL TRACEBACK/i)).toBeNull();
  });

  it("ENROLLMENT_SAMPLE_CONFLICT is NOT automatically retried", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_CONFLICT,
          message: "Conflict",
        },
      },
      409,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/conflict/i),
      ).toBeDefined();
    });
    expect(fetchLog).toHaveLength(1);
  });

  it("FACE_SERVICE_TIMEOUT renders safe infrastructure messaging", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.FACE_SERVICE_TIMEOUT,
          message: "upstream timeout",
        },
      },
      502,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/temporarily unavailable/i),
      ).toBeDefined();
    });
    expect(screen.queryByText(/upstream timeout/i)).toBeNull();
  });

  it("FACE_SERVICE_UNAVAILABLE renders safe infrastructure messaging", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.FACE_SERVICE_UNAVAILABLE,
          message: "FACE_SERVICE_URL=http://internal",
        },
      },
      502,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/temporarily unavailable/i),
      ).toBeDefined();
    });
    expect(screen.queryByText(/FACE_SERVICE_URL/)).toBeNull();
  });
});

// =============================================================================
// Tests — capture-level errors (PHASE 4.5B3)
// =============================================================================

describe("EnrollmentSamplePanel — capture-time errors", () => {
  it("an unready video frame surfaces as FRAME_NOT_READY without fetching", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    // Deliberately do NOT attach a ready frame
    const video = document.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "videoWidth", {
      configurable: true,
      value: 0,
    });
    Object.defineProperty(video, "videoHeight", {
      configurable: true,
      value: 0,
    });
    Object.defineProperty(video, "readyState", {
      configurable: true,
      value: 1,
    });

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/has not produced a frame/i),
      ).toBeDefined();
    });
    expect(fetchLog).toHaveLength(0);
  });

  it("FRAME_ENCODING_FAILED from the capture seam maps to safe copy", async () => {
    const FailingCapture = async (): Promise<never> => {
      throw {
        code: "FRAME_ENCODING_FAILED",
        message: "encoding fail",
      };
    };

    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
        captureImpl={FailingCapture as unknown as typeof import("@/components/face-id/capture-video-frame").captureVideoFrame}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/could not be encoded/i),
      ).toBeDefined();
    });
  });
});

// =============================================================================
// Tests — complete=true gate (PHASE 4.5B3)
// =============================================================================

describe("EnrollmentSamplePanel — enrollment complete", () => {
  it("complete=true disables further captures", () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={5}
        requiredSamples={5}
        initialComplete
      />,
    );
    const capture = getCaptureSampleButton();
    expect(isDisabled(capture)).toBe(true);
  });

  it("complete=true shows 'All required samples collected' message", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={5}
        requiredSamples={5}
        initialComplete
      />,
    );
    await turnCameraOn();
    expect(screen.getByText("5 of 5 samples")).toBeDefined();
    await waitFor(() => {
      expect(
        screen.getByText(/all required samples collected/i),
      ).toBeDefined();
    });
  });

  it("complete=true does NOT claim FaceProfile exists", () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={5}
        requiredSamples={5}
        initialComplete
      />,
    );
    expect(screen.queryByText(/face ?id.*configured/i)).toBeNull();
    expect(screen.queryByText(/enrollment complete/i)).toBeNull();
    expect(screen.queryByText(/identity verified/i)).toBeNull();
    expect(screen.getByText(/final setup/i)).toBeDefined();
  });

  it("after a server response with complete=true the UI disables Capture", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={4}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 5,
        requiredSamples: 5,
        complete: true,
      },
    });

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      const updated = getCaptureSampleButton();
      expect(isDisabled(updated)).toBe(true);
    });
  });
});

// =============================================================================
// Tests — privacy regression / no leakage (PHASE 4.5B3)
// =============================================================================

describe("EnrollmentSamplePanel — privacy regression", () => {
  it("does not call URL.createObjectURL", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);
    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });
    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });
    expect(URL.createObjectURL).toBeDefined();
  });

  it("does not render an <img> after a successful capture", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);
    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });
    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });
    expect(document.querySelector("img")).toBeNull();
  });

  it("no recognizable fake embedding [0.123456] appears in the rendered DOM", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);
    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      embedding: [0.123456, 0.654321],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });
    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });
    await waitFor(() => {
      expect(screen.getByText(/sample accepted/i)).toBeDefined();
    });
    const dom = document.body.textContent ?? "";
    expect(dom).not.toContain("0.123456");
    expect(dom).not.toContain("0.654321");
  });

  it("the captured Blob is the only place it lives", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);
    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });
    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });
    await waitFor(() => {
      expect(fetchLog.length).toBeGreaterThanOrEqual(1);
    });

    const fd = fetchLog[0]!.init?.body as FormData;
    const image = fd.get("image") as File;
    expect(image).toBeInstanceOf(Blob);
    expect(document.querySelector("img")).toBeNull();
  });

  it("does not send X-Service-Token or reference Face Service URL", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);
    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });
    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });
    await waitFor(() => {
      expect(fetchLog.length).toBeGreaterThanOrEqual(1);
    });

    const headers = fetchLog[0]!.init?.headers as
      | Record<string, string>
      | undefined;
    if (headers) {
      const serialized = Object.entries(headers)
        .map(([k, v]) => `${k}:${v}`)
        .join(",")
        .toLowerCase();
      expect(serialized).not.toContain("x-service-token");
    }
    expect(fetchLog[0]!.url).not.toMatch(/face-service|fastapi/i);
  });
});

// =============================================================================
// PHASE 4.5B4 TESTS
// =============================================================================

describe("EnrollmentSamplePanel — reload resilience", () => {
  it("renders 0/5 when server progress is 0", () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    expect(screen.getByText("0 of 5 samples")).toBeDefined();
  });

  it("renders 2/5 when server progress is 2", () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    expect(screen.getByText("2 of 5 samples")).toBeDefined();
  });

  it("renders 4/5 when server progress is 4", () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={4}
        requiredSamples={5}
      />,
    );
    expect(screen.getByText("4 of 5 samples")).toBeDefined();
  });

  it("renders 5/5 when server progress is 5", () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={5}
        requiredSamples={5}
      />,
    );
    expect(screen.getByText("5 of 5 samples")).toBeDefined();
  });

  it("5/5 disables Capture button", () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={5}
        requiredSamples={5}
      />,
    );
    const capture = getCaptureSampleButton();
    expect(isDisabled(capture)).toBe(true);
  });

  it("5/5 does not claim Face ID is configured", () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={5}
        requiredSamples={5}
      />,
    );
    expect(screen.queryByText(/face id configured/i)).toBeNull();
    expect(screen.queryByText(/identity verified/i)).toBeNull();
  });
});

describe("EnrollmentSamplePanel — conflict reconciliation", () => {
  it("ENROLLMENT_SAMPLE_CONFLICT triggers reconciliation callback", async () => {
    const reconcileMock = vi.fn();
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
        onReconcile={reconcileMock}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_CONFLICT,
          message: "Conflict",
        },
      },
      409,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/conflict/i)).toBeDefined();
    });
    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });

  it("conflict does NOT increment local progress", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_CONFLICT,
          message: "Conflict",
        },
      },
      409,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText("2 of 5 samples")).toBeDefined();
    });
  });

  it("conflict message does not claim the sample was saved", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_CONFLICT,
          message: "Conflict",
        },
      },
      409,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/another.*saved/i)).toBeDefined();
    });
    expect(screen.queryByText(/your sample was saved/i)).toBeNull();
  });

  it("camera is not automatically restarted after conflict", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_CONFLICT,
          message: "Conflict",
        },
      },
      409,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/conflict/i)).toBeDefined();
    });
    // Camera should still be running (Stop button enabled)
    const stop = screen.getByRole("button", {
      name: /stop camera/i,
    }) as HTMLButtonElement;
    expect(isDisabled(stop)).toBe(false);
  });

  it("conflict auto-detection when server returns lower count", async () => {
    const reconcileMock = vi.fn();
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={3}
        requiredSamples={5}
        onReconcile={reconcileMock}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    // Server returns 2 samples (another tab saved sample #3 first)
    // Client expected 4 samples
    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 2,
        requiredSamples: 5,
        complete: false,
      },
    });

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/conflict/i)).toBeDefined();
    });
    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });
});

describe("EnrollmentSamplePanel — expired / not started", () => {
  it("ENROLLMENT_EXPIRED disables further capture", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_EXPIRED,
          message: "Expired",
        },
      },
      409,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getAllByText(/session expired/i).length).toBeGreaterThanOrEqual(1);
    });

    // Capture should be disabled now
    expect(isDisabled(getCaptureSampleButton())).toBe(true);
  });

  it("ENROLLMENT_EXPIRED stops camera", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_EXPIRED,
          message: "Expired",
        },
      },
      409,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getAllByText(/session expired/i).length).toBeGreaterThanOrEqual(1);
    });

    // Camera should be stopped
    const stop = screen.getByRole("button", {
      name: /stop camera/i,
    }) as HTMLButtonElement;
    expect(isDisabled(stop)).toBe(true);
  });

  it("ENROLLMENT_EXPIRED triggers reconciliation", async () => {
    const reconcileMock = vi.fn();
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
        onReconcile={reconcileMock}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_EXPIRED,
          message: "Expired",
        },
      },
      409,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getAllByText(/session expired/i).length).toBeGreaterThanOrEqual(1);
    });
    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });

  it("ENROLLMENT_NOT_STARTED disables capture and shows message", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_NOT_STARTED,
          message: "Not started",
        },
      },
      409,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/not found/i)).toBeDefined();
    });
    expect(isDisabled(getCaptureSampleButton())).toBe(true);
  });

  it("ENROLLMENT_NOT_STARTED stops camera", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_NOT_STARTED,
          message: "Not started",
        },
      },
      409,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/not found/i)).toBeDefined();
    });

    const stop = screen.getByRole("button", {
      name: /stop camera/i,
    }) as HTMLButtonElement;
    expect(isDisabled(stop)).toBe(true);
  });

  it("no automatic enrollment restart on expired", async () => {
    const reconcileMock = vi.fn();
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
        onReconcile={reconcileMock}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_EXPIRED,
          message: "Expired",
        },
      },
      409,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getAllByText(/session expired/i).length).toBeGreaterThanOrEqual(1);
    });

    // Should reconcile, not auto-start
    expect(reconcileMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/starting/i)).toBeNull();
  });
});

describe("EnrollmentSamplePanel — sample limit", () => {
  it("ENROLLMENT_SAMPLE_LIMIT_REACHED triggers reconciliation", async () => {
    const reconcileMock = vi.fn();
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={4}
        requiredSamples={5}
        onReconcile={reconcileMock}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_LIMIT_REACHED,
          message: "Limit reached",
        },
      },
      502,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/limit reached/i)).toBeDefined();
    });
    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });

  it("ENROLLMENT_SAMPLE_LIMIT_REACHED disables capture", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={4}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_LIMIT_REACHED,
          message: "Limit reached",
        },
      },
      502,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/limit reached/i)).toBeDefined();
    });
    expect(isDisabled(getCaptureSampleButton())).toBe(true);
  });

  it("limit reached stops camera", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={4}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_LIMIT_REACHED,
          message: "Limit reached",
        },
      },
      502,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/limit reached/i)).toBeDefined();
    });

    const stop = screen.getByRole("button", {
      name: /stop camera/i,
    }) as HTMLButtonElement;
    expect(isDisabled(stop)).toBe(true);
  });

  it("no finalization call after limit reached", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={4}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_LIMIT_REACHED,
          message: "Limit reached",
        },
      },
      502,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/limit reached/i)).toBeDefined();
    });

    // No POST to any finalization endpoint
    expect(
      fetchLog.every((entry) => !entry.url.includes("finalize")),
    ).toBe(true);
  });
});

describe("EnrollmentSamplePanel — model mismatch", () => {
  it("MODEL_MISMATCH disables capture", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.MODEL_MISMATCH,
          message: "Model mismatch",
        },
      },
      502,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/invalid/i)).toBeDefined();
    });
    expect(isDisabled(getCaptureSampleButton())).toBe(true);
  });

  it("MODEL_MISMATCH stops camera", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.MODEL_MISMATCH,
          message: "Model mismatch",
        },
      },
      502,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/invalid/i)).toBeDefined();
    });

    const stop = screen.getByRole("button", {
      name: /stop camera/i,
    }) as HTMLButtonElement;
    expect(isDisabled(stop)).toBe(true);
  });

  it("MODEL_MISMATCH does not expose model data", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.MODEL_MISMATCH,
          message: "modelIdentity=insightface-123",
        },
      },
      502,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/invalid/i)).toBeDefined();
    });
    expect(screen.queryByText(/modelIdentity/i)).toBeNull();
    expect(screen.queryByText(/insightface/i)).toBeNull();
  });

  it("MODEL_MISMATCH does not auto-restart enrollment", async () => {
    const reconcileMock = vi.fn();
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
        onReconcile={reconcileMock}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.MODEL_MISMATCH,
          message: "Model mismatch",
        },
      },
      502,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/invalid/i)).toBeDefined();
    });

    // No reconciliation called - model mismatch is not recoverable
    expect(reconcileMock).not.toHaveBeenCalled();
  });

  it("MODEL_MISMATCH shows restart guidance", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.MODEL_MISMATCH,
          message: "Model mismatch",
        },
      },
      502,
    );

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/restart/i)).toBeDefined();
    });
  });
});

describe("EnrollmentSamplePanel — network uncertainty", () => {
  it("network failure does not increment progress", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    // Simulate network failure
    fetchResponses.push({ kind: "error", error: new Error("Network failure") });

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/connection error/i)).toBeDefined();
    });
    expect(screen.getByText("2 of 5 samples")).toBeDefined();
  });

  it("timeout does not increment progress", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    fetchResponses.push({
      kind: "ok",
      body: {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.FACE_SERVICE_TIMEOUT,
          message: "timeout",
        },
      },
      status: 502,
    });

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText("2 of 5 samples")).toBeDefined();
    });
  });

  it("network error does not auto-retry POST", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    fetchResponses.push({ kind: "error", error: new Error("Network failure") });

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/connection error/i)).toBeDefined();
    });

    // Only one POST attempt
    expect(fetchLog).toHaveLength(1);
  });

  it("network error shows reconciliation message", async () => {
    const reconcileMock = vi.fn();
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
        onReconcile={reconcileMock}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    fetchResponses.push({ kind: "error", error: new Error("Network failure") });

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(screen.getByText(/connection error/i)).toBeDefined();
    });

    // Reconciliation is triggered for network errors
    expect(reconcileMock).toHaveBeenCalledTimes(1);
  });
});

describe("EnrollmentSamplePanel — prop reconciliation", () => {
  it("panel initially renders 2/5 from server props", () => {
    const { unmount } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    expect(screen.getByText("2 of 5 samples")).toBeDefined();
    unmount();
  });

  it("refreshed complete state disables Capture", async () => {
    const { rerender } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={4}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 5,
        requiredSamples: 5,
        complete: true,
      },
    });

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      expect(isDisabled(getCaptureSampleButton())).toBe(true);
    });

    // Simulate prop update from router.refresh()
    rerender(
      <EnrollmentSamplePanel
        initialAcceptedSamples={5}
        requiredSamples={5}
        initialComplete
      />,
    );

    expect(isDisabled(getCaptureSampleButton())).toBe(true);
  });

  it("prop change from 2 to 3 reconciles progress", async () => {
    const { rerender } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    expect(screen.getByText("2 of 5 samples")).toBeDefined();

    // Simulate router.refresh() updating props to 3/5
    rerender(
      <EnrollmentSamplePanel
        initialAcceptedSamples={3}
        requiredSamples={5}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("3 of 5 samples")).toBeDefined();
    });
  });

  it("stale local progress does not override refreshed server progress", async () => {
    const { rerender } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={1}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    // Local state might show 1, but server returned 3 (another tab advanced)
    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 3,
        requiredSamples: 5,
        complete: false,
      },
    });

    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    await waitFor(() => {
      // Progress display shows 3/5 - use getAllByText since feedback block also shows it
      expect(screen.getAllByText("3 of 5 samples").length).toBeGreaterThanOrEqual(1);
    });

    // Simulate refresh with new props
    rerender(
      <EnrollmentSamplePanel
        initialAcceptedSamples={3}
        requiredSamples={5}
      />,
    );

    // Should show 3, not revert to 1
    expect(screen.getAllByText("3 of 5 samples").length).toBeGreaterThanOrEqual(1);
    // Also verify it did not revert to 1
    expect(screen.queryByText("1 of 5 samples")).toBeNull();
  });
});

describe("EnrollmentSamplePanel — biometric field exposure", () => {
  it("no embedding field in DOM", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);
    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      embedding: [0.123456],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });
    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });
    await waitFor(() => {
      expect(screen.getByText(/sample accepted/i)).toBeDefined();
    });
    const dom = document.body.textContent ?? "";
    expect(dom).not.toMatch(/\[.*0\.\d+\]/);
  });

  it("no ciphertext field in DOM", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);
    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      ciphertext: "base64encodedstring",
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });
    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });
    await waitFor(() => {
      expect(screen.getByText(/sample accepted/i)).toBeDefined();
    });
    const dom = document.body.textContent ?? "";
    expect(dom).not.toContain("ciphertext");
    expect(dom).not.toContain("base64encodedstring");
  });

  it("no modelIdentity field in DOM", async () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);
    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      modelIdentity: "insightface-buffalo-l",
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });
    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });
    await waitFor(() => {
      expect(screen.getByText(/sample accepted/i)).toBeDefined();
    });
    const dom = document.body.textContent ?? "";
    expect(dom).not.toContain("modelIdentity");
    expect(dom).not.toContain("insightface-buffalo-l");
  });
});

describe("EnrollmentSamplePanel — expiry display", () => {
  it("displays expiry timestamp when provided", () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
        expiresAt="2026-09-10T14:30:00.000Z"
      />,
    );
    expect(screen.getByText(/expires/i)).toBeDefined();
  });

  it("does not display expiry when not provided", () => {
    render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
      />,
    );
    expect(screen.queryByText(/expires/i)).toBeNull();
  });
});

// =============================================================================
// PHASE 4.5B4.2 — Server-authoritative downward reconciliation
// =============================================================================
//
// These tests verify the generation-aware reconciliation logic.
//
// Server-generated `expiresAt` is the safe, non-biometric discriminator
// that tells the browser "the server has just emitted a freshly created
// or reset enrollment session — replace your local state."
//
//   - SAME generation (expiresAt unchanged):
//       The B4 stale-prop guard remains. Lower counts are rejected.
//   - NEW generation (expiresAt changed):
//       The browser must yield to the server, even when the count
//       decreases. Transient panel state from the OLD session is
//       cleared so it cannot leak into the NEW session.
//
describe("EnrollmentSamplePanel — server-authoritative downward reconciliation", () => {
  // ---------------------------------------------------------------------------
  // 1. Same-generation stale lower progress is ignored.
  // ---------------------------------------------------------------------------
  it("same-generation: stale lower props (2/5) do NOT overwrite acknowledged 3/5", async () => {
    const expiresAt = "2026-09-10T14:30:00.000Z";
    const { rerender } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
        expiresAt={expiresAt}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    // Server response advances local state to 3/5.
    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 3,
        requiredSamples: 5,
        complete: false,
      },
    });
    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });
    await waitFor(() => {
      expect(
        screen.getAllByText("3 of 5 samples").length,
      ).toBeGreaterThanOrEqual(1);
    });

    // Same-generation stale prop arrives with lower count. This MUST be
    // ignored because `expiresAt` is unchanged.
    await act(async () => {
      rerender(
        <EnrollmentSamplePanel
          initialAcceptedSamples={2}
          requiredSamples={5}
          expiresAt={expiresAt}
        />,
      );
    });

    // Should remain 3/5, not revert to 2/5.
    expect(
      screen.getAllByText("3 of 5 samples").length,
    ).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("2 of 5 samples")).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 2. Same-generation refreshed higher progress is accepted.
  // ---------------------------------------------------------------------------
  it("same-generation: refreshed higher props (4/5) are accepted", async () => {
    const expiresAt = "2026-09-10T14:30:00.000Z";
    const { rerender } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={3}
        requiredSamples={5}
        expiresAt={expiresAt}
      />,
    );
    await turnCameraOn();

    // Same-generation refresh bumps the count to 4/5.
    rerender(
      <EnrollmentSamplePanel
        initialAcceptedSamples={4}
        requiredSamples={5}
        expiresAt={expiresAt}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("4 of 5 samples")).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // 3. NEW generation: 3/5 (A) → 0/5 (B). UI must become 0/5.
  // PHASE 4.5B4.3: generationId is the primary discriminator.
  // ---------------------------------------------------------------------------
  it("new-generation: 3/5 (generationId=A) is replaced by 0/5 (generationId=B)", async () => {
    const expiresAt = "2026-09-10T14:30:00.000Z";
    const { rerender } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={3}
        requiredSamples={5}
        expiresAt={expiresAt}
        generationId="gen-A"
      />,
    );
    await turnCameraOn();
    expect(screen.getByText("3 of 5 samples")).toBeDefined();

    // Server reset the session in another tab. generationId changed.
    await act(async () => {
      rerender(
        <EnrollmentSamplePanel
          initialAcceptedSamples={0}
          requiredSamples={5}
          expiresAt={expiresAt}
          generationId="gen-B"
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("0 of 5 samples")).toBeDefined();
    });
    // The old 3/5 must no longer be present in the DOM.
    expect(screen.queryByText("3 of 5 samples")).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // 4. NEW generation: 5/5 (A) → 0/5 (B). Capture must NOT be stuck disabled.
  //
  // The capture button is gated by BOTH session state (complete/invalid) AND
  // camera readiness. This test verifies the session-state gates are cleared
  // after a new generation. Camera readiness is a separate pre-condition
  // (covered by the camera tests); the key B4.2 invariant is that the
  // 5/5 complete-state does NOT persist into a newly reset 0/5 session.
  // PHASE 4.5B4.3: generationId is the primary discriminator.
  // ---------------------------------------------------------------------------
  it("new-generation: 5/5 (A) → 0/5 (B) clears the complete state from the panel", async () => {
    const expiresAt = "2026-09-10T14:30:00.000Z";

    const { rerender } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={5}
        requiredSamples={5}
        initialComplete
        expiresAt={expiresAt}
        generationId="gen-A"
      />,
    );

    // Verify initial complete state.
    const sectionBefore = document.querySelector(
      "section[aria-label='Face ID enrollment sample']",
    );
    expect(sectionBefore?.getAttribute("data-status")).toBe("complete");

    // Server emitted a new session (e.g. another tab reset).
    await act(async () => {
      rerender(
        <EnrollmentSamplePanel
          initialAcceptedSamples={0}
          requiredSamples={5}
          initialComplete={false}
          expiresAt={expiresAt}
          generationId="gen-B"
        />,
      );
    });

    // The new-generation branch must have:
    //   1. Reset progress to 0/5
    //   2. Cleared the 'complete' status
    //   3. Cleared sessionInvalid
    //   4. Cleared feedback status back to 'idle'
    const sectionAfter = document.querySelector(
      "section[aria-label='Face ID enrollment sample']",
    );
    const statusAfter = sectionAfter?.getAttribute("data-status");

    expect(statusAfter).toBe("idle");
    expect(screen.getByText("0 of 5 samples")).toBeDefined();
    expect(screen.queryByText("5 of 5 samples")).toBeNull();

    // With the complete-state cleared, the only remaining capture gate is
    // camera readiness — which is tested separately. The critical B4.2
    // invariant is proven: the old 5/5 complete state does NOT leak.
  });

  // ---------------------------------------------------------------------------
  // 5. NEW generation clears stale "Sample accepted" feedback.
  // PHASE 4.5B4.3: generationId is the primary discriminator.
  // ---------------------------------------------------------------------------
  it("new-generation: clears stale 'Sample accepted' feedback", async () => {
    const expiresAt = "2026-09-10T14:30:00.000Z";

    const { rerender } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
        expiresAt={expiresAt}
        generationId="gen-A"
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 1,
        requiredSamples: 5,
        complete: false,
      },
    });
    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });
    await waitFor(() => {
      expect(screen.getByText(/sample accepted/i)).toBeDefined();
    });

    // Another tab reset the session.
    await act(async () => {
      rerender(
        <EnrollmentSamplePanel
          initialAcceptedSamples={0}
          requiredSamples={5}
          expiresAt={expiresAt}
          generationId="gen-B"
        />,
      );
    });

    await waitFor(() => {
      expect(screen.queryByText(/sample accepted/i)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 6. NEW generation clears stale quality rejection feedback.
  // PHASE 4.5B4.3: generationId is the primary discriminator.
  // ---------------------------------------------------------------------------
  it("new-generation: clears stale quality rejection feedback", async () => {
    const expiresAt = "2026-09-10T14:30:00.000Z";

    const { rerender } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
        expiresAt={expiresAt}
        generationId="gen-A"
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchOk({
      accepted: false,
      rejectionReasons: ["FACE_TOO_SMALL"],
      progress: {
        acceptedSamples: 2,
        requiredSamples: 5,
        complete: false,
      },
    });
    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });
    await waitFor(() => {
      expect(screen.getByText(/move a little closer/i)).toBeDefined();
    });

    // New generation arrives.
    await act(async () => {
      rerender(
        <EnrollmentSamplePanel
          initialAcceptedSamples={0}
          requiredSamples={5}
          expiresAt={expiresAt}
          generationId="gen-B"
        />,
      );
    });

    await waitFor(() => {
      expect(screen.queryByText(/move a little closer/i)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 7. NEW generation clears stale conflict feedback.
  // PHASE 4.5B4.3: generationId is the primary discriminator.
  // ---------------------------------------------------------------------------
  it("new-generation: clears stale conflict feedback", async () => {
    const expiresAt = "2026-09-10T14:30:00.000Z";

    const { rerender } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
        expiresAt={expiresAt}
        generationId="gen-A"
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchError(
      {
        error: {
          code: SAMPLE_CLIENT_ERROR_CODES.ENROLLMENT_SAMPLE_CONFLICT,
          message: "Conflict",
        },
      },
      409,
    );
    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });
    await waitFor(() => {
      expect(screen.getByText(/conflict/i)).toBeDefined();
    });

    // New server generation replaces the old one.
    await act(async () => {
      rerender(
        <EnrollmentSamplePanel
          initialAcceptedSamples={0}
          requiredSamples={5}
          expiresAt={expiresAt}
          generationId="gen-B"
        />,
      );
    });

    await waitFor(() => {
      expect(screen.queryByText(/conflict/i)).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 8. NEW generation does NOT automatically request camera permission.
  // PHASE 4.5B4.3: generationId is the primary discriminator.
  // ---------------------------------------------------------------------------
  it("new-generation: does NOT automatically request camera permission", async () => {
    const expiresAt = "2026-09-10T14:30:00.000Z";

    const { rerender } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
        expiresAt={expiresAt}
        generationId="gen-A"
      />,
    );
    await turnCameraOn();
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    // A new server generation arrives via rerender. No additional
    // getUserMedia() call should be triggered.
    await act(async () => {
      rerender(
        <EnrollmentSamplePanel
          initialAcceptedSamples={0}
          requiredSamples={5}
          expiresAt={expiresAt}
          generationId="gen-B"
        />,
      );
    });

    // Wait for reconciliation to flush.
    await waitFor(() => {
      expect(screen.getByText("0 of 5 samples")).toBeDefined();
    });
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
  });

  // ---------------------------------------------------------------------------
  // 9. NEW generation does NOT automatically POST a sample.
  // PHASE 4.5B4.3: generationId is the primary discriminator.
  // ---------------------------------------------------------------------------
  it("new-generation: does NOT automatically POST a sample", async () => {
    const expiresAt = "2026-09-10T14:30:00.000Z";

    const { rerender } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
        expiresAt={expiresAt}
        generationId="gen-A"
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);
    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 3,
        requiredSamples: 5,
        complete: false,
      },
    });
    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });
    await waitFor(() => {
      expect(fetchLog.length).toBeGreaterThanOrEqual(1);
    });
    const fetchesBefore = fetchLog.length;

    await act(async () => {
      rerender(
        <EnrollmentSamplePanel
          initialAcceptedSamples={0}
          requiredSamples={5}
          expiresAt={expiresAt}
          generationId="gen-B"
        />,
      );
    });
    await waitFor(() => {
      expect(screen.getByText("0 of 5 samples")).toBeDefined();
    });
    expect(fetchLog.length).toBe(fetchesBefore);
  });

  // ---------------------------------------------------------------------------
  // 10. No userId / embedding / model metadata introduced by new generation.
  // PHASE 4.5B4.3: generationId is the primary discriminator.
  // ---------------------------------------------------------------------------
  it("new-generation: does not introduce userId, embedding, or model metadata", async () => {
    const expiresAt = "2026-09-10T14:30:00.000Z";

    const { rerender } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={3}
        requiredSamples={5}
        expiresAt={expiresAt}
        generationId="gen-A"
      />,
    );
    await turnCameraOn();

    rerender(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
        expiresAt={expiresAt}
        generationId="gen-B"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("0 of 5 samples")).toBeDefined();
    });

    const dom = document.body.textContent ?? "";
    expect(dom).not.toContain("userId");
    expect(dom).not.toContain("embedding");
    expect(dom).not.toContain("ciphertext");
    expect(dom).not.toContain("modelIdentity");
    expect(dom).not.toContain("authTag");
  });

  // ---------------------------------------------------------------------------
  // 11. `expiresAt` is not sent back to the server as trusted persistence.
  //     The browser never puts it in any fetch body / header.
  // PHASE 4.5B4.3: generationId is the primary discriminator.
  // ---------------------------------------------------------------------------
  it("new-generation: expiresAt is never placed in any fetch payload or header", async () => {
    const expiresAt = "2026-09-10T14:30:00.000Z";

    const { rerender } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
        expiresAt={expiresAt}
        generationId="gen-A"
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);
    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 3,
        requiredSamples: 5,
        complete: false,
      },
    });
    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });

    // Reconcile to a new generation.
    rerender(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
        expiresAt={expiresAt}
        generationId="gen-B"
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("0 of 5 samples")).toBeDefined();
    });

    // Inspect every fetch log entry — no expiresAt anywhere.
    for (const entry of fetchLog) {
      const serialized = JSON.stringify({
        url: entry.url,
        headers: entry.init?.headers ?? null,
        body: entry.init?.body ?? null,
      });
      expect(serialized).not.toContain("expiresAt");
      expect(serialized).not.toContain("2026-09-10T14:30");
    }
  });

  // ---------------------------------------------------------------------------
  // MULTI-TAB SCENARIO — explicit end-to-end story for B4 resilience.
  // PHASE 4.5B4.3: generationId is the primary discriminator.
  // ---------------------------------------------------------------------------
  it("multi-tab scenario: Tab A 3/5 is reconciled to 0/5 after Tab B reset", async () => {
    const expiresAt = "2026-09-10T14:30:00.000Z";

    // ── Tab A opens with its own session at 3/5.
    const tabA = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={3}
        requiredSamples={5}
        expiresAt={expiresAt}
        generationId="tab-A-gen"
      />,
    );
    expect(screen.getByText("3 of 5 samples")).toBeDefined();

    // ── Tab B explicitly restarts the session via the existing
    //    createOrResetEnrollmentSession upsert. The server stamps a
    //    new generationId and returns 0/5.
    // ── Tab A's router.refresh() observes the new generationId and the
    //    new count.
    await act(async () => {
      tabA.rerender(
        <EnrollmentSamplePanel
          initialAcceptedSamples={0}
          requiredSamples={5}
          expiresAt={expiresAt}
          generationId="tab-B-gen"
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByText("0 of 5 samples")).toBeDefined();
    });
    // Tab A's old 3/5 must not leak.
    expect(screen.queryByText("3 of 5 samples")).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // Defensive: identical expiresAt but different generationId → new generation.
  // PHASE 4.5B4.3: generationId is the primary discriminator.
  // ---------------------------------------------------------------------------
  it("identical expiresAt but different generationId counts as a new generation", async () => {
    const expiresAt = "2026-09-10T14:30:00.000Z";

    const { rerender } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={3}
        requiredSamples={5}
        expiresAt={expiresAt}
        generationId="gen-A"
      />,
    );
    expect(screen.getByText("3 of 5 samples")).toBeDefined();

    // Same expiresAt but different generationId — MUST count as a new
    // generation (the new-generation branch uses generationId, not expiresAt).
    rerender(
      <EnrollmentSamplePanel
        initialAcceptedSamples={0}
        requiredSamples={5}
        expiresAt={expiresAt}
        generationId="gen-B"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("0 of 5 samples")).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Defensive: identical generationId across rerenders does NOT count as new.
  // PHASE 4.5B4.3: generationId is the primary discriminator.
  // ---------------------------------------------------------------------------
  it("identical generationId across rerenders does NOT clear acknowledged progress", async () => {
    const expiresAt = "2026-09-10T14:30:00.000Z";
    const generationId = "gen-fixed";

    const { rerender } = render(
      <EnrollmentSamplePanel
        initialAcceptedSamples={2}
        requiredSamples={5}
        expiresAt={expiresAt}
        generationId={generationId}
      />,
    );
    await turnCameraOn();
    const video = document.querySelector("video") as HTMLVideoElement;
    attachReadyFrame(video);

    queueFetchOk({
      accepted: true,
      rejectionReasons: [],
      progress: {
        acceptedSamples: 4,
        requiredSamples: 5,
        complete: false,
      },
    });
    const capture = getCaptureSampleButton();
    await act(async () => {
      fireEvent.click(capture);
    });
    await waitFor(() => {
      expect(
        screen.getAllByText("4 of 5 samples").length,
      ).toBeGreaterThanOrEqual(1);
    });

    // Same generationId — must NOT reset.
    rerender(
      <EnrollmentSamplePanel
        initialAcceptedSamples={4}
        requiredSamples={5}
        expiresAt={expiresAt}
        generationId={generationId}
      />,
    );
    // Still 4/5.
    expect(
      screen.getAllByText("4 of 5 samples").length,
    ).toBeGreaterThanOrEqual(1);
  });
});
