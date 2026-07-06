import type { ChangeReportT, AnnouncementT } from "@shepherd/shared";
import { type HubClient } from "./hubClient.js";

/**
 * Background presence timer. While connected, it POSTs `/heartbeat` every
 * `intervalSeconds` so an actively-coding-but-quiet session stays "live" on the
 * hub, independent of any tool calls. Each beat also attaches a best-effort
 * change report (when `buildReport` is supplied) so the agent's committed work
 * surfaces to teammates within ~one interval, not only when it next calls
 * work/sync.
 *
 * Fails open: every error (HubUnreachable, HubRequestError, or anything else) is
 * swallowed and logged to stderr at most — NEVER thrown, never written to stdout
 * (stdout is the stdio MCP protocol channel).
 */
export interface Heartbeat {
  /** Begin pinging the hub for this session. Restarts cleanly if already running. */
  start(sessionId: string): void;
  /** Stop pinging. Idempotent: safe when not started and safe to call twice. */
  stop(): void;
}

export function createHeartbeat({
  hubClient,
  intervalSeconds,
  buildReport,
  announcementSink,
}: {
  hubClient: HubClient;
  intervalSeconds: number;
  /**
   * Best-effort change-report builder. Must itself be fail-open (return
   * undefined rather than throw); the beat omits `changeReport` when it yields
   * undefined. Omitted entirely → heartbeats carry presence only.
   */
  buildReport?: () => Promise<ChangeReportT | undefined>;
  /**
   * Model-visible sink for announcements the hub hands over on a beat. Its mere
   * PRESENCE opts this heartbeat into announcement delivery — there is no
   * separate boolean to get out of sync, so it is structurally impossible to ask
   * the hub for announcements without somewhere to put them.
   *
   * Delivery is two-phase and crash-safe: each beat fetches pending
   * announcements, writes them to THIS sink FIRST, and only then acks them back
   * to the hub (which records the delivery). If the sink throws, the beat skips
   * the ack, so the hub keeps the messages pending and re-delivers next beat —
   * nothing is marked delivered before it is locally persisted. The sink may
   * therefore throw to signal a failed write; that is caught here.
   */
  announcementSink?: (announcements: AnnouncementT[]) => void;
}): Heartbeat {
  let timer: ReturnType<typeof setInterval> | null = null;

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function beat(sessionId: string): Promise<void> {
    // Build the change report first (fail-open). A null/undefined builder or a
    // thrown error degrades to a presence-only beat.
    let changeReport: ChangeReportT | undefined;
    if (buildReport) {
      try {
        changeReport = await buildReport();
      } catch {
        changeReport = undefined;
      }
    }
    const body: Record<string, unknown> = { sessionId };
    if (changeReport) body.changeReport = changeReport;
    // Delivery is gated on having a sink: presence implies request. No sink ⇒
    // never ask the hub to hand over announcements.
    if (announcementSink) body.deliverAnnouncements = true;

    const response = (await hubClient.post("/heartbeat", body)) as {
      announcements?: AnnouncementT[];
    } | null;

    const delivered = response?.announcements;
    if (announcementSink && Array.isArray(delivered) && delivered.length > 0) {
      // Phase 1: persist to the model-visible sink FIRST. A throw here means the
      // local write failed — log and bail WITHOUT acking, so the hub keeps the
      // messages pending and re-delivers on the next beat (the inbox dedups by
      // id). This is the whole point of the two-phase protocol: we never let the
      // hub consider a message delivered before it is locally durable.
      try {
        announcementSink(delivered);
      } catch (err) {
        console.error(
          `[shepherd] inbox delivery failed (not acking, will retry): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        return;
      }

      // Phase 2: the local write succeeded → ack so the hub records the delivery
      // and stops re-delivering. A failure here (hub blip) just means a re-fetch
      // + re-append (deduped) next beat, never a lost message.
      await hubClient.post("/heartbeat", {
        sessionId,
        ackAnnouncementIds: delivered.map((a) => a.id),
      });
    }
  }

  function start(sessionId: string): void {
    // Restart cleanly if a previous timer is still running.
    stop();

    timer = setInterval(() => {
      // The callback must never throw and never return a rejected promise that
      // goes unhandled, so we attach a catch here. The hub client may reject
      // with HubUnreachable / HubRequestError or anything else — all swallowed.
      void beat(sessionId).catch((err: unknown) => {
        // stderr only — stdout is the MCP protocol channel.
        console.error(
          `[shepherd] heartbeat failed: ${err instanceof Error ? err.message : String(err)}`
        );
      });
    }, intervalSeconds * 1000);

    // Never let the heartbeat alone keep the process alive.
    timer.unref();
  }

  return { start, stop };
}
