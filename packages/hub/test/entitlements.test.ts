import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  runTestMigrations,
  truncateAll,
} from "./setup.js";

/**
 * Seed a workspace with a suite-unique slug and return its uuid. The
 * entitlements table FKs into workspaces, so every row needs a real
 * workspace to point at. Slugs are prefixed `ent-` so afterEach can clear
 * exactly the rows this suite created without touching other suites' state.
 */
async function seedWorkspace(pool: pg.Pool, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [slug, slug],
  );
  return rows[0]!.id;
}

describe.skipIf(!dbAvailable)("workspace_entitlements (migration 020)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
  });

  afterEach(async () => {
    await truncateAll(pool);
    // Cascades any workspace_entitlements rows created against these
    // workspaces (workspace_id FK is ON DELETE CASCADE).
    await pool.query(`DELETE FROM workspaces WHERE slug LIKE 'ent-%'`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("records the 020 migration as applied", async () => {
    const { rows } = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = '020_workspace_entitlements'",
    );
    expect(rows).toHaveLength(1);
  });

  it("inserts an all-null caps row and reads it back (NULL = unlimited)", async () => {
    const workspaceId = await seedWorkspace(pool, "ent-roundtrip");

    await pool.query(
      `INSERT INTO workspace_entitlements (workspace_id) VALUES ($1)`,
      [workspaceId],
    );

    const { rows } = await pool.query<{
      workspace_id: string;
      seats_limit: number | null;
      repos_limit: number | null;
      retention_days: number | null;
      expires_at: Date | null;
      updated_at: Date;
    }>(`SELECT * FROM workspace_entitlements WHERE workspace_id = $1`, [
      workspaceId,
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.workspace_id).toBe(workspaceId);
    expect(rows[0]!.seats_limit).toBeNull();
    expect(rows[0]!.repos_limit).toBeNull();
    expect(rows[0]!.retention_days).toBeNull();
    expect(rows[0]!.expires_at).toBeNull();
    expect(rows[0]!.updated_at).toBeInstanceOf(Date);
  });

  it("stores explicit caps and an expiry", async () => {
    const workspaceId = await seedWorkspace(pool, "ent-caps");

    await pool.query(
      `INSERT INTO workspace_entitlements
         (workspace_id, seats_limit, repos_limit, retention_days, expires_at)
       VALUES ($1, 4, 5, 30, now() + interval '1 day')`,
      [workspaceId],
    );

    const { rows } = await pool.query<{
      seats_limit: number;
      repos_limit: number;
      retention_days: number;
      expires_at: Date;
    }>(`SELECT * FROM workspace_entitlements WHERE workspace_id = $1`, [
      workspaceId,
    ]);
    expect(rows[0]!.seats_limit).toBe(4);
    expect(rows[0]!.repos_limit).toBe(5);
    expect(rows[0]!.retention_days).toBe(30);
    expect(rows[0]!.expires_at).toBeInstanceOf(Date);
  });

  it("the CHECK rejects seats_limit = 0 (caps must be positive)", async () => {
    const workspaceId = await seedWorkspace(pool, "ent-check-seats");

    await expect(
      pool.query(
        `INSERT INTO workspace_entitlements (workspace_id, seats_limit)
         VALUES ($1, 0)`,
        [workspaceId],
      ),
    ).rejects.toThrow();
  });

  it("the CHECKs reject repos_limit = 0 and retention_days = 0", async () => {
    const workspaceId = await seedWorkspace(pool, "ent-check-rest");

    await expect(
      pool.query(
        `INSERT INTO workspace_entitlements (workspace_id, repos_limit)
         VALUES ($1, 0)`,
        [workspaceId],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO workspace_entitlements (workspace_id, retention_days)
         VALUES ($1, 0)`,
        [workspaceId],
      ),
    ).rejects.toThrow();
  });

  it("a second row for the same workspace violates the PK (one row per workspace)", async () => {
    const workspaceId = await seedWorkspace(pool, "ent-pk");

    await pool.query(
      `INSERT INTO workspace_entitlements (workspace_id) VALUES ($1)`,
      [workspaceId],
    );
    await expect(
      pool.query(
        `INSERT INTO workspace_entitlements (workspace_id) VALUES ($1)`,
        [workspaceId],
      ),
    ).rejects.toThrow();
  });

  it("deleting the workspace cascades the entitlements row", async () => {
    const workspaceId = await seedWorkspace(pool, "ent-cascade");

    await pool.query(
      `INSERT INTO workspace_entitlements (workspace_id, seats_limit)
       VALUES ($1, 4)`,
      [workspaceId],
    );
    await pool.query(`DELETE FROM workspaces WHERE id = $1`, [workspaceId]);

    const { rows } = await pool.query(
      `SELECT 1 FROM workspace_entitlements WHERE workspace_id = $1`,
      [workspaceId],
    );
    expect(rows).toHaveLength(0);
  });
});
