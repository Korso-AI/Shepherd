/**
 * Session resolution for the coordination operations — the per-request tenancy
 * gate on a `sessionId`.
 *
 * A session UUID is a capability the agent presents in the request BODY, not a
 * route/identity input. Before an operation may act on one, the hub must prove
 * the CALLER is allowed to reach that session's workspace. This module is the
 * single place that proof lives, so the six session-bearing operations
 * (work/done/sync/heartbeat/leave/announce) stop each re-deriving the workspace
 * — "one guard in the resolver beats a check in every handler."
 *
 * It handles BOTH credential kinds uniformly (see the {@link TenantContext}
 * `workspaceId` contract): a workspace-scoped/self-host token already carries a
 * concrete workspace, so it keeps today's `getSession` cross-tenant gate exactly;
 * an account-scoped token carries only an account, so the session's own
 * workspace is read and then authorized by live membership. Fail-closed: an
 * unknown session AND a session in a workspace the account can't see produce the
 * SAME observable response (the same {@link UnknownSessionError} → type/message/
 * status), so the account cannot tell them apart. A one-query timing delta does
 * exist (the non-member path runs the membership lookup the unknown path skips),
 * but it is unexploitable given unguessable 122-bit UUID session ids.
 */

import { UnknownSessionError } from "./errors.js";
import { getSession, getSessionById, findMembership } from "./repo.js";
import type { SessionWithAgent } from "./repo.js";
import { setDbContext, type ScopedDb } from "./scopedDb.js";
import { NO_ROUTE_WORKSPACE, requireAccountId } from "./tenant.js";
import type { TenantContext } from "./tenant.js";

/**
 * Resolve a request's `sessionId` to the membership-authorized session for the
 * calling tenant, or throw {@link UnknownSessionError} (→ 404). The returned
 * session's `workspaceId` is the concrete workspace the operation then scopes to.
 *
 * Runs on the operation's {@link ScopedDb} transaction so the lookup + membership
 * check share the same transaction/connection as the write that follows (READ
 * COMMITTED — statements share the connection, NOT one MVCC snapshot, so a
 * concurrent membership revocation may still commit between this check and a
 * later write; that is no worse than today's per-request check).
 *
 * - Workspace-scoped / self-host credential (`workspaceId` is a concrete id):
 *   defer to {@link getSession}, whose `workspace_id` predicate is the existing
 *   cross-tenant isolation gate — a session in another workspace is simply not
 *   found and throws (404). The transaction is already in that workspace's
 *   context (see {@link contextForTenant}), so no context change is needed.
 * - Account-scoped credential (`workspaceId` is {@link NO_ROUTE_WORKSPACE}): the
 *   transaction runs in ACCOUNT context, so sessions/agents are visible only
 *   through the caller's own memberships (migration 021's membership-EXISTS
 *   arm) — a session in a foreign workspace is simply invisible and both
 *   "no such session" and "a session you may not see" collapse to the same
 *   {@link UnknownSessionError} (404), no existence disclosure. Once membership
 *   is proven the session's workspace is ADOPTED into the transaction context so
 *   the operation's writes run under workspace-context policies.
 */
export async function resolveSession(
  db: ScopedDb,
  tenant: TenantContext,
  sessionId: string,
): Promise<SessionWithAgent> {
  if (tenant.workspaceId !== NO_ROUTE_WORKSPACE) {
    return getSession(db, tenant.workspaceId, sessionId);
  }
  // Account-scoped credential: the transaction is in ACCOUNT context, where
  // sessions/agents are readable only through the caller's own memberships
  // (migration 021's membership-EXISTS arm) — so a session in a foreign
  // workspace is simply invisible and both "unknown" and "not yours" collapse
  // to the same 404, exactly as today.
  const session = await getSessionById(db, sessionId);
  if (session === null) {
    throw new UnknownSessionError(sessionId);
  }
  const membership = await findMembership(
    db,
    requireAccountId(tenant),
    session.workspaceId,
  );
  if (membership === null) {
    throw new UnknownSessionError(sessionId);
  }
  // Membership proven — ADOPT the session's workspace for the rest of the
  // transaction so the operation's writes run under workspace-context policies.
  await setDbContext(db, {
    kind: "workspace",
    workspaceId: session.workspaceId,
    accountId: requireAccountId(tenant),
  });
  return session;
}
