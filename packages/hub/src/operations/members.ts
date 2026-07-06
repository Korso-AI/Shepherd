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

import type {
  ListMembersResponseT,
  RoleT,
  SetMemberRoleResponseT,
  TransferOwnershipResponseT,
} from "@shepherd/shared";

import { getContext } from "../context.js";
import { withTransaction } from "../db.js";
import { AuthError, ConflictError } from "../errors.js";
import {
  listMembers,
  findMembership,
  findWorkspaceById,
  countAdmins,
  removeMembership,
  revokeApiTokensForMember,
  setRole,
  setWorkspaceOwner,
} from "../repo.js";
import {
  requireAccountId,
  requireAdmin,
  requireWorkspaceId,
  type TenantContext,
} from "../tenant.js";

/**
 * Resolve the OWNER account of `workspaceId` (workspaces.created_by), or throw
 * 404 if the workspace has vanished. The owner is the single account allowed to
 * change roles or transfer ownership; there is no role column value for it, so it
 * is derived here from created_by rather than from `tenant.role`.
 */
async function requireOwnerAccount(
  db: Parameters<typeof findWorkspaceById>[0],
  workspaceId: string,
  callerAccountId: string
): Promise<string> {
  const ws = await findWorkspaceById(db, workspaceId);
  if (ws === null) {
    throw new AuthError(404, "workspace not found");
  }
  if (ws.createdBy !== callerAccountId) {
    throw new AuthError(403, "operation requires the workspace owner");
  }
  return ws.createdBy;
}

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
  // requireAdmin already rejected the self-host TEAM_TOKEN (no role), so an
  // accountId is always present here — needed for the owner comparisons below.
  const callerAccountId = requireAccountId(tenant);

  const target = await findMembership(pool, targetAccountId, workspaceId);
  if (target === null) {
    // Not a member of THIS workspace — generic 404 (no existence leak).
    throw new AuthError(404, "member not found");
  }

  const ws = await findWorkspaceById(pool, workspaceId);
  if (ws === null) {
    throw new AuthError(404, "workspace not found");
  }
  const callerIsOwner = ws.createdBy === callerAccountId;

  // The OWNER can never be removed by anyone — the power structure is theirs to
  // hand off. They must transfer ownership first, then be removed / leave.
  if (targetAccountId === ws.createdBy) {
    throw new ConflictError(
      "The workspace owner cannot be removed; transfer ownership first."
    );
  }

  // Removing a fellow ADMIN is owner-only: a plain admin managing the roster may
  // remove members, but not other admins — otherwise a promoted admin could
  // still dismantle the admin group they can't demote.
  if (target.role === "admin" && !callerIsOwner) {
    throw new AuthError(403, "removing an admin requires the workspace owner");
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

/**
 * Set `targetAccountId`'s role in the caller's workspace (promote member→admin or
 * demote admin→member). OWNER-ONLY: restricting role changes to the owner is the
 * escalation guard — a promoted admin cannot then demote the rest and seize the
 * workspace. The owner cannot change their OWN role (they are always an admin),
 * an unknown target reads as 404, and the last-admin guard still applies on a
 * demotion (naturally satisfied while the owner remains an admin). Idempotent:
 * setting the role a member already holds is a no-op success.
 */
export async function setMemberRole(
  targetAccountId: string,
  role: RoleT,
  tenant: TenantContext
): Promise<SetMemberRoleResponseT> {
  const { pool } = getContext();
  const workspaceId = requireWorkspaceId(tenant);
  const callerAccountId = requireAccountId(tenant);
  await requireOwnerAccount(pool, workspaceId, callerAccountId);

  if (targetAccountId === callerAccountId) {
    // The owner is always an admin; there is no valid self role-change.
    throw new ConflictError("The owner's role cannot be changed.");
  }

  const target = await findMembership(pool, targetAccountId, workspaceId);
  if (target === null) {
    throw new AuthError(404, "member not found");
  }

  if (target.role === role) {
    // Already at the requested role — nothing to do.
    return { ok: true, role };
  }

  // Demotion last-admin guard (defensive: with the owner always an admin, and the
  // owner unable to demote themselves, the workspace always retains ≥1 admin).
  if (role === "member" && (await countAdmins(pool, workspaceId)) <= 1) {
    throw new ConflictError(
      "Cannot demote the last admin; promote or transfer another admin first."
    );
  }

  await setRole(pool, workspaceId, targetAccountId, role);
  return { ok: true, role };
}

/**
 * Transfer ownership of the caller's workspace to `targetAccountId`. OWNER-ONLY.
 * The target must already be a MEMBER (404 otherwise); they become the new owner
 * (workspaces.created_by) and are promoted to admin if they weren't already, in
 * ONE transaction so the "owner is always an admin" invariant never lapses. The
 * former owner stays an admin. This is the only way to change who the owner is.
 */
export async function transferOwnership(
  targetAccountId: string,
  tenant: TenantContext
): Promise<TransferOwnershipResponseT> {
  const { pool } = getContext();
  const workspaceId = requireWorkspaceId(tenant);
  const callerAccountId = requireAccountId(tenant);
  await requireOwnerAccount(pool, workspaceId, callerAccountId);

  if (targetAccountId === callerAccountId) {
    throw new ConflictError("You are already the owner of this workspace.");
  }

  const target = await findMembership(pool, targetAccountId, workspaceId);
  if (target === null) {
    throw new AuthError(404, "member not found");
  }

  await withTransaction(pool, async (tx) => {
    await setWorkspaceOwner(tx, workspaceId, targetAccountId);
    // The new owner must be an admin — promote if they were a member.
    if (target.role !== "admin") {
      await setRole(tx, workspaceId, targetAccountId, "admin");
    }
  });

  return { ok: true };
}
