/**
 * Disposable-Postgres test harness for @shepherd/hub.
 *
 * Usage in test files:
 *
 *   import { dbAvailable, createTestPool, runTestMigrations, truncateAll } from './setup.js';
 *
 *   describe.skipIf(!dbAvailable)('my suite', () => {
 *     let pool: pg.Pool;
 *     beforeAll(async () => { pool = createTestPool(); await runTestMigrations(pool); });
 *     afterEach(async () => truncateAll(pool));
 *     afterAll(async () => pool.end());
 *   });
 *
 * Connection resolution:
 *   1. TEST_DATABASE_URL   (preferred — a throwaway DB)
 *   2. DATABASE_URL        (fallback — share the dev DB; tests still truncate)
 *
 * When neither is set, `dbAvailable` is false and DB-dependent suites skip
 * with a clear message.  Pure unit tests (config.test.ts etc.) run regardless.
 */

import pg from "pg";
import { runMigrations } from "../src/migrate.js";

/** Connection string for test Postgres, or undefined if none configured. */
export const TEST_DATABASE_URL: string | undefined =
  process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"];

/**
 * True when a Postgres connection string is available.
 * Use with `describe.skipIf(!dbAvailable)` to gate DB-dependent suites.
 */
export const dbAvailable: boolean = TEST_DATABASE_URL !== undefined;

if (!dbAvailable) {
  console.warn(
    "[test/setup] No TEST_DATABASE_URL or DATABASE_URL set — " +
      "DB-dependent tests will be skipped.",
  );
}

/** Create a pool pointed at the test database. Throws if no URL is available. */
export function createTestPool(): pg.Pool {
  if (!TEST_DATABASE_URL) {
    throw new Error(
      "Cannot create test pool: neither TEST_DATABASE_URL nor DATABASE_URL is set.",
    );
  }
  return new pg.Pool({ connectionString: TEST_DATABASE_URL });
}

/** Run migrations against the test pool (idempotent). */
export async function runTestMigrations(pool: pg.Pool): Promise<void> {
  await runMigrations(pool);
}

/**
 * Two-helper split (since migration 011 introduced multi-tenancy).
 *
 * `truncateAll` clears the coordination tables (the rows a typical test
 * produces) but deliberately LEAVES the tenancy tables — most importantly the
 * `workspaces` row(s) — intact. Coordination tables now carry
 * `workspace_id uuid NOT NULL REFERENCES workspaces(id)`, so a per-test
 * truncate of `workspaces` would either fail the FK or force every suite to
 * re-seed a workspace in `beforeEach`. Keeping the workspace stable across
 * `afterEach` is both faster and FK-correct.
 *
 * `truncateTenancy` is the heavier reset for the tenancy/isolation suites that
 * exercise workspaces, memberships, tokens, invites, and account profiles.
 * Those suites own the tenancy state and clear it explicitly.
 *
 * SEED REQUIREMENT: because `truncateAll` never creates a workspace, any
 * coordination-only suite must seed a `workspaces` row in `beforeAll` (e.g.
 * `INSERT INTO workspaces (slug, name, created_by) VALUES ('test', 'Test', 'tester')
 * RETURNING id`) and use that id as the `workspace_id` for the agents/sessions/
 * work_items/announcements/change_records rows it inserts. Seed once in
 * `beforeAll` (not `beforeEach`) — `truncateAll` leaves it in place.
 */

/**
 * Truncate the coordination tables and reset identity sequences between tests.
 * Order respects FK constraints (children before parents):
 *   announcement_deliveries → announcements,
 *   work_items / change_records → sessions → agents.
 * `change_records` carries `workspace_id` and an `agent_id` FK into `agents`, so
 * it must be cleared alongside the other agent children. The tenancy tables
 * (workspaces, memberships, api_tokens, invites, account_profiles) are left
 * intact — see the seed requirement above and use `truncateTenancy` to reset
 * them.
 */
export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      announcement_deliveries,
      announcements,
      work_items,
      change_records,
      sessions,
      agents,
      feedback
    RESTART IDENTITY CASCADE
  `);
}

/**
 * Truncate the identity / tenancy tables for suites that exercise them.
 * Order respects FK constraints (children before parents):
 *   invites / api_tokens / memberships → workspaces (all three FK into it),
 *   account_profiles is independent.
 * CASCADE additionally clears any coordination rows still pointing at the
 * dropped workspaces, so call `truncateAll` first if you want a clean failure
 * surface; on its own this leaves the database empty of both tenancy and
 * coordination data.
 */
export async function truncateTenancy(pool: pg.Pool): Promise<void> {
  await pool.query(`
    TRUNCATE TABLE
      invites,
      api_tokens,
      memberships,
      workspaces,
      account_profiles
    RESTART IDENTITY CASCADE
  `);
}
