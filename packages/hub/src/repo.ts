/**
 * Data-access layer for @shepherd/hub.
 *
 * EVERY SQL query lives here. Workspace scoping and the "active claim"
 * definition are enforced in exactly one place.
 *
 * Mutating functions accept a `tx` (pg.PoolClient from withTransaction) so
 * callers can compose multiple operations atomically.
 * Read-only functions (`getSession`, `listActiveClaims`) accept the pool.
 */

import pg from "pg";
import type {
  ClaimT,
  AnnouncementT,
  ChangeRecordT,
  FeedbackContextT,
  RoleT,
  WorkspaceSummaryT,
  TokenSummaryT,
  MemberSummaryT,
  TrendPointT,
  TopWorkspaceT,
  ShepherdAnalyticsResponseT,
} from "@shepherd/shared";
import { UnknownSessionError } from "./errors.js";

/**
 * Anything that can run a parameterised query: the pool itself OR a checked-out
 * client (pg.PoolClient from withTransaction). Read functions accept either so
 * callers inside a transaction can pass `tx` and avoid checking out a SECOND
 * connection — see the pool-exhaustion note in operations/work.ts.
 */
type Queryable = pg.Pool | pg.PoolClient;

/**
 * Max pending announcements delivered to a session in a single work/sync call.
 * A hardcoded integer constant (never user input) so it is safe to interpolate
 * into the SQL text. Surplus is delivered on later calls, oldest-id first.
 */
const DELIVERY_BATCH_LIMIT = 200;

// ---------------------------------------------------------------------------
// Identity & tenancy (migration 011) — lookups used by resolveTenant (Task 2.2)
//
// These five functions are the ONLY data access the auth/tenancy layer needs.
// The mutating ones take a Queryable so resolveTenant can run them on the pool
// (it never opens a transaction). The fuller CRUD over these tables is Task 3.1.
// ---------------------------------------------------------------------------

/** A non-revoked api_tokens row, by its token_hash. */
export interface ApiTokenRow {
  id: string;
  account_id: string;
  /**
   * The workspace this token is locked to, or `null` for an ACCOUNT-scoped
   * token (migration 015 dropped the NOT NULL). A null workspace_id means the
   * token is not bound to any single workspace; the per-workspace membership
   * check at resolve/session time is what gates which workspaces it can reach.
   */
  workspace_id: string | null;
}

/**
 * Look up an ACTIVE (non-revoked) api_tokens row by its token_hash, or null.
 * The hash is the only stored form of the secret. A revoked token
 * (revoked_at IS NOT NULL) is treated as not found.
 */
export async function findApiTokenByHash(
  db: Queryable,
  tokenHash: string
): Promise<ApiTokenRow | null> {
  const { rows } = await db.query<ApiTokenRow>(
    `SELECT id, account_id, workspace_id
     FROM   api_tokens
     WHERE  token_hash = $1
       AND  revoked_at IS NULL`,
    [tokenHash]
  );
  return rows[0] ?? null;
}

/**
 * The role an account holds in a workspace, or null when there is no membership
 * row for (accountId, workspaceId). Callers MUST treat null as "no access" —
 * resolveTenant turns a missing membership into a 404 (does not reveal existence).
 */
export async function findMembership(
  db: Queryable,
  accountId: string,
  workspaceId: string
): Promise<{ role: "admin" | "member" } | null> {
  const { rows } = await db.query<{ role: "admin" | "member" }>(
    `SELECT role
     FROM   memberships
     WHERE  account_id   = $1
       AND  workspace_id = $2`,
    [accountId, workspaceId]
  );
  return rows[0] ?? null;
}

/**
 * Insert-or-refresh an account's display profile. The browser-via-BFF path
 * upserts trusted profile headers on every request so the snapshot stays fresh.
 *
 * On conflict each field is COALESCEd — a NEW non-null value overwrites, but a
 * null (an ABSENT header) preserves the existing value rather than wiping it.
 * The header being absent means "no news", NOT "clear this field": a single
 * header-less-but-authenticated request must not erase a good snapshot and
 * collapse the roster to the raw accountId. `updated_at` is always bumped.
 * (The trade-off: a field cannot be cleared back to null via this path — an
 * acceptable cost for a best-effort display snapshot vs. losing a known-good
 * name.)
 */
export async function upsertAccountProfile(
  db: Queryable,
  params: {
    accountId: string;
    displayName: string | null;
    githubLogin: string | null;
    email: string | null;
    avatarUrl: string | null;
  }
): Promise<void> {
  const { accountId, displayName, githubLogin, email, avatarUrl } = params;
  await db.query(
    `INSERT INTO account_profiles
       (account_id, display_name, github_login, email, avatar_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (account_id) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, account_profiles.display_name),
       github_login = COALESCE(EXCLUDED.github_login, account_profiles.github_login),
       email        = COALESCE(EXCLUDED.email,        account_profiles.email),
       avatar_url   = COALESCE(EXCLUDED.avatar_url,   account_profiles.avatar_url),
       updated_at   = now()`,
    [accountId, displayName, githubLogin, email, avatarUrl]
  );
}

/** A workspace row, by its unique slug; null when no workspace has that slug. */
export async function findWorkspaceBySlug(
  db: Queryable,
  slug: string
): Promise<{ id: string; slug: string; name: string } | null> {
  const { rows } = await db.query<{ id: string; slug: string; name: string }>(
    `SELECT id, slug, name FROM workspaces WHERE slug = $1`,
    [slug]
  );
  return rows[0] ?? null;
}

/**
 * A workspace row, by its id; null when no workspace has that id. `createdBy` is
 * the OWNER account id (see WorkspaceSummary.isOwner) — callers building a
 * summary compare it to the viewing account to derive ownership.
 */
export async function findWorkspaceById(
  db: Queryable,
  id: string
): Promise<{ id: string; slug: string; name: string; createdBy: string } | null> {
  const { rows } = await db.query<{
    id: string;
    slug: string;
    name: string;
    createdBy: string;
  }>(
    `SELECT id, slug, name, created_by AS "createdBy" FROM workspaces WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/**
 * An account's display profile (the trusted snapshot upserted by the BFF path),
 * or null when no profile row exists. `join` uses this on the hosted path to
 * override the client-supplied `human` with the account's real identity
 * (preferring github_login, then display_name, then the email's local-part).
 */
export async function getAccountProfile(
  db: Queryable,
  accountId: string
): Promise<{
  display_name: string | null;
  github_login: string | null;
  email: string | null;
} | null> {
  const { rows } = await db.query<{
    display_name: string | null;
    github_login: string | null;
    email: string | null;
  }>(
    `SELECT display_name, github_login, email FROM account_profiles WHERE account_id = $1`,
    [accountId]
  );
  return rows[0] ?? null;
}

/**
 * Stamp an api_token's last_used_at to now(). Best-effort liveness/audit signal
 * on the agent-token path; not transactional with the request.
 */
export async function touchApiTokenLastUsed(
  db: Queryable,
  tokenId: string
): Promise<void> {
  await db.query(`UPDATE api_tokens SET last_used_at = now() WHERE id = $1`, [tokenId]);
}

// ---------------------------------------------------------------------------
// Identity & tenancy CRUD (Task 3.1)
//
// The fuller management surface over the migration-011 tables: workspaces,
// memberships, api_tokens and invites. Every function that touches a tenant's
// rows is scoped by `workspaceId` (or `accountId` for the account-scoped
// listings) so a credential can never read or mutate another tenant's data —
// the same isolation discipline the coordination queries above enforce.
// Mutating functions take a Queryable so callers can compose them under
// `withTransaction` (workspace-create is createWorkspace + addMembership in one
// transaction; member-remove is removeMembership + revokeApiTokensForMember).
// ---------------------------------------------------------------------------

/** A full workspaces row (migration 011). */
export interface WorkspaceRow {
  id: string;
  slug: string;
  name: string;
  createdBy: string;
  createdAt: Date;
}

/**
 * Derive a URL-safe slug from a workspace name: lowercase, non-alphanumerics
 * collapsed to single hyphens, leading/trailing hyphens trimmed. The result is
 * a CANDIDATE — uniqueness is enforced by the `workspaces.slug` UNIQUE
 * constraint, so the create path collision-suffixes against `findWorkspaceBySlug`
 * (design §"Slug collisions"). An all-symbol name slugifies to "" — the caller
 * is responsible for falling back to a generated slug in that case.
 */
export function slugifyWorkspaceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Insert a workspace and return the full row. `slug` must already be unique
 * (the caller derives it via slugifyWorkspaceName + a collision-suffix loop);
 * a duplicate slug surfaces the UNIQUE-constraint error rather than being
 * silently resolved here.
 */
export async function createWorkspace(
  db: Queryable,
  params: { slug: string; name: string; createdBy: string }
): Promise<WorkspaceRow> {
  const { slug, name, createdBy } = params;
  const { rows } = await db.query<WorkspaceRow>(
    `INSERT INTO workspaces (slug, name, created_by)
     VALUES ($1, $2, $3)
     RETURNING id, slug, name, created_by AS "createdBy", created_at AS "createdAt"`,
    [slug, name, createdBy]
  );
  return rows[0]!;
}

/**
 * Permanently delete `workspaceId` and every row scoped to it, in ONE
 * transaction (the caller passes a `tx` from withTransaction).
 *
 * WHY explicit ordered child-deletes rather than relying on the FKs: of the
 * tables referencing workspaces(id), only `memberships` and `invites` are
 * ON DELETE CASCADE and `feedback` is ON DELETE SET NULL (migration 014,
 * intentionally preserving feedback history). The six coordination/token tables
 * — `agents`, `sessions`, `work_items`, `announcements`, `change_records`,
 * `api_tokens` — reference workspaces(id) with NO cascade (011:64-66,145-157),
 * so a bare `DELETE FROM workspaces` would FK-fail. We clear them here first, in
 * an order that also respects the inter-child FKs (`sessions→agents`,
 * `work_items/announcements/announcement_deliveries→sessions`,
 * `change_records→agents`) — the same dependency order as `truncateAll` +
 * `truncateTenancy` in test/setup.ts. `announcement_deliveries` has no
 * workspace_id column, so it is scoped through its session FK. The final
 * `DELETE FROM workspaces` cascades memberships + invites and SET-NULLs feedback.
 *
 * NOTE: as the workspace-scoped table set grows, this list must grow with it —
 * a new table with a non-cascading FK into workspaces(id) will start failing
 * this delete until it is added here (or given ON DELETE CASCADE in a migration).
 */
export async function deleteWorkspaceCascade(
  tx: pg.PoolClient,
  workspaceId: string
): Promise<void> {
  await tx.query(
    `DELETE FROM announcement_deliveries
     WHERE session_id IN (SELECT id FROM sessions WHERE workspace_id = $1)`,
    [workspaceId]
  );
  await tx.query(`DELETE FROM announcements  WHERE workspace_id = $1`, [workspaceId]);
  await tx.query(`DELETE FROM work_items     WHERE workspace_id = $1`, [workspaceId]);
  await tx.query(`DELETE FROM change_records WHERE workspace_id = $1`, [workspaceId]);
  await tx.query(`DELETE FROM sessions       WHERE workspace_id = $1`, [workspaceId]);
  await tx.query(`DELETE FROM agents         WHERE workspace_id = $1`, [workspaceId]);
  await tx.query(`DELETE FROM api_tokens     WHERE workspace_id = $1`, [workspaceId]);
  await tx.query(`DELETE FROM workspaces     WHERE id = $1`, [workspaceId]);
}

/**
 * Add (or update) a membership for (workspaceId, accountId) at `role`.
 * Idempotent on the (account_id, workspace_id) primary key: re-adding an
 * existing member updates their role rather than failing the PK constraint —
 * so a redeem of a higher-role invite can promote an existing member, and a
 * retry is harmless.
 */
export async function addMembership(
  db: Queryable,
  params: { workspaceId: string; accountId: string; role: RoleT }
): Promise<void> {
  const { workspaceId, accountId, role } = params;
  await db.query(
    `INSERT INTO memberships (account_id, workspace_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (account_id, workspace_id) DO UPDATE SET role = EXCLUDED.role`,
    [accountId, workspaceId, role]
  );
}

/**
 * Every workspace `accountId` is a member of, as WorkspaceSummary (the row plus
 * the caller's own role in it). Scoped by accountId via the membership join, so
 * an agent token still correctly returns ALL of that account's workspaces (the
 * MCP `link` tool relies on this — see Task 3.3). Ordered by workspace name.
 */
export async function listWorkspacesForAccount(
  db: Queryable,
  accountId: string
): Promise<WorkspaceSummaryT[]> {
  const { rows } = await db.query<{
    id: string;
    slug: string;
    name: string;
    role: RoleT;
    is_owner: boolean;
  }>(
    `SELECT w.id, w.slug, w.name, m.role,
            (w.created_by = m.account_id) AS is_owner
     FROM   memberships m
     JOIN   workspaces  w ON w.id = m.workspace_id
     WHERE  m.account_id = $1
     ORDER BY w.name`,
    [accountId]
  );
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    role: r.role,
    isOwner: r.is_owner,
  }));
}

/**
 * How many workspaces this account has created (workspaces.created_by). Backs
 * the per-account creation cap (design §8): the create path rejects with 403
 * once this reaches the cap.
 */
export async function countWorkspacesCreatedBy(
  db: Queryable,
  accountId: string
): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*) AS count FROM workspaces WHERE created_by = $1`,
    [accountId]
  );
  return Number(rows[0]!.count);
}

/**
 * Insert a minted api_token, storing ONLY its hash (the plaintext shp_ token is
 * shown once at mint time and never persisted). Returns the non-secret
 * TokenSummary — deliberately the same shape `listApiTokens` returns, never the
 * hash. `name` is optional metadata.
 */
export async function insertApiToken(
  db: Queryable,
  params: {
    // null => an ACCOUNT-scoped token (migration 015): not locked to any
    // workspace. The INSERT binds NULL through unchanged.
    workspaceId: string | null;
    accountId: string;
    tokenHash: string;
    name?: string | null;
  }
): Promise<TokenSummaryT> {
  const { workspaceId, accountId, tokenHash, name } = params;
  const { rows } = await db.query<{
    id: string;
    name: string | null;
    last_used_at: Date | null;
    created_at: Date;
    revoked_at: Date | null;
  }>(
    `INSERT INTO api_tokens (workspace_id, account_id, token_hash, name)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, last_used_at, created_at, revoked_at`,
    [workspaceId, accountId, tokenHash, name ?? null]
  );
  return tokenSummaryFromRow(rows[0]!);
}

/**
 * Non-secret summaries of the ACTIVE (non-revoked) tokens in `workspaceId`,
 * newest first, bounded to a sane cap. Revoked tokens are excluded — the UI
 * list shows only live tokens, and a revoked token is dead weight. Scoped by
 * workspace so it never leaks another tenant's tokens; the SELECT omits
 * token_hash entirely so the secret can never reach a caller.
 */
export async function listApiTokens(
  db: Queryable,
  workspaceId: string
): Promise<TokenSummaryT[]> {
  const { rows } = await db.query<{
    id: string;
    name: string | null;
    last_used_at: Date | null;
    created_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT id, name, last_used_at, created_at, revoked_at
     FROM   api_tokens
     WHERE  workspace_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC
     LIMIT  200`,
    [workspaceId]
  );
  return rows.map(tokenSummaryFromRow);
}

/**
 * Non-secret summaries of the ACTIVE (non-revoked) tokens OWNED by `accountId`,
 * newest first, bounded to a sane cap. The account-scoped sibling of
 * `listApiTokens` — it keys on `account_id` rather than `workspace_id`, so it
 * returns every token the account owns (both account-scoped and any
 * workspace-narrowed ones) regardless of workspace. Scoped by account so it never
 * leaks another account's tokens; the SELECT omits token_hash entirely so the
 * secret can never reach a caller.
 */
export async function listApiTokensForAccount(
  db: Queryable,
  accountId: string
): Promise<TokenSummaryT[]> {
  const { rows } = await db.query<{
    id: string;
    name: string | null;
    last_used_at: Date | null;
    created_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT id, name, last_used_at, created_at, revoked_at
     FROM   api_tokens
     WHERE  account_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC
     LIMIT  200`,
    [accountId]
  );
  return rows.map(tokenSummaryFromRow);
}

/** Map an api_tokens row to the non-secret TokenSummary (ISO-string timestamps). */
function tokenSummaryFromRow(row: {
  id: string;
  name: string | null;
  last_used_at: Date | null;
  created_at: Date;
  revoked_at: Date | null;
}): TokenSummaryT {
  return {
    id: row.id,
    name: row.name,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    revokedAt: row.revoked_at?.toISOString() ?? null,
  };
}

/**
 * Revoke one token, scoped by workspaceId so a credential can only revoke its
 * OWN workspace's token — a cross-tenant tokenId matches zero rows. Idempotent
 * on an already-revoked token (the revoked_at IS NULL guard means a second call
 * affects zero rows). Returns true when a live token was revoked, false
 * otherwise (cross-tenant, unknown, or already revoked).
 */
export async function revokeApiToken(
  db: Queryable,
  workspaceId: string,
  tokenId: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE api_tokens
     SET    revoked_at = now()
     WHERE  id           = $1
       AND  workspace_id = $2
       AND  revoked_at IS NULL`,
    [tokenId, workspaceId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Revoke one token the CALLER owns: scoped by `accountId` so a member can revoke
 * only their OWN token. A token belonging to another account matches zero rows —
 * the `account_id` guard lives in the WHERE clause, making the ownership check
 * atomic (no read-then-check TOCTOU). Ownership is `account_id` alone, NOT the
 * workspace: an account-scoped token has `workspace_id IS NULL`, so keying on the
 * workspace would make it unrevocable — and the workspace predicate was redundant
 * defense (a caller can only present a tokenId; account_id is the security
 * property). Idempotent on an already-revoked token (the `revoked_at IS NULL`
 * guard). Returns true when a live, caller-owned token was revoked; false
 * otherwise. Sibling of `revokeApiToken` — that workspace-only form is kept for
 * the admin/member-removal path (Tasks 3.1/3.6); this form is the self-service
 * revoke used by both the flat `/tokens` and the `/workspaces/:id/tokens` paths.
 */
export async function revokeOwnApiToken(
  db: Queryable,
  accountId: string,
  tokenId: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE api_tokens
     SET    revoked_at = now()
     WHERE  id         = $1
       AND  account_id = $2
       AND  revoked_at IS NULL`,
    [tokenId, accountId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Revoke ALL of a member's live tokens in `workspaceId`, returning how many were
 * revoked. Used when a member is removed (or leaves) so their agent tokens stop
 * authenticating into the workspace they no longer belong to. Workspace-scoped,
 * so it never touches that account's tokens in OTHER workspaces.
 *
 * DO NOT "fix" the `WHERE workspace_id = $1` to also sweep account-scoped
 * (workspace_id IS NULL) tokens (migration 015): that is the CORRECT behavior.
 * Removing an account from ONE workspace must NOT kill an account-scoped token
 * that still serves the account's OTHER workspaces — the per-workspace
 * membership check at resolve/session time fails closed for the removed
 * workspace only, so the token loses access here without being revoked wholesale.
 */
export async function revokeApiTokensForMember(
  db: Queryable,
  workspaceId: string,
  accountId: string
): Promise<number> {
  const result = await db.query(
    `UPDATE api_tokens
     SET    revoked_at = now()
     WHERE  workspace_id = $1
       AND  account_id   = $2
       AND  revoked_at IS NULL`,
    [workspaceId, accountId]
  );
  return result.rowCount ?? 0;
}

/**
 * Revoke EVERY live token the account owns — workspace-scoped AND account-scoped
 * (workspace_id IS NULL) alike. This is the account-deletion sweep, deliberately
 * broader than `revokeApiTokensForMember` above: the account is going away, so
 * no credential of its may survive. Returns how many were revoked.
 */
export async function revokeAllApiTokensForAccount(
  db: Queryable,
  accountId: string
): Promise<number> {
  const result = await db.query(
    `UPDATE api_tokens
     SET    revoked_at = now()
     WHERE  account_id = $1
       AND  revoked_at IS NULL`,
    [accountId]
  );
  return result.rowCount ?? 0;
}

/**
 * Delete the account's profile snapshot row. Part of account deletion; a
 * missing row (an account that never had a profile upsert) is a no-op.
 */
export async function deleteAccountProfile(
  db: Queryable,
  accountId: string
): Promise<void> {
  await db.query(`DELETE FROM account_profiles WHERE account_id = $1`, [accountId]);
}

/** A full invites row (migration 011 + 018), with camelCase fields. */
export interface InviteRow {
  id: string;
  workspaceId: string;
  code: string;
  createdBy: string;
  roleGranted: RoleT;
  expiresAt: Date | null;
  // null = unlimited, redeemable until explicitly revoked (migration 013).
  maxUses: number | null;
  useCount: number;
  revokedAt: Date | null;
  createdAt: Date;
  // The recipient of an EMAIL invite (migration 018); null for code invites.
  email: string | null;
}

/** SELECT/RETURNING column list for invites, aliased to InviteRow's camelCase. */
const INVITE_COLUMNS = `id,
        workspace_id  AS "workspaceId",
        code,
        created_by    AS "createdBy",
        role_granted  AS "roleGranted",
        expires_at    AS "expiresAt",
        max_uses      AS "maxUses",
        use_count     AS "useCount",
        revoked_at    AS "revokedAt",
        created_at    AS "createdAt",
        email`;

/**
 * Create a redeemable invite into `workspaceId` at `roleGranted`. `code` is a
 * pre-generated unique string (the operation layer mints it); `maxUses` caps
 * redemptions (null = unlimited, until revoked) and `expiresAt` is an optional
 * hard expiry (null = never). `email` records the recipient of an email invite
 * (backs the pending-invites list); code/link invites leave it null.
 */
export async function createInvite(
  db: Queryable,
  params: {
    workspaceId: string;
    code: string;
    createdBy: string;
    roleGranted: RoleT;
    maxUses: number | null;
    expiresAt?: Date | null;
    email?: string | null;
  }
): Promise<InviteRow> {
  const { workspaceId, code, createdBy, roleGranted, maxUses, expiresAt, email } = params;
  const { rows } = await db.query<InviteRow>(
    `INSERT INTO invites
       (workspace_id, code, created_by, role_granted, max_uses, expires_at, email)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${INVITE_COLUMNS}`,
    [workspaceId, code, createdBy, roleGranted, maxUses, expiresAt ?? null, email ?? null]
  );
  return rows[0]!;
}

/**
 * The PENDING email invites of `workspaceId`, newest first: rows that carry a
 * recipient email and are still redeemable — not revoked, not expired, and with
 * uses remaining (email invites are minted maxUses=1, so a redeemed one drops
 * out here — exactly the "disappears once they join" the Config list wants).
 * The predicate mirrors incrementInviteUse's atomic claim guard so this list
 * never shows an invite that a redeem would refuse.
 */
export async function listPendingEmailInvites(
  db: Queryable,
  workspaceId: string
): Promise<InviteRow[]> {
  const { rows } = await db.query<InviteRow>(
    `SELECT ${INVITE_COLUMNS}
     FROM   invites
     WHERE  workspace_id = $1
       AND  email IS NOT NULL
       AND  revoked_at IS NULL
       AND  (max_uses IS NULL OR use_count < max_uses)
       AND  (expires_at IS NULL OR expires_at > now())
     ORDER BY created_at DESC
     LIMIT  200`,
    [workspaceId]
  );
  return rows;
}

/**
 * Find a LIVE (non-revoked) invite by its code, or null. A revoked invite
 * (revoked_at IS NOT NULL) reads as not-found — the redeem path then reports an
 * invalid code without revealing it once existed. Expiry/use-count are NOT
 * checked here (they are dynamic redeem-time conditions the caller evaluates and
 * incrementInviteUse enforces atomically).
 */
export async function findInviteByCode(
  db: Queryable,
  code: string
): Promise<InviteRow | null> {
  const { rows } = await db.query<InviteRow>(
    `SELECT ${INVITE_COLUMNS}
     FROM   invites
     WHERE  code = $1
       AND  revoked_at IS NULL`,
    [code]
  );
  return rows[0] ?? null;
}

/**
 * Atomically claim one use of an invite by code, returning the updated row or
 * null when the claim is refused. ALL redeem-time guards live in the WHERE clause
 * so they are enforced under the row lock (no read-modify-write race between two
 * concurrent redeems): the use only lands when the invite is non-revoked, NOT
 * expired (expires_at IS NULL OR > now()), AND still has remaining uses
 * (max_uses IS NULL [unlimited] OR use_count < max_uses). A refused claim
 * (revoked, expired, or already at max) leaves use_count unchanged and
 * returns null.
 *
 * Expiry is checked HERE — not just in the operation layer — so the cap, the
 * revocation, AND the expiry are one atomic guard. (A time-based check would have
 * a benign TOCTOU window if done separately in the operation, but the cap would
 * not, so the single atomic predicate is the clean home for all three.)
 */
export async function incrementInviteUse(
  db: Queryable,
  code: string
): Promise<InviteRow | null> {
  const { rows } = await db.query<InviteRow>(
    `UPDATE invites
     SET    use_count = use_count + 1
     WHERE  code = $1
       AND  revoked_at IS NULL
       AND  (max_uses IS NULL OR use_count < max_uses)
       AND  (expires_at IS NULL OR expires_at > now())
     RETURNING ${INVITE_COLUMNS}`,
    [code]
  );
  return rows[0] ?? null;
}

/**
 * Revoke one invite, scoped by workspaceId so a credential can only revoke its
 * OWN workspace's invite — a cross-tenant inviteId matches zero rows. Idempotent
 * on an already-revoked invite. Returns true when a live invite was revoked.
 */
export async function revokeInvite(
  db: Queryable,
  workspaceId: string,
  inviteId: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE invites
     SET    revoked_at = now()
     WHERE  id           = $1
       AND  workspace_id = $2
       AND  revoked_at IS NULL`,
    [inviteId, workspaceId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Revoke one invite by its CODE, scoped by workspaceId so the workspace + code are
 * matched in ONE atomic UPDATE — a code that belongs to another workspace (or is
 * unknown / already revoked) matches zero rows. The redeem-facing revoke path
 * (Task 3.5) holds the code, not the invite id, so this avoids a look-up-then-check
 * round trip (and its cross-tenant TOCTOU): the workspace ownership guard lives in
 * the WHERE clause. Idempotent on an already-revoked invite. Returns true when a
 * live, in-workspace invite was revoked. Sibling of `revokeInvite` (by id) — that
 * form is kept for the admin-by-id path; this form is the by-code revoke for 3.5.
 */
export async function revokeInviteByCode(
  db: Queryable,
  workspaceId: string,
  code: string
): Promise<boolean> {
  const result = await db.query(
    `UPDATE invites
     SET    revoked_at = now()
     WHERE  code         = $1
       AND  workspace_id = $2
       AND  revoked_at IS NULL`,
    [code, workspaceId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Members of `workspaceId` as MemberSummary, joining account_profiles for the
 * display identity (LEFT JOIN so a member with no profile snapshot yet still
 * appears, with null display fields). Workspace-scoped; ordered by display name
 * then account id for a stable listing.
 */
export async function listMembers(
  db: Queryable,
  workspaceId: string
): Promise<MemberSummaryT[]> {
  const { rows } = await db.query<{
    account_id: string;
    display_name: string | null;
    github_login: string | null;
    email: string | null;
    avatar_url: string | null;
    role: RoleT;
    is_owner: boolean;
  }>(
    `SELECT m.account_id,
            p.display_name,
            p.github_login,
            p.email,
            p.avatar_url,
            m.role,
            (m.account_id = w.created_by) AS is_owner
     FROM   memberships m
     JOIN   workspaces  w ON w.id = m.workspace_id
     LEFT JOIN account_profiles p ON p.account_id = m.account_id
     WHERE  m.workspace_id = $1
     ORDER BY p.display_name NULLS LAST, m.account_id
     LIMIT  1000`,
    [workspaceId]
  );
  return rows.map((r) => ({
    accountId: r.account_id,
    displayName: r.display_name,
    githubLogin: r.github_login,
    email: r.email,
    avatarUrl: r.avatar_url,
    role: r.role,
    isOwner: r.is_owner,
  }));
}

/**
 * The human-readable name for `accountId`, from its profile snapshot: display
 * name, else GitHub login, else email. Returns null when the account has no
 * profile row (or no usable field) — callers fall back to a generic label.
 * Backs sender/target labelling on announcements.
 */
export async function accountLabel(
  db: Queryable,
  accountId: string
): Promise<string | null> {
  const { rows } = await db.query<{
    display_name: string | null;
    github_login: string | null;
    email: string | null;
  }>(
    `SELECT display_name, github_login, email
     FROM   account_profiles
     WHERE  account_id = $1`,
    [accountId]
  );
  const p = rows[0];
  if (!p) return null;
  return p.display_name ?? p.github_login ?? p.email ?? null;
}

/**
 * Remove a member from `workspaceId`, scoped by workspaceId so a credential can
 * only remove from its OWN workspace — a cross-tenant (workspaceId, accountId)
 * matches zero rows. Returns true when a membership was removed. The last-admin
 * guard lives in the operation layer (via countAdmins), NOT here.
 */
export async function removeMembership(
  db: Queryable,
  workspaceId: string,
  accountId: string
): Promise<boolean> {
  const result = await db.query(
    `DELETE FROM memberships
     WHERE  workspace_id = $1
       AND  account_id   = $2`,
    [workspaceId, accountId]
  );
  return (result.rowCount ?? 0) > 0;
}

/**
 * Number of admins in `workspaceId`. Backs the last-admin guard: the operation
 * layer refuses to remove or demote the final admin (countAdmins must stay > 0).
 */
export async function countAdmins(
  db: Queryable,
  workspaceId: string
): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*) AS count
     FROM   memberships
     WHERE  workspace_id = $1
       AND  role = 'admin'`,
    [workspaceId]
  );
  return Number(rows[0]!.count);
}

/**
 * Total member count of `workspaceId` (any role). Backs account deletion's
 * sole-member check: a workspace whose ONLY member is the deleting account is
 * deleted outright rather than orphaned admin-less.
 */
export async function countMembers(
  db: Queryable,
  workspaceId: string
): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `SELECT count(*) AS count
     FROM   memberships
     WHERE  workspace_id = $1`,
    [workspaceId]
  );
  return Number(rows[0]!.count);
}

/**
 * Set a member's role within `workspaceId`, scoped so it only affects the
 * caller's OWN workspace. A no-op (zero rows) for a non-member or cross-tenant
 * pair. The last-admin demotion guard lives in the operation layer (countAdmins).
 */
export async function setRole(
  db: Queryable,
  workspaceId: string,
  accountId: string,
  role: RoleT
): Promise<void> {
  await db.query(
    `UPDATE memberships
     SET    role = $3
     WHERE  workspace_id = $1
       AND  account_id   = $2`,
    [workspaceId, accountId, role]
  );
}

/**
 * Point `workspaceId`'s owner (workspaces.created_by) at `accountId`. Backs
 * transfer-ownership; the operation layer pairs it with a setRole('admin') on the
 * new owner (in one transaction) so the owner invariant — owner is always an
 * admin — is preserved. Scoped by id, so it only affects the named workspace.
 */
export async function setWorkspaceOwner(
  db: Queryable,
  workspaceId: string,
  accountId: string
): Promise<void> {
  await db.query(
    `UPDATE workspaces
     SET    created_by = $2
     WHERE  id = $1`,
    [workspaceId, accountId]
  );
}

// ---------------------------------------------------------------------------
// Agent
// ---------------------------------------------------------------------------

export interface AgentRow {
  id: string;
  workspaceId: string;
  name: string;
  human: string;
  program: string;
  model: string | null;
  created_at: Date;
}

/**
 * Insert a new agent row and return it.
 * Unique on (workspace_id, name). The name is ALWAYS supplied by the caller
 * (computed in join.ts — `{handle}-{ordinal}`, or `@shepherd/shared`'s
 * generateName fallback) — there is no DB default or trigger that generates it.
 *
 * `model` is OPTIONAL: the column is nullable (migration 003) because the model
 * may be unknown when an agent first joins. When absent/null we insert NULL.
 */
export async function createAgent(
  tx: pg.PoolClient,
  params: {
    workspaceId: string;
    name: string;
    human: string;
    program: string;
    model?: string | null;
  }
): Promise<AgentRow> {
  const { workspaceId, name, human, program, model } = params;
  const { rows } = await tx.query<AgentRow>(
    `INSERT INTO agents (workspace_id, name, human, program, model)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, workspace_id AS "workspaceId", name, human, program, model, created_at`,
    [workspaceId, name, human, program, model ?? null]
  );
  return rows[0]!;
}

/**
 * Look up an agent by (workspace_id, name); null when none exists. Identity is
 * per-session, keyed on (workspace_id, name) alone (the old by-tuple `findAgent`
 * was removed). Used by `join` to reclaim a recycled-ordinal row — see the
 * reclaim invariant documented at the call site in join.ts.
 */
export async function findAgentByName(
  db: Queryable,
  workspaceId: string,
  name: string
): Promise<AgentRow | null> {
  const { rows } = await db.query<AgentRow>(
    `SELECT id, workspace_id AS "workspaceId", name, human, program, model, created_at
     FROM agents
     WHERE workspace_id = $1
       AND name         = $2`,
    [workspaceId, name]
  );
  return rows[0] ?? null;
}

/**
 * Names of agents in `workspace` whose NAME belongs to the handle's ordinal
 * family (`name LIKE handle || '-%'`) AND that have at least one LIVE session
 * (a session whose last_heartbeat_at is within `staleAfterSeconds` of `now`).
 *
 * Keyed deliberately on the NAME family (the ordinal namespace `handle-N`), not
 * on the `human` column — this answers "which ordinals under this handle are
 * currently taken by a live agent" so join can pick the lowest free ordinal.
 * `handle` is already normalized to `[a-z0-9-]` upstream, so it carries no LIKE
 * wildcards. Returns DISTINCT names.
 */
export async function reservedAgentNamesForHandle(
  db: Queryable,
  workspaceId: string,
  handle: string,
  now: Date,
  staleAfterSeconds: number,
  changeRecordTtlSeconds: number,
  graceSeconds: number
): Promise<string[]> {
  // A name in `handle`'s ordinal family is RESERVED (its ordinal must not be
  // recycled) while the agent still has ANY live footprint, so a freshly-joined
  // session never collides with another that is dead-but-still-referenced:
  //   (1) a live session (heartbeat within the stale window), OR
  //   (2) an active, non-expired claim on one of its sessions — a dead session's
  //       claim is HIDDEN from landscapes (see listActiveClaims) but its name
  //       must stay parked until that claim's own TTL lapses, OR
  //   (3) an outstanding change record — but only one that is still VISIBLE in the
  //       landscape, so name-parking matches what teammates can actually see. A
  //       `committed` record (within its TTL) qualifies unconditionally — it is a
  //       durable, presence-independent fact. An `uncommitted` record qualifies
  //       ONLY while the agent has a session within `graceSeconds`, exactly the
  //       grace gate in listOtherChangeRecords: once a dead agent's dirty snapshot
  //       stops showing, its ordinal must not stay parked (it would otherwise hold
  //       an invisible name for the full change-record TTL).
  const { rows } = await db.query<{ name: string }>(
    `SELECT a.name
     FROM   agents a
     WHERE  a.workspace_id = $1
       AND  a.name LIKE $2 || '-%'
       AND  (
         EXISTS (
           SELECT 1 FROM sessions s
           WHERE  s.agent_id = a.id
             AND  s.last_heartbeat_at > $3::timestamptz - ($4 * interval '1 second')
         )
         OR EXISTS (
           SELECT 1 FROM work_items wi
           JOIN   sessions s2 ON s2.id = wi.session_id
           WHERE  s2.agent_id = a.id
             AND  wi.status = 'active'
             AND  wi.expires_at > $3::timestamptz
         )
         OR EXISTS (
           SELECT 1 FROM change_records cr
           WHERE  cr.agent_id = a.id
             AND  cr.updated_at > $3::timestamptz - ($5 * interval '1 second')
             AND  (
               cr.kind = 'committed'
               OR EXISTS (
                 SELECT 1 FROM sessions s3
                 WHERE  s3.agent_id = a.id
                   AND  s3.last_heartbeat_at > $3::timestamptz - ($6 * interval '1 second')
               )
             )
         )
       )`,
    [workspaceId, handle, now, staleAfterSeconds, changeRecordTtlSeconds, graceSeconds]
  );
  return rows.map((r) => r.name);
}

/**
 * Names of agents that currently have a LIVE session in `workspace`+`repo` (a
 * session whose last_heartbeat_at is within `staleAfterSeconds` of `now`) —
 * i.e. the teammates a directed announcement in this repo could actually reach,
 * matching the set shown live in the landscape. Returns DISTINCT names, sorted.
 *
 * Used by `announce` to reject a directed message whose target is not a live
 * agent here (a typo'd base handle like "Maeriyn" instead of "maeriyn-4" would
 * otherwise be stored verbatim and silently delivered to no one).
 */
export async function liveAgentNamesInRepo(
  db: Queryable,
  workspaceId: string,
  repo: string,
  now: Date,
  staleAfterSeconds: number
): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT DISTINCT a.name
     FROM   agents   a
     JOIN   sessions s ON s.agent_id = a.id
     WHERE  s.workspace_id = $1
       AND  s.repo         = $2
       AND  s.last_heartbeat_at > $3::timestamptz - ($4 * interval '1 second')
     ORDER BY a.name`,
    [workspaceId, repo, now, staleAfterSeconds]
  );
  return rows.map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export interface SessionRow {
  id: string;
  workspaceId: string;
  agent_id: string;
  repo: string;
  branch: string;
  last_heartbeat_at: Date;
  created_at: Date;
}

export interface SessionWithAgent {
  id: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  human: string;
  repo: string;
  branch: string;
}

/**
 * Insert a new session row and return it.
 */
export async function createSession(
  tx: pg.PoolClient,
  params: {
    workspaceId: string;
    agentId: string;
    repo: string;
    branch: string;
  }
): Promise<SessionRow> {
  const { workspaceId, agentId, repo, branch } = params;
  const { rows } = await tx.query<SessionRow>(
    `INSERT INTO sessions (workspace_id, agent_id, repo, branch)
     VALUES ($1, $2, $3, $4)
     RETURNING id, workspace_id AS "workspaceId", agent_id, repo, branch, last_heartbeat_at, created_at`,
    [workspaceId, agentId, repo, branch]
  );
  return rows[0]!;
}

/**
 * Fetch a session by ID, joining agents for agentName.
 * Returns the session with camelCase fields needed by the delivery query.
 * Throws UnknownSessionError if not found.
 */
export async function getSession(
  db: Queryable,
  workspaceId: string,
  sessionId: string
): Promise<SessionWithAgent> {
  const { rows } = await db.query<{
    id: string;
    workspace_id: string;
    agent_id: string;
    agent_name: string;
    human: string;
    repo: string;
    branch: string;
  }>(
    `SELECT s.id,
            s.workspace_id,
            s.agent_id,
            a.name  AS agent_name,
            a.human,
            s.repo,
            s.branch
     FROM sessions s
     JOIN agents   a ON a.id = s.agent_id
     WHERE s.id = $1
       AND s.workspace_id = $2`,
    [sessionId, workspaceId]
  );

  if (rows.length === 0) {
    throw new UnknownSessionError(sessionId);
  }

  const r = rows[0]!;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    agentId: r.agent_id,
    agentName: r.agent_name,
    human: r.human,
    repo: r.repo,
    branch: r.branch,
  };
}

/**
 * Fetch a session by ID ALONE — the unscoped sibling of {@link getSession},
 * joining agents for agentName. Returns null when no session has that id (the
 * caller decides the error, rather than throwing here).
 *
 * The `workspace_id` predicate that {@link getSession} bakes in is deliberately
 * ABSENT: this exists ONLY for the account-scoped credential path, where the
 * workspace is not known from the route or token and must be read FROM the
 * session, then authorized by membership. NEVER call this without a subsequent
 * membership/scope check — see {@link resolveSession} in sessionScope.ts, the
 * one caller that pairs it with a `findMembership` gate. The returned
 * `workspaceId` is what that caller checks the membership against.
 */
export async function getSessionById(
  db: Queryable,
  sessionId: string
): Promise<SessionWithAgent | null> {
  const { rows } = await db.query<{
    id: string;
    workspace_id: string;
    agent_id: string;
    agent_name: string;
    human: string;
    repo: string;
    branch: string;
  }>(
    `SELECT s.id,
            s.workspace_id,
            s.agent_id,
            a.name  AS agent_name,
            a.human,
            s.repo,
            s.branch
     FROM sessions s
     JOIN agents   a ON a.id = s.agent_id
     WHERE s.id = $1`,
    [sessionId]
  );

  if (rows.length === 0) {
    return null;
  }

  const r = rows[0]!;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    agentId: r.agent_id,
    agentName: r.agent_name,
    human: r.human,
    repo: r.repo,
    branch: r.branch,
  };
}

/**
 * Update a session's branch. Used when an agent switches branches mid-session.
 */
export async function updateSessionBranch(
  tx: pg.PoolClient,
  sessionId: string,
  branch: string
): Promise<void> {
  await tx.query(`UPDATE sessions SET branch = $2 WHERE id = $1`, [sessionId, branch]);
}

// ---------------------------------------------------------------------------
// Heartbeat / renewal
// ---------------------------------------------------------------------------

/**
 * Update ONLY the session's last_heartbeat_at to `now` — proving liveness
 * WITHOUT renewing any claims.
 *
 * This is the presence half of `touchHeartbeat`, split out so the background
 * heartbeat can keep a session "live" (so its work survives the staleness
 * window for presence purposes) without silently extending its claim leases.
 * A session that only ever calls `touchPresence` lets its claims lapse at their
 * own frozen TTL — exactly the behavior the heartbeat loop wants.
 */
export async function touchPresence(
  tx: pg.PoolClient,
  sessionId: string,
  now: Date
): Promise<void> {
  await tx.query(
    `UPDATE sessions
     SET last_heartbeat_at = $1
     WHERE id = $2`,
    [now, sessionId]
  );
}

/**
 * Force a session's PRESENCE offline by backdating its heartbeat to `asOf`
 * (callers pass a timestamp already older than the staleness window). Used by
 * `leave` for a clean shutdown: the session reads as gone immediately, so its
 * live claims stop surfacing to teammates (see listActiveClaims) WITHOUT
 * touching the claims or change records themselves — those are durable signals
 * that must outlive the session. Idempotent: affects zero rows for an unknown
 * session, which the caller treats as success.
 *
 * Scoped to `workspaceId` so a credential can only mark its OWN workspace's
 * sessions offline — a cross-tenant sessionId simply matches zero rows (the
 * cross-tenant isolation gate, applied even on this presence-only path).
 */
export async function expireSessionPresence(
  tx: pg.PoolClient,
  workspaceId: string,
  sessionId: string,
  asOf: Date
): Promise<void> {
  await tx.query(
    `UPDATE sessions
     SET last_heartbeat_at = $1
     WHERE id = $2
       AND workspace_id = $3`,
    [asOf, sessionId, workspaceId]
  );
}

/**
 * Update last_heartbeat_at to `now` AND renew every ACTIVE work_item for this
 * session by computing expires_at = now + (its own ttl_seconds).
 *
 * This is the SINGLE renewal path. Renewal restores each claim's original
 * lease length (row's own ttl_seconds, NOT any default). It is composed of the
 * presence half (`touchPresence`) plus the claim-renewal UPDATE; observable
 * behavior is unchanged (presence + renewal in one call).
 */
export async function touchHeartbeat(
  tx: pg.PoolClient,
  sessionId: string,
  now: Date
): Promise<void> {
  // Presence half: bump the session's heartbeat timestamp.
  await touchPresence(tx, sessionId, now);

  // Renewal half: renew each active work item using its own ttl_seconds.
  await tx.query(
    `UPDATE work_items
     SET expires_at = $1::timestamptz + (ttl_seconds * interval '1 second')
     WHERE session_id = $2
       AND status = 'active'`,
    [now, sessionId]
  );
}

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

/**
 * Persist a new work_item row and return its id.
 */
export async function insertWorkItem(
  tx: pg.PoolClient,
  params: {
    workspaceId: string;
    sessionId: string;
    repo: string;
    intentText: string;
    pathGlobs: string[];
    ttlSeconds: number;
    expiresAt: Date;
  }
): Promise<string> {
  const { workspaceId, sessionId, repo, intentText, pathGlobs, ttlSeconds, expiresAt } =
    params;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO work_items
       (workspace_id, session_id, repo, intent_text, path_globs, ttl_seconds, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [workspaceId, sessionId, repo, intentText, pathGlobs, ttlSeconds, expiresAt]
  );
  return rows[0]!.id;
}

/**
 * Return all ACTIVE, non-expired claims for a given workspace+repo,
 * excluding the owner session.
 *
 * The "active claim" predicate (status + expires_at) appears in EXACTLY ONE
 * place — here.
 *
 * VISIBILITY REQUIRES BOTH a live TTL AND a LIVE OWNING SESSION (last_heartbeat_at
 * within `staleAfterSeconds`). A dead agent's claim disappears once its session
 * goes stale, rather than lingering until the much longer claim TTL — so you
 * never "conflict with a ghost" of a session that has exited.
 *
 * This relies on the client's 60s background heartbeat (mcp-server/heartbeat.ts),
 * which keeps an actively-coding-but-quiet session live independent of tool
 * calls. Because the heartbeat interval (60s) is well under STALE_AFTER_SECONDS
 * (120s), a genuinely-live session never false-negatives — so staleness is now a
 * sound proxy for "the session is gone". (This reverses the earlier TTL-only
 * rule, which predated the background heartbeat and kept ghost claims visible to
 * avoid hiding heads-down editors; the heartbeat removed that hazard.) Known
 * trade-off: a live-but-hub-unreachable agent's heartbeats fail open, so its
 * claims vanish for others during a partition — acceptable, since it isn't
 * coordinating anyway and its claim TTL-expires regardless.
 */
export async function listActiveClaims(
  db: Queryable,
  workspaceId: string,
  repo: string,
  now: Date,
  staleAfterSeconds: number,
  options: { excludeSessionId: string }
): Promise<ClaimT[]> {
  const { excludeSessionId } = options;

  const { rows } = await db.query<{
    work_item_id: string;
    agent_name: string;
    human: string;
    intent_text: string;
    path_globs: string[];
    expires_at: Date;
  }>(
    `SELECT wi.id          AS work_item_id,
            a.name         AS agent_name,
            a.human,
            wi.intent_text,
            wi.path_globs,
            wi.expires_at
     FROM   work_items wi
     JOIN   sessions   s  ON s.id  = wi.session_id
     JOIN   agents     a  ON a.id  = s.agent_id
     WHERE  wi.workspace_id = $1
       AND  wi.repo       = $2
       AND  wi.status     = 'active'
       AND  wi.expires_at > $3::timestamptz
       AND  wi.session_id <> $4
       AND  s.last_heartbeat_at > $3::timestamptz - ($5 * interval '1 second')`,
    [workspaceId, repo, now, excludeSessionId, staleAfterSeconds]
  );

  return rows.map((r) => ({
    workItemId: r.work_item_id,
    agentName: r.agent_name,
    human: r.human,
    intent: r.intent_text,
    pathGlobs: r.path_globs,
    expiresAt: r.expires_at.toISOString(),
  }));
}

/**
 * Return the flattened path globs of THIS session's own ACTIVE, non-expired
 * claims. Used by `sync` to detect collisions that appeared against the
 * caller's existing claims after it claimed them. Because `globsOverlap` is an
 * any-pair check, flattening all of the session's globs into one list and
 * testing each other claim against it is equivalent to testing against each of
 * the session's claims individually.
 *
 * Self-scoped, so no staleness filter is needed (the caller has just
 * heart-beaten); only status + expiry gate which of its own claims still count.
 */
export async function listSessionActiveGlobs(
  db: Queryable,
  sessionId: string,
  now: Date
): Promise<string[]> {
  const { rows } = await db.query<{ path_globs: string[] }>(
    `SELECT wi.path_globs
     FROM   work_items wi
     WHERE  wi.session_id = $1
       AND  wi.status     = 'active'
       AND  wi.expires_at > $2::timestamptz`,
    [sessionId, now]
  );
  return rows.flatMap((r) => r.path_globs);
}

/**
 * Return THIS session's own ACTIVE, non-expired claims as full ClaimT rows.
 *
 * Mirrors `listActiveClaims` but scoped to a single session and WITHOUT the
 * exclude-self filter — this is precisely the "your claims" view that lets an
 * agent confirm its own claim is live (it never appears in `listActiveClaims`,
 * which excludes the caller). Self-scoped, so no presence-staleness filter:
 * only status + expiry gate which of the caller's own claims still count.
 */
export async function listSessionClaims(
  db: Queryable,
  sessionId: string,
  now: Date
): Promise<ClaimT[]> {
  const { rows } = await db.query<{
    work_item_id: string;
    agent_name: string;
    human: string;
    intent_text: string;
    path_globs: string[];
    expires_at: Date;
  }>(
    `SELECT wi.id          AS work_item_id,
            a.name         AS agent_name,
            a.human,
            wi.intent_text,
            wi.path_globs,
            wi.expires_at
     FROM   work_items wi
     JOIN   sessions   s  ON s.id  = wi.session_id
     JOIN   agents     a  ON a.id  = s.agent_id
     WHERE  wi.session_id = $1
       AND  wi.status     = 'active'
       AND  wi.expires_at > $2::timestamptz`,
    [sessionId, now]
  );

  return rows.map((r) => ({
    workItemId: r.work_item_id,
    agentName: r.agent_name,
    human: r.human,
    intent: r.intent_text,
    pathGlobs: r.path_globs,
    expiresAt: r.expires_at.toISOString(),
  }));
}

/**
 * Owner-scoped release: UPDATE status='released' where id, session_id, status='active'.
 * Returns rowCount (0 is fine — caller treats as idempotent success).
 */
export async function releaseWorkItem(
  tx: pg.PoolClient,
  sessionId: string,
  workItemId: string,
  now: Date
): Promise<number> {
  const result = await tx.query(
    `UPDATE work_items
     SET    status      = 'released',
            released_at = $1
     WHERE  id          = $2
       AND  session_id  = $3
       AND  status      = 'active'`,
    [now, workItemId, sessionId]
  );
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------

/**
 * Insert a new announcement and return its id (bigint serialised as number).
 */
export async function insertAnnouncement(
  tx: pg.PoolClient,
  params: {
    workspaceId: string;
    repo: string;
    fromSessionId: string;
    targetAgentName: string | null;
    body: string;
    // true => addressed to the operator side (the dashboard). Excluded from
    // agent delivery; surfaced in the workspace feed. Defaults to false.
    toAdmin?: boolean;
    // When the message is for a SPECIFIC workspace member (toAdmin must also be
    // true so agent delivery skips it): the member's account id plus a
    // render-ready snapshot of their name at send time (the from_label pattern —
    // survives profile changes / member removal). Null/omitted => the legacy
    // collective "to the operators" message.
    targetAccountId?: string | null;
    targetLabel?: string | null;
  }
): Promise<number> {
  const { workspaceId, repo, fromSessionId, targetAgentName, body } = params;
  const toAdmin = params.toAdmin ?? false;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO announcements
       (workspace_id, repo, from_session_id, target_agent_name, body, to_admin, target_account_id, target_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      workspaceId,
      repo,
      fromSessionId,
      targetAgentName,
      body,
      toAdmin,
      params.targetAccountId ?? null,
      params.targetLabel ?? null,
    ]
  );
  // BIGINT identity comes back as string from pg driver; coerce to number.
  return Number(rows[0]!.id);
}

/**
 * Insert an announcement sent by the human operator from the dashboard, which
 * has no agent session behind it. `from_session_id` is NULL, `from_admin` is
 * true, and `from_label` snapshots the sender identity. Returns the new id.
 */
export async function insertAdminAnnouncement(
  tx: pg.PoolClient,
  params: {
    workspaceId: string;
    repo: string;
    targetAgentName: string | null;
    body: string;
    fromLabel: string;
  }
): Promise<number> {
  const { workspaceId, repo, targetAgentName, body, fromLabel } = params;
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO announcements
       (workspace_id, repo, from_session_id, target_agent_name, body, from_admin, from_label)
     VALUES ($1, $2, NULL, $3, $4, true, $5)
     RETURNING id`,
    [workspaceId, repo, targetAgentName, body, fromLabel]
  );
  return Number(rows[0]!.id);
}

/**
 * The repo to tag an admin DM with so the existing per-repo delivery query
 * reaches the target: the named agent's MOST-RECENT session repo in `workspace`.
 * Returns null when the agent name is unknown or has never opened a session
 * (nothing to deliver to) — the caller turns that into a 400.
 */
export async function findAgentRepoForDelivery(
  db: Queryable,
  workspaceId: string,
  agentName: string
): Promise<string | null> {
  const { rows } = await db.query<{ repo: string }>(
    `SELECT s.repo
     FROM   agents   a
     JOIN   sessions s ON s.agent_id = a.id
     WHERE  a.workspace_id = $1
       AND  a.name      = $2
     ORDER BY s.last_heartbeat_at DESC
     LIMIT 1`,
    [workspaceId, agentName]
  );
  return rows[0]?.repo ?? null;
}

/**
 * Distinct repos agents have connected from in `workspace` (from sessions).
 * Used to fan an all-repos admin broadcast out to one row per repo, so it lands
 * in every repo's per-repo delivery scope.
 */
export async function listWorkspaceRepos(
  db: Queryable,
  workspaceId: string
): Promise<string[]> {
  const { rows } = await db.query<{ repo: string }>(
    `SELECT DISTINCT repo FROM sessions WHERE workspace_id = $1 ORDER BY repo`,
    [workspaceId]
  );
  return rows.map((r) => r.repo);
}

/**
 * Fetch announcements that have NOT yet been delivered to this session.
 *
 * Filters:
 *   - Same workspace + repo as the session
 *   - Addressed to this agent (broadcast or targeted)
 *   - Not sent by this session
 *   - No delivery record for (session.id, announcement.id)
 *
 * Returns Announcement[] shape as required by @shepherd/shared.
 *
 * Bounded by DELIVERY_BATCH_LIMIT: at most that many pending announcements are
 * delivered per call. Any surplus is delivered on subsequent work/sync calls
 * (ORDER BY ann.id makes the cut deterministic — oldest first). This caps the
 * per-request payload and the anti-join cost regardless of backlog size.
 *
 * NOTE (retention): announcements and announcement_deliveries are never pruned
 * by the hub today (no sweep job, by design). The ledger therefore grows
 * O(sessions × announcements) over the workspace's lifetime. A retention/prune
 * job (and optionally a per-session high-water-mark) is the planned follow-up if
 * a long-lived workspace accumulates a large backlog — tracked in the review
 * findings (P2-2), not yet implemented.
 */
export async function fetchPendingAnnouncements(
  tx: pg.PoolClient,
  session: SessionWithAgent
): Promise<AnnouncementT[]> {
  // LEFT JOIN (not JOIN) so admin-sent rows — which have a NULL from_session_id
  // and therefore no session/agent to join — are still returned. Their sender is
  // the snapshotted from_label rather than an agent name/human.
  const { rows } = await tx.query<{
    id: string;
    from_agent_name: string;
    from_human: string;
    body: string;
    target_agent_name: string | null;
    created_at: Date;
  }>(
    `SELECT ann.id,
            COALESCE(a.name,  ann.from_label) AS from_agent_name,
            COALESCE(a.human, ann.from_label) AS from_human,
            ann.body,
            ann.target_agent_name,
            ann.created_at
     FROM   announcements ann
     LEFT JOIN sessions   fs  ON fs.id = ann.from_session_id
     LEFT JOIN agents     a   ON a.id  = fs.agent_id
     WHERE  ann.workspace_id = $1
       AND  ann.repo      = $2
       -- Operator-directed replies (to_admin) belong to the dashboard feed only;
       -- never deliver them to agents. A NULL target is a broadcast, so without
       -- this an agent reply addressed to the operator would reach everyone.
       AND  ann.to_admin = false
       AND  (ann.target_agent_name IS NULL
             OR ann.target_agent_name = $3)
       -- Exclude the caller's OWN sends. Admin rows have a NULL from_session_id,
       -- and (NULL <> $4) is NULL (falsy) -- which would silently drop them -- so
       -- the IS NULL branch keeps admin messages deliverable.
       AND  (ann.from_session_id IS NULL OR ann.from_session_id <> $4)
       AND  NOT EXISTS (
             SELECT 1
             FROM   announcement_deliveries ad
             WHERE  ad.session_id      = $4
               AND  ad.announcement_id = ann.id
           )
     ORDER BY ann.id
     LIMIT ${DELIVERY_BATCH_LIMIT}`,
    [session.workspaceId, session.repo, session.agentName, session.id]
  );

  return rows.map((r) => ({
    id: Number(r.id),
    fromAgentName: r.from_agent_name,
    fromHuman: r.from_human,
    body: r.body,
    targetAgentName: r.target_agent_name,
    createdAt: r.created_at.toISOString(),
  }));
}

/**
 * Record that a set of announcements have been delivered to sessionId.
 * Uses ON CONFLICT DO NOTHING so it is safe to call multiple times.
 * No-op when announcementIds is empty.
 */
export async function recordAnnouncementDeliveries(
  tx: pg.PoolClient,
  sessionId: string,
  announcementIds: number[]
): Promise<void> {
  if (announcementIds.length === 0) return;

  // Build a VALUES list: ($1, $2), ($1, $3), …
  // sessionId is always $1; each announcementId gets its own param index.
  const valuePlaceholders = announcementIds
    .map((_, i) => `($1, $${i + 2})`)
    .join(", ");

  await tx.query(
    `INSERT INTO announcement_deliveries (session_id, announcement_id)
     VALUES ${valuePlaceholders}
     ON CONFLICT DO NOTHING`,
    [sessionId, ...announcementIds]
  );
}

// ---------------------------------------------------------------------------
// Change records
// ---------------------------------------------------------------------------

/**
 * Ingest one agent's reported working state into change_records. The two record
 * kinds are handled differently because they have different lifetimes:
 *
 *  - `uncommitted` is an ephemeral PER-AGENT snapshot of the dirty tree. We
 *    wholesale-replace this agent's uncommitted rows every call, so a clean tree
 *    (no uncommitted entries) auto-clears them — a decaying, best-effort hint.
 *
 *  - `committed` is a PER-COMMIT fact, deduplicated across reporters AND branches by
 *    (workspace_id, repo, commit_sha) via UPSERT against the partial unique index
 *    (migration 005, re-keyed per-commit in 009). The FIRST agent to report a commit owns the row
 *    (its agent_id / agent_name); later reporters — including a teammate who
 *    merely pulled the commit — only refresh updated_at so it stays alive while
 *    anyone still has it unlanded.
 *
 *    We ALSO remove this agent's committed rows that are no longer in its current
 *    report (any sha it no longer carries — dedup is per-commit, so this is matched
 *    sha-only regardless of branch). This is the fix for the squash/rebase ghost:
 *    after the agent merges its branch the
 *    original sha is gone from `base..HEAD`, so it drops out of the report, and we
 *    delete it instead of letting it linger to the 3-day TTL showing a wrong
 *    "unpushed, coordinate" hint (viewer-side `isAncestor` can never resolve a
 *    squashed-away sha, since the sha changed). It also clears stale rows from a
 *    branch the agent switched away from. We only delete rows THIS agent owns; a
 *    teammate who still holds the commit re-inserts it on their next report (≤ one
 *    heartbeat), so cross-reporter awareness is eventually-consistent, not lost.
 *
 * `agent_name` and `branch` are snapshotted onto each row, and each entry's
 * `paths` maps to the `path_globs` column. Transactional: the caller passes a tx
 * so all statements commit atomically.
 */
export async function replaceChangeRecords(
  tx: pg.PoolClient,
  params: {
    agentId: string;
    agentName: string;
    workspaceId: string;
    repo: string;
    branch: string;
    entries: Array<{
      kind: "committed" | "uncommitted";
      commitSha: string | null;
      message: string | null;
      paths: string[];
    }>;
  }
): Promise<void> {
  const { agentId, agentName, workspaceId, repo, branch, entries } = params;

  // Wholesale-replace ONLY this agent's uncommitted rows (a clean tree auto-clears
  // them).
  await tx.query(
    `DELETE FROM change_records WHERE agent_id = $1 AND kind = 'uncommitted'`,
    [agentId]
  );

  const committed = entries.filter((e) => e.kind === "committed");
  const uncommitted = entries.filter((e) => e.kind === "uncommitted");

  // Remove this agent's committed rows it is no longer reporting: any sha not in
  // the current set (squashed/rebased away after a merge, or left behind on a
  // branch the agent switched off of). Dedup is per-COMMIT (migration 009), so the
  // match is sha-only — branch is display metadata and never part of identity.
  // Scoped to agent_id so we never delete a row another agent still owns. With an
  // empty committed set this clears all of the agent's committed rows (nothing
  // unlanded).
  const committedShas = committed
    .map((e) => e.commitSha)
    .filter((s): s is string => s !== null);
  await tx.query(
    `DELETE FROM change_records
     WHERE agent_id = $1
       AND kind = 'committed'
       AND NOT (commit_sha = ANY($2::text[]))`,
    [agentId, committedShas]
  );

  // Committed: dedup per COMMIT across reporters and branches (migration 009's
  // (workspace_id, repo, commit_sha) index). First reporter owns the row (agent_id,
  // agent_name, branch are snapshotted then); later reports of the same sha — even
  // under a different branch label — just refresh updated_at so it stays fresh (and
  // unpruned) while still unlanded for someone. One statement per entry keeps the
  // ON CONFLICT target simple.
  for (const e of committed) {
    await tx.query(
      `INSERT INTO change_records
         (workspace_id, repo, agent_id, agent_name, branch, kind, commit_sha, message, path_globs)
       VALUES ($1, $2, $3, $4, $5, 'committed', $6, $7, $8)
       ON CONFLICT (workspace_id, repo, commit_sha) WHERE kind = 'committed'
       DO UPDATE SET updated_at = now()`,
      [workspaceId, repo, agentId, agentName, branch, e.commitSha, e.message, e.paths]
    );
  }

  // Uncommitted: re-insert this agent's current dirty-tree snapshot (the old set
  // was just cleared above). Single bulk INSERT, no conflict handling needed.
  // Shared columns are $1..$5; kind/commit_sha are literals; each entry then
  // contributes exactly 2 params (message, path_globs).
  if (uncommitted.length > 0) {
    const sharedCount = 5;
    const valuePlaceholders = uncommitted
      .map((_, i) => {
        const base = sharedCount + i * 2;
        return `($1, $2, $3, $4, $5, 'uncommitted', NULL, $${base + 1}, $${base + 2})`;
      })
      .join(", ");

    const entryParams = uncommitted.flatMap((e) => [e.message, e.paths]);

    await tx.query(
      `INSERT INTO change_records
         (workspace_id, repo, agent_id, agent_name, branch, kind, commit_sha, message, path_globs)
       VALUES ${valuePlaceholders}`,
      [workspaceId, repo, agentId, agentName, branch, ...entryParams]
    );
  }
}

/**
 * Change records for `(workspace, repo)` authored by agents OTHER than
 * `excludeAgentId`, enriched with author presence.
 *
 * Each record's `agent_id` is LEFT-joined to that agent's sessions to compute
 * the author's latest heartbeat (MAX(sessions.last_heartbeat_at)):
 *   - authorLastActiveAt = that max (ISO). EDGE CASE: an agent with NO sessions
 *     has a NULL max; we fall back to the record's own `updated_at` so the field
 *     is always a valid ISO timestamp (the record is still returned).
 *   - authorIsLive = (now - max) <= staleAfterSeconds, i.e. false when the max
 *     is NULL (no sessions) or older than the staleness window.
 *
 * GRACE GATE (uncommitted only): an `uncommitted` record is a decaying,
 * best-effort "in progress / may change" snapshot of an author's dirty tree. It
 * stays visible only while the author was alive within `graceSeconds` of `now`
 * (their MAX heartbeat). This DECOUPLES two things: `staleAfterSeconds` (120s)
 * still drives the author_is_live LABEL (active-now vs offline), while the longer
 * `graceSeconds` (≈15 min) drives VISIBILITY — so a just-crashed/just-restarting
 * agent's dirty work survives the restart window (when a collision is most
 * likely), but a long-dead agent's snapshot stops ghosting well before the 3-day
 * change-record TTL. Pass `graceSeconds == staleAfterSeconds` for a hard
 * presence gate with no grace. Without any gate these would ghost for the full
 * TTL, because — unlike committed records, which the viewer drops once the SHA
 * lands (isAncestor) — a contentless dirty snapshot has no SHA and so can never
 * be resolved viewer-side. Committed records are returned regardless of author
 * liveness (an unpushed commit is worth surfacing either way).
 *
 * No glob filtering here — the landscape layer does that. Ordered newest-first
 * and capped at 200 rows.
 *
 * No `updated_at` display cutoff is applied here intentionally: both callers
 * (`work`, `sync`) run `pruneChangeRecords` for this exact `(workspace, repo)`
 * EARLIER in the same transaction, with the same `now`, so any row older than
 * the change-record TTL is already gone before this read. The prune-before-read
 * ordering makes the display TTL correct without a redundant WHERE clause here;
 * keep that ordering if either operation is refactored.
 */
export async function listOtherChangeRecords(
  db: Queryable,
  workspaceId: string,
  repo: string,
  excludeAgentId: string,
  now: Date,
  staleAfterSeconds: number,
  graceSeconds: number
): Promise<ChangeRecordT[]> {
  const { rows } = await db.query<{
    agent_name: string;
    human: string;
    branch: string;
    kind: "committed" | "uncommitted";
    commit_sha: string | null;
    message: string | null;
    path_globs: string[];
    updated_at: Date;
    author_last_active_at: Date | null;
    author_is_live: boolean;
  }>(
    `SELECT cr.agent_name,
            a.human,
            cr.branch,
            cr.kind,
            cr.commit_sha,
            cr.message,
            cr.path_globs,
            cr.updated_at,
            MAX(s.last_heartbeat_at) AS author_last_active_at,
            COALESCE(
              MAX(s.last_heartbeat_at) > $4::timestamptz - ($5 * interval '1 second'),
              false
            ) AS author_is_live
     FROM   change_records cr
     JOIN   agents   a ON a.id = cr.agent_id
     LEFT JOIN sessions s ON s.agent_id = cr.agent_id
     WHERE  cr.workspace_id = $1
       AND  cr.repo      = $2
       AND  cr.agent_id <> $3
     GROUP BY cr.id, a.human
     -- Grace gate on UNCOMMITTED records only: keep a dirty-tree snapshot visible
     -- while its author was alive within graceSeconds ($6), then drop it — rather
     -- than let it ghost until the 3-day TTL. graceSeconds ($6) is the VISIBILITY
     -- window and is independent of staleAfterSeconds ($5, the active/offline
     -- label above). Committed records are unaffected — they carry a SHA and
     -- resolve viewer-side (isAncestor), and an unpushed commit is worth surfacing
     -- whether or not its author is live. The MAX() is an aggregate, so HAVING.
     HAVING cr.kind = 'committed'
        OR  COALESCE(
              MAX(s.last_heartbeat_at) > $4::timestamptz - ($6 * interval '1 second'),
              false
            )
     ORDER BY cr.updated_at DESC
     LIMIT 200`,
    [workspaceId, repo, excludeAgentId, now, staleAfterSeconds, graceSeconds]
  );

  return rows.map((r) => ({
    agentName: r.agent_name,
    human: r.human,
    branch: r.branch,
    kind: r.kind,
    commitSha: r.commit_sha,
    message: r.message,
    paths: r.path_globs,
    authorIsLive: r.author_is_live,
    // No-session edge case: fall back to the record's own updated_at.
    authorLastActiveAt: (r.author_last_active_at ?? r.updated_at).toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Wallboard — whole-workspace read (GET /workspace/landscape)
// ---------------------------------------------------------------------------

/**
 * Most recent announcements surfaced to the dashboard feed. A hardcoded integer
 * constant (never user input) so it is safe to interpolate into the SQL text.
 */
const WORKSPACE_ANNOUNCEMENTS_LIMIT = 50;

/** One agent + its most-recent session, for the dashboard. */
export interface WorkspaceAgentRow {
  name: string;
  human: string;
  program: string;
  model: string | null;
  /** From the agent's most-recent session; null when it has no session. */
  repo: string | null;
  branch: string | null;
  lastHeartbeatAt: Date | null;
}

/** One announcement for the dashboard feed. */
export interface WorkspaceAnnouncementRow {
  fromAgentName: string;
  fromHuman: string;
  body: string;
  targetAgentName: string | null;
  repo: string;
  /** True for operator/admin-sent messages (no agent session behind them). */
  fromAdmin: boolean;
  /** True when an agent addressed the message to the operator side (mirror of fromAdmin). */
  toAdmin: boolean;
  /**
   * When an agent addressed a SPECIFIC workspace member: the member's name
   * snapshotted at send time (target_label). Null for collective/legacy
   * operator messages.
   */
  targetMemberName: string | null;
  createdAt: Date;
}

export interface WorkspaceLandscapeRows {
  agents: WorkspaceAgentRow[];
  tasks: Array<{
    agentName: string;
    program: string;
    model: string | null;
    repo: string;
    intent: string;
    pathGlobs: string[];
    status: "active" | "done" | "dropped";
    createdAt: Date;
    endedAt: Date | null;
  }>;
  announcements: WorkspaceAnnouncementRow[];
}

/**
 * Assemble the unfiltered whole-workspace view the dashboard needs: every agent
 * in `workspace` (joined to its most-recent session), the active/history task
 * split, and the most recent announcements.
 *
 * Unlike `buildLandscape`, this is NOT scoped to a caller's session/repo and
 * applies no glob filtering — it is the read-only "air traffic control" view.
 *
 * Raw timestamps (Date) and the owner's heartbeat are returned verbatim, so
 * AGENT presence is derived in the operation layer via `presenceFor`. The task
 * active/history split, however, applies the staleness boundary as a SQL
 * predicate. The boundary *value* is single-sourced: `staleAfterSeconds` is
 * passed in from the same config `presenceFor` reads. The *comparison* is NOT
 * shared — by design the task split mirrors `listActiveClaims`' claim-liveness
 * (strict `last_heartbeat_at > now - staleAfterSeconds`), so a claim shown as
 * active on the board agrees with what actually blocks teammates in conflict
 * detection. `presenceFor`/`isStale` use the strict-greater-than complement
 * (`elapsed > boundary` is stale ⇒ live at the exact boundary), so the two paths
 * differ only at the single exact-boundary instant: an agent could read "live"
 * in the crew strip while its claim is already in the dropped bucket. That
 * window is ~1ms wide and self-heals on the next poll; aligning the board with
 * the conflict path (listActiveClaims) is the deliberate tradeoff.
 *
 * `now` and `staleAfterSeconds` are injected (driving the staleness boundary) —
 * the query layer never reads the clock, matching the rest of repo.ts.
 */
export async function getWorkspaceLandscape(
  db: Queryable,
  workspaceId: string,
  now: Date,
  staleAfterSeconds: number
): Promise<WorkspaceLandscapeRows> {
  // Agents joined to their most-recent session. LEFT JOIN LATERAL so an agent
  // with no session still appears, with NULL repo/branch/last_heartbeat_at.
  const agentsResult = await db.query<{
    name: string;
    human: string;
    program: string;
    model: string | null;
    repo: string | null;
    branch: string | null;
    last_heartbeat_at: Date | null;
  }>(
    // Agent rows accumulate for the workspace's lifetime (joins mint rows;
    // nothing deletes them short of workspace deletion), so cap the payload at
    // the 500 most recently active — the inner recency sort picks WHICH agents
    // survive the cap, the outer sort preserves the stable by-name order.
    `SELECT * FROM (
       SELECT a.name,
              a.human,
              a.program,
              a.model,
              s.repo,
              s.branch,
              s.last_heartbeat_at
       FROM   agents a
       LEFT JOIN LATERAL (
         SELECT repo, branch, last_heartbeat_at
         FROM   sessions
         WHERE  agent_id = a.id
         ORDER BY last_heartbeat_at DESC
         LIMIT 1
       ) s ON true
       WHERE  a.workspace_id = $1
       ORDER BY s.last_heartbeat_at DESC NULLS LAST
       LIMIT  500
     ) recent
     ORDER BY name`,
    [workspaceId]
  );

  // Active tasks: status='active' AND owner session LIVE (mirrors listActiveClaims'
  // heartbeat liveness). These are the things being worked on right now. Note the
  // board gates on owner liveness ONLY, not the claim's `expires_at` TTL the way
  // listActiveClaims does — a live owner's claim shows as active regardless of TTL,
  // since a live session renews well inside the staleness window anyway.
  const activeResult = await db.query<{
    agent_name: string; program: string; model: string | null; repo: string;
    intent_text: string; path_globs: string[]; created_at: Date;
  }>(
    `SELECT a.name AS agent_name, a.program, a.model, wi.repo,
            wi.intent_text, wi.path_globs, wi.created_at
     FROM   work_items wi
     JOIN   sessions   s ON s.id = wi.session_id
     JOIN   agents     a ON a.id = s.agent_id
     WHERE  wi.workspace_id = $1
       AND  wi.status = 'active'
       AND  s.last_heartbeat_at > $2::timestamptz - ($3 * interval '1 second')
     ORDER BY wi.created_at DESC`,
    [workspaceId, now, staleAfterSeconds]
  );

  // History tasks: released (done) OR active-but-owner-stale (dropped).
  // endedAt = released_at for done, owner's last heartbeat for dropped.
  const historyResult = await db.query<{
    agent_name: string; program: string; model: string | null; repo: string;
    intent_text: string; path_globs: string[]; created_at: Date;
    released_at: Date | null; owner_last_heartbeat_at: Date;
  }>(
    `SELECT a.name AS agent_name, a.program, a.model, wi.repo,
            wi.intent_text, wi.path_globs, wi.created_at,
            wi.released_at, s.last_heartbeat_at AS owner_last_heartbeat_at
     FROM   work_items wi
     JOIN   sessions   s ON s.id = wi.session_id
     JOIN   agents     a ON a.id = s.agent_id
     WHERE  wi.workspace_id = $1
       AND  ( wi.released_at IS NOT NULL
              OR (wi.status = 'active'
                  AND s.last_heartbeat_at <= $2::timestamptz - ($3 * interval '1 second')) )
     ORDER BY COALESCE(wi.released_at, s.last_heartbeat_at) DESC
     LIMIT 100`,
    [workspaceId, now, staleAfterSeconds]
  );

  const tasks = [
    ...activeResult.rows.map((r) => ({
      agentName: r.agent_name, program: r.program, model: r.model, repo: r.repo,
      intent: r.intent_text, pathGlobs: r.path_globs,
      status: "active" as const, createdAt: r.created_at, endedAt: null,
    })),
    ...historyResult.rows.map((r) => ({
      agentName: r.agent_name, program: r.program, model: r.model, repo: r.repo,
      intent: r.intent_text, pathGlobs: r.path_globs,
      status: (r.released_at !== null ? "done" : "dropped") as "done" | "dropped",
      createdAt: r.created_at,
      endedAt: r.released_at ?? r.owner_last_heartbeat_at,
    })),
  ];

  // Most recent announcements across the workspace, newest first, capped.
  // LEFT JOIN so admin-sent rows (NULL from_session_id) appear in the feed; the
  // COALESCE falls back to the snapshotted from_label for those.
  const announcementsResult = await db.query<{
    from_agent_name: string;
    from_human: string;
    body: string;
    target_agent_name: string | null;
    repo: string;
    from_admin: boolean;
    to_admin: boolean;
    target_label: string | null;
    created_at: Date;
  }>(
    `SELECT COALESCE(a.name,  ann.from_label) AS from_agent_name,
            COALESCE(a.human, ann.from_label) AS from_human,
            ann.body,
            ann.target_agent_name,
            ann.repo,
            ann.from_admin,
            ann.to_admin,
            ann.target_label,
            ann.created_at
     FROM   announcements ann
     LEFT JOIN sessions   fs ON fs.id = ann.from_session_id
     LEFT JOIN agents     a  ON a.id  = fs.agent_id
     WHERE  ann.workspace_id = $1
     ORDER BY ann.id DESC
     LIMIT ${WORKSPACE_ANNOUNCEMENTS_LIMIT}`,
    [workspaceId]
  );

  return {
    agents: agentsResult.rows.map((r) => ({
      name: r.name,
      human: r.human,
      program: r.program,
      model: r.model,
      repo: r.repo,
      branch: r.branch,
      lastHeartbeatAt: r.last_heartbeat_at,
    })),
    tasks,
    announcements: announcementsResult.rows.map((r) => ({
      fromAgentName: r.from_agent_name,
      fromHuman: r.from_human,
      body: r.body,
      targetAgentName: r.target_agent_name,
      repo: r.repo,
      fromAdmin: r.from_admin,
      toAdmin: r.to_admin,
      targetMemberName: r.target_label,
      createdAt: r.created_at,
    })),
  };
}

/**
 * Delete change records in `(workspace_id, repo)` whose `updated_at` is older than
 * `now - ttlSeconds`. Scoped by `(workspace_id, repo)` so the composite index
 * `(workspace_id, repo, updated_at)` applies.
 */
export async function pruneChangeRecords(
  tx: pg.PoolClient,
  workspaceId: string,
  repo: string,
  now: Date,
  ttlSeconds: number
): Promise<void> {
  await tx.query(
    `DELETE FROM change_records
     WHERE workspace_id = $1
       AND repo      = $2
       AND updated_at < $3::timestamptz - ($4 * interval '1 second')`,
    [workspaceId, repo, now, ttlSeconds]
  );
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/**
 * Insert a feedback submission. `workspaceId`/`accountId` are whatever the
 * caller's resolved tenant happened to carry — neither is required, so a
 * self-host TEAM_TOKEN call or a workspace-less hosted call still lands a row.
 * Returns the new row's uuid.
 */
export async function insertFeedback(
  pool: pg.Pool,
  params: {
    workspaceId: string | null;
    accountId: string | null;
    type: string;
    body: string;
    /** Client-gathered context (route/appVersion/userAgent/viewport), already
     * validated + length-capped by FeedbackRequest. NULL when the (older)
     * client sent none. */
    context: FeedbackContextT | null;
  }
): Promise<string> {
  const { workspaceId, accountId, type, body, context } = params;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO feedback (workspace_id, account_id, type, body, context)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [workspaceId, accountId, type, body, context]
  );
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Platform analytics (operator surface)
//
// A cross-tenant, READ-ONLY aggregate over the whole hub with NO workspace
// scoping on purpose — which is exactly why the calling route is operator-gated
// (see requireOperator in tenant.ts for the trust model). No user input reaches
// the SQL: the only bound parameter is the trend window start computed
// server-side; table/column fragments are hardcoded constants.
// ---------------------------------------------------------------------------

// The wire shapes are canonically defined in @shepherd/shared (contract.ts);
// these aliases keep the existing repo-level names for callers while pinning
// this layer to the shared contract so drift is caught at compile time.
export type TrendPoint = TrendPointT;
export type TopWorkspace = TopWorkspaceT;
export type ShepherdAnalytics = ShepherdAnalyticsResponseT;

/**
 * A zero-filled daily trend over `[since, now]` for one table's timestamp
 * column. `table`/`tsColumn`/`extraWhere` are HARDCODED constants supplied by
 * the single caller below — never user input — so interpolating them into the
 * SQL text is safe; the window bound is the only bound parameter.
 */
async function dailyTrend(
  db: Queryable,
  table: string,
  tsColumn: string,
  since: Date,
  extraWhere = ""
): Promise<TrendPoint[]> {
  const { rows } = await db.query<{ date: string; count: string }>(
    `SELECT to_char(d, 'YYYY-MM-DD') AS date, COALESCE(b.count, 0) AS count
       FROM generate_series(date_trunc('day', $1::timestamptz),
                            date_trunc('day', now()),
                            interval '1 day') AS d
       LEFT JOIN (
         SELECT date_trunc('day', ${tsColumn}) AS day, count(*) AS count
           FROM ${table}
          WHERE ${tsColumn} >= $1${extraWhere ? ` AND ${extraWhere}` : ""}
          GROUP BY 1
       ) AS b ON b.day = d
      ORDER BY d`,
    [since]
  );
  return rows.map((r) => ({ date: r.date, count: Number(r.count) }));
}

/** Scalar count helper — runs `sql` and coerces the single `count` column. */
async function scalarCount(db: Queryable, sql: string): Promise<number> {
  const { rows } = await db.query<{ count: string }>(sql);
  return Number(rows[0]?.count ?? 0);
}

/**
 * Compute the whole cross-tenant analytics rollup in one call. The independent
 * aggregate queries are fanned out in THREE sequential `Promise.all` batches
 * (totals, then engagement + leaderboard, then trends) so a single rollup never
 * demands more concurrent connections than the pool's max (10) — one flat
 * ~20-query `Promise.all` would queue behind itself and could starve concurrent
 * requests. `liveWindowSeconds` is the presence window that counts a session as
 * "live" (the hub's STALE_AFTER_SECONDS); `trendDays` is the daily trend horizon.
 */
export async function getShepherdAnalytics(
  db: Queryable,
  opts: { liveWindowSeconds: number; trendDays: number }
): Promise<ShepherdAnalytics> {
  const { liveWindowSeconds, trendDays } = opts;
  const since = new Date(Date.now() - trendDays * 24 * 60 * 60 * 1000);
  const live = `now() - (${Math.trunc(liveWindowSeconds)} * interval '1 second')`;

  // Batch 1: the flat totals.
  const [
    accounts,
    workspaces,
    memberships,
    agents,
    liveSessions,
    activeTokens,
    revokedTokens,
    activeInvites,
    feedback,
    changeRecords,
    activeWorkItems,
  ] = await Promise.all([
    scalarCount(db, `SELECT count(*) AS count FROM account_profiles`),
    scalarCount(db, `SELECT count(*) AS count FROM workspaces`),
    scalarCount(db, `SELECT count(*) AS count FROM memberships`),
    scalarCount(db, `SELECT count(*) AS count FROM agents`),
    scalarCount(db, `SELECT count(*) AS count FROM sessions WHERE last_heartbeat_at > ${live}`),
    scalarCount(db, `SELECT count(*) AS count FROM api_tokens WHERE revoked_at IS NULL`),
    scalarCount(db, `SELECT count(*) AS count FROM api_tokens WHERE revoked_at IS NOT NULL`),
    scalarCount(
      db,
      `SELECT count(*) AS count FROM invites
        WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`
    ),
    scalarCount(db, `SELECT count(*) AS count FROM feedback`),
    scalarCount(db, `SELECT count(*) AS count FROM change_records`),
    scalarCount(db, `SELECT count(*) AS count FROM work_items WHERE status = 'active'`),
  ]);

  // Batch 2: engagement rollups + the feedback and workspace leaderboards.
  const [
    activeWorkspaces7d,
    activeWorkspaces30d,
    largestWorkspace,
    feedbackByTypeRows,
    topWorkspaceRows,
  ] = await Promise.all([
    scalarCount(
      db,
      `SELECT count(DISTINCT workspace_id) AS count FROM change_records
        WHERE updated_at > now() - interval '7 days'`
    ),
    scalarCount(
      db,
      `SELECT count(DISTINCT workspace_id) AS count FROM change_records
        WHERE updated_at > now() - interval '30 days'`
    ),
    scalarCount(
      db,
      `SELECT COALESCE(max(c), 0) AS count FROM (
         SELECT count(*) AS c FROM memberships GROUP BY workspace_id
       ) AS m`
    ),
    db.query<{ type: string; count: string }>(
      `SELECT type, count(*) AS count FROM feedback GROUP BY type ORDER BY count DESC`
    ),
    db.query<{
      name: string;
      slug: string;
      members: string;
      agents: string;
      live_sessions: string;
    }>(
      `SELECT w.name, w.slug,
              (SELECT count(*) FROM memberships m WHERE m.workspace_id = w.id) AS members,
              (SELECT count(*) FROM agents a WHERE a.workspace_id = w.id) AS agents,
              (SELECT count(*) FROM sessions s
                 WHERE s.workspace_id = w.id AND s.last_heartbeat_at > ${live}) AS live_sessions
         FROM workspaces w
        ORDER BY members DESC, w.name ASC
        LIMIT 10`
    ),
  ]);

  // Batch 3: the daily trend series.
  const [newAccounts, newWorkspaces, newSessions, commits] = await Promise.all([
    dailyTrend(db, "account_profiles", "created_at", since),
    dailyTrend(db, "workspaces", "created_at", since),
    dailyTrend(db, "sessions", "created_at", since),
    dailyTrend(db, "change_records", "updated_at", since, "kind = 'committed'"),
  ]);

  const avgMembersPerWorkspace = workspaces === 0 ? 0 : memberships / workspaces;

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      accounts,
      workspaces,
      memberships,
      agents,
      liveSessions,
      activeTokens,
      revokedTokens,
      activeInvites,
      feedback,
      changeRecords,
      activeWorkItems,
    },
    engagement: {
      activeWorkspaces7d,
      activeWorkspaces30d,
      avgMembersPerWorkspace: Math.round(avgMembersPerWorkspace * 100) / 100,
      largestWorkspace,
    },
    feedbackByType: feedbackByTypeRows.rows.map((r) => ({
      type: r.type,
      count: Number(r.count),
    })),
    trends: { newAccounts, newWorkspaces, newSessions, commits },
    topWorkspaces: topWorkspaceRows.rows.map((r) => ({
      name: r.name,
      slug: r.slug,
      members: Number(r.members),
      agents: Number(r.agents),
      liveSessions: Number(r.live_sessions),
    })),
  };
}
