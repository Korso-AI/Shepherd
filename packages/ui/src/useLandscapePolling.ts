import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkspaceLandscapeResponseT } from "@shepherd/shared";
import { ShepherdClientError } from "./client.js";
import { useShepherdClient } from "./context.js";

/** Default poll cadence, mirroring `POLL_MS = 5000` in the original app.js. */
const DEFAULT_POLL_MS = 5000;

/** The freshness re-render cadence, mirroring app.js's 1s `tickFreshness` loop. */
const FRESHNESS_MS = 1000;

/**
 * Connection state surfaced to the board chrome:
 * - `live`: the most recent poll succeeded.
 * - `reconnecting`: a poll failed transiently; the last good snapshot is kept.
 * - `unauthorized`: the hub returned 401; the last good snapshot is kept while
 *   the host-supplied client's `onUnauthorized` handles any token clearing.
 */
export type LandscapeStatus = "live" | "reconnecting" | "unauthorized";

/** Options for {@link useLandscapePolling}. */
export interface UseLandscapePollingOptions {
  /**
   * Workspace to poll. When given, the hook calls `client.landscape(id)` (the
   * hosted, multi-workspace route); when omitted it calls the singular
   * `client.getLandscape()` self-host alias. Changing it re-pulls immediately.
   */
  workspaceId?: string;
  /** Poll cadence in ms; defaults to {@link DEFAULT_POLL_MS} (5000). */
  pollMs?: number;
  /**
   * Whether to poll at all; defaults to `true`. When `false` the hook performs
   * NO request (no initial poll, no interval) and stays on its last value — used
   * by the hosted shell to keep the board from polling when there is no
   * workspace to scope to.
   */
  enabled?: boolean;
}

/** The reactive value returned by {@link useLandscapePolling}. */
export interface LandscapePolling {
  /** Last good landscape, or `null` until the first successful poll. */
  snapshot: WorkspaceLandscapeResponseT | null;
  /**
   * The `workspaceId` the current {@link snapshot} was fetched for
   * (`undefined` for the self-host singular route). Because the last-good
   * snapshot is RETAINED across a `workspaceId` switch (so the board never
   * blanks), a caller that must not act on another workspace's data — e.g.
   * the setup checklist's stage derivation — compares this against its
   * current `workspaceId` before trusting the snapshot.
   */
  snapshotWorkspaceId: string | undefined;
  /** Current connection state. */
  status: LandscapeStatus;
  /** `Date.now()` of the last successful poll, or `null` before the first. */
  lastUpdatedMs: number | null;
  /** Run one poll immediately (used by the composer after a successful send). */
  refresh: () => Promise<void>;
}

/**
 * Polls the Shepherd hub's whole-workspace landscape on an interval and exposes
 * the latest good snapshot plus a connection status, mirroring the browser-only
 * polling loop in packages/hub/public/app.js (`poll` + `tickFreshness`).
 *
 * The client is read from {@link useShepherdClient} (context), keeping the hook
 * auth-agnostic — it never touches tokens or the BFF. On mount it polls once
 * immediately, then on `setInterval(pollMs)`. A SECOND `setInterval(1000)` only
 * bumps a tick counter so relative-time text re-renders even between polls (the
 * React analogue of app.js's `tickFreshness`); both intervals are cleared on
 * unmount.
 *
 * Failure handling preserves the original board's resilience: a 401
 * {@link ShepherdClientError} sets `unauthorized`, and ANY other error sets
 * `reconnecting`. In both cases the last good `snapshot`/`lastUpdatedMs` are
 * RETAINED (app.js's `lastSnapshot` retention), so the wallboard never blanks on
 * a transient blip. The same last-good retention holds across a `workspaceId`
 * switch — the prior board stays on screen until the new workspace's first poll
 * lands, and an in-flight poll for the old workspace is dropped so it can't
 * clobber the new one.
 *
 * Two refinements beyond the original loop: a `workspaceId` change re-pulls the
 * new workspace immediately (the poll effect depends on it), and the interval
 * poll is skipped while the tab is hidden (`document.visibilityState`), resuming
 * with an immediate poll on `visibilitychange` back to visible — a backgrounded
 * wallboard shouldn't hammer the hub.
 *
 * @param opts - Optional workspace to scope to and poll cadence override.
 * @returns The current snapshot, status, last-updated timestamp, and a manual
 *   {@link LandscapePolling.refresh}.
 */
export function useLandscapePolling(
  opts?: UseLandscapePollingOptions,
): LandscapePolling {
  const client = useShepherdClient();
  const workspaceId = opts?.workspaceId;
  const pollMs = opts?.pollMs ?? DEFAULT_POLL_MS;
  const enabled = opts?.enabled ?? true;

  const [snapshot, setSnapshot] = useState<WorkspaceLandscapeResponseT | null>(
    null,
  );
  // Which workspace `snapshot` belongs to — set atomically with it, so a
  // retained snapshot from the previous workspace is identifiable during the
  // gap before the new workspace's first poll lands.
  const [snapshotWorkspaceId, setSnapshotWorkspaceId] = useState<
    string | undefined
  >(undefined);
  const [status, setStatus] = useState<LandscapeStatus>("live");
  const [lastUpdatedMs, setLastUpdatedMs] = useState<number | null>(null);
  // A monotonically-bumped counter whose only job is to force a re-render every
  // second so relative timestamps in the tree refresh between polls. The value
  // itself is never read — the state change IS the freshness tick.
  const [, setTick] = useState(0);

  // The latest client lives in a ref so the stable `poll`/`refresh` callbacks
  // always call through to the current provider value without re-subscribing.
  const clientRef = useRef(client);
  clientRef.current = client;

  // Each poll effect run bumps this "generation". A poll captures the generation
  // it started under and compares against the live ref before any setState, so a
  // response that resolves after its effect was torn down — by unmount OR a
  // `workspaceId` switch — is dropped and can't clobber a newer workspace's
  // board. A single shared boolean can't do this: a switch runs old-cleanup then
  // new-setup synchronously, so a boolean reset by setup would let the stale
  // promise's late resolve sail through. The generation only ever moves forward,
  // so a superseded poll's captured value is always behind `gen.current`.
  const gen = useRef(0);

  /**
   * Runs exactly one poll, mapping the outcome onto status/snapshot. Reads
   * `workspaceId` via closure (it's a `useCallback` dep): a non-empty id hits the
   * workspace-scoped `landscape(id)` route, an absent one the singular
   * `getLandscape()` alias. `myGen` is the caller's generation — the result is
   * applied only while it's still the current one.
   */
  const poll = useCallback(
    async (myGen: number) => {
      try {
        const next = workspaceId
          ? await clientRef.current.landscape(workspaceId)
          : await clientRef.current.getLandscape();
        if (myGen !== gen.current) return;
        setSnapshot(next);
        setSnapshotWorkspaceId(workspaceId);
        setLastUpdatedMs(Date.now());
        setStatus("live");
      } catch (err) {
        if (myGen !== gen.current) return;
        // A 401 is terminal-ish: the client's onUnauthorized already ran. Keep
        // the last good board up and flag it; everything else is a transient
        // blip and also keeps the last good board ("reconnecting…" in app.js).
        if (err instanceof ShepherdClientError && err.status === 401) {
          setStatus("unauthorized");
        } else {
          setStatus("reconnecting");
        }
      }
    },
    [workspaceId],
  );

  // Poll once on mount, then on the cadence interval. Re-runs when `poll`
  // changes (i.e. on a `workspaceId` switch), re-pulling the new workspace
  // immediately. The interval tick is skipped while the tab is hidden, and a
  // return to visibility polls right away to catch up. The 1s freshness interval
  // is independent so a slow/failed poll never blocks the relative-time refresh.
  useEffect(() => {
    // Disabled: do nothing — no poll, no intervals — so a no-workspace board
    // never hits the hub. Re-enabling re-runs this effect and pulls immediately.
    if (!enabled) return;
    const myGen = ++gen.current;
    void poll(myGen);
    const pollTimer = setInterval(() => {
      // A backgrounded wallboard doesn't need to poll; resume below on visible.
      if (document.visibilityState === "hidden") return;
      void poll(myGen);
    }, pollMs);
    const freshnessTimer = setInterval(() => {
      setTick((t) => t + 1);
    }, FRESHNESS_MS);
    const onVisible = (): void => {
      if (document.visibilityState === "visible") void poll(myGen);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      // Bumping the generation invalidates any in-flight poll from this run.
      gen.current++;
      clearInterval(pollTimer);
      clearInterval(freshnessTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [poll, pollMs, enabled]);

  // Manual refresh always runs under the current generation, so its result
  // applies as long as the hook hasn't since switched workspace or unmounted.
  const refresh = useCallback(() => poll(gen.current), [poll]);

  return { snapshot, snapshotWorkspaceId, status, lastUpdatedMs, refresh };
}
