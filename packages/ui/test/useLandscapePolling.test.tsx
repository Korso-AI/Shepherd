import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import type {
  WorkspaceLandscapeResponseT,
  WorkspaceAnnounceResponseT,
} from "@shepherd/shared";
import type { ShepherdClient } from "../src/client.js";
import { ShepherdClientError } from "../src/client.js";
import { ShepherdClientProvider } from "../src/context.js";
import { useLandscapePolling } from "../src/useLandscapePolling.js";

/** A minimal, empty-but-valid landscape payload for resolve cases. */
function makeSnapshot(serverTime: string): WorkspaceLandscapeResponseT {
  return {
    agents: [],
    tasks: [],
    announcements: [],
    serverTime,
  };
}

/**
 * A controllable stub client. `getLandscape`/`landscape`/`announce` are vi mocks
 * so a test can set per-call resolve/reject behavior and assert how often (and
 * with what workspace id) the hook polled.
 */
interface StubClient extends ShepherdClient {
  getLandscape: ReturnType<typeof vi.fn>;
  landscape: ReturnType<typeof vi.fn>;
  announce: ReturnType<typeof vi.fn>;
}

function makeStub(): StubClient {
  return {
    getLandscape: vi.fn<() => Promise<WorkspaceLandscapeResponseT>>(),
    landscape: vi.fn<(id: string) => Promise<WorkspaceLandscapeResponseT>>(),
    announce: vi.fn<() => Promise<WorkspaceAnnounceResponseT>>(),
  };
}

/** Wraps a hook render in the provider so `useShepherdClient()` resolves. */
function wrapper(client: ShepherdClient) {
  return function Wrapper({ children }: { children: ReactNode }): ReactNode {
    return (
      <ShepherdClientProvider client={client}>
        {children}
      </ShepherdClientProvider>
    );
  };
}

describe("useLandscapePolling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-28T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fetches once on mount and reports status 'live'", async () => {
    const client = makeStub();
    client.getLandscape.mockResolvedValue(
      makeSnapshot("2026-06-28T12:00:00.000Z"),
    );

    const { result } = renderHook(() => useLandscapePolling(), {
      wrapper: wrapper(client),
    });

    // Flush the immediate-on-mount poll's microtasks.
    await act(async () => {
      await Promise.resolve();
    });

    expect(client.getLandscape).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("live");
    expect(result.current.snapshot).not.toBeNull();
    expect(result.current.lastUpdatedMs).toBe(
      Date.parse("2026-06-28T12:00:00.000Z"),
    );
  });

  it("polls again on the interval (default 5000ms)", async () => {
    const client = makeStub();
    client.getLandscape.mockResolvedValue(
      makeSnapshot("2026-06-28T12:00:00.000Z"),
    );

    renderHook(() => useLandscapePolling(), { wrapper: wrapper(client) });

    await act(async () => {
      await Promise.resolve();
    });
    expect(client.getLandscape).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(client.getLandscape).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(client.getLandscape).toHaveBeenCalledTimes(3);
  });

  it("respects a custom pollMs", async () => {
    const client = makeStub();
    client.getLandscape.mockResolvedValue(
      makeSnapshot("2026-06-28T12:00:00.000Z"),
    );

    renderHook(() => useLandscapePolling({ pollMs: 2000 }), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(client.getLandscape).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(client.getLandscape).toHaveBeenCalledTimes(2);
  });

  it("keeps the previous snapshot and goes 'reconnecting' on a generic error", async () => {
    const client = makeStub();
    const good = makeSnapshot("2026-06-28T12:00:00.000Z");
    client.getLandscape
      .mockResolvedValueOnce(good)
      .mockRejectedValueOnce(new Error("network down"));

    const { result } = renderHook(() => useLandscapePolling(), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe("live");
    const keptSnapshot = result.current.snapshot;
    const keptUpdatedMs = result.current.lastUpdatedMs;
    expect(keptSnapshot).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(result.current.status).toBe("reconnecting");
    // Last good snapshot is retained across the transient failure.
    expect(result.current.snapshot).toBe(keptSnapshot);
    expect(result.current.lastUpdatedMs).toBe(keptUpdatedMs);
  });

  it("goes 'unauthorized' on a 401 ShepherdClientError, keeping the snapshot", async () => {
    const client = makeStub();
    const good = makeSnapshot("2026-06-28T12:00:00.000Z");
    client.getLandscape
      .mockResolvedValueOnce(good)
      .mockRejectedValueOnce(new ShepherdClientError("Unauthorized", 401));

    const { result } = renderHook(() => useLandscapePolling(), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await Promise.resolve();
    });
    const keptSnapshot = result.current.snapshot;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(result.current.status).toBe("unauthorized");
    expect(result.current.snapshot).toBe(keptSnapshot);
  });

  it("treats a non-401 ShepherdClientError as 'reconnecting'", async () => {
    const client = makeStub();
    const good = makeSnapshot("2026-06-28T12:00:00.000Z");
    client.getLandscape
      .mockResolvedValueOnce(good)
      .mockRejectedValueOnce(new ShepherdClientError("HTTP 500", 500));

    const { result } = renderHook(() => useLandscapePolling(), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(result.current.status).toBe("reconnecting");
  });

  it("refresh() triggers an immediate extra fetch", async () => {
    const client = makeStub();
    client.getLandscape.mockResolvedValue(
      makeSnapshot("2026-06-28T12:00:00.000Z"),
    );

    const { result } = renderHook(() => useLandscapePolling(), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(client.getLandscape).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh();
    });
    expect(client.getLandscape).toHaveBeenCalledTimes(2);
  });

  it("advances lastUpdatedMs on a successful refresh after recovering", async () => {
    const client = makeStub();
    client.getLandscape.mockResolvedValue(
      makeSnapshot("2026-06-28T12:00:00.000Z"),
    );

    const { result } = renderHook(() => useLandscapePolling(), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      await Promise.resolve();
    });
    const first = result.current.lastUpdatedMs;
    expect(first).not.toBeNull();

    vi.setSystemTime(new Date("2026-06-28T12:00:10.000Z"));
    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.lastUpdatedMs).toBe(
      Date.parse("2026-06-28T12:00:10.000Z"),
    );
    expect(result.current.status).toBe("live");
  });

  it("polls client.landscape(workspaceId) when a workspaceId is given", async () => {
    const client = makeStub();
    client.landscape.mockResolvedValue(
      makeSnapshot("2026-06-28T12:00:00.000Z"),
    );

    const { result } = renderHook(
      () => useLandscapePolling({ workspaceId: "ws_1" }),
      { wrapper: wrapper(client) },
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(client.landscape).toHaveBeenCalledTimes(1);
    expect(client.landscape).toHaveBeenCalledWith("ws_1");
    expect(client.getLandscape).not.toHaveBeenCalled();
    expect(result.current.status).toBe("live");
    expect(result.current.snapshot).not.toBeNull();
  });

  it("polls the singular getLandscape alias when no workspaceId is given", async () => {
    const client = makeStub();
    client.getLandscape.mockResolvedValue(
      makeSnapshot("2026-06-28T12:00:00.000Z"),
    );

    renderHook(() => useLandscapePolling(), { wrapper: wrapper(client) });

    await act(async () => {
      await Promise.resolve();
    });

    expect(client.getLandscape).toHaveBeenCalledTimes(1);
    expect(client.landscape).not.toHaveBeenCalled();
  });

  it("re-polls immediately against the new id when workspaceId changes", async () => {
    const client = makeStub();
    client.landscape.mockResolvedValue(
      makeSnapshot("2026-06-28T12:00:00.000Z"),
    );

    const { rerender } = renderHook(
      ({ id }: { id: string }) => useLandscapePolling({ workspaceId: id }),
      { wrapper: wrapper(client), initialProps: { id: "ws_1" } },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(client.landscape).toHaveBeenCalledTimes(1);
    expect(client.landscape).toHaveBeenLastCalledWith("ws_1");

    await act(async () => {
      rerender({ id: "ws_2" });
      await Promise.resolve();
    });

    // The switch re-pulls right away (not waiting for the 5s tick) against ws_2.
    expect(client.landscape).toHaveBeenCalledTimes(2);
    expect(client.landscape).toHaveBeenLastCalledWith("ws_2");
  });

  it("drops a slow ws_1 poll that resolves after switching to ws_2", async () => {
    const client = makeStub();
    const ws1 = makeSnapshot("2026-06-28T11:00:00.000Z");
    const ws2 = makeSnapshot("2026-06-28T12:00:00.000Z");

    // Hold the ws_1 poll open so it's still in flight when we switch away; the
    // ws_2 poll resolves immediately. This is the real-latency ordering the
    // shared-ref guard failed to handle.
    let resolveWs1!: (snap: WorkspaceLandscapeResponseT) => void;
    const ws1Pending = new Promise<WorkspaceLandscapeResponseT>((res) => {
      resolveWs1 = res;
    });
    client.landscape
      .mockReturnValueOnce(ws1Pending) // ws_1 (left pending)
      .mockResolvedValueOnce(ws2); // ws_2

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useLandscapePolling({ workspaceId: id }),
      { wrapper: wrapper(client), initialProps: { id: "ws_1" } },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(client.landscape).toHaveBeenNthCalledWith(1, "ws_1");

    // Switch to ws_2 while ws_1 is still pending; ws_2 resolves now.
    await act(async () => {
      rerender({ id: "ws_2" });
      await Promise.resolve();
    });
    expect(client.landscape).toHaveBeenNthCalledWith(2, "ws_2");
    expect(result.current.snapshot).toBe(ws2);

    // The stale ws_1 response lands LAST — it must NOT clobber the ws_2 board.
    await act(async () => {
      resolveWs1(ws1);
      await ws1Pending;
      await Promise.resolve();
    });

    expect(result.current.snapshot).toBe(ws2);
  });

  it("skips the interval poll while the tab is hidden, then polls on becoming visible", async () => {
    const client = makeStub();
    client.getLandscape.mockResolvedValue(
      makeSnapshot("2026-06-28T12:00:00.000Z"),
    );

    const visibility = vi.spyOn(document, "visibilityState", "get");
    visibility.mockReturnValue("visible");

    renderHook(() => useLandscapePolling(), { wrapper: wrapper(client) });

    await act(async () => {
      await Promise.resolve();
    });
    expect(client.getLandscape).toHaveBeenCalledTimes(1);

    // Hidden tab: the interval tick must NOT poll.
    visibility.mockReturnValue("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(client.getLandscape).toHaveBeenCalledTimes(1);

    // Returning to visible polls immediately on the visibilitychange event.
    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    expect(client.getLandscape).toHaveBeenCalledTimes(2);

    visibility.mockRestore();
  });

  it("clears both intervals on unmount (no further fetches)", async () => {
    const client = makeStub();
    client.getLandscape.mockResolvedValue(
      makeSnapshot("2026-06-28T12:00:00.000Z"),
    );

    const { unmount } = renderHook(() => useLandscapePolling(), {
      wrapper: wrapper(client),
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(client.getLandscape).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });

    // No poll fired after unmount.
    expect(client.getLandscape).toHaveBeenCalledTimes(1);
    // The 1s freshness interval is also gone — assert by ensuring no timers
    // remain pending after unmount + flush.
    expect(vi.getTimerCount()).toBe(0);
  });
});
