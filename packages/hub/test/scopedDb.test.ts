import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import {
  dbAvailable,
  createTestPool,
  createAppPool,
  runTestMigrations,
} from "./setup.js";
import { withContext, setDbContext, type DbContext } from "../src/scopedDb.js";

describe.skipIf(!dbAvailable)("withContext", () => {
  // Owner pool: raw leak/rollback assertions read DB state bypassing RLS.
  let pool: pg.Pool;
  // Restricted app-role pool: the withContext-under-test runs here, so its
  // GUC probes and maintenance/operator table access exercise the policies.
  let appPool: pg.Pool;
  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
    appPool = createAppPool();
  });
  afterAll(async () => {
    await appPool.end();
    await pool.end();
  });

  /** Read the GUC 4-tuple on the given handle. */
  async function readGucs(
    db: Pick<pg.PoolClient, "query">,
  ): Promise<{ ctx: string; ws: string; acct: string; inv: string }> {
    const { rows } = await db.query(
      `SELECT current_setting('app.context') AS ctx,
              current_setting('app.workspace_id') AS ws,
              current_setting('app.account_id') AS acct,
              current_setting('app.invite_code') AS inv`,
    );
    return rows[0] as { ctx: string; ws: string; acct: string; inv: string };
  }

  it("sets all three GUCs transaction-locally for a workspace context", async () => {
    await withContext(
      appPool,
      {
        kind: "workspace",
        workspaceId: "11111111-1111-1111-1111-111111111111",
        accountId: "acct-1",
      },
      async (db) => {
        expect(await readGucs(db)).toEqual({
          ctx: "workspace",
          ws: "11111111-1111-1111-1111-111111111111",
          acct: "acct-1",
          inv: "",
        });
      },
    );
    // Transaction-local: a fresh connection sees no leaked GUC.
    const { rows } = await pool.query(
      `SELECT current_setting('app.context', true) AS ctx`,
    );
    expect(rows[0].ctx === null || rows[0].ctx === "").toBe(true);
  });

  // Every kind's GUC 4-tuple, pinned one by one: these exact strings are the
  // contract the Phase 2 policy SQL (migration 021) matches on, so an unnoticed
  // drift here would surface as a policy mismatch there. The `inv` dimension is
  // app.invite_code: only a code-bearing account context sets it; every other
  // kind pins '' (and setDbContext OVERWRITES it on every re-scope, so a
  // widening can never inherit a stale code).
  const KIND_TRIPLES: Array<
    [DbContext, { ctx: string; ws: string; acct: string; inv: string }]
  > = [
    [
      { kind: "workspace", workspaceId: "ws-1" },
      { ctx: "workspace", ws: "ws-1", acct: "", inv: "" },
    ],
    [
      { kind: "account", accountId: "acct-1" },
      { ctx: "account", ws: "", acct: "acct-1", inv: "" },
    ],
    [
      { kind: "account", accountId: "acct-1", workspaceId: "ws-focus" },
      { ctx: "account", ws: "ws-focus", acct: "acct-1", inv: "" },
    ],
    [
      { kind: "account", accountId: "acct-1", inviteCode: "invite-code-1" },
      { ctx: "account", ws: "", acct: "acct-1", inv: "invite-code-1" },
    ],
    [{ kind: "auth" }, { ctx: "auth", ws: "", acct: "", inv: "" }],
    [
      { kind: "auth", accountId: "acct-1" },
      { ctx: "auth", ws: "", acct: "acct-1", inv: "" },
    ],
    [
      { kind: "internal", workspaceId: "ws-1" },
      { ctx: "internal", ws: "ws-1", acct: "", inv: "" },
    ],
    [{ kind: "operator" }, { ctx: "operator", ws: "", acct: "", inv: "" }],
    [
      { kind: "maintenance" },
      { ctx: "maintenance", ws: "", acct: "", inv: "" },
    ],
  ];
  it.each(KIND_TRIPLES)(
    "maps %j to its exact GUC triple",
    async (ctx, expected) => {
      await withContext(appPool, ctx, async (db) => {
        expect(await readGucs(db)).toEqual(expected);
      });
    },
  );

  it("rejects an empty id the kind requires, before running the callback", async () => {
    const ran: string[] = [];
    for (const ctx of [
      { kind: "workspace", workspaceId: "" },
      { kind: "account", accountId: "" },
      { kind: "account", accountId: "acct-1", workspaceId: "" },
      { kind: "internal", workspaceId: "" },
      // OPTIONAL ids are validated too when present: supplied-but-empty is a
      // threaded sentinel, not a deliberate omission.
      { kind: "workspace", workspaceId: "ws-1", accountId: "" },
      { kind: "auth", accountId: "" },
      // The invite code is a capability, validated the same way: a present-but-
      // empty code would fail closed under the code-scoped policy arms.
      { kind: "account", accountId: "acct-1", inviteCode: "" },
    ] satisfies DbContext[]) {
      await expect(
        withContext(appPool, ctx, async () => {
          ran.push(ctx.kind);
        }),
      ).rejects.toThrow(/must be non-empty/);
    }
    // Fail LOUDLY here rather than silently-zero-rows under the policies: the
    // callback must never have started.
    expect(ran).toEqual([]);
  });

  it("setDbContext re-scopes mid-transaction", async () => {
    await withContext(
      appPool,
      { kind: "account", accountId: "acct-1" },
      async (db) => {
        await setDbContext(db, {
          kind: "workspace",
          workspaceId: "22222222-2222-2222-2222-222222222222",
          accountId: "acct-1",
        });
        const { rows } = await db.query(
          `SELECT current_setting('app.context') AS ctx, current_setting('app.workspace_id') AS ws`,
        );
        expect(rows[0]).toEqual({
          ctx: "workspace",
          ws: "22222222-2222-2222-2222-222222222222",
        });
      },
    );
  });

  it("rolls back the transaction's writes and rethrows on error", async () => {
    await expect(
      withContext(appPool, { kind: "maintenance" }, async (db) => {
        await db.query(
          `INSERT INTO workspaces (slug, name, created_by)
           VALUES ('rollback-probe', 'rollback-probe', 'test')`,
        );
        // The write is visible inside the transaction...
        const { rows } = await db.query(
          `SELECT count(*)::int AS n FROM workspaces WHERE slug = 'rollback-probe'`,
        );
        expect(rows[0].n).toBe(1);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // ...and gone after the rollback, observed from a fresh connection.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM workspaces WHERE slug = 'rollback-probe'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it("nested withContext is an INDEPENDENT transaction, not a subtransaction", async () => {
    // Nesting withContext inside a ScopedDb callback is FORBIDDEN in src (it
    // burns a second pool connection and loses atomicity — see the scopedDb.ts
    // module header; re-scope with setDbContext instead). This test pins the
    // semantics that rule guards against: the inner transaction cannot see the
    // outer one's uncommitted write, and keeps its own context.
    await expect(
      withContext(appPool, { kind: "maintenance" }, async (outer) => {
        await outer.query(
          `INSERT INTO workspaces (slug, name, created_by)
           VALUES ('nesting-probe', 'nesting-probe', 'test')`,
        );
        await withContext(appPool, { kind: "operator" }, async (inner) => {
          const { rows } = await inner.query(
            `SELECT count(*)::int AS n FROM workspaces WHERE slug = 'nesting-probe'`,
          );
          expect(rows[0].n).toBe(0); // independent snapshot — atomicity is lost
          expect((await readGucs(inner)).ctx).toBe("operator");
        });
        expect((await readGucs(outer)).ctx).toBe("maintenance");
        throw new Error("cleanup"); // roll the probe row back out
      }),
    ).rejects.toThrow("cleanup");
  });
});
