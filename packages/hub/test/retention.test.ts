/**
 * Tests for the entitlements-window announcement retention prune:
 *   repo.pruneAnnouncements (bounded delete, deliveries first — the FK has no
 *   CASCADE) driven by retention.maybePruneRetention (lazy, hourly-throttled
 *   per workspace, inert without ENTITLEMENTS_DEFAULT_LIMITS).
 *
 * Pure data-layer suite: the driver is exercised directly inside a
 * transaction the way work/sync/heartbeat call it — no HTTP server needed.
 * Fixture window numbers follow entitlementLimits.test.ts (30-day default,
 * 365-day override).
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  createAppPool,
  runTestMigrations,
  truncateAll,
} from "./setup.js";
import { withContext } from "../src/scopedDb.js";
import {
  maybePruneRetention,
  __resetRetentionThrottle,
} from "../src/retention.js";
import { ANNOUNCEMENT_PRUNE_BATCH_LIMIT } from "../src/repo.js";
import type { Config } from "../src/config.js";

const DEFAULT_LIMITS = { seatsLimit: 4, reposLimit: 5, retentionDays: 30 };

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_URL: "postgres://localhost/test",
    TEAM_TOKEN: "secret-test-token",
    HUB_PORT: 8080,
    ALLOWED_WORKSPACE: "test-ws",
    DEFAULT_TTL_SECONDS: 1800,
    MIN_TTL_SECONDS: 30,
    STALE_AFTER_SECONDS: 120,
    CHANGE_RECORD_TTL_SECONDS: 604800,
    HUB_ADMIN_LABEL: "admin",
    ENTITLEMENTS_DEFAULT_LIMITS: DEFAULT_LIMITS,
    ...overrides,
  };
}

describe.skipIf(!dbAvailable)("announcement retention prune (DB-gated)", () => {
  let pool: pg.Pool;
  let appPool: pg.Pool;
  let workspaceId: string;
  let sessionId: string;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
    // The prune under test runs as the restricted app-role login so the
    // workspace-context RLS policies on announcements/deliveries are exercised.
    appPool = createAppPool();
  });

  /** Seed workspace + agent + session fresh for each test (truncateAll clears them). */
  async function seedSession(): Promise<void> {
    const { rows: ws } = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (slug, name, created_by) VALUES ('ret-ws', 'ret-ws', 'tester')
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    );
    workspaceId = ws[0]!.id;
    const { rows: agents } = await pool.query<{ id: string }>(
      `INSERT INTO agents (workspace_id, name, human, program, model)
         VALUES ($1, 'ret-agent', 'alice', 'prog', 'model') RETURNING id`,
      [workspaceId],
    );
    const { rows: sessions } = await pool.query<{ id: string }>(
      `INSERT INTO sessions (workspace_id, agent_id, repo, branch)
         VALUES ($1, $2, 'ret-repo', 'main') RETURNING id`,
      [workspaceId, agents[0]!.id],
    );
    sessionId = sessions[0]!.id;
  }

  /** Insert an announcement `ageDays` old (+ a delivery row); returns its id. */
  async function seedAnnouncement(
    ageDays: number,
    withDelivery = true,
  ): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO announcements (workspace_id, repo, from_session_id, body, created_at)
         VALUES ($1, 'ret-repo', $2, 'hello', now() - ($3 * interval '1 day'))
         RETURNING id`,
      [workspaceId, sessionId, ageDays],
    );
    const id = rows[0]!.id;
    if (withDelivery) {
      await pool.query(
        `INSERT INTO announcement_deliveries (session_id, announcement_id)
           VALUES ($1, $2)`,
        [sessionId, id],
      );
    }
    return id;
  }

  async function runPrune(config: Config, now = new Date()): Promise<void> {
    await withContext(
      appPool,
      { kind: "workspace", workspaceId },
      async (tx) => {
        await maybePruneRetention(tx, config, workspaceId, now);
      },
    );
  }

  async function remainingIds(): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM announcements WHERE workspace_id = $1 ORDER BY id`,
      [workspaceId],
    );
    return rows.map((r) => r.id);
  }

  async function deliveryCount(): Promise<number> {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM announcement_deliveries`,
    );
    return Number(rows[0]!.count);
  }

  afterEach(async () => {
    __resetRetentionThrottle();
    await truncateAll(pool);
    await pool.query(`DELETE FROM workspaces WHERE slug = 'ret-ws'`);
  });

  afterAll(async () => {
    await appPool.end();
    await pool.end();
  });

  it("prunes past the 30-day default window (with delivery rows), keeps fresh rows", async () => {
    await seedSession();
    const stale = await seedAnnouncement(40);
    const fresh = await seedAnnouncement(1);

    await runPrune(makeConfig());

    const left = await remainingIds();
    expect(left).toContain(fresh);
    expect(left).not.toContain(stale);
    // Only the fresh announcement's delivery row survives.
    expect(await deliveryCount()).toBe(1);
  });

  it("a live entitlements row with retention_days = 365 keeps both", async () => {
    await seedSession();
    await pool.query(
      `INSERT INTO workspace_entitlements (workspace_id, retention_days) VALUES ($1, 365)`,
      [workspaceId],
    );
    await seedAnnouncement(40);
    await seedAnnouncement(1);

    await runPrune(makeConfig());
    expect(await remainingIds()).toHaveLength(2);
  });

  it("a null retention cap in a live row means never prune", async () => {
    await seedSession();
    await pool.query(
      `INSERT INTO workspace_entitlements (workspace_id, retention_days) VALUES ($1, NULL)`,
      [workspaceId],
    );
    await seedAnnouncement(400);

    await runPrune(makeConfig());
    expect(await remainingIds()).toHaveLength(1);
  });

  it("an EXPIRED entitlements row falls back to the default window", async () => {
    await seedSession();
    await pool.query(
      `INSERT INTO workspace_entitlements (workspace_id, retention_days, expires_at)
         VALUES ($1, 365, now() - interval '1 day')`,
      [workspaceId],
    );
    const stale = await seedAnnouncement(40);
    const fresh = await seedAnnouncement(1);

    await runPrune(makeConfig());

    const left = await remainingIds();
    expect(left).toContain(fresh);
    expect(left).not.toContain(stale);
  });

  it("never prunes with ENTITLEMENTS_DEFAULT_LIMITS unset", async () => {
    await seedSession();
    await seedAnnouncement(400);

    await runPrune(makeConfig({ ENTITLEMENTS_DEFAULT_LIMITS: undefined }));
    expect(await remainingIds()).toHaveLength(1);
  });

  it("throttles to once per workspace per hour; __resetRetentionThrottle re-arms it", async () => {
    await seedSession();
    await seedAnnouncement(40);

    await runPrune(makeConfig());
    expect(await remainingIds()).toHaveLength(0);

    // A second stale row within the hour is NOT pruned (throttled skip).
    await seedAnnouncement(50);
    await runPrune(makeConfig());
    expect(await remainingIds()).toHaveLength(1);

    // After a reset (standing in for the hour lapsing) it prunes again.
    __resetRetentionThrottle();
    await runPrune(makeConfig());
    expect(await remainingIds()).toHaveLength(0);
  });

  it("one pass deletes at most the batch bound; the rest drains later", async () => {
    await seedSession();
    const surplus = 20;
    const total = ANNOUNCEMENT_PRUNE_BATCH_LIMIT + surplus;
    // Bulk-seed stale announcements (no deliveries — bulk keeps this fast).
    await pool.query(
      `INSERT INTO announcements (workspace_id, repo, from_session_id, body, created_at)
           SELECT $1, 'ret-repo', $2, 'bulk', now() - interval '40 days'
           FROM generate_series(1, $3)`,
      [workspaceId, sessionId, total],
    );

    await runPrune(makeConfig());
    expect(await remainingIds()).toHaveLength(surplus);

    // The hourly throttle owns the drain cadence; once it re-arms, the
    // next pass finishes the backlog.
    __resetRetentionThrottle();
    await runPrune(makeConfig());
    expect(await remainingIds()).toHaveLength(0);
  }, 20000);
});
