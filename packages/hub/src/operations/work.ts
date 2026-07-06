/**
 * work operation: atomic check-and-claim.
 *
 * In one transaction (with a per-repo advisory lock for serialisation):
 *   1. Look up the session.
 *   2. Acquire the per-(workspace, repo) advisory lock.
 *   3. Heartbeat the session (renews its existing claims).
 *   4. Reuse an existing matching active claim if the SAME (intent + normalized
 *      pathGlobs) is already held by this session (idempotent retry/refresh),
 *      otherwise insert a new claim with a resolved TTL.
 *   5. Build the landscape (other sessions' active claims, advisory conflicts
 *      against the requested globs, and pending announcements).
 *   6. Return { workItemId, landscape }.
 *
 * The claim ALWAYS succeeds — conflicts are advisory only.
 */

import type { WorkRequestT, WorkResponseT } from "@shepherd/shared";
import { getContext } from "../context.js";
import { type TenantContext } from "../tenant.js";
import { resolveSession } from "../sessionScope.js";
import { touchHeartbeat } from "../repo.js";
import { insertWorkItem } from "../repo.js";
import {
  updateSessionBranch,
  replaceChangeRecords,
  pruneChangeRecords,
  listSessionClaims,
} from "../repo.js";
import { withTransaction } from "../db.js";
import { resolveTtlSeconds, computeExpiry } from "../presence.js";
import { buildLandscape } from "./landscape.js";

/**
 * Canonical form of a pathGlobs list for idempotent-claim matching: trim each
 * glob, drop blanks and duplicates, and sort. Two `work` calls that name the
 * same files in a different ORDER (or with incidental repeats/whitespace) are
 * the same claim, so they must canonicalize identically.
 */
function normalizeGlobs(globs: string[]): string[] {
  return [...new Set(globs.map((g) => g.trim()).filter((g) => g.length > 0))].sort();
}

/** Whether two already-normalized glob lists are equal element-for-element. */
function globsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((g, i) => g === b[i]);
}

export async function work(
  input: WorkRequestT,
  tenant: TenantContext
): Promise<WorkResponseT> {
  const { pool, config } = getContext();

  return withTransaction(pool, async (tx) => {
    // Resolve + authorize the session ON THE TRANSACTION CLIENT as the FIRST
    // statement, so the membership check and the write below stay atomic.
    // resolveSession handles BOTH credential kinds: a workspace-scoped/self-host
    // token keeps getSession's cross-tenant gate; an account-scoped token reads
    // the session's own workspace and requires live membership. Either way a
    // session the caller may not reach throws UnknownSessionError (-> 404) — the
    // P1 cross-tenant isolation gate. The empty transaction simply rolls back;
    // no row is written. The concrete workspace is read from the session below.
    const session = await resolveSession(tx, tenant, input.sessionId);

    // Acquire a per-repo serialisation lock FIRST so that the check-then-claim
    // sequence is genuinely atomic per (workspace, repo). The advisory lock is
    // released automatically at COMMIT/ROLLBACK — no explicit unlock needed.
    // The two-arg form keys on (workspace, repo) independently, widening the
    // keyspace to 2^64 so distinct repos cannot collide on a single hashtext.
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [session.workspaceId, session.repo]
    );

    const now = new Date();

    // 1. Heartbeat: update last_heartbeat_at and renew all active claims.
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
      config.CHANGE_RECORD_TTL_SECONDS
    );

    // 2. Idempotency: a repeated `work` for the SAME (intent + normalized
    //    pathGlobs) on this session must not pile up duplicate active claims —
    //    e.g. an agent that re-runs the same claim to renew/refresh it, or a
    //    client retry after a dropped response. Reuse the existing matching
    //    active claim instead of inserting a new row. touchHeartbeat above
    //    already renewed every active claim for this session, so the matched
    //    claim is freshly refreshed — we just return its id. Self-scoped, so a
    //    different agent claiming the same files still inserts its own claim and
    //    surfaces as a conflict (advisory), unchanged.
    const ownClaims = await listSessionClaims(tx, session.id, now);
    const wantGlobs = normalizeGlobs(input.pathGlobs);
    const existing = ownClaims.find(
      (c) => c.intent === input.intent && globsEqual(normalizeGlobs(c.pathGlobs), wantGlobs)
    );

    let workItemId: string;
    if (existing) {
      // Reuse (already TTL-renewed by touchHeartbeat) — no duplicate insert.
      workItemId = existing.workItemId;
    } else {
      // 3. Resolve TTL and compute expiry timestamp, then insert the new claim.
      const ttlSeconds = resolveTtlSeconds(input.ttlSeconds, config);
      const expiresAt = computeExpiry(now, ttlSeconds);
      workItemId = await insertWorkItem(tx, {
        workspaceId: session.workspaceId,
        sessionId: session.id,
        repo: session.repo,
        intentText: input.intent,
        pathGlobs: input.pathGlobs,
        ttlSeconds,
        expiresAt,
      });
    }

    // 4. Build the landscape on the SAME tx: conflicts are computed against the
    //    globs just requested. listActiveClaims excludes this session, so the
    //    row we just inserted is not reported back to its owner.
    const landscape = await buildLandscape(tx, session, now, input.pathGlobs, config);

    return { workItemId, landscape };
  });
}
