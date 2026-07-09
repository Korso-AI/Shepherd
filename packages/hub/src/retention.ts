/**
 * Entitlements-window announcement retention — the lazy prune driver.
 *
 * The hub has no sweep job by design; instead the hot coordination
 * transactions (work / sync / heartbeat) call {@link maybePruneRetention}
 * right after their change-record prune, and it:
 *
 *   1. No-ops unless the deployment configured ENTITLEMENTS_DEFAULT_LIMITS
 *      (self-host keeps its full history forever, by construction).
 *   2. Throttles in-memory to ONE prune attempt per workspace per hour
 *      (mirrors tenant.ts's hot-path write throttles) so a busy workspace
 *      doesn't pay the entitlements read + delete on every call.
 *   3. Resolves the workspace's retention window via effectiveLimits —
 *      a live record's retention_days, else the deployment default;
 *      null → never prune.
 *   4. Deletes announcements older than the window in BOUNDED passes
 *      (repo.pruneAnnouncements, at most ANNOUNCEMENT_PRUNE_BATCH_LIMIT rows
 *      per call) so the first prune of a deep backlog cannot bloat a hot
 *      transaction — the hourly cadence drains the rest over later ticks.
 *
 * change_records are untouched: their global TTL (CHANGE_RECORD_TTL_SECONDS,
 * 3 days) is stricter than any retention window worth configuring.
 */

import type { Config } from "./config.js";
import { enforcementEnabled, effectiveLimits } from "./entitlements.js";
import {
  getWorkspaceEntitlements,
  pruneAnnouncements,
  ANNOUNCEMENT_PRUNE_BATCH_LIMIT,
} from "./repo.js";
import type pg from "pg";

/** Minimum gap between prune attempts for the same workspace. */
const RETENTION_PRUNE_INTERVAL_MS = 3_600_000; // 1 hour

// One entry per workspace uuid, reset on restart — same bounded-by-id-space
// posture as tenant.ts's throttle maps.
const lastPruneAttempt = new Map<string, number>();

/** Test-only: clear the per-workspace prune throttle. */
export function __resetRetentionThrottle(): void {
  lastPruneAttempt.clear();
}

/**
 * Prune this workspace's announcement history down to its retention window,
 * if enforcement is on and the hourly throttle allows. Call inside a hot
 * coordination transaction with the transaction client; deletes ride the
 * caller's COMMIT/ROLLBACK. (A rolled-back prune stays throttled — the next
 * hourly tick retries.)
 */
export async function maybePruneRetention(
  tx: pg.PoolClient,
  config: Config,
  workspaceId: string,
  now: Date,
): Promise<void> {
  if (!enforcementEnabled(config)) return;

  const nowMs = now.getTime();
  const last = lastPruneAttempt.get(workspaceId);
  if (last !== undefined && nowMs - last < RETENTION_PRUNE_INTERVAL_MS) {
    return;
  }
  lastPruneAttempt.set(workspaceId, nowMs);

  const record = await getWorkspaceEntitlements(tx, workspaceId);
  const retentionDays = effectiveLimits(
    record,
    config.ENTITLEMENTS_DEFAULT_LIMITS!,
    now,
  ).retentionDays;
  if (retentionDays === null) return;

  const deleted = await pruneAnnouncements(tx, workspaceId, now, retentionDays);
  if (deleted === ANNOUNCEMENT_PRUNE_BATCH_LIMIT) {
    // Bound hit — a backlog remains; the hourly cadence drains it.
    console.warn(
      `[retention] workspace ${workspaceId}: pruned ${deleted} announcements (batch bound hit, backlog remains)`,
    );
  }
}
