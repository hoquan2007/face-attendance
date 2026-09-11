/**
 * Tests for the `useFaceCamera` React hook.
 *
 * PHASE 4.5A — Browser Camera Foundation.
 *
 * These tests drive the hook through `@testing-library/react`'s
 * `renderHook`, mock `navigator.mediaDevices.getUserMedia`, and
 * verify the lifecycle invariants required by PHASE 4.5A:
 *
 *   1.  initial state is idle
 *   2.  getUserMedia is NOT called on mount
 *   3.  explicit start calls getUserMedia exactly once
 *   4.  audio is requested as false
 *   5.  video constraints request a user-facing camera
 *   6.  successful stream reaches the ready state
 *   7.  successful stream attaches to video.srcObject
 *   8.  stopCamera stops all stream tracks
 *   9.  stopCamera detaches / clears the video srcObject
 *   10. component unmount stops tracks
 *   11. permission denial maps to CAMERA_PERMISSION_DENIED
 *   12. missing camera maps to CAMERA_NOT_FOUND
 *   13. NotReadableError maps to CAMERA_IN_USE
 *   14. insecure context maps to CAMERA_INSECURE_CONTEXT
 *   15. unknown error maps to CAMERA_UNAVAILABLE
 *   16. error shape does not expose raw stack information
 *   17. retry after error can request camera again
 *   18. repeated start does not leak multiple active streams
 *   19. no microphone permission is requested
 *   20. no enrollment-sample API call is made
 *
 * `navigator.mediaDevices`, `MediaStream`, and `MediaStreamTrack`
 * are stubbed via a tiny in-test fake — we never read the developer's
 * real webcam during automated tests.
 */

import { act, renderHook } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { CAMERA_ERROR_CODES } from "@/components/face-id/camera-constants";
import { useFaceCamera } from "@/components/face-id/use-face-camera";

// =============================================================================
// MediaStream / MediaStreamTrack fakes
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

// =============================================================================
// MediaDevices fake
// =============================================================================

/**
 * Captures the constraints passed to `getUserMedia` and resolves with
 * a controllable stream. The `mode` controls the rejection / resolve
 * behaviour per test.
 */
type GetUserMediaMode =
  | { kind: "resolve"; stream: FakeStream }
  | { kind: "reject"; name: string; message?: string }
  | { kind: "queue"; stream: FakeStream }
  | { kind: "deferred"; stream: FakeStream };

interface GetUserMediaCall {
  audio: boolean | MediaTrackConstraints;
  video: boolean | MediaTrackConstraints;
}

/**
 * Resolvers for the currently-pending deferred `getUserMedia` call.
 * Populated by the mock when `mode === "deferred"` and the call has
 * not yet been completed. The concurrency guard under test MUST keep
 * these from being populated twice.
 */
interface DeferredResolvers {
  resolve: (stream: FakeStream) => void;
  reject: (err: { name: string; message?: string }) => void;
}
let pendingDeferred: DeferredResolvers | null = null;

const getUserMediaCalls: GetUserMediaCall[] = [];
let getUserMediaMode: GetUserMediaMode = {
  kind: "resolve",
  stream: makeFakeStream([makeFakeTrack("video")]),
};

const getUserMediaMock = vi.fn((constraints: MediaStreamConstraints) => {
  getUserMediaCalls.push({
    audio: constraints.audio as boolean | MediaTrackConstraints,
    video: constraints.video as boolean | MediaTrackConstraints,
  });

  if (getUserMediaMode.kind === "resolve") {
    return Promise.resolve(
      getUserMediaMode.stream as unknown as MediaStream,
    );
  }
  if (getUserMediaMode.kind === "reject") {
    return Promise.reject({
      name: getUserMediaMode.name,
      message: getUserMediaMode.message ?? "rejected",
    });
  }
  if (getUserMediaMode.kind === "deferred") {
    return new Promise<MediaStream>((resolve, reject) => {
      pendingDeferred = {
        resolve: (stream) => {
          pendingDeferred = null;
          resolve(stream as unknown as MediaStream);
        },
        reject: (err) => {
          pendingDeferred = null;
          reject(err);
        },
      };
    });
  }
  // queue mode — never resolves on its own.
  return new Promise<MediaStream>(() => {
    /* never */
  });
});

// Minimal MediaStream / MediaStreamTrack class shapes used by the
// hook. We deliberately use classes so `instanceof MediaStream`
// checks inside the hook behave predictably.
class FakeMediaStream {
  public tracks: FakeTrack[];
  constructor(tracks: FakeTrack[]) {
    this.tracks = tracks;
  }
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
}

class FakeMediaStreamTrack {
  public kind: string;
  public stopped: boolean;
  constructor(kind: string) {
    this.kind = kind;
    this.stopped = false;
  }
  stop(): void {
    this.stopped = true;
  }
}

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

function setSecureContext(value: boolean): void {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value,
  });
}

function setMediaDevices(devices: MediaDevices | undefined): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: devices,
  });
}

beforeEach(() => {
  // Default to a secure context + working mediaDevices mock.
  setSecureContext(true);
  setMediaDevices({
    getUserMedia: getUserMediaMock,
  } as unknown as MediaDevices);

  getUserMediaCalls.length = 0;
  getUserMediaMock.mockClear();
  getUserMediaMode = {
    kind: "resolve",
    stream: makeFakeStream([makeFakeTrack("video")]),
  };
  pendingDeferred = null;

  // Install our fakes on the global scope so `instanceof` checks
  // succeed when the hook uses them. We do NOT replace the real
  // classes when they exist — only add ours.
  Object.defineProperty(globalThis, "FakeMediaStream", {
    configurable: true,
    value: FakeMediaStream,
  });
  Object.defineProperty(globalThis, "FakeMediaStreamTrack", {
    configurable: true,
    value: FakeMediaStreamTrack,
  });
});

afterEach(() => {
  // Restore globals to avoid leaking into other test files.
  if (originalMediaDevices) {
    Object.defineProperty(
      navigator,
      "mediaDevices",
      originalMediaDevices,
    );
  } else {
    delete (navigator as unknown as { mediaDevices?: MediaDevices })
      .mediaDevices;
  }
  if (originalIsSecureContext) {
    Object.defineProperty(
      window,
      "isSecureContext",
      originalIsSecureContext,
    );
  } else {
    delete (window as unknown as { isSecureContext?: boolean })
      .isSecureContext;
  }
});

// =============================================================================
// Tests
// =============================================================================

describe("useFaceCamera — initial state", () => {
  it("starts in idle state with no error", () => {
    const { result } = renderHook(() => useFaceCamera());
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.isReady).toBe(false);
  });

  it("does NOT call getUserMedia on mount", () => {
    renderHook(() => useFaceCamera());
    expect(getUserMediaMock).not.toHaveBeenCalled();
    expect(getUserMediaCalls).toHaveLength(0);
  });

  it("exposes a videoRef object", () => {
    const { result } = renderHook(() => useFaceCamera());
    expect(result.current.videoRef).toBeDefined();
    expect(typeof result.current.videoRef).toBe("object");
  });
});

describe("useFaceCamera — explicit start", () => {
  it("calls getUserMedia exactly once when startCamera is invoked", async () => {
    const { result } = renderHook(() => useFaceCamera());

    await act(async () => {
      await result.current.startCamera();
    });

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
  });

  it("requests audio: false (no microphone)", async () => {
    const { result } = renderHook(() => useFaceCamera());

    await act(async () => {
      await result.current.startCamera();
    });

    expect(getUserMediaCalls).toHaveLength(1);
    expect(getUserMediaCalls[0]?.audio).toBe(false);
  });

  it("requests user-facing video constraints with 1280x720 ideal", async () => {
    const { result } = renderHook(() => useFaceCamera());

    await act(async () => {
      await result.current.startCamera();
    });

    const video = getUserMediaCalls[0]?.video as MediaTrackConstraints;
    expect(video.facingMode).toBe("user");
    const width = video.width as { ideal: number };
    const height = video.height as { ideal: number };
    expect(width.ideal).toBe(1280);
    expect(height.ideal).toBe(720);
  });

  it("transitions to ready state and clears error after a successful start", async () => {
    const { result } = renderHook(() => useFaceCamera());

    await act(async () => {
      await result.current.startCamera();
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeNull();
    expect(result.current.isReady).toBe(true);
  });

  it("attaches the active stream to videoRef.current.srcObject", async () => {
    const stream = makeFakeStream([makeFakeTrack("video")]);
    getUserMediaMode = { kind: "resolve", stream };

    const { result } = renderHook(() => useFaceCamera());

    // Attach a fake <video> element to the ref.
    const fakeVideo = {
      srcObject: null as unknown,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result.current.videoRef as any).current = fakeVideo;

    await act(async () => {
      await result.current.startCamera();
    });

    expect(fakeVideo.srcObject).toBe(stream);
  });
});

describe("useFaceCamera — stopCamera", () => {
  it("stops every active track on stopCamera", async () => {
    const trackA = makeFakeTrack("video");
    const trackB = makeFakeTrack("video");
    const stream = makeFakeStream([trackA, trackB]);
    getUserMediaMode = { kind: "resolve", stream };

    const { result } = renderHook(() => useFaceCamera());
    await act(async () => {
      await result.current.startCamera();
    });

    act(() => {
      result.current.stopCamera();
    });

    expect(trackA.stopped).toBe(true);
    expect(trackB.stopped).toBe(true);
  });

  it("detaches the stream from the video element on stopCamera", async () => {
    const stream = makeFakeStream([makeFakeTrack("video")]);
    getUserMediaMode = { kind: "resolve", stream };

    const { result } = renderHook(() => useFaceCamera());
    const fakeVideo = {
      srcObject: null as unknown,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result.current.videoRef as any).current = fakeVideo;

    await act(async () => {
      await result.current.startCamera();
    });
    expect(fakeVideo.srcObject).toBe(stream);

    act(() => {
      result.current.stopCamera();
    });
    expect(fakeVideo.srcObject).toBeNull();
  });

  it("returns to idle state with no error after stopCamera", async () => {
    const { result } = renderHook(() => useFaceCamera());
    await act(async () => {
      await result.current.startCamera();
    });
    expect(result.current.status).toBe("ready");

    act(() => {
      result.current.stopCamera();
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.isReady).toBe(false);
  });

  it("is safe to call when no stream is active", () => {
    const { result } = renderHook(() => useFaceCamera());
    expect(() => {
      act(() => {
        result.current.stopCamera();
      });
    }).not.toThrow();
  });
});

describe("useFaceCamera — cleanup on unmount", () => {
  it("stops active tracks when the hook unmounts", async () => {
    const track = makeFakeTrack("video");
    const stream = makeFakeStream([track]);
    getUserMediaMode = { kind: "resolve", stream };

    const { result, unmount } = renderHook(() => useFaceCamera());
    await act(async () => {
      await result.current.startCamera();
    });
    expect(track.stopped).toBe(false);

    unmount();
    expect(track.stopped).toBe(true);
  });

  it("does not throw when unmounting with no active stream", () => {
    const { unmount } = renderHook(() => useFaceCamera());
    expect(() => unmount()).not.toThrow();
  });
});

describe("useFaceCamera — error mapping", () => {
  it("maps NotAllowedError to CAMERA_PERMISSION_DENIED", async () => {
    getUserMediaMode = { kind: "reject", name: "NotAllowedError" };
    const { result } = renderHook(() => useFaceCamera());

    await act(async () => {
      await result.current.startCamera();
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.code).toBe(
      CAMERA_ERROR_CODES.CAMERA_PERMISSION_DENIED,
    );
  });

  it("maps NotFoundError to CAMERA_NOT_FOUND", async () => {
    getUserMediaMode = { kind: "reject", name: "NotFoundError" };
    const { result } = renderHook(() => useFaceCamera());

    await act(async () => {
      await result.current.startCamera();
    });

    expect(result.current.error?.code).toBe(
      CAMERA_ERROR_CODES.CAMERA_NOT_FOUND,
    );
  });

  it("maps NotReadableError to CAMERA_IN_USE", async () => {
    getUserMediaMode = { kind: "reject", name: "NotReadableError" };
    const { result } = renderHook(() => useFaceCamera());

    await act(async () => {
      await result.current.startCamera();
    });

    expect(result.current.error?.code).toBe(
      CAMERA_ERROR_CODES.CAMERA_IN_USE,
    );
  });

  it("maps an insecure context to CAMERA_INSECURE_CONTEXT", async () => {
    setSecureContext(false);
    const { result } = renderHook(() => useFaceCamera());

    await act(async () => {
      await result.current.startCamera();
    });

    expect(result.current.error?.code).toBe(
      CAMERA_ERROR_CODES.CAMERA_INSECURE_CONTEXT,
    );
    // getUserMedia must NOT have been called in an insecure context.
    expect(getUserMediaMock).not.toHaveBeenCalled();
  });

  it("maps an unknown error to CAMERA_UNAVAILABLE", async () => {
    getUserMediaMode = {
      kind: "reject",
      name: "SomeBrowserSpecificError",
    };
    const { result } = renderHook(() => useFaceCamera());

    await act(async () => {
      await result.current.startCamera();
    });

    expect(result.current.error?.code).toBe(
      CAMERA_ERROR_CODES.CAMERA_UNAVAILABLE,
    );
  });

  it("error shape does NOT include the raw exception stack", async () => {
    getUserMediaMode = {
      kind: "reject",
      name: "NotAllowedError",
      message: "INTERNAL-DETAIL-DO-NOT-LEAK",
    };
    const { result } = renderHook(() => useFaceCamera());

    await act(async () => {
      await result.current.startCamera();
    });

    const serialized = JSON.stringify(result.current.error);
    expect(serialized).not.toContain("INTERNAL-DETAIL-DO-NOT-LEAK");
    expect(serialized).not.toContain("NotAllowedError");
  });

  it("supports retry after an error", async () => {
    // First call rejects.
    getUserMediaMode = { kind: "reject", name: "NotAllowedError" };
    const { result } = renderHook(() => useFaceCamera());

    await act(async () => {
      await result.current.startCamera();
    });
    expect(result.current.status).toBe("error");

    // Second call resolves.
    const track = makeFakeTrack("video");
    getUserMediaMode = {
      kind: "resolve",
      stream: makeFakeStream([track]),
    };

    await act(async () => {
      await result.current.startCamera();
    });

    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeNull();
  });
});

describe("useFaceCamera — repeated start is safe", () => {
  it("does NOT leak multiple MediaStreams when start is called twice", async () => {
    const firstStream = makeFakeStream([makeFakeTrack("video")]);
    getUserMediaMode = { kind: "resolve", stream: firstStream };

    const { result } = renderHook(() => useFaceCamera());

    await act(async () => {
      await result.current.startCamera();
    });

    // Replace the mode so a hypothetical second `getUserMedia` would
    // produce a clearly-distinct stream. The hook MUST NOT call it.
    const secondTrack = makeFakeTrack("video");
    const secondStream = makeFakeStream([secondTrack]);
    getUserMediaMode = { kind: "resolve", stream: secondStream };

    await act(async () => {
      await result.current.startCamera();
    });

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(firstStream.tracks[0]?.stopped).toBe(false);
    expect(secondStream.tracks[0]?.stopped).toBe(false);
    expect(result.current.status).toBe("ready");
  });
});

describe("useFaceCamera — no server-side surface", () => {
  it("never references the enrollment-sample API", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 200 }));

    const { result } = renderHook(() => useFaceCamera());

    await act(async () => {
      await result.current.startCamera();
    });

    const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(
      calledUrls.some((u) => u.includes("/api/face-id/enrollment/sample")),
    ).toBe(false);
    fetchSpy.mockRestore();
  });
});

// =============================================================================
// PHASE 4.5A.1 — Camera start concurrency / lifecycle hardening
// =============================================================================

describe("useFaceCamera — start concurrency guard", () => {
  it("two synchronous startCamera() calls while getUserMedia is pending fire getUserMedia exactly ONCE", async () => {
    // Use deferred mode so the FIRST getUserMedia is real-pending
    // until we resolve it explicitly below.
    const stream = makeFakeStream([makeFakeTrack("video")]);
    getUserMediaMode = { kind: "deferred", stream };

    const { result } = renderHook(() => useFaceCamera());

    // Fire two starts without awaiting — both run their synchronous
    // prelude before either await yields. Without the in-flight
    // guard both would record a getUserMedia call.
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => {
      first = result.current.startCamera();
      second = result.current.startCamera();
    });

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    // Resolve the pending request and let both promises settle.
    await act(async () => {
      pendingDeferred?.resolve(stream);
      await Promise.all([first, second]);
    });

    // The deferred promise was consumed by exactly one getUserMedia
    // invocation — no leak through a second pending call.
    expect(pendingDeferred).toBeNull();
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeNull();
  });

  it("a pending request that resolves becomes the single active stream — no second stream attaches", async () => {
    const pendingStream = makeFakeStream([makeFakeTrack("video")]);
    getUserMediaMode = { kind: "deferred", stream: pendingStream };

    const { result } = renderHook(() => useFaceCamera());
    const fakeVideo = { srcObject: null as unknown };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result.current.videoRef as any).current = fakeVideo;

    let start: Promise<void> | undefined;
    act(() => {
      start = result.current.startCamera();
    });
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingDeferred?.resolve(pendingStream);
      await start;
    });

    // The single active stream is the one we resolved with.
    expect(fakeVideo.srcObject).toBe(pendingStream);
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeNull();
  });

  it("a failed pending request releases the in-flight guard so a retry can run", async () => {
    getUserMediaMode = {
      kind: "deferred",
      stream: makeFakeStream([makeFakeTrack("video")]),
    };

    const { result } = renderHook(() => useFaceCamera());

    let first: Promise<void> | undefined;
    act(() => {
      first = result.current.startCamera();
    });
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingDeferred?.reject({ name: "NotAllowedError" });
      await first;
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.code).toBe(
      CAMERA_ERROR_CODES.CAMERA_PERMISSION_DENIED,
    );

    // After the rejection, the in-flight guard MUST be released so a
    // deliberate retry can issue a new getUserMedia.
    const retryTrack = makeFakeTrack("video");
    const retryStream = makeFakeStream([retryTrack]);
    getUserMediaMode = { kind: "resolve", stream: retryStream };

    await act(async () => {
      await result.current.startCamera();
    });

    expect(getUserMediaMock).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("ready");
    expect(result.current.error).toBeNull();
  });

  it("explicit user retry after a failed start produces a new getUserMedia call", async () => {
    getUserMediaMode = { kind: "reject", name: "NotAllowedError" };
    const { result } = renderHook(() => useFaceCamera());

    await act(async () => {
      await result.current.startCamera();
    });
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("error");

    const retryTrack = makeFakeTrack("video");
    const retryStream = makeFakeStream([retryTrack]);
    getUserMediaMode = { kind: "resolve", stream: retryStream };

    await act(async () => {
      await result.current.startCamera();
    });

    expect(getUserMediaMock).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe("ready");
    expect(retryTrack.stopped).toBe(false);
  });

  it("unmount while getUserMedia is pending stops the resolved stream's tracks", async () => {
    const stream = makeFakeStream([makeFakeTrack("video")]);
    getUserMediaMode = { kind: "deferred", stream };

    const { result, unmount } = renderHook(() => useFaceCamera());

    let start: Promise<void> | undefined;
    act(() => {
      start = result.current.startCamera();
    });
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    // Unmount while the request is still pending. The hook cleanup
    // marks the component as unmounted.
    unmount();

    // Now the deferred request resolves. The hook MUST stop every
    // track rather than leak the hardware or attach to a detached
    // <video>.
    await act(async () => {
      pendingDeferred?.resolve(stream);
      await start;
    });

    expect(stream.tracks[0]?.stopped).toBe(true);
    // No second getUserMedia was issued as a side effect.
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
  });

  it("stopCamera while getUserMedia is pending discards the resolved stream and does not make it active", async () => {
    const stream = makeFakeStream([makeFakeTrack("video")]);
    getUserMediaMode = { kind: "deferred", stream };

    const { result } = renderHook(() => useFaceCamera());
    const fakeVideo = { srcObject: null as unknown };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (result.current.videoRef as any).current = fakeVideo;

    let start: Promise<void> | undefined;
    act(() => {
      start = result.current.startCamera();
    });
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    // User clicks stop BEFORE the request resolves.
    act(() => {
      result.current.stopCamera();
    });

    // The request resolves later.
    await act(async () => {
      pendingDeferred?.resolve(stream);
      await start;
    });

    // The resolved stream MUST be stopped, NOT attached as the
    // active preview, and the hook MUST end in the idle state that
    // stopCamera establishes.
    expect(stream.tracks[0]?.stopped).toBe(true);
    expect(fakeVideo.srcObject).toBeNull();
    expect(result.current.status).toBe("idle");
    expect(result.current.error).toBeNull();
  });

  it("repeated startCamera while ready does not issue a second getUserMedia call", async () => {
    const stream = makeFakeStream([makeFakeTrack("video")]);
    getUserMediaMode = { kind: "resolve", stream };

    const { result } = renderHook(() => useFaceCamera());

    await act(async () => {
      await result.current.startCamera();
    });
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("ready");

    // Multiple rapid starts in the ready state must all be no-ops.
    await act(async () => {
      await result.current.startCamera();
      await result.current.startCamera();
      await result.current.startCamera();
    });

    expect(getUserMediaMock).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("ready");
    expect(stream.tracks[0]?.stopped).toBe(false);
  });

  it("no active MediaStream leak across any concurrency / lifecycle scenario", async () => {
    // This test exercises the full matrix of scenarios end-to-end,
    // verifying there is never more than one non-stopped stream in
    // flight at any observable point.

    // ---- Scenario A: two concurrent starts, resolve one ----
    const streamA = makeFakeStream([makeFakeTrack("video")]);
    getUserMediaMode = { kind: "deferred", stream: streamA };

    const { result } = renderHook(() => useFaceCamera());
    let p1: Promise<void> | undefined;
    let p2: Promise<void> | undefined;
    act(() => {
      p1 = result.current.startCamera();
      p2 = result.current.startCamera();
    });
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pendingDeferred?.resolve(streamA);
      await Promise.all([p1, p2]);
    });
    expect(streamA.tracks[0]?.stopped).toBe(false);
    expect(getUserMediaMock).toHaveBeenCalledTimes(1);

    // ---- Scenario B: stop, then start (clean restart) ----
    act(() => {
      result.current.stopCamera();
    });
    expect(streamA.tracks[0]?.stopped).toBe(true);

    const streamB = makeFakeStream([makeFakeTrack("video")]);
    getUserMediaMode = { kind: "resolve", stream: streamB };
    await act(async () => {
      await result.current.startCamera();
    });
    expect(getUserMediaMock).toHaveBeenCalledTimes(2);
    expect(streamB.tracks[0]?.stopped).toBe(false);

    // ---- Scenario C: stop while a deferred request is pending ----
    act(() => {
      result.current.stopCamera();
    });
    expect(streamB.tracks[0]?.stopped).toBe(true);

    const streamC = makeFakeStream([makeFakeTrack("video")]);
    getUserMediaMode = { kind: "deferred", stream: streamC };
    let p3: Promise<void> | undefined;
    act(() => {
      p3 = result.current.startCamera();
    });
    expect(getUserMediaMock).toHaveBeenCalledTimes(3);

    act(() => {
      result.current.stopCamera();
    });
    // streamC is still pending so its track is not yet stopped.
    expect(streamC.tracks[0]?.stopped).toBe(false);

    await act(async () => {
      pendingDeferred?.resolve(streamC);
      await p3;
    });
    // streamC's tracks must have been stopped because Stop was
    // requested before it resolved.
    expect(streamC.tracks[0]?.stopped).toBe(true);
    expect(getUserMediaMock).toHaveBeenCalledTimes(3);

    // Final assertion: only getUserMedia calls were tracked, no
    // additional stream was leaked through the guard.
    expect(getUserMediaMock).toHaveBeenCalledTimes(3);
  });
});
