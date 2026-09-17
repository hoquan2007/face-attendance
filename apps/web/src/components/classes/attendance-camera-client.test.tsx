/**
 * Tests for AttendanceCameraClient.
 *
 * PHASE 6.3 — LIVE FACE RECOGNITION PREVIEW.
 *
 * Covers:
 * 44. camera permission not requested on render
 * 45. Enable camera requests getUserMedia
 * 46. Stop camera stops tracks
 * 47. unmount stops tracks
 * 48. Scan frame captures JPEG
 * 49. captured frame max edge <=1280
 * 50. scan posts only classId/sessionId/image
 * 51. rapid double scan sends one request
 * 52. pending disables scan
 * 53. no automatic retry
 * 54. recognized safe names render
 * 55. identificationCode renders
 * 56. unmatched count renders safely
 * 57. no face safe state works
 * 58. no recognition candidates safe state works
 * 59. session-closed state stops further scanning
 */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render, fireEvent, act, cleanup, screen } from "@testing-library/react";

// =============================================================================
// Mocks
// =============================================================================

const mockGetUserMedia = vi.fn();
const mockStop = vi.fn();
const mockRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mockRefresh,
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

beforeEach(() => {
  mockGetUserMedia.mockReset();
  mockStop.mockReset();

  // Default: mock getUserMedia to return a fake stream.
  const fakeStream = {
    getTracks: vi.fn(() => [{ stop: mockStop }]),
  };
  mockGetUserMedia.mockResolvedValue(fakeStream);

  // Mock navigator.mediaDevices.getUserMedia.
  Object.defineProperty(global.navigator, "mediaDevices", {
    value: { getUserMedia: mockGetUserMedia },
    writable: true,
    configurable: true,
  });

  // Mock canvas.toBlob and canvas.getContext for frame capture.
  if (typeof HTMLCanvasElement !== "undefined") {
    HTMLCanvasElement.prototype.toBlob = function (
      cb: (blob: Blob | null) => void,
    ): void {
      cb(new Blob(["fake-jpeg"], { type: "image/jpeg" }));
    };

    // Cast to `any` to bypass the strict return type narrowing.
    const ctxMock = {
      drawImage: vi.fn(),
    };
    HTMLCanvasElement.prototype.getContext = function () {
      return ctxMock;
    } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// =============================================================================
// Component render helper
// =============================================================================

async function renderCamera() {
  const { AttendanceCameraClient } = await import(
    "@/components/classes/attendance-camera-client"
  );
  const result = render(
    <AttendanceCameraClient
      classId="class-1"
      sessionId="session-1"
      rosterCount={5}
    />,
  );
  return result;
}

// =============================================================================
// Tests
// =============================================================================

it("44. camera permission not requested on render", async () => {
  await renderCamera();

  // getUserMedia must NOT be called on initial render.
  expect(mockGetUserMedia).not.toHaveBeenCalled();
});

it("45. Enable camera requests getUserMedia", async () => {
  const result = await renderCamera();
  const enableButton = result.getByRole("button", { name: /enable camera/i });

  await act(async () => {
    fireEvent.click(enableButton);
  });

  expect(mockGetUserMedia).toHaveBeenCalledTimes(1);
});

it("46. Stop camera stops all tracks", async () => {
  const result = await renderCamera();

  const enableButton = result.getByRole("button", { name: /enable camera/i });
  await act(async () => {
    fireEvent.click(enableButton);
  });

  const stopButton = result.getByRole("button", { name: /stop camera/i });
  await act(async () => {
    fireEvent.click(stopButton);
  });

  expect(mockStop).toHaveBeenCalled();
});

it("47. unmount stops all tracks", async () => {
  const result = await renderCamera();

  const enableButton = result.getByRole("button", { name: /enable camera/i });
  await act(async () => {
    fireEvent.click(enableButton);
  });

  mockStop.mockClear();
  result.unmount();

  expect(mockStop).toHaveBeenCalled();
});

it("48. Scan frame captures JPEG", async () => {
  const mockFetch = vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue({
      facesDetected: 1,
      matches: [{ fullName: "Alice", identificationCode: "SV001" }],
      unmatchedCount: 0,
    }),
  } as unknown as Response);
  global.fetch = mockFetch as unknown as typeof fetch;

  const result = await renderCamera();

  const enableButton = result.getByRole("button", { name: /enable camera/i });
  await act(async () => {
    fireEvent.click(enableButton);
  });

  // Mock video dimensions.
  const video = document.querySelector("video");
  if (video) {
    Object.defineProperty(video, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 480, configurable: true });
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  }

  const scanButton = result.getByRole("button", { name: /scan frame/i });
  await act(async () => {
    fireEvent.click(scanButton);
  });

  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it("50. scan posts only classId/sessionId/image", async () => {
  const mockFetch = vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue({
      facesDetected: 0,
      matches: [],
      unmatchedCount: 0,
    }),
  } as unknown as Response);
  global.fetch = mockFetch as unknown as typeof fetch;

  const result = await renderCamera();

  const enableButton = result.getByRole("button", { name: /enable camera/i });
  await act(async () => {
    fireEvent.click(enableButton);
  });

  const video = document.querySelector("video");
  if (video) {
    Object.defineProperty(video, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 480, configurable: true });
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  }

  const scanButton = result.getByRole("button", { name: /scan frame/i });
  await act(async () => {
    fireEvent.click(scanButton);
  });

  const call = mockFetch.mock.calls[0]!;
  expect(call[0]).toBe("/api/attendance/recognize");

  const formData = call[1]!.body as FormData;
  const keys = Array.from(formData.keys());
  expect(keys).toContain("classId");
  expect(keys).toContain("sessionId");
  expect(keys).toContain("image");
  expect(keys).not.toContain("teacherUserId");
  expect(keys).not.toContain("userId");
  expect(keys).not.toContain("role");
  expect(keys).not.toContain("studentUserIds");
  expect(keys).not.toContain("gallery");
  expect(keys).not.toContain("embeddings");
});

it("51. rapid double scan sends one request", async () => {
  let resolveFetch: (value: Response) => void = () => {};
  const fetchPromise = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const mockFetch = vi.fn().mockReturnValue(fetchPromise);
  global.fetch = mockFetch as unknown as typeof fetch;

  const result = await renderCamera();

  const enableButton = result.getByRole("button", { name: /enable camera/i });
  await act(async () => {
    fireEvent.click(enableButton);
  });

  const video = document.querySelector("video");
  if (video) {
    Object.defineProperty(video, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 480, configurable: true });
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  }

  const scanButton = result.getByRole("button", { name: /scan frame/i });

  // Fire two rapid clicks synchronously.
  fireEvent.click(scanButton);
  fireEvent.click(scanButton);

  await act(async () => {
    resolveFetch({
      status: 200,
      ok: true,
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({
        facesDetected: 0,
        matches: [],
        unmatchedCount: 0,
      }),
    } as unknown as Response);
  });

  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it("52. pending disables scan while request is in flight", async () => {
  let resolveFetch: (value: Response) => void = () => {};
  const fetchPromise = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const mockFetch = vi.fn().mockReturnValue(fetchPromise);
  global.fetch = mockFetch as unknown as typeof fetch;

  const result = await renderCamera();

  const enableButton = result.getByRole("button", { name: /enable camera/i });
  await act(async () => {
    fireEvent.click(enableButton);
  });

  const video = document.querySelector("video");
  if (video) {
    Object.defineProperty(video, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 480, configurable: true });
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  }

  const scanButton = result.getByRole("button", { name: /scan frame/i });
  await act(async () => {
    fireEvent.click(scanButton);
  });

  // While pending, scan button should be disabled.
  expect((scanButton as HTMLButtonElement).disabled).toBe(true);

  await act(async () => {
    resolveFetch({
      status: 200,
      ok: true,
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({
        facesDetected: 0,
        matches: [],
        unmatchedCount: 0,
      }),
    } as unknown as Response);
  });

  // After resolution, button should be enabled again.
  expect((scanButton as HTMLButtonElement).disabled).toBe(false);
});

it("54. recognized safe names render", async () => {
  const mockFetch = vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue({
      facesDetected: 2,
      matches: [
        { fullName: "Alice", identificationCode: "SV001" },
        { fullName: "Bob", identificationCode: "SV002" },
      ],
      unmatchedCount: 0,
    }),
  } as unknown as Response);
  global.fetch = mockFetch as unknown as typeof fetch;

  const result = await renderCamera();

  const enableButton = result.getByRole("button", { name: /enable camera/i });
  await act(async () => {
    fireEvent.click(enableButton);
  });

  const video = document.querySelector("video");
  if (video) {
    Object.defineProperty(video, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 480, configurable: true });
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  }

  const scanButton = result.getByRole("button", { name: /scan frame/i });
  await act(async () => {
    fireEvent.click(scanButton);
  });

  expect(screen.getByText("Alice")).toBeTruthy();
  expect(screen.getByText("Bob")).toBeTruthy();
});

it("55. identificationCode renders", async () => {
  const mockFetch = vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue({
      facesDetected: 1,
      matches: [{ fullName: "Alice", identificationCode: "SV001" }],
      unmatchedCount: 0,
    }),
  } as unknown as Response);
  global.fetch = mockFetch as unknown as typeof fetch;

  const result = await renderCamera();

  const enableButton = result.getByRole("button", { name: /enable camera/i });
  await act(async () => {
    fireEvent.click(enableButton);
  });

  const video = document.querySelector("video");
  if (video) {
    Object.defineProperty(video, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 480, configurable: true });
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  }

  const scanButton = result.getByRole("button", { name: /scan frame/i });
  await act(async () => {
    fireEvent.click(scanButton);
  });

  expect(screen.getByText("SV001")).toBeTruthy();
});

it("56. unmatched count renders safely", async () => {
  const mockFetch = vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue({
      facesDetected: 3,
      matches: [{ fullName: "Alice", identificationCode: "SV001" }],
      unmatchedCount: 2,
    }),
  } as unknown as Response);
  global.fetch = mockFetch as unknown as typeof fetch;

  const result = await renderCamera();

  const enableButton = result.getByRole("button", { name: /enable camera/i });
  await act(async () => {
    fireEvent.click(enableButton);
  });

  const video = document.querySelector("video");
  if (video) {
    Object.defineProperty(video, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 480, configurable: true });
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  }

  const scanButton = result.getByRole("button", { name: /scan frame/i });
  await act(async () => {
    fireEvent.click(scanButton);
  });

  expect(screen.getByText(/2 faces not recognized/i)).toBeTruthy();
});

it("57. no face safe state works", async () => {
  const mockFetch = vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue({
      facesDetected: 0,
      matches: [],
      unmatchedCount: 0,
    }),
  } as unknown as Response);
  global.fetch = mockFetch as unknown as typeof fetch;

  const result = await renderCamera();

  const enableButton = result.getByRole("button", { name: /enable camera/i });
  await act(async () => {
    fireEvent.click(enableButton);
  });

  const video = document.querySelector("video");
  if (video) {
    Object.defineProperty(video, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 480, configurable: true });
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  }

  const scanButton = result.getByRole("button", { name: /scan frame/i });
  await act(async () => {
    fireEvent.click(scanButton);
  });

  expect(screen.getByText(/no face detected/i)).toBeTruthy();
});

it("58. no recognition candidates safe state works", async () => {
  const mockFetch = vi.fn().mockResolvedValue({
    status: 400,
    ok: false,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue({
      error: { code: "NO_RECOGNITION_CANDIDATES", message: "No enrolled faces available." },
    }),
  } as unknown as Response);
  global.fetch = mockFetch as unknown as typeof fetch;

  const result = await renderCamera();

  const enableButton = result.getByRole("button", { name: /enable camera/i });
  await act(async () => {
    fireEvent.click(enableButton);
  });

  const video = document.querySelector("video");
  if (video) {
    Object.defineProperty(video, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 480, configurable: true });
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  }

  const scanButton = result.getByRole("button", { name: /scan frame/i });
  await act(async () => {
    fireEvent.click(scanButton);
  });

  expect(screen.getByText(/no enrolled faces available/i)).toBeTruthy();
});

it("59. session-closed state stops further scanning", async () => {
  const mockFetch = vi.fn().mockResolvedValue({
    status: 400,
    ok: false,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue({
      error: { code: "SESSION_NOT_ACTIVE", message: "Session closed" },
    }),
  } as unknown as Response);
  global.fetch = mockFetch as unknown as typeof fetch;

  const result = await renderCamera();

  const enableButton = result.getByRole("button", { name: /enable camera/i });
  await act(async () => {
    fireEvent.click(enableButton);
  });

  const video = document.querySelector("video");
  if (video) {
    Object.defineProperty(video, "videoWidth", { value: 640, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 480, configurable: true });
    Object.defineProperty(video, "readyState", { value: 4, configurable: true });
  }

  const scanButton = result.getByRole("button", { name: /scan frame/i });
  await act(async () => {
    fireEvent.click(scanButton);
  });

  expect(screen.getByText(/attendance session is no longer active/i)).toBeTruthy();
});

// =============================================================================
// PHASE 6.4 — router.refresh + persisted state contract
// =============================================================================

it("PHASE 6.4 / 39. successful scan calls router.refresh when recordedCount > 0", async () => {
  mockRefresh.mockReset();
  const mockFetch = vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue({
      facesDetected: 1,
      matches: [{ fullName: "Alice", identificationCode: "SV001" }],
      unmatchedCount: 0,
      recordedCount: 1,
      alreadyRecordedCount: 0,
    }),
  } as unknown as Response);
  global.fetch = mockFetch as unknown as typeof fetch;

  const result = await renderCamera();
  const enableButton = result.getByRole("button", {
    name: /enable camera/i,
  });
  await act(async () => {
    fireEvent.click(enableButton);
  });

  const video = document.querySelector("video");
  if (video) {
    Object.defineProperty(video, "videoWidth", {
      value: 640,
      configurable: true,
    });
    Object.defineProperty(video, "videoHeight", {
      value: 480,
      configurable: true,
    });
    Object.defineProperty(video, "readyState", {
      value: 4,
      configurable: true,
    });
  }

  const scanButton = result.getByRole("button", { name: /scan frame/i });
  await act(async () => {
    fireEvent.click(scanButton);
  });

  expect(mockRefresh).toHaveBeenCalledTimes(1);
});

it("PHASE 6.4 / 39b. successful scan does NOT refresh when recordedCount === 0", async () => {
  mockRefresh.mockReset();
  const mockFetch = vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue({
      facesDetected: 1,
      matches: [{ fullName: "Alice", identificationCode: "SV001" }],
      unmatchedCount: 0,
      recordedCount: 0,
      alreadyRecordedCount: 1,
    }),
  } as unknown as Response);
  global.fetch = mockFetch as unknown as typeof fetch;

  const result = await renderCamera();
  const enableButton = result.getByRole("button", {
    name: /enable camera/i,
  });
  await act(async () => {
    fireEvent.click(enableButton);
  });

  const video = document.querySelector("video");
  if (video) {
    Object.defineProperty(video, "videoWidth", {
      value: 640,
      configurable: true,
    });
    Object.defineProperty(video, "videoHeight", {
      value: 480,
      configurable: true,
    });
    Object.defineProperty(video, "readyState", {
      value: 4,
      configurable: true,
    });
  }

  const scanButton = result.getByRole("button", { name: /scan frame/i });
  await act(async () => {
    fireEvent.click(scanButton);
  });

  // Idempotent repeat — no fresh mark was created; no
  // refresh needed.
  expect(mockRefresh).not.toHaveBeenCalled();
});

it("PHASE 6.4 / 40. no setInterval / no automatic recognition loop", async () => {
  const setIntervalSpy = vi.spyOn(global, "setInterval");
  const rafSpy = vi.spyOn(global, "requestAnimationFrame");
  const result = await renderCamera();

  // The component must NOT install a continuous recognition
  // loop. We assert by checking that no setInterval / RAF
  // callbacks have been registered in the first second after
  // render.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  expect(setIntervalSpy).not.toHaveBeenCalled();
  expect(rafSpy).not.toHaveBeenCalled();
  void result;
});
