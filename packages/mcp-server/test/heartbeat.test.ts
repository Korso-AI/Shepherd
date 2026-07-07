import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHeartbeat } from "../src/heartbeat.js";
import {
  HubUnreachable,
  HubRequestError,
  type HubClient,
} from "../src/hubClient.js";

const SESSION_ID = "11111111-1111-1111-1111-111111111111";
const INTERVAL_SECONDS = 30;

function makeHubClient(): { post: ReturnType<typeof vi.fn> } & HubClient {
  return { post: vi.fn().mockResolvedValue({ ok: true }) };
}

describe("createHeartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  // ---- happy path ---------------------------------------------------------
  it("POSTs /heartbeat with { sessionId } after each interval", async () => {
    const hubClient = makeHubClient();
    const heartbeat = createHeartbeat({
      hubClient,
      intervalSeconds: INTERVAL_SECONDS,
    });

    heartbeat.start(SESSION_ID);
    expect(hubClient.post).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);
    expect(hubClient.post).toHaveBeenCalledTimes(1);
    expect(hubClient.post).toHaveBeenLastCalledWith("/heartbeat", {
      sessionId: SESSION_ID,
    });

    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);
    expect(hubClient.post).toHaveBeenCalledTimes(2);
    expect(hubClient.post).toHaveBeenLastCalledWith("/heartbeat", {
      sessionId: SESSION_ID,
    });

    heartbeat.stop();
  });

  // ---- change report attachment (#5) --------------------------------------
  it("attaches the change report from buildReport to each beat", async () => {
    const hubClient = makeHubClient();
    const report = {
      branch: "feature",
      baseBranch: "main",
      head: "abc123",
      truncated: false,
      entries: [
        {
          kind: "committed" as const,
          sha: "abc123",
          message: "wip",
          paths: ["src/a.ts"],
        },
      ],
    };
    const buildReport = vi.fn().mockResolvedValue(report);
    const heartbeat = createHeartbeat({
      hubClient,
      intervalSeconds: INTERVAL_SECONDS,
      buildReport,
    });

    heartbeat.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);

    expect(hubClient.post).toHaveBeenLastCalledWith("/heartbeat", {
      sessionId: SESSION_ID,
      changeReport: report,
    });
    heartbeat.stop();
  });

  it("sends a presence-only beat when buildReport yields undefined", async () => {
    const hubClient = makeHubClient();
    const buildReport = vi.fn().mockResolvedValue(undefined);
    const heartbeat = createHeartbeat({
      hubClient,
      intervalSeconds: INTERVAL_SECONDS,
      buildReport,
    });

    heartbeat.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);

    expect(hubClient.post).toHaveBeenLastCalledWith("/heartbeat", {
      sessionId: SESSION_ID,
    });
    heartbeat.stop();
  });

  it("fails open to a presence-only beat when buildReport throws", async () => {
    const hubClient = makeHubClient();
    const buildReport = vi.fn().mockRejectedValue(new Error("git blew up"));
    const heartbeat = createHeartbeat({
      hubClient,
      intervalSeconds: INTERVAL_SECONDS,
      buildReport,
    });

    heartbeat.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);

    expect(hubClient.post).toHaveBeenLastCalledWith("/heartbeat", {
      sessionId: SESSION_ID,
    });
    heartbeat.stop();
  });

  // ---- two-phase announcement delivery (sink-gated) -----------------------
  const sampleAnnouncement = {
    id: 7,
    fromAgentName: "RedDragon",
    fromHuman: "alice",
    body: "heads up",
    targetAgentName: null,
    createdAt: "2026-06-25T12:00:00.000Z",
  };

  it("adds deliverAnnouncements:true to the beat body only when a sink is provided", async () => {
    const hubClient = makeHubClient();
    const heartbeat = createHeartbeat({
      hubClient,
      intervalSeconds: INTERVAL_SECONDS,
      announcementSink: vi.fn(),
    });

    heartbeat.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);

    // No announcements in the (default) response → fetch beat only, no ack.
    expect(hubClient.post).toHaveBeenCalledTimes(1);
    expect(hubClient.post).toHaveBeenLastCalledWith("/heartbeat", {
      sessionId: SESSION_ID,
      deliverAnnouncements: true,
    });
    heartbeat.stop();
  });

  it("does NOT add the flag when no sink is provided", async () => {
    const hubClient = makeHubClient();
    const heartbeat = createHeartbeat({
      hubClient,
      intervalSeconds: INTERVAL_SECONDS,
    });

    heartbeat.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);

    expect(hubClient.post).toHaveBeenLastCalledWith("/heartbeat", {
      sessionId: SESSION_ID,
    });
    heartbeat.stop();
  });

  it("writes to the sink FIRST, then acks the delivered ids to the hub", async () => {
    const hubClient = makeHubClient();
    hubClient.post.mockResolvedValue({
      ok: true,
      announcements: [sampleAnnouncement],
    });
    const order: string[] = [];
    const announcementSink = vi.fn(() => {
      order.push("sink");
    });
    // Record when the ack post happens relative to the sink write.
    hubClient.post.mockImplementation(
      async (_path: string, body: Record<string, unknown>) => {
        if (body.ackAnnouncementIds) order.push("ack");
        return {
          ok: true,
          announcements: body.deliverAnnouncements ? [sampleAnnouncement] : [],
        };
      },
    );

    const heartbeat = createHeartbeat({
      hubClient,
      intervalSeconds: INTERVAL_SECONDS,
      announcementSink,
    });

    heartbeat.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);

    expect(announcementSink).toHaveBeenCalledTimes(1);
    expect(announcementSink).toHaveBeenCalledWith([sampleAnnouncement]);
    // Sink write strictly precedes the ack.
    expect(order).toEqual(["sink", "ack"]);
    // The ack carries exactly the delivered ids.
    const ackCall = hubClient.post.mock.calls.find(
      (c) => (c[1] as Record<string, unknown>).ackAnnouncementIds,
    );
    expect(ackCall![1]).toEqual({
      sessionId: SESSION_ID,
      ackAnnouncementIds: [sampleAnnouncement.id],
    });
    heartbeat.stop();
  });

  it("does NOT call the sink (or ack) when the response carries no announcements", async () => {
    const hubClient = makeHubClient();
    hubClient.post.mockResolvedValue({ ok: true, announcements: [] });
    const announcementSink = vi.fn();
    const heartbeat = createHeartbeat({
      hubClient,
      intervalSeconds: INTERVAL_SECONDS,
      announcementSink,
    });

    heartbeat.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);

    expect(announcementSink).not.toHaveBeenCalled();
    // Only the fetch beat — no ack.
    expect(hubClient.post).toHaveBeenCalledTimes(1);
    heartbeat.stop();
  });

  it("does NOT ack (and keeps ticking) when the sink throws — leaves messages pending", async () => {
    const hubClient = makeHubClient();
    hubClient.post.mockResolvedValue({
      ok: true,
      announcements: [sampleAnnouncement],
    });
    const announcementSink = vi.fn(() => {
      throw new Error("sink blew up");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const heartbeat = createHeartbeat({
      hubClient,
      intervalSeconds: INTERVAL_SECONDS,
      announcementSink,
    });

    heartbeat.start(SESSION_ID);
    await expect(
      vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000),
    ).resolves.not.toThrow();

    // No ack was sent (the only post was the fetch beat).
    const ackCalls = hubClient.post.mock.calls.filter(
      (c) => (c[1] as Record<string, unknown>).ackAnnouncementIds,
    );
    expect(ackCalls).toHaveLength(0);

    // Still ticking on the next interval (re-fetch attempt).
    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);
    expect(announcementSink).toHaveBeenCalledTimes(2);
    heartbeat.stop();
  });

  // ---- degradation: hub errors are swallowed ------------------------------
  it("swallows HubUnreachable and keeps ticking", async () => {
    const hubClient = makeHubClient();
    hubClient.post.mockRejectedValue(new HubUnreachable("down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const heartbeat = createHeartbeat({
      hubClient,
      intervalSeconds: INTERVAL_SECONDS,
    });
    heartbeat.start(SESSION_ID);

    // Should not throw out of the interval callback.
    await expect(
      vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000),
    ).resolves.not.toThrow();
    expect(hubClient.post).toHaveBeenCalledTimes(1);

    // Subsequent ticks still fire.
    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);
    expect(hubClient.post).toHaveBeenCalledTimes(2);

    heartbeat.stop();
    errSpy.mockRestore();
  });

  it("swallows HubRequestError and any other error", async () => {
    const hubClient = makeHubClient();
    hubClient.post
      .mockRejectedValueOnce(new HubRequestError(500, "boom"))
      .mockRejectedValueOnce(new Error("unexpected"))
      .mockResolvedValue({ ok: true });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const heartbeat = createHeartbeat({
      hubClient,
      intervalSeconds: INTERVAL_SECONDS,
    });
    heartbeat.start(SESSION_ID);

    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);
    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);
    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);
    expect(hubClient.post).toHaveBeenCalledTimes(3);

    heartbeat.stop();
  });

  // ---- lifecycle ----------------------------------------------------------
  it("stop() halts further posts", async () => {
    const hubClient = makeHubClient();
    const heartbeat = createHeartbeat({
      hubClient,
      intervalSeconds: INTERVAL_SECONDS,
    });

    heartbeat.start(SESSION_ID);
    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000);
    expect(hubClient.post).toHaveBeenCalledTimes(1);

    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL_SECONDS * 1000 * 5);
    expect(hubClient.post).toHaveBeenCalledTimes(1);
  });

  it("stop() is safe to call twice and when never started", () => {
    const hubClient = makeHubClient();
    const heartbeat = createHeartbeat({
      hubClient,
      intervalSeconds: INTERVAL_SECONDS,
    });

    expect(() => heartbeat.stop()).not.toThrow();
    heartbeat.start(SESSION_ID);
    expect(() => {
      heartbeat.stop();
      heartbeat.stop();
    }).not.toThrow();
  });

  it("calls .unref() on the timer so it never keeps the process alive", () => {
    const hubClient = makeHubClient();
    const unref = vi.fn();
    const setIntervalSpy = vi
      .spyOn(globalThis, "setInterval")
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>);

    const heartbeat = createHeartbeat({
      hubClient,
      intervalSeconds: INTERVAL_SECONDS,
    });
    heartbeat.start(SESSION_ID);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(unref).toHaveBeenCalledTimes(1);

    setIntervalSpy.mockRestore();
  });
});
