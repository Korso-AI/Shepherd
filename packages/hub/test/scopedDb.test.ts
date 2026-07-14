import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import { dbAvailable, createTestPool, runTestMigrations } from "./setup.js";
import { withContext, setDbContext } from "../src/scopedDb.js";

describe.skipIf(!dbAvailable)("withContext", () => {
  let pool: pg.Pool;
  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
  });
  afterAll(async () => pool.end());

  it("sets all three GUCs transaction-locally for a workspace context", async () => {
    await withContext(
      pool,
      { kind: "workspace", workspaceId: "11111111-1111-1111-1111-111111111111", accountId: "acct-1" },
      async (db) => {
        const { rows } = await db.query(
          `SELECT current_setting('app.context') AS ctx,
                  current_setting('app.workspace_id') AS ws,
                  current_setting('app.account_id') AS acct`,
        );
        expect(rows[0]).toEqual({
          ctx: "workspace",
          ws: "11111111-1111-1111-1111-111111111111",
          acct: "acct-1",
        });
      },
    );
    // Transaction-local: a fresh connection sees no leaked GUC.
    const { rows } = await pool.query(
      `SELECT current_setting('app.context', true) AS ctx`,
    );
    expect(rows[0].ctx === null || rows[0].ctx === "").toBe(true);
  });

  it("sets empty strings for absent ids (operator context)", async () => {
    await withContext(pool, { kind: "operator" }, async (db) => {
      const { rows } = await db.query(
        `SELECT current_setting('app.context') AS ctx,
                current_setting('app.workspace_id') AS ws,
                current_setting('app.account_id') AS acct`,
      );
      expect(rows[0]).toEqual({ ctx: "operator", ws: "", acct: "" });
    });
  });

  it("setDbContext re-scopes mid-transaction", async () => {
    await withContext(pool, { kind: "account", accountId: "acct-1" }, async (db) => {
      await setDbContext(db, {
        kind: "workspace",
        workspaceId: "22222222-2222-2222-2222-222222222222",
        accountId: "acct-1",
      });
      const { rows } = await db.query(
        `SELECT current_setting('app.context') AS ctx, current_setting('app.workspace_id') AS ws`,
      );
      expect(rows[0]).toEqual({ ctx: "workspace", ws: "22222222-2222-2222-2222-222222222222" });
    });
  });

  it("rolls back and rethrows on error (withTransaction semantics preserved)", async () => {
    await expect(
      withContext(pool, { kind: "maintenance" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});
