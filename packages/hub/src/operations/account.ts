/**
 * Account self-service: permanently delete the CALLER's account.
 *
 * DELETE /account — a non-`:id` route, so resolveTenant does NO route-membership
 * check; like invite redemption, this operation pins the trust explicitly:
 *
 *  - requireAccountId — a self-host TEAM_TOKEN (no accountId) is rejected.
 *  - the credential MUST be the browser-via-BFF path (`tenant.via === "browser"`):
 *    a leaked agent `shp_` token must never be able to erase its owning account.
 *
 * WHAT DELETION MEANS, per workspace the account belongs to:
 *
 *  - Sole member         → the workspace is deleted outright
 *    (deleteWorkspaceCascade), since with its only member gone it would be an
 *    unreachable admin-less husk (recovery would need direct-DB intervention —
 *    see the last-admin note in operations/members.ts).
 *  - Last admin, but the workspace still has OTHER members → 409 ConflictError
 *    BEFORE anything is mutated. The caller must promote another admin or
 *    delete that workspace first — the same invariant the leave/remove paths
 *    enforce (a workspace must always retain an admin).
 *  - Otherwise           → the membership is removed and the account's tokens
 *    in that workspace are revoked, exactly like a leave.
 *
 * Then, account-wide: every remaining live token the account owns is revoked
 * (including account-scoped, workspace_id IS NULL ones) and the profile row is
 * deleted. All mutations run in ONE transaction, with the guards re-checked
 * inside it, so a failure midway leaves the account fully intact. Feedback rows
 * keep their free-text account_id (product history, mirroring how deleted
 * workspaces preserve feedback); the external identity itself lives with the
 * IdP, so signing in again simply mints a fresh, empty account.
 */

import type { DeleteAccountResponseT } from "@shepherd/shared";

import { getContext } from "../context.js";
import { withTransaction } from "../db.js";
import { AuthError, ConflictError } from "../errors.js";
import {
  listWorkspacesForAccount,
  countAdmins,
  countMembers,
  deleteWorkspaceCascade,
  removeMembership,
  revokeApiTokensForMember,
  revokeAllApiTokensForAccount,
  deleteAccountProfile,
} from "../repo.js";
import { requireAccountId, type TenantContext } from "../tenant.js";

/**
 * Permanently delete the caller's account. See the file header for the trust
 * model and per-workspace semantics. Throws 403 for a non-browser credential
 * and 409 (ConflictError) when the caller is the last admin of a workspace
 * that still has other members.
 */
export async function deleteAccount(
  tenant: TenantContext
): Promise<DeleteAccountResponseT> {
  const { pool } = getContext();
  const accountId = requireAccountId(tenant);

  if (tenant.via !== "browser") {
    throw new AuthError(403, "account deletion requires a browser account session");
  }

  await withTransaction(pool, async (tx) => {
    // Membership snapshot + guards INSIDE the transaction, so the decision and
    // the mutation see the same committed state.
    const workspaces = await listWorkspacesForAccount(tx, accountId);

    for (const ws of workspaces) {
      const members = await countMembers(tx, ws.id);
      if (members <= 1) {
        // The caller is the only member: the workspace would be an orphaned,
        // admin-less husk — delete it with all its data.
        await deleteWorkspaceCascade(tx, ws.id);
        continue;
      }
      if (ws.role === "admin" && (await countAdmins(tx, ws.id)) <= 1) {
        // Other members exist but no other admin: refuse BEFORE mutating
        // anything (the throw rolls the whole transaction back).
        throw new ConflictError(
          `You're the last admin of "${ws.name}", which still has other members. ` +
            `Promote another admin or delete that workspace first.`
        );
      }
      await removeMembership(tx, ws.id, accountId);
      await revokeApiTokensForMember(tx, ws.id, accountId);
    }

    // Account-wide sweep: any token not covered by the per-workspace revokes
    // above (account-scoped tokens have workspace_id IS NULL) dies here too.
    await revokeAllApiTokensForAccount(tx, accountId);
    await deleteAccountProfile(tx, accountId);
  });

  return { deleted: true };
}
