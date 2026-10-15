import { describe, it, expect, afterAll } from "vitest";
import type pg from "pg";
import { createPool } from "../src/db.js";
import { dbAvailable, createTestPool, TEST_DATABASE_URL } from "./setup.js";

describe.skipIf(!dbAvailable)("createPool", () => {
  const pools: pg.Pool[] = [];
  afterAll(async () => {
    await Promise.all(pools.map((p) => p.end()));
  });

  // Production crash (2026-10-15): an idle pooled connection dropped by the
  // network path made pg emit 'error' on the pool; with no listener Node threw
  // it as uncaught and the hub exited. Killing the backend reproduces that.
  it("survives an idle client's connection dropping and keeps serving", async () => {
    const pool = createPool(TEST_DATABASE_URL);
    const owner = createTestPool();
    pools.push(pool, owner);

    const { rows } = await pool.query<{ pid: number }>(
      "SELECT pg_backend_pid() AS pid",
    );
    expect(pool.idleCount).toBe(1);

    await owner.query("SELECT pg_terminate_backend($1)", [rows[0]?.pid]);
    // pg evicts the broken idle client once its socket reports the drop.
    await expect.poll(() => pool.totalCount, { timeout: 5_000 }).toBe(0);

    const after = await pool.query<{ one: number }>("SELECT 1 AS one");
    expect(after.rows[0]?.one).toBe(1);
  });
});
