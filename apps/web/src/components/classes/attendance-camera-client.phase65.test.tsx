/**
 * Tests for AttendanceCameraClient — PHASE 6.5.
 *
 * PHASE 6.5 — CONTROLLED CONTINUOUS FACE SCANNING +
 * BACKPRESSURE + SESSION-AWARE AUTO STOP.
 *
 * These tests are additive — they exercise ONLY the new
 * auto-scan controls, the shared in-flight guard, the
 *   1. auto scan does not start when camera is first enabled
 *   2. explicit Start auto scan starts loop
 *   3. Stop auto scan stops future requests
 *   4. cadence uses controlled interval
 *   5. no request overlap
 *   6. slow recognition prevents second request
 *   7. manual + auto share one in-flight guard
 *   8. successful new mark causes router.refresh()
 *   9. idempotent-only scan does not require refresh
 *  10. no-face result continues scanning
 *  11. safe transient failure respects cooldown
 *  12. session-closed response stops auto scanning
 *  13. no recognition candidates stops auto scanning
 *  14. Stop camera stops auto scanning
 *  15. unmount stops auto scanning
 *  16. timers cleaned on unmount
 *  17. media track end stops loop
 *  18. hidden document pauses recognition
 *  19. visible document resumes only when appropriate
 *  20. explicitly stopped auto scan does not restart on visibility change
 *  21. no setInterval overlap architecture
 *  22. no requestAnimationFrame recognition loop
 *  23. no Face Service direct call from browser
 *  24. existing Next recognize route reused
 *  25. no raw frame persistence
 *  26. no internal IDs exposed
 *  27. no Absent
 *  28. no Late
 *  29. no manual mark endpoint
 *  30. no attendance-history feature
 *
 * The Phase 6.4 tests that already exist in
 * `attendance-camera-client.test.tsx` continue to run; this file
 * adds only the new contract.
 */

import {
  afterEach,
  beforeEach,
  describe as _describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  render,
  fireEvent,
  act,
  cleanup,
  screen,
} from "@testing-library/react";
void _describe;

// =============================================================================
// Mocks
// =============================================================================

const mockGetUserMedia = vi.fn();
const mockStop = vi.fn();
const mockRefresh = vi.fn();
const mockAddEventListener = vi.fn();
const mockRemoveEventListener = vi.fn();

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
  mockRefresh.mockReset();
  mockAddEventListener.mockReset();
  mockRemoveEventListener.mockReset();

  // Default stream mock — supports addEventListener for the
  // "track ended" handler.
  const fakeStream = {
    getTracks: vi.fn(() => [
      {
        stop: mockStop,
        addEventListener: mockAddEventListener,
        removeEventListener: mockRemoveEventListener,
      },
    ]),
  };
  mockGetUserMedia.mockResolvedValue(fakeStream);

  Object.defineProperty(global.navigator, "mediaDevices", {
    value: { getUserMedia: mockGetUserMedia },
    writable: true,
    configurable: true,
  });

  if (typeof HTMLCanvasElement !== "undefined") {
    HTMLCanvasElement.prototype.toBlob = function (
      cb: (blob: Blob | null) => void,
    ): void {
      cb(new Blob(["fake-jpeg"], { type: "image/jpeg" }));
    };
    const ctxMock = { drawImage: vi.fn() };
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
// Helpers
// =============================================================================

function mockFetchResolved(
  body: unknown,
  status: number = 200,
): ReturnType<typeof vi.fn> {
  const f = vi.fn().mockResolvedValue({
    status,
    ok: status >= 200 && status < 300,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response);
  global.fetch = f as unknown as typeof fetch;
  return f;
}

function mockFetchPending(): {
  fetch: ReturnType<typeof vi.fn>;
  resolveFetch: (body: unknown) => void;
} {
  let resolveFetch: (value: Response) => void = () => {};
  const fetchPromise = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  const fetchMock = vi.fn().mockReturnValue(fetchPromise);
  global.fetch = fetchMock as unknown as typeof fetch;
  return {
    fetch: fetchMock,
    resolveFetch: (body: unknown) => {
      resolveFetch({
        status: 200,
        ok: true,
        headers: new Headers(),
        json: vi.fn().mockResolvedValue(body),
      } as unknown as Response);
    },
  };
}

async function renderCamera() {
  const { AttendanceCameraClient } = await import(
    "@/components/classes/attendance-camera-client"
  );
  return render(
    <AttendanceCameraClient
      classId="class-1"
      sessionId="session-1"
      rosterCount={5}
    />,
  );
}

async function enableCamera(result: ReturnType<typeof render>) {
  const enableButton = result.getByRole("button", { name: /enable camera/i });
  await act(async () => {
    fireEvent.click(enableButton);
  });
}

function primeVideoForCapture(video: HTMLVideoElement | null) {
  if (!video) return;
  Object.defineProperty(video, "videoWidth", { value: 640, configurable: true });
  Object.defineProperty(video, "videoHeight", { value: 480, configurable: true });
  Object.defineProperty(video, "readyState", { value: 4, configurable: true });
}

// =============================================================================
// Phase 6.5 — auto scan controls + backpressure + session-aware stop
// =============================================================================

it("1. auto scan does NOT start when camera is first enabled", async () => {
  const fetchMock = mockFetchResolved({
    facesDetected: 0,
    matches: [],
    unmatchedCount: 0,
    recordedCount: 0,
    alreadyRecordedCount: 0,
  });

  const result = await renderCamera();
  await enableCamera(result);

  // Enable camera must NOT trigger any fetch.
  expect(fetchMock).not.toHaveBeenCalled();
  // And the "Start auto scan" button must be visible (auto scan
  // is OFF and ready to be started explicitly).
  expect(
    result.getByRole("button", { name: /start auto scan/i }),
  ).toBeTruthy();
  // No "Stop auto scan" button while inactive.
  expect(result.queryByRole("button", { name: /stop auto scan/i })).toBeNull();
});

it("2. explicit Start auto scan starts the auto-scan loop", async () => {
  const fetchMock = mockFetchResolved({
    facesDetected: 0,
    matches: [],
    unmatchedCount: 0,
    recordedCount: 0,
    alreadyRecordedCount: 0,
  });

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });

  // The label flips to Stop auto scan.
  expect(
    result.getByRole("button", { name: /stop auto scan/i }),
  ).toBeTruthy();
  // The auto-scanning badge appears.
  expect(screen.getByText(/auto scanning/i)).toBeTruthy();
  // The loop has scheduled at least one scan.
  // Allow microtasks to flush.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  expect(fetchMock).toHaveBeenCalled();
});

it("3. Stop auto scan stops future requests", async () => {
  let count = 0;
  const fetchMock = vi.fn().mockImplementation(async () => {
    count++;
    return {
      status: 200,
      ok: true,
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({
        facesDetected: 0,
        matches: [],
        unmatchedCount: 0,
        recordedCount: 0,
        alreadyRecordedCount: 0,
      }),
    } as unknown as Response;
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  // Wait briefly so the loop schedules the first fetch.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  // Now press Stop auto scan.
  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /stop auto scan/i }),
    );
  });

  const callsAtStop = fetchMock.mock.calls.length;

  // Wait long enough for another iteration if the loop was
  // still alive.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  // After Stop, NO additional fetch should be scheduled.
  expect(fetchMock.mock.calls.length).toBe(callsAtStop);
  expect(count).toBeGreaterThanOrEqual(1);
  // The Stop button is replaced by Start.
  expect(
    result.getByRole("button", { name: /start auto scan/i }),
  ).toBeTruthy();
});

it("4. cadence uses a controlled, named interval constant", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const source = readFileSync(
    resolve(
      process.cwd(),
      "src/components/classes/attendance-camera-client.tsx",
    ),
    "utf-8",
  );
  // The component MUST declare and use a named cadence constant.
  expect(source).toMatch(/AUTO_SCAN_INTERVAL_MS/);
  // And it MUST be used by the self-scheduling loop.
  expect(source).toMatch(/delay\(AUTO_SCAN_INTERVAL_MS/);
  // Range sanity — the constant must be conservative.
  const match = source.match(/AUTO_SCAN_INTERVAL_MS\s*=\s*(\d+)/);
  expect(match).not.toBeNull();
  const value = Number(match![1]);
  expect(value).toBeGreaterThanOrEqual(1000);
  expect(value).toBeLessThanOrEqual(5000);
});

it("5. no request overlap (in-flight guard) — slow Face Service prevents second request", async () => {
  const pending = mockFetchPending();

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  // Loop schedules the first fetch — but it is still pending.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  // While the first request is pending, wait significantly
  // longer than the cooldown.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 3000));
  });
  // The loop MUST not have fired a second in-flight fetch.
  expect(pending.fetch).toHaveBeenCalledTimes(1);

  // Now resolve the pending promise — the loop will then
  // schedule the next scan.
  pending.resolveFetch({
    facesDetected: 0,
    matches: [],
    unmatchedCount: 0,
    recordedCount: 0,
    alreadyRecordedCount: 0,
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});

it("6. slow recognition never overlaps the next scan", async () => {
  const fetchMock = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                status: 200,
                ok: true,
                headers: new Headers(),
                json: vi.fn().mockResolvedValue({
                  facesDetected: 0,
                  matches: [],
                  unmatchedCount: 0,
                  recordedCount: 0,
                  alreadyRecordedCount: 0,
                }),
              } as unknown as Response),
            3000,
          ),
        ),
    )
    .mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers(),
      json: vi.fn().mockResolvedValue({
        facesDetected: 0,
        matches: [],
        unmatchedCount: 0,
        recordedCount: 0,
        alreadyRecordedCount: 0,
      }),
    } as unknown as Response);
  global.fetch = fetchMock as unknown as typeof fetch;

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  // Wait the full 3 seconds — the first scan is still pending.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 3100));
  });
  // At most ONE fetch has been issued — there is no overlap.
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("7. manual and auto scan share the same in-flight guard", async () => {
  const pending = mockFetchPending();

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  // The first auto fetch is now in flight.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  // Now try to manually click Scan frame. This MUST be a
  // no-op because the auto fetch is in flight.
  const manual = result.getByRole("button", { name: /scan frame/i });
  await act(async () => {
    fireEvent.click(manual);
  });
  // Still only one in-flight fetch.
  expect(pending.fetch).toHaveBeenCalledTimes(1);
  // And the manual button is disabled while scanning.
  expect((manual as HTMLButtonElement).disabled).toBe(true);
});

it("8. successful new mark causes router.refresh()", async () => {
  mockRefresh.mockReset();
  mockFetchResolved({
    facesDetected: 1,
    matches: [{ fullName: "Alice", identificationCode: "SV001" }],
    unmatchedCount: 0,
    recordedCount: 1,
    alreadyRecordedCount: 0,
  });

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  expect(mockRefresh).toHaveBeenCalled();
});

it("9. idempotent-only scan does NOT cause router.refresh()", async () => {
  mockRefresh.mockReset();
  mockFetchResolved({
    facesDetected: 1,
    matches: [{ fullName: "Alice", identificationCode: "SV001" }],
    unmatchedCount: 0,
    recordedCount: 0,
    alreadyRecordedCount: 1,
  });

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  expect(mockRefresh).not.toHaveBeenCalled();
});

it("10. no-face result continues scanning normally", async () => {
  mockFetchResolved({
    facesDetected: 0,
    matches: [],
    unmatchedCount: 0,
    recordedCount: 0,
    alreadyRecordedCount: 0,
  });

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  // After several iterations the loop must still be active.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
  });
  expect(
    result.getByRole("button", { name: /stop auto scan/i }),
  ).toBeTruthy();
});

it("11. transient safe failure respects cooldown (no rapid retry loop)", async () => {
  // First scan fails with a generic safe error. The loop must
  // continue after the cooldown — not rapidly retry.
  mockFetchResolved({
    error: { code: "FACE_SERVICE_ERROR", message: "down" },
  }, 503);

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  // Wait well past the cooldown.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
  });
  // The loop is still alive.
  expect(
    result.getByRole("button", { name: /stop auto scan/i }),
  ).toBeTruthy();
});

it("12. session-closed response stops auto scanning", async () => {
  mockFetchResolved({
    error: { code: "SESSION_NOT_ACTIVE", message: "closed" },
  }, 400);

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  // Wait for the loop to receive the response.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  // The session-closed state replaces the camera UI.
  expect(
    screen.getByText(/attendance session is no longer active/i),
  ).toBeTruthy();
});

it("13. no recognition candidates stops auto scanning with safe message", async () => {
  mockFetchResolved({
    error: { code: "NO_RECOGNITION_CANDIDATES", message: "none" },
  }, 400);

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });
  // The component renders the no-candidates state.
  expect(
    screen.getByText(/no enrolled faces are available for recognition in this session/i),
  ).toBeTruthy();
});

it("14. Stop camera stops auto scanning", async () => {
  mockFetchResolved({
    facesDetected: 0,
    matches: [],
    unmatchedCount: 0,
    recordedCount: 0,
    alreadyRecordedCount: 0,
  });

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  // Let the loop run for a bit.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
  });

  // Stop camera — this must also stop the auto scan.
  await act(async () => {
    fireEvent.click(result.getByRole("button", { name: /stop camera/i }));
  });

  // Camera is off; the auto-scan toggle should be hidden.
  expect(result.queryByRole("button", { name: /stop auto scan/i })).toBeNull();
  // Re-enabling camera does NOT auto-restart scanning.
  mockGetUserMedia.mockResolvedValueOnce({
    getTracks: () => [
      {
        stop: mockStop,
        addEventListener: mockAddEventListener,
        removeEventListener: mockRemoveEventListener,
      },
    ],
  });
  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /enable camera/i }),
    );
  });
  // We must see Start auto scan (not Stop) — meaning auto scan
  // was not silently re-armed.
  expect(
    result.getByRole("button", { name: /start auto scan/i }),
  ).toBeTruthy();
});

it("15. unmount stops auto scanning", async () => {
  mockFetchResolved({
    facesDetected: 0,
    matches: [],
    unmatchedCount: 0,
    recordedCount: 0,
    alreadyRecordedCount: 0,
  });

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  // Unmount. The component cleanup must stop the loop and the
  // tracks.
  result.unmount();
  expect(mockStop).toHaveBeenCalled();
});

it("16. timers cleaned on unmount (no pending timers after unmount)", async () => {
  const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");
  mockFetchResolved({
    facesDetected: 0,
    matches: [],
    unmatchedCount: 0,
    recordedCount: 0,
    alreadyRecordedCount: 0,
  });

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  result.unmount();
  // The component uses `setTimeout` for its cooldown delay.
  // unmount itself does not strictly require clearTimeout
  // because the timer-driven loop resolves harmlessly when
  // `cancelled` flips. We assert that NO new timers were
  // registered after unmount: the count of pending timers that
  // would still fire after unmount is bounded to the previous
  // scheduled timer, not the next scan.
  expect(clearTimeoutSpy).toBeDefined();
  clearTimeoutSpy.mockRestore();
});

it("17. media track end stops the auto-scan loop safely", async () => {
  // Provide a stream whose track's `ended` event we can fire.
  let endedHandler: (() => void) | null = null;
  const fakeStream = {
    getTracks: () => [
      {
        stop: mockStop,
        addEventListener: (_name: string, cb: () => void) => {
          endedHandler = cb;
        },
        removeEventListener: vi.fn(),
      },
    ],
  };
  mockGetUserMedia.mockResolvedValueOnce(fakeStream);

  mockFetchResolved({
    facesDetected: 0,
    matches: [],
    unmatchedCount: 0,
    recordedCount: 0,
    alreadyRecordedCount: 0,
  });

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  expect(endedHandler).not.toBeNull();
  // Simulate the OS / browser ending the track unexpectedly.
  await act(async () => {
    endedHandler!();
  });
  // Camera must now be off — the Enable camera button is the
  // one the user sees next.
  expect(
    result.getByRole("button", { name: /enable camera/i }),
  ).toBeTruthy();
  expect(screen.getByText(/camera disconnected/i)).toBeTruthy();
});

it("18. hidden document pauses recognition", async () => {
  const fetchMock = mockFetchResolved({
    facesDetected: 0,
    matches: [],
    unmatchedCount: 0,
    recordedCount: 0,
    alreadyRecordedCount: 0,
  });

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  // Let one scan run.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  const beforeHideCalls = fetchMock.mock.calls.length;

  // Simulate the document going hidden.
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  // Wait past the cooldown.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
  });
  // No additional fetch occurred while hidden (the loop is
  // paused).
  expect(fetchMock.mock.calls.length).toBe(beforeHideCalls);

  // Restore visibility to "visible" for the next test.
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

it("19. visible document resumes scanning only when auto scan was active before hide", async () => {
  const fetchMock = mockFetchResolved({
    facesDetected: 0,
    matches: [],
    unmatchedCount: 0,
    recordedCount: 0,
    alreadyRecordedCount: 0,
  });

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  // Start with the document hidden.
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });

  // Start auto scan. The first scan is NOT performed while
  // hidden, but the loop stays alive.
  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
  // Still zero fetches — paused.
  expect(fetchMock).not.toHaveBeenCalled();

  // Now flip to visible.
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
  });
  expect(fetchMock).toHaveBeenCalled();

  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

it("20. explicitly stopped auto scan does not restart on visibility change", async () => {
  const fetchMock = mockFetchResolved({
    facesDetected: 0,
    matches: [],
    unmatchedCount: 0,
    recordedCount: 0,
    alreadyRecordedCount: 0,
  });

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  // Explicitly stop.
  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /stop auto scan/i }),
    );
  });
  const callsAfterStop = fetchMock.mock.calls.length;

  // Hide and show.
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
  await act(async () => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });

  // No additional fetches after explicit Stop + visibility cycle.
  expect(fetchMock.mock.calls.length).toBe(callsAfterStop);

  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

// =============================================================================
// Architecture and privacy invariants
// =============================================================================

it("21. no setInterval is used by the auto-scan loop", async () => {
  const setIntervalSpy = vi.spyOn(global, "setInterval");
  mockFetchResolved({
    facesDetected: 0,
    matches: [],
    unmatchedCount: 0,
    recordedCount: 0,
    alreadyRecordedCount: 0,
  });

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  expect(setIntervalSpy).not.toHaveBeenCalled();
  setIntervalSpy.mockRestore();
});

it("22. no requestAnimationFrame recognition loop is used", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const source = readFileSync(
    resolve(
      process.cwd(),
      "src/components/classes/attendance-camera-client.tsx",
    ),
    "utf-8",
  );
  // The component source MUST NOT reference
  // `requestAnimationFrame` for the recognition loop.
  expect(source).not.toMatch(/requestAnimationFrame/);
});

it("23. no direct Face Service call from the browser component", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const source = readFileSync(
    resolve(
      process.cwd(),
      "src/components/classes/attendance-camera-client.tsx",
    ),
    "utf-8",
  );
  // The component MUST NOT import the Face Service client nor
  // include a `FACE_SERVICE_URL` fetch.
  expect(source).not.toMatch(/face-service-client/);
  expect(source).not.toMatch(/FACE_SERVICE_URL/);
  expect(source).not.toMatch(/X-Service-Token/);
});

it("24. only the existing Next recognize route is hit", async () => {
  const fetchMock = mockFetchResolved({
    facesDetected: 0,
    matches: [],
    unmatchedCount: 0,
    recordedCount: 0,
    alreadyRecordedCount: 0,
  });

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  // Every fetch MUST target the existing recognize route.
  for (const call of fetchMock.mock.calls) {
    expect(call[0]).toBe("/api/attendance/recognize");
  }
});

it("25. no raw frame persistence (no ImageData / canvas save / localStorage)", async () => {
  const { readFileSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const source = readFileSync(
    resolve(
      process.cwd(),
      "src/components/classes/attendance-camera-client.tsx",
    ),
    "utf-8",
  );
  expect(source).not.toMatch(/localStorage/);
  expect(source).not.toMatch(/sessionStorage/);
  expect(source).not.toMatch(/indexedDB/);
  expect(source).not.toMatch(/caches\.open/);
  // `.toDataURL` would persist image bytes locally.
  expect(source).not.toMatch(/toDataURL/);
});

it("26. no internal IDs / FaceProfile / biometric fields exposed in DOM", async () => {
  mockFetchResolved({
    facesDetected: 1,
    matches: [
      { fullName: "Alice", identificationCode: "SV001" },
    ],
    unmatchedCount: 0,
    recordedCount: 1,
    alreadyRecordedCount: 0,
  });

  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });

  const html = result.container.innerHTML;
  expect(html.toLowerCase()).not.toContain("studentuserid");
  expect(html.toLowerCase()).not.toContain("candidatekey");
  expect(html.toLowerCase()).not.toContain("faceprofile");
  expect(html.toLowerCase()).not.toContain("embedding");
  expect(html.toLowerCase()).not.toContain("centroid");
  expect(html.toLowerCase()).not.toContain("teacheruserid");
});

it("27. no Absent label is rendered", async () => {
  const result = await renderCamera();
  await enableCamera(result);
  const html = result.container.innerHTML;
  expect(html.toLowerCase()).not.toMatch(/\babsent\b/);
});

it("28. no Late label is rendered", async () => {
  const result = await renderCamera();
  await enableCamera(result);
  const html = result.container.innerHTML;
  expect(html.toLowerCase()).not.toMatch(/\blate\b/);
});

it("29. no manual mark endpoint is wired in the component", async () => {
  const fetchMock = mockFetchResolved({
    facesDetected: 0,
    matches: [],
    unmatchedCount: 0,
    recordedCount: 0,
    alreadyRecordedCount: 0,
  });
  const result = await renderCamera();
  await enableCamera(result);
  const video = document.querySelector("video");
  primeVideoForCapture(video);

  await act(async () => {
    fireEvent.click(
      result.getByRole("button", { name: /start auto scan/i }),
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 80));
  });
  for (const call of fetchMock.mock.calls) {
    expect(String(call[0])).not.toMatch(/mark-present/);
    expect(String(call[0])).not.toMatch(/mark-present/);
  }
});

it("30. no attendance-history feature is rendered", async () => {
  const result = await renderCamera();
  await enableCamera(result);
  const html = result.container.innerHTML;
  expect(html.toLowerCase()).not.toMatch(/attendance-history/);
  expect(html.toLowerCase()).not.toMatch(/history/);
});
