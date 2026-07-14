/**
 * The ONE door to the database for request-serving code.
 *
 * `withContext` opens a transaction and sets three TRANSACTION-LOCAL GUCs —
 * `app.context`, `app.workspace_id`, `app.account_id` — that the row-security
 * policies (the Phase 2 policy migration, 021) read via the `app_context()` /
 * `app_workspace_id()` / `app_account_id()` SQL helpers. Until that migration
 * exists the GUCs are inert, so this module deploys as a pure refactor.
 *
 * `ScopedDb` is a BRANDED query handle: repo.ts functions accept only it, and
 * only this module mints one — so a query that skipped context-setting is a
 * compile error, not a latent cross-tenant bug.
 *
 * NEVER call `withContext` while already holding a ScopedDb: it checks out a
 * SECOND pool connection and opens an INDEPENDENT transaction — writes silently
 * lose atomicity with the outer transaction, and under load it is the classic
 * pool self-deadlock. To change context mid-transaction, use `setDbContext`
 * on the ScopedDb you already hold.
 *
 * Context kinds (the Phase 2 policy migration maps each to its policy arms):
 *  - workspace   — a resolved request pinned to one workspace.
 *  - account     — account-surface routes (list/create workspaces, tokens,
 *                  invite redemption, account deletion). May FOCUS one
 *                  workspace (`workspaceId`) after validating a capability
 *                  (an invite code, the caller's own membership) to unlock
 *                  that workspace's membership/entitlement reads WITHOUT
 *                  granting full workspace powers.
 *  - auth        — resolveTenant's pre-tenant lookups (chicken-and-egg), plus
 *                  ONE sanctioned post-auth use: createWorkspace's global
 *                  slug-uniqueness probe (see workspaces.ts — account context
 *                  would hide other tenants' slugs and break suffixing).
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
/**
 * The query surface of a transaction whose RLS context GUCs are set. Only
 * `query` is exposed (SAVEPOINTs and advisory locks still go through it):
 * withholding `release()` and the rest of PoolClient keeps operation code
 * from corrupting the transaction lifecycle that withContext owns.
 */
export type ScopedDb = Pick<pg.PoolClient, "query"> & {
  readonly [scoped]: true;
};

/**
 * Resolve the GUC id pair for a context, failing LOUDLY when an id the kind
 * requires is empty. An empty required id is always a caller bug (e.g. a
 * sentinel threaded past contextForTenant); once the policies exist it would
 * fail closed to zero rows — turning a buggy write into a silent no-op — so
 * reject it here instead. The switch is exhaustive: a new kind that forgets
 * its arm is a compile error, not a silently-empty GUC.
 */
function contextIds(ctx: DbContext): {
  workspaceId: string;
  accountId: string;
} {
  switch (ctx.kind) {
    case "workspace":
      return {
        workspaceId: requireId(ctx.workspaceId, "workspace", "workspaceId"),
        // Optional ids get the same loudness when PRESENT: a supplied-but-empty
        // accountId is a threaded sentinel, not a deliberate omission.
        accountId:
          ctx.accountId !== undefined
            ? requireId(ctx.accountId, "workspace", "accountId")
            : "",
      };
    case "account":
      return {
        workspaceId:
          ctx.workspaceId !== undefined
            ? requireId(ctx.workspaceId, "account", "workspaceId (focus)")
            : "",
        accountId: requireId(ctx.accountId, "account", "accountId"),
      };
    case "auth":
      return {
        workspaceId: "",
        accountId:
          ctx.accountId !== undefined
            ? requireId(ctx.accountId, "auth", "accountId")
            : "",
      };
    case "internal":
      return {
        workspaceId: requireId(ctx.workspaceId, "internal", "workspaceId"),
        accountId: "",
      };
    case "operator":
    case "maintenance":
      return { workspaceId: "", accountId: "" };
    default: {
      const exhausted: never = ctx;
      throw new Error(`unknown DbContext: ${JSON.stringify(exhausted)}`);
    }
  }
}

function requireId(value: string, kind: string, field: string): string {
  if (value === "") {
    throw new Error(`DbContext ${kind}: ${field} must be non-empty`);
  }
  return value;
}

/**
 * Set the three context GUCs on the CURRENT transaction (is_local = true, so
 * they vanish at COMMIT/ROLLBACK and can never leak across pooled
 * connections). Absent ids are set to '' — the SQL helpers NULLIF that back
 * to NULL, and `col = NULL` is never true, so an id-less context fails closed.
 *
 * Re-pointing a live transaction's context is an ESCALATION primitive: a call
 * site must hold a proof (the validated row) that justifies the new scope, and
 * the full call-site list is pinned by test/doorInvariants.test.ts — adding a
 * site means updating that allowlist under review, on purpose.
 */
export async function setDbContext(
  db: ScopedDb,
  ctx: DbContext,
): Promise<void> {
  const ids = contextIds(ctx);
  await db.query(
    `SELECT set_config('app.context', $1, true),
            set_config('app.workspace_id', $2, true),
            set_config('app.account_id', $3, true)`,
    [ctx.kind, ids.workspaceId, ids.accountId],
  );
}

/**
 * Run `fn` in a transaction whose RLS context is `ctx`. Same rollback /
 * always-release semantics as withTransaction (which it wraps). This is the
 * ONLY producer of a ScopedDb. Not composable: see the module header for why
 * nesting withContext inside a ScopedDb callback is forbidden.
 */
export async function withContext<T>(
  pool: pg.Pool,
  ctx: DbContext,
  fn: (db: ScopedDb) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, async (client) => {
    // The ONE sanctioned mint (pinned by test/doorInvariants.test.ts). The
    // two-step cast is required because ScopedDb deliberately exposes only
    // `query`, so PoolClient and ScopedDb no longer overlap structurally.
    const db = client as unknown as ScopedDb;
    await setDbContext(db, ctx);
    return fn(db);
  });
}
