/**
 * Workspace management operations: create a workspace, list mine, delete one.
 *
 * createWorkspace/listWorkspaces are account-scoped, not workspace-scoped: they
 * key off `tenant.accountId`, never the route `:id` (the NON-`:id` routes
 * `POST /workspaces` and `GET /workspaces`). A credential with no account — the
 * self-host TEAM_TOKEN — cannot manage workspaces; management is a hosted/
 * account-only surface. deleteWorkspace is the exception: it is the
 * `/workspaces/:id` route, so it is workspace-scoped and admin-gated (like the
 * member-management ops).
 *
 *  - createWorkspace: a signed-in account MINTS a new workspace and becomes its
 *    first admin, in ONE transaction (createWorkspace + addMembership) so a
 *    half-created workspace — a row with no owner — can never exist.
 *  - listWorkspaces: every workspace the account belongs to, with its own role.
 *    Scoped by accountId, so an agent `shp_` token (which carries an accountId
 *    but is bound to a single workspace) still correctly returns ALL of that
 *    account's workspaces — this is what the MCP `link` tool relies on.
 *  - deleteWorkspace: any ADMIN permanently deletes the workspace and all its
 *    data in ONE transaction (deleteWorkspaceCascade). Irreversible.
 */

import type {
  CreateWorkspaceRequestT,
  WorkspaceSummaryT,
  ListWorkspacesResponseT,
  DeleteWorkspaceResponseT,
} from "@shepherd/shared";

import { getContext } from "../context.js";
import { withTransaction } from "../db.js";
import { AuthError } from "../errors.js";
import {
  createWorkspace as createWorkspaceRow,
  addMembership,
  countWorkspacesCreatedBy,
  listWorkspacesForAccount,
  findWorkspaceBySlug,
  slugifyWorkspaceName,
  deleteWorkspaceCascade,
} from "../repo.js";
import {
  requireAccountId,
  requireAdmin,
  requireWorkspaceId,
  type TenantContext,
} from "../tenant.js";

/**
 * Per-account cap on created workspaces (design §8). The (cap+1)th create is
 * rejected with 403; the count is `workspaces.created_by = accountId`.
 */
const MAX_WORKSPACES_PER_ACCOUNT = 10;

/**
 * Derive a UNIQUE slug for `name`. The candidate comes from `slugifyWorkspaceName`
 * (lowercase-kebab); an all-symbol/empty name slugifies to "" so we fall back to a
 * generated base. We then collision-suffix (`base`, `base-2`, `base-3`, …) until
 * `findWorkspaceBySlug` reports the slug free.
 *
 * The slug uniqueness is ALSO enforced by the `workspaces.slug` UNIQUE constraint;
 * this loop avoids the constraint error on the common path. A race between two
 * concurrent creates of the same name would still surface the constraint error
 * from `createWorkspace` (acceptable: rare, and the caller simply retries).
 */
async function deriveUniqueSlug(
  db: Parameters<typeof findWorkspaceBySlug>[0],
  name: string
): Promise<string> {
  const base = slugifyWorkspaceName(name) || `workspace-${Date.now().toString(36)}`;
  let candidate = base;
  let suffix = 2;
  while ((await findWorkspaceBySlug(db, candidate)) !== null) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Create a workspace for the signed-in account and make it the first admin.
 * Enforces the per-account creation cap, derives a unique slug, and performs the
 * insert + membership in a single transaction.
 */
export async function createWorkspace(
  input: CreateWorkspaceRequestT,
  tenant: TenantContext
): Promise<WorkspaceSummaryT> {
  const { pool } = getContext();
  const accountId = requireAccountId(tenant);

  const created = await countWorkspacesCreatedBy(pool, accountId);
  if (created >= MAX_WORKSPACES_PER_ACCOUNT) {
    throw new AuthError(403, "workspace creation cap reached");
  }

  // Derive the slug on the pool BEFORE the transaction so the collision check
  // sees committed rows; the UNIQUE constraint is the final backstop.
  const slug = await deriveUniqueSlug(pool, input.name);

  const workspace = await withTransaction(pool, async (tx) => {
    const ws = await createWorkspaceRow(tx, {
      slug,
      name: input.name,
      createdBy: accountId,
    });
    await addMembership(tx, { workspaceId: ws.id, accountId, role: "admin" });
    return ws;
  });

  // The creator is the workspace's first admin AND its owner (created_by).
  return {
    id: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    role: "admin",
    isOwner: true,
  };
}

/** List every workspace the signed-in account belongs to, with its own role. */
export async function listWorkspaces(
  tenant: TenantContext
): Promise<ListWorkspacesResponseT> {
  const { pool } = getContext();
  const accountId = requireAccountId(tenant);
  const workspaces = await listWorkspacesForAccount(pool, accountId);
  return { workspaces };
}

/**
 * Permanently delete the caller's active workspace and all its data.
 *
 * This is the `/workspaces/:id` route (workspace-scoped, unlike create/list
 * above), so resolveTenant has ALREADY validated the browser caller's membership
 * of `:id` and set `tenant.role`; we gate on `requireAdmin` — ANY admin may
 * delete, regardless of member count (the type-to-confirm modal in the UI is the
 * guard against accident, per the design). requireWorkspaceId rejects the
 * NO_ROUTE_WORKSPACE sentinel (a non-workspace-scoped credential) with 400.
 *
 * The delete is a single transaction (deleteWorkspaceCascade): a partial failure
 * rolls back, so a workspace can never be left with some children orphaned and
 * others gone. Irreversible — there is no soft-delete or restore.
 */
export async function deleteWorkspace(
  tenant: TenantContext
): Promise<DeleteWorkspaceResponseT> {
  const { pool } = getContext();
  const workspaceId = requireWorkspaceId(tenant);
  requireAdmin(tenant);

  await withTransaction(pool, (tx) => deleteWorkspaceCascade(tx, workspaceId));

  return { deleted: true };
}
