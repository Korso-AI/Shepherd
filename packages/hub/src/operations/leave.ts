/**
 * leave operation: clean-shutdown signal from the MCP client when its process
 * exits. It marks the session's PRESENCE offline immediately (backdating the
 * heartbeat just past the staleness window) so the agent's live claims stop
 * surfacing to teammates the moment it disconnects — instead of lingering for
 * the full staleness window.
 *
 * Presence ONLY. It deliberately does NOT release claims or clear change
 * records: those are durable, presence-independent signals that must outlive the
 * session (a teammate may still need to coordinate around the agent's unlanded
 * work).
 *
 * Leave resolves + authorizes the session via {@link
 * resolveSession} FIRST (so account-scoped tokens work on it, and the concrete
 * workspace comes from the session rather than a route). This is a DELIBERATE
 * behavior change from the old "direct UPDATE, no getSession" form: an UNKNOWN
 * session id (no such row) — or a session the caller may not reach — now throws
 * UnknownSessionError (→ 404) instead of silently affecting no rows and
 * returning ok. Leave remains idempotent for a session that still EXISTS: a
 * repeat leave (or one on an already-offline session) resolves fine and simply
 * re-expires presence.
 */

import type { LeaveRequestT, LeaveResponseT } from "@shepherd/shared";
import { getContext } from "../context.js";
import { expireSessionPresence } from "../repo.js";
import { resolveSession } from "../sessionScope.js";
import { withTransaction } from "../db.js";
import { type TenantContext } from "../tenant.js";

export async function leave(
  input: LeaveRequestT,
  tenant: TenantContext,
): Promise<LeaveResponseT> {
  const { pool, config } = getContext();

  await withTransaction(pool, async (tx) => {
    // Resolve + authorize the session as the FIRST statement so the presence
    // expiry below is scoped to the SESSION's own workspace (not a route) and a
    // session the caller may not reach 404s before any write — the cross-tenant
    // isolation gate. See the module header for the deliberate idempotency change.
    const session = await resolveSession(tx, tenant, input.sessionId);
    const now = new Date();
    // Backdate one second past the staleness window so the session reads as
    // offline immediately, while "last seen" still reads as roughly when the
    // agent actually left (rather than the epoch).
    const offlineAt = new Date(
      now.getTime() - (config.STALE_AFTER_SECONDS + 1) * 1000,
    );
    await expireSessionPresence(tx, session.workspaceId, session.id, offlineAt);
  });

  return { ok: true };
}
