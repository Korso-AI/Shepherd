/**
 * Shared landscape assembly for `work` and `sync`.
 *
 * Both operations, once they hold a transaction client, build the same view of
 * the workspace: other sessions' active claims, the subset that overlaps the
 * caller's own globs (advisory conflicts), and the caller's pending
 * announcements (which are marked delivered as a side effect). The ONLY thing
 * that differs is which globs define "the caller's own" — `work` uses the globs
 * it is about to claim, `sync` uses the session's existing active globs.
 *
 * Everything runs on the passed-in `tx` so the reads share the transaction's
 * snapshot and never check out a second pooled connection.
 */

import type pg from "pg";
import type { LandscapeT } from "@shepherd/shared";
import { type Config, DEFAULT_UNCOMMITTED_GRACE_SECONDS } from "../config.js";
import type { SessionWithAgent } from "../repo.js";
import {
  listActiveClaims,
  listSessionClaims,
  fetchPendingAnnouncements,
  recordAnnouncementDeliveries,
  listOtherChangeRecords,
} from "../repo.js";
import { globsOverlap } from "../globs.js";

/**
 * Max change records surfaced in a single landscape, after overlap filtering.
 * The repo layer already caps the candidate set at 200 (ORDER BY updated_at
 * DESC); we re-sort most-recent-first and slice to this tighter per-response
 * limit so the payload stays bounded.
 */
const CHANGE_RECORDS_LIMIT = 100;

export async function buildLandscape(
  tx: pg.PoolClient,
  session: SessionWithAgent,
  now: Date,
  ownGlobs: string[],
  config: Config
): Promise<LandscapeT> {
  // Other sessions' active claims for this workspace+repo. Visibility requires
  // both a live TTL and a live owning session (see repo.listActiveClaims), so a
  // dead agent's claims drop out once its session goes stale.
  const activeClaims = await listActiveClaims(
    tx,
    session.workspaceId,
    session.repo,
    now,
    config.STALE_AFTER_SECONDS,
    { excludeSessionId: session.id }
  );

  // The caller's OWN active claims, so it can confirm its claim is live
  // (activeClaims excludes the caller's own session by design).
  const yourClaims = await listSessionClaims(tx, session.id, now);

  // Advisory conflicts: the claims whose globs overlap the caller's own globs.
  const conflicts = activeClaims.filter((c) =>
    globsOverlap(c.pathGlobs, ownGlobs)
  );

  // Pending announcements, marked delivered in the same transaction.
  const announcements = await fetchPendingAnnouncements(tx, session);
  await recordAnnouncementDeliveries(
    tx,
    session.id,
    announcements.map((a) => a.id)
  );

  // Other agents' change records for this workspace+repo (presence-enriched by
  // the repo layer; NOT glob-filtered, caller's own already excluded). Filter to
  // those whose paths overlap the caller's own globs — mirroring `conflicts` —
  // then return most-recent-first, capped at CHANGE_RECORDS_LIMIT. When ownGlobs
  // is empty the overlap filter yields [] (consistent with conflicts).
  const otherChangeRecords = await listOtherChangeRecords(
    tx,
    session.workspaceId,
    session.repo,
    session.agentId,
    now,
    config.STALE_AFTER_SECONDS,
    config.UNCOMMITTED_GRACE_SECONDS ?? DEFAULT_UNCOMMITTED_GRACE_SECONDS
  );
  const changeRecords = otherChangeRecords
    .filter((r) => globsOverlap(r.paths, ownGlobs))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, CHANGE_RECORDS_LIMIT);

  return { conflicts, activeClaims, yourClaims, announcements, changeRecords };
}
