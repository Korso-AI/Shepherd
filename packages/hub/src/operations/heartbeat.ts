/**
 * heartbeat operation: keep a session's PRESENCE live without renewing claims,
 * and (optionally) refresh its durable change records.
 *
 * This is the presence half of the heartbeat: it bumps the session's
 * last_heartbeat_at so the session survives the staleness window, but it
 * deliberately does NOT renew any active claim's lease. A session that only
 * ever heartbeats lets its claims lapse at their own frozen TTL — exactly what
 * the background heartbeat loop wants (presence without claim renewal).
 *
 * If the background heartbeat attaches a change report, we ingest it exactly as
 * work/sync do — update the session's branch, wholesale-replace this agent's
 * change records, and prune expired ones — so a teammate's commits surface
 * within ~one heartbeat interval instead of only when they next call work/sync.
 * This is still change-AWARENESS, not claim renewal: it never touches TTLs.
 *
 * Announcement delivery is OPT-IN and TWO-PHASE so a message is never marked
 * delivered before the client actually holds it (the old single-transaction
 * fetch+mark could lose a message if the response never reached the client, or
 * the client's local inbox append threw, AFTER the hub had already recorded the
 * delivery):
 *   - deliverAnnouncements (fetch phase): return pending announcements WITHOUT
 *     marking them delivered. The client persists them to its model-visible sink
 *     (a local inbox file drained by a hook) before doing anything else.
 *   - ackAnnouncementIds (ack phase): once the local write is confirmed, the
 *     client sends back the ids it persisted and the hub records the delivery for
 *     exactly those. A lost response or a failed append simply leaves them
 *     pending, so the next beat re-delivers (the client-side inbox dedups by id).
 * Without either field the old invariant holds: presence (and optional change
 * awareness) only, announcements untouched.
 */

import type {
  HeartbeatRequestT,
  HeartbeatResponseT,
  AnnouncementT,
} from "@shepherd/shared";
import { getContext } from "../context.js";
import {
  touchPresence,
  updateSessionBranch,
  replaceChangeRecords,
  pruneChangeRecords,
  fetchPendingAnnouncements,
  recordAnnouncementDeliveries,
} from "../repo.js";
import { resolveSession } from "../sessionScope.js";
import { withContext } from "../scopedDb.js";
import { maybePruneRetention } from "../retention.js";
import { contextForTenant, type TenantContext } from "../tenant.js";

export async function heartbeat(
  input: HeartbeatRequestT,
  tenant: TenantContext,
): Promise<HeartbeatResponseT> {
  const { pool, config } = getContext();

  return withContext(pool, contextForTenant(tenant), async (tx) => {
    const now = new Date();
    // Resolve + authorize the session as the FIRST statement. resolveSession
    // handles both credential kinds; a session the caller may not reach throws
    // UnknownSessionError (→ 404), the cross-tenant isolation gate.
    const session = await resolveSession(tx, tenant, input.sessionId);
    // Presence only — does NOT renew claims. That is the whole point.
    await touchPresence(tx, session.id, now);

    // Durable change awareness (same ingestion as work/sync, no claim renewal):
    // refresh the agent's change records from the reported working state, then
    // prune any that have aged past the TTL.
    if (input.changeReport) {
      const cr = input.changeReport;
      await updateSessionBranch(tx, session.id, cr.branch);
      await replaceChangeRecords(tx, {
        agentId: session.agentId,
        agentName: session.agentName,
        workspaceId: session.workspaceId,
        repo: session.repo,
        branch: cr.branch,
        entries: cr.entries.map((e) => ({
          kind: e.kind,
          commitSha: e.sha,
          message: e.message,
          paths: e.paths,
        })),
      });
      await pruneChangeRecords(
        tx,
        session.workspaceId,
        session.repo,
        now,
        config.CHANGE_RECORD_TTL_SECONDS,
      );
    }

    // Lazy announcement retention (entitlements window), every beat rather
    // than only when a changeReport rode along — the hourly per-workspace
    // throttle keeps it a no-op read in the common case; inert without
    // ENTITLEMENTS_DEFAULT_LIMITS. See retention.ts.
    await maybePruneRetention(tx, config, session.workspaceId, now);

    // ACK phase: the client confirms it has durably written these ids to its
    // model-visible sink. Mark exactly those delivered to the caller's session.
    // Runs before the fetch below so a single beat could (in principle) ack a
    // previous batch and fetch a fresh one; the client uses two separate beats,
    // so in practice only one branch fires per request.
    if (input.ackAnnouncementIds && input.ackAnnouncementIds.length > 0) {
      await recordAnnouncementDeliveries(
        tx,
        session.id,
        input.ackAnnouncementIds,
      );
    }

    // FETCH phase: hand over pending announcements but DO NOT mark them
    // delivered — the client acks (above, on its next beat) only after its local
    // write succeeds, so a message is never recorded delivered before the model
    // can see it. Bounded by fetchPendingAnnouncements' batch limit; surplus
    // arrives on later beats once earlier ones are acked.
    let announcements: AnnouncementT[] = [];
    if (input.deliverAnnouncements) {
      announcements = await fetchPendingAnnouncements(tx, session);
    }

    return { ok: true, announcements };
  });
}
