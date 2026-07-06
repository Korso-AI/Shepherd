/**
 * Member management operations (Task 3.6): list the roster, remove a member, and
 * leave a workspace.
 *
 * All three are `/workspaces/:id/*` routes, so by the time these run resolveTenant
 * has ALREADY validated the browser-via-BFF caller is a MEMBER of `:id` (a
 * non-member is rejected 404 in the onRequest hook, before any handler) and set
 * `tenant.role`. The tenant therefore carries a concrete, membership-checked
 * `workspaceId`; that scoping is the whole isolation story — every query below is
 * pinned to it via requireWorkspaceId.
 *
 *  - list:   any member may see the roster (membership is the gate, already
 *            enforced upstream — there is intentionally NO requireAdmin here).
 *  - remove: admin-only. Resolves the target within THIS workspace (a non-member
 *            reads as 404, no existence leak), refuses to remove the LAST admin
 *            (409), then removes the membership AND revokes that member's tokens
 *            in this workspace in ONE transaction — a removed member's agent
 *            tokens must not outlive their membership.
 *  - leave:  the caller removes their own membership (+ revokes their own tokens,
 *            same rationale), unless they are the LAST admin (409): a workspace
 *            must always keep at least one admin.
 *
 * The last-admin guard (remove + leave) is the only invariant these operations
 * enforce beyond authorization; it is NOT a SQL constraint, so the check + the
 * mutation race could in principle interleave. countAdmins reads committed state
 * and the window is tiny; a stricter SELECT … FOR UPDATE lock is a possible
 * follow-up. Note the failure mode (zero admins) is NOT self-recoverable in
 * product: minting an invite requires an admin (createInvite → requireAdmin), so
 * with no admin left there is no one who can issue one — recovery needs operator
 * / direct-DB intervention. This is left out of the task's scope only because the
 * race window is tiny, not because it self-heals.
 */

import type { ListMembersResponseT } from "@shepherd/shared";

import { getContext } from "../context.js";
import { withTransaction } from "../db.js";
import { AuthError, ConflictError } from "../errors.js";
import {
  listMembers,
  findMembership,
  countAdmins,
  removeMembership,
  revokeApiTokensForMember,
} from "../repo.js";
import {
  requireAccountId,
  requireAdmin,
  requireWorkspaceId,
  type TenantContext,
} from "../tenant.js";

/**
 * List every member of the caller's workspace with their profile snapshot + role.
 * Any member may call this — membership of `:id` is already enforced upstream by
 * resolveTenant, so there is no admin gate (the design lets members see the
 * roster). Strictly workspace-scoped via requireWorkspaceId.
 */
export async function listWorkspaceMembers(
  tenant: TenantContext
): Promise<ListMembersResponseT> {
  const { pool } = getContext();
  const workspaceId = requireWorkspaceId(tenant);
  const members = await listMembers(pool, workspaceId);
  return { members };
}

/**
 * Remove `targetAccountId` from the caller's workspace. Admin-only. The target is
 * resolved WITHIN this workspace (a non-member — or a cross-workspace account —
 * reads as 404, never revealing whether the account exists elsewhere). The LAST
 * admin cannot be removed (409). On success the membership is deleted AND that
 * member's live tokens in this workspace are revoked, atomically.
 */
export async function removeMember(
  targetAccountId: string,
  tenant: TenantContext
): Promise<{ removed: true; tokensRevoked: number }> {
  const { pool } = getContext();
  const workspaceId = requireWorkspaceId(tenant);
  requireAdmin(tenant);

  const target = await findMembership(pool, targetAccountId, workspaceId);
  if (target === null) {
    // Not a member of THIS workspace — generic 404 (no existence leak).
    throw new AuthError(404, "member not found");
  }

  // Last-admin guard: refuse to strip the workspace of its final admin.
  if (target.role === "admin" && (await countAdmins(pool, workspaceId)) <= 1) {
    throw new ConflictError(
      "Cannot remove the last admin; promote or transfer another admin first."
    );
  }

  const tokensRevoked = await withTransaction(pool, async (tx) => {
    await removeMembership(tx, workspaceId, targetAccountId);
    // A removed member's agent tokens must not outlive their membership.
    return revokeApiTokensForMember(tx, workspaceId, targetAccountId);
  });

  return { removed: true, tokensRevoked };
}

/**
 * Remove the CALLER's own membership from the workspace (+ revoke their own tokens
 * in it). The caller is necessarily a member (resolveTenant validated `:id`), but
 * a last admin cannot leave (409) — a workspace must always retain an admin.
 */
export async function leaveWorkspace(
  tenant: TenantContext
): Promise<{ left: true; tokensRevoked: number }> {
  const { pool } = getContext();
  const workspaceId = requireWorkspaceId(tenant);
  const accountId = requireAccountId(tenant);

  // Defensive: resolveTenant already validated membership of a `:id` route, so
  // this should always resolve — but pin it rather than trust the upstream.
  const own = await findMembership(pool, accountId, workspaceId);
  if (own === null) {
    throw new AuthError(404, "not a member of the requested workspace");
  }

  // Last-admin guard: the final admin must promote/transfer before leaving.
  if (own.role === "admin" && (await countAdmins(pool, workspaceId)) <= 1) {
    throw new ConflictError(
      "You are the last admin; promote or transfer admin before leaving."
    );
  }

  const tokensRevoked = await withTransaction(pool, async (tx) => {
    await removeMembership(tx, workspaceId, accountId);
    return revokeApiTokensForMember(tx, workspaceId, accountId);
  });

  return { left: true, tokensRevoked };
}
