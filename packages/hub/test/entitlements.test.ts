import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import type { EntitlementLimitsT } from "@shepherd/shared";
import {
  dbAvailable,
  createTestPool,
  runTestMigrations,
  truncateAll,
} from "./setup.js";
import { loadConfig } from "../src/config.js";
import { enforcementEnabled, effectiveLimits } from "../src/entitlements.js";
import {
  getWorkspaceEntitlements,
  upsertWorkspaceEntitlements,
  deleteWorkspaceEntitlements,
  type WorkspaceEntitlementsRow,
} from "../src/repo.js";

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

// ---------------------------------------------------------------------------
// Pure units — no Postgres needed
// ---------------------------------------------------------------------------

const DEFAULTS: EntitlementLimitsT = {
  seatsLimit: 4,
  reposLimit: 5,
  retentionDays: 30,
};

const NOW = new Date("2026-07-09T12:00:00.000Z");

/** A live (unexpired) row shape for the pure effectiveLimits cases. */
function row(
  overrides: Partial<WorkspaceEntitlementsRow> = {},
): WorkspaceEntitlementsRow {
  return {
    seats_limit: 50,
    repos_limit: 60,
    retention_days: 365,
    expires_at: null,
    updated_at: NOW,
    ...overrides,
  };
}

describe("effectiveLimits — pure (no Postgres needed)", () => {
  it("a live record with an expiry in the future wins over the defaults", () => {
    const future = new Date(NOW.getTime() + 60_000);
    expect(effectiveLimits(row({ expires_at: future }), DEFAULTS, NOW)).toEqual(
      {
        seatsLimit: 50,
        reposLimit: 60,
        retentionDays: 365,
      },
    );
  });

  it("an end-less record (expires_at null) wins over the defaults", () => {
    expect(effectiveLimits(row(), DEFAULTS, NOW)).toEqual({
      seatsLimit: 50,
      reposLimit: 60,
      retentionDays: 365,
    });
  });

  it("an EXPIRED record is ignored — the defaults apply", () => {
    const past = new Date(NOW.getTime() - 60_000);
    expect(effectiveLimits(row({ expires_at: past }), DEFAULTS, NOW)).toEqual(
      DEFAULTS,
    );
  });

  it("no record at all — the defaults apply", () => {
    expect(effectiveLimits(null, DEFAULTS, NOW)).toEqual(DEFAULTS);
  });

  it("a null cap in a live record means unlimited for that dimension", () => {
    const limits = effectiveLimits(
      row({ seats_limit: null, retention_days: null }),
      DEFAULTS,
      NOW,
    );
    expect(limits.seatsLimit).toBeNull();
    expect(limits.reposLimit).toBe(60);
    expect(limits.retentionDays).toBeNull();
  });
});

describe("enforcementEnabled — pure (no Postgres needed)", () => {
  const BASE_ENV = {
    DATABASE_URL: "postgres://localhost/test",
    TEAM_TOKEN: "tok-abc",
    ALLOWED_WORKSPACE: "acme",
  };

  it("is true exactly when ENTITLEMENTS_DEFAULT_LIMITS is set", () => {
    const on = loadConfig({
      ...BASE_ENV,
      ENTITLEMENTS_DEFAULT_LIMITS:
        '{"seatsLimit":4,"reposLimit":5,"retentionDays":30}',
    });
    expect(enforcementEnabled(on)).toBe(true);
  });

  it("is false when the env var is unset (every check no-ops)", () => {
    expect(enforcementEnabled(loadConfig(BASE_ENV))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Repo helpers — DB-gated
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)("workspace entitlements repo helpers", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
  });

  afterEach(async () => {
    await truncateAll(pool);
    await pool.query(`DELETE FROM workspaces WHERE slug LIKE 'ent-%'`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("getWorkspaceEntitlements returns null when no row exists", async () => {
    const workspaceId = await seedWorkspace(pool, "ent-helper-none");
    expect(await getWorkspaceEntitlements(pool, workspaceId)).toBeNull();
  });

  it("upsert inserts, round-trips, then updates in place bumping updated_at", async () => {
    const workspaceId = await seedWorkspace(pool, "ent-helper-upsert");

    const inserted = await upsertWorkspaceEntitlements(pool, workspaceId, {
      seatsLimit: 4,
      reposLimit: 5,
      retentionDays: 30,
      expiresAt: null,
    });
    expect(inserted.seats_limit).toBe(4);
    expect(inserted.repos_limit).toBe(5);
    expect(inserted.retention_days).toBe(30);
    expect(inserted.expires_at).toBeNull();

    const fetched = await getWorkspaceEntitlements(pool, workspaceId);
    expect(fetched).not.toBeNull();
    expect(fetched!.seats_limit).toBe(4);

    const expiresAt = new Date("2026-08-01T00:00:00.000Z");
    const updated = await upsertWorkspaceEntitlements(pool, workspaceId, {
      seatsLimit: 50,
      reposLimit: null,
      retentionDays: 365,
      expiresAt,
    });
    expect(updated.seats_limit).toBe(50);
    expect(updated.repos_limit).toBeNull();
    expect(updated.retention_days).toBe(365);
    expect(updated.expires_at?.toISOString()).toBe(expiresAt.toISOString());
    expect(updated.updated_at.getTime()).toBeGreaterThanOrEqual(
      inserted.updated_at.getTime(),
    );

    // Still exactly one row (ON CONFLICT updated in place).
    const { rows } = await pool.query(
      `SELECT count(*) AS count FROM workspace_entitlements WHERE workspace_id = $1`,
      [workspaceId],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  it("deleteWorkspaceEntitlements deletes once, then reports false (idempotent)", async () => {
    const workspaceId = await seedWorkspace(pool, "ent-helper-del");

    await upsertWorkspaceEntitlements(pool, workspaceId, {
      seatsLimit: null,
      reposLimit: null,
      retentionDays: null,
      expiresAt: null,
    });
    expect(await deleteWorkspaceEntitlements(pool, workspaceId)).toBe(true);
    expect(await deleteWorkspaceEntitlements(pool, workspaceId)).toBe(false);
    expect(await getWorkspaceEntitlements(pool, workspaceId)).toBeNull();
  });
});
