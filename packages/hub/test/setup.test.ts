import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  runTestMigrations,
  truncateAll,
  truncateTenancy,
} from "./setup.js";

/**
 * Exercises the two truncate helpers against a live schema (post-011):
 *   - truncateAll clears coordination rows but leaves the workspace standing.
 *   - truncateTenancy then removes the workspace itself.
 * Both must run without FK errors and leave the expected state.
 */
describe.skipIf(!dbAvailable)("test harness — truncate helpers", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
    // Start from a known-clean slate so a prior suite's tenancy rows don't leak in.
    await truncateAll(pool);
    await truncateTenancy(pool);
  });

  afterAll(async () => {
    await truncateAll(pool);
    await truncateTenancy(pool);
    await pool.end();
  });

  it("truncateAll clears coordination rows but leaves the workspace intact", async () => {
    // Seed a workspace, then an agent hanging off it (workspace_id FK).
    const { rows: wsRows } = await pool.query<{ id: string }>(`
      INSERT INTO workspaces (slug, name, created_by)
      VALUES ('test', 'Test Workspace', 'tester')
      RETURNING id
    `);
    const workspaceId = wsRows[0]!.id;

    await pool.query(
      `
      INSERT INTO agents (workspace_id, name, human, program, model)
      VALUES ($1, 'agent-alpha', 'alice', 'prog', 'claude-3')
      `,
      [workspaceId],
    );

    // truncateAll must not raise an FK error and must drop the agent.
    await expect(truncateAll(pool)).resolves.not.toThrow();

    const { rows: agentCount } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM agents",
    );
    expect(agentCount[0]!.n).toBe("0");

    // The workspace survives truncateAll.
    const { rows: wsCount } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM workspaces",
    );
    expect(wsCount[0]!.n).toBe("1");
  });

  it("truncateTenancy removes the workspace", async () => {
    // Previous test left exactly one workspace standing.
    const { rows: before } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM workspaces",
    );
    expect(before[0]!.n).toBe("1");

    await expect(truncateTenancy(pool)).resolves.not.toThrow();

    const { rows: after } = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM workspaces",
    );
    expect(after[0]!.n).toBe("0");
  });
});
