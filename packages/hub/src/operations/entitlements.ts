/**
 * Internal entitlements operations: the /internal/workspaces/:id/entitlements
 * management surface a trusted embedding service (the platform BFF, calling
 * on its own behalf) uses to push per-workspace caps into the hub.
 *
 *  - putEntitlements:    upsert the workspace's caps record (404 for an
 *      unknown workspace — the caller is already fully trusted, so there is
 *      no existence-leak concern in being precise).
 *  - getEntitlementsStatus: the stored record (null when none), the caps that
 *      actually apply right now (all-null when this deployment never enabled
 *      enforcement), and current usage so the caller can render headroom.
 *  - deleteEntitlements: drop the record, reverting the workspace to the
 *      deployment defaults. Idempotent.
 *
 * Every operation gates on requireInternal — only the BFF service-call path
 * (matched x-internal-token + /internal/* pathname + no x-account-id) may
 * reach these; see tenant.ts for the discriminator.
 */

import type {
  EntitlementsStatusResponseT,
  PutEntitlementsRequestT,
  WorkspaceEntitlementsT,
} from "@shepherd/shared";
import { getContext } from "../context.js";
import { effectiveLimits, enforcementEnabled } from "../entitlements.js";
import { AuthError } from "../errors.js";
import { requireInternal, type TenantContext } from "../tenant.js";
import {
  countMembers,
  deleteWorkspaceEntitlements,
  findWorkspaceById,
  getWorkspaceEntitlements,
  listWorkspaceRepos,
  upsertWorkspaceEntitlements,
  type WorkspaceEntitlementsRow,
} from "../repo.js";

/** A stored row in its wire shape (ISO timestamps, camelCase caps). */
function toWire(row: WorkspaceEntitlementsRow): WorkspaceEntitlementsT {
  return {
    seatsLimit: row.seats_limit,
    reposLimit: row.repos_limit,
    retentionDays: row.retention_days,
    expiresAt: row.expires_at === null ? null : row.expires_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/** 404 unless `workspaceId` names a real workspace. */
async function assertWorkspaceExists(workspaceId: string): Promise<void> {
  const { pool } = getContext();
  const ws = await findWorkspaceById(pool, workspaceId);
  if (ws === null) {
    throw new AuthError(404, "workspace not found");
  }
}

export async function putEntitlements(
  workspaceId: string,
  body: PutEntitlementsRequestT,
  tenant: TenantContext,
): Promise<WorkspaceEntitlementsT> {
  requireInternal(tenant);
  const { pool } = getContext();

  await assertWorkspaceExists(workspaceId);
  const row = await upsertWorkspaceEntitlements(pool, workspaceId, {
    seatsLimit: body.seatsLimit,
    reposLimit: body.reposLimit,
    retentionDays: body.retentionDays,
    expiresAt: body.expiresAt === null ? null : new Date(body.expiresAt),
  });
  return toWire(row);
}

export async function getEntitlementsStatus(
  workspaceId: string,
  tenant: TenantContext,
): Promise<EntitlementsStatusResponseT> {
  requireInternal(tenant);
  const { pool, config } = getContext();

  await assertWorkspaceExists(workspaceId);
  const record = await getWorkspaceEntitlements(pool, workspaceId);

  // With enforcement off there are no limits of any kind — report all-null
  // rather than pretending a stored record binds anything.
  const effective = enforcementEnabled(config)
    ? effectiveLimits(record, config.ENTITLEMENTS_DEFAULT_LIMITS!, new Date())
    : { seatsLimit: null, reposLimit: null, retentionDays: null };

  const [seatsUsed, repos] = await Promise.all([
    countMembers(pool, workspaceId),
    listWorkspaceRepos(pool, workspaceId),
  ]);

  return {
    record: record === null ? null : toWire(record),
    effective,
    usage: { seatsUsed, reposUsed: repos.length },
  };
}

export async function deleteEntitlements(
  workspaceId: string,
  tenant: TenantContext,
): Promise<{ deleted: boolean }> {
  requireInternal(tenant);
  const { pool } = getContext();

  const deleted = await deleteWorkspaceEntitlements(pool, workspaceId);
  return { deleted };
}
