/**
 * done operation: release a work item the calling session owns, and deliver any
 * pending announcements to the caller.
 *
 * Idempotent: unknown id, already-released, or not-owned-by-this-session all
 * return { ok: true }. The owner-scoped WHERE clause in releaseWorkItem is the
 * entire protection — another session's claim is simply left untouched.
 *
 * #4: done is a model-visible turn (the agent reads its result), so it is a good
 * place to surface inbound messages — they otherwise wait for the next
 * work/sync. We fetch + mark-delivered exactly as the landscape does. (Heartbeat
 * does NOT do this by default — its result never reaches the model — UNLESS the
 * client opts in with deliverAnnouncements, which it only does when it has a
 * model-visible sink, i.e. the local inbox file drained by a hook. See
 * operations/heartbeat.ts.)
 */

import type { DoneRequestT, DoneResponseT } from "@shepherd/shared";
import { getContext } from "../context.js";
import { type TenantContext } from "../tenant.js";
import { resolveSession } from "../sessionScope.js";
import {
  releaseWorkItem,
  touchPresence,
  fetchPendingAnnouncements,
  recordAnnouncementDeliveries,
} from "../repo.js";
import { withTransaction } from "../db.js";

export async function done(
  input: DoneRequestT,
  tenant: TenantContext
): Promise<DoneResponseT> {
  const { pool } = getContext();

  // Resolve the session, bump its presence, release the claim, AND deliver
  // pending announcements in one transaction so every step composes through a
  // single `tx` (no second pooled connection). rowCount from releaseWorkItem is
  // deliberately ignored — the owner-scoped WHERE clause is the entire
  // protection, and 0 rows (unknown/already-released/not-owned) is success.
  return withTransaction(pool, async (tx) => {
    // Resolve + authorize the session as the FIRST statement. resolveSession
    // handles both credential kinds: a session the caller may not reach (another
    // workspace, or an account with no membership) throws UnknownSessionError
    // (→ 404), the cross-tenant isolation gate. No claim of another tenant's
    // session is ever released.
    const session = await resolveSession(tx, tenant, input.sessionId);
    const now = new Date();
    // Presence only — NOT touchHeartbeat: releasing one claim must not renew this
    // session's OTHER active claims (a `done` is not activity on unrelated work).
    await touchPresence(tx, session.id, now);
    await releaseWorkItem(tx, session.id, input.workItemId, now);

    const announcements = await fetchPendingAnnouncements(tx, session);
    await recordAnnouncementDeliveries(
      tx,
      session.id,
      announcements.map((a) => a.id)
    );

    return { ok: true, announcements };
  });
}
