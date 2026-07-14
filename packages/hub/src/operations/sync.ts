/**
 * sync operation: refresh the landscape, deliver pending announcements, renew
 * the session's claims' TTL, and update the heartbeat.
 *
 * Returns { landscape } containing:
 *   - activeClaims: other sessions' non-expired, non-stale claims
 *   - conflicts: subset of activeClaims whose pathGlobs overlap the caller's own
 *   - announcements: pending (not yet delivered) announcements for this session
 *
 * sync is NOT a prerequisite for `work` — an agent that never calls sync is
 * still fully coordinated. sync is purely advisory / informational.
 */

import type { SyncRequestT, SyncResponseT } from "@shepherd/shared";
import { getContext } from "../context.js";
import { contextForTenant, type TenantContext } from "../tenant.js";
import { resolveSession } from "../sessionScope.js";
import { touchHeartbeat } from "../repo.js";
import { listSessionActiveGlobs } from "../repo.js";
import {
  updateSessionBranch,
  replaceChangeRecords,
  pruneChangeRecords,
} from "../repo.js";
import { withContext } from "../scopedDb.js";
import { maybePruneRetention } from "../retention.js";
import { buildLandscape } from "./landscape.js";

export async function sync(
  input: SyncRequestT,
  tenant: TenantContext,
): Promise<SyncResponseT> {
  const { pool, config } = getContext();

  return withContext(pool, contextForTenant(tenant), async (tx) => {
    // Resolve + authorize the session as the FIRST statement (no second
    // connection). resolveSession handles both credential kinds; a session the
    // caller may not reach throws UnknownSessionError (-> 404), the cross-tenant
    // gate. The concrete workspace is read from the session below.
    const session = await resolveSession(tx, tenant, input.sessionId);

    const now = new Date();

    // 1. Heartbeat: update last_heartbeat_at and renew all active claims
    //    using each claim's OWN ttl_seconds (not a default).
    await touchHeartbeat(tx, session.id, now);

    // 1b. Durable change awareness: if the caller reported its working state,
    //     update its branch and wholesale-replace its change records. Always
    //     prune expired change records for this workspace+repo afterwards.
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
    }
    await pruneChangeRecords(
      tx,
      session.workspaceId,
      session.repo,
      now,
      config.CHANGE_RECORD_TTL_SECONDS,
    );
    // Lazy announcement retention (entitlements window). Hourly-throttled
    // per workspace and inert without ENTITLEMENTS_DEFAULT_LIMITS — see
    // retention.ts.
    await maybePruneRetention(tx, config, session.workspaceId, now);

    // 2. Read this session's own active path globs to detect collisions that
    //    appeared against its existing claims after it made them.
    const myGlobs = await listSessionActiveGlobs(tx, session.id, now);

    // 3. Build the landscape on the SAME tx: conflicts are computed against the
    //    caller's own active globs.
    const landscape = await buildLandscape(tx, session, now, myGlobs, config);

    return { landscape };
  });
}
