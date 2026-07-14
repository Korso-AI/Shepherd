/**
 * The ONE door to the database for request-serving code.
 *
 * `withContext` opens a transaction and sets three TRANSACTION-LOCAL GUCs —
 * `app.context`, `app.workspace_id`, `app.account_id` — that the row-security
 * policies (migration 021) read via the `app_context()` / `app_workspace_id()`
 * / `app_account_id()` SQL helpers. Until that migration exists the GUCs are
 * inert, so this module deploys as a pure refactor.
 *
 * `ScopedDb` is a BRANDED PoolClient: repo.ts functions accept only it, and
 * only this module mints one — so a query that skipped context-setting is a
 * compile error, not a latent cross-tenant bug.
 *
 * Context kinds (see docs/rls.md for the policy map they unlock):
 *  - workspace   — a resolved request pinned to one workspace.
 *  - account     — account-surface routes (list/create workspaces, tokens,
 *                  invite redemption, account deletion). May FOCUS one
 *                  workspace (`workspaceId`) after validating a capability
 *                  (an invite code, the caller's own membership) to unlock
 *                  that workspace's membership/entitlement reads WITHOUT
 *                  granting full workspace powers.
 *  - auth        — resolveTenant's pre-tenant lookups (chicken-and-egg).
 *  - internal    — the /internal/* entitlements surface (BFF service call).
 *  - operator    — /admin/* read-only cross-tenant analytics.
 *  - maintenance — boot-time self-host seeding.
 */

import type pg from "pg";
import { withTransaction } from "./db.js";

export type DbContext =
  | { kind: "workspace"; workspaceId: string; accountId?: string }
  | { kind: "account"; accountId: string; workspaceId?: string }
  | { kind: "auth"; accountId?: string }
  | { kind: "internal"; workspaceId: string }
  | { kind: "operator" }
  | { kind: "maintenance" };

declare const scoped: unique symbol;
/** A PoolClient whose transaction has its RLS context GUCs set. */
export type ScopedDb = pg.PoolClient & { readonly [scoped]: true };

/**
 * Set the three context GUCs on the CURRENT transaction (is_local = true, so
 * they vanish at COMMIT/ROLLBACK and can never leak across pooled
 * connections). Absent ids are set to '' — the SQL helpers NULLIF that back
 * to NULL, and `col = NULL` is never true, so an id-less context fails closed.
 */
export async function setDbContext(
  db: ScopedDb,
  ctx: DbContext,
): Promise<void> {
  const workspaceId = "workspaceId" in ctx ? (ctx.workspaceId ?? "") : "";
  const accountId = "accountId" in ctx ? (ctx.accountId ?? "") : "";
  await db.query(
    `SELECT set_config('app.context', $1, true),
            set_config('app.workspace_id', $2, true),
            set_config('app.account_id', $3, true)`,
    [ctx.kind, workspaceId, accountId],
  );
}

/**
 * Run `fn` in a transaction whose RLS context is `ctx`. Same rollback /
 * always-release semantics as withTransaction (which it wraps). This is the
 * ONLY producer of a ScopedDb.
 */
export async function withContext<T>(
  pool: pg.Pool,
  ctx: DbContext,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    const db = client as ScopedDb;
    await setDbContext(db, ctx);
    return fn(db);
  });
}
