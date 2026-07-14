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

/**
 * Test-only LOGIN member of the per-database app group role
 * (`<database>_app`, created by migration 021). The disposable test pool
 * normally connects as `postgres` (a SUPERUSER, which BYPASSES RLS), so the
 * policies migration 021 installs would stay dormant. `createAppPool` connects
 * as this restricted role instead, so every swept suite exercises the policies.
 *
 * Test-cluster only: the credentials are fixed and unprivileged (the role is a
 * plain LOGIN that owns nothing and inherits only the group's granted DML).
 */
const APP_LOGIN_ROLE = "shepherd_app_login";
const APP_LOGIN_PASSWORD = "shepherd_app_test";

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

/**
 * Create a pool pointed at the test database as its OWNER (the superuser in the
 * connection URL). Use this for migrations, fixture INSERTs, `truncateAll`/
 * `truncateTenancy`, and raw-SQL assertions of DB state — a superuser bypasses
 * RLS, and TRUNCATE requires the owner regardless. Code UNDER TEST should run
 * through `createAppPool` so it exercises the policies. Throws if no URL.
 */
export function createTestPool(): pg.Pool {
  if (!TEST_DATABASE_URL) {
    throw new Error(
      "Cannot create test pool: neither TEST_DATABASE_URL nor DATABASE_URL is set.",
    );
  }
  return new pg.Pool({ connectionString: TEST_DATABASE_URL });
}

/**
 * Create a pool that connects as the restricted app LOGIN role
 * (`APP_LOGIN_ROLE`), a member of the per-database `<database>_app` group. This
 * role is NOT a superuser, so RLS (migration 021) is ENFORCED against it — wire
 * the code under test (`initContext({ pool })`, direct `resolveTenant`/
 * `withContext` calls) to this pool so the suite proves the policies. Fixtures,
 * truncates, and raw asserts stay on `createTestPool` (owner). Throws if no URL.
 *
 * Reuses the same TEST_DATABASE_URL with the username/password swapped, so the
 * connection targets the SAME database (and therefore the same `<database>_app`
 * group) as the owner pool. Call `runTestMigrations(ownerPool)` first — it
 * provisions the login role.
 */
export function createAppPool(): pg.Pool {
  if (!TEST_DATABASE_URL) {
    throw new Error(
      "Cannot create app pool: neither TEST_DATABASE_URL nor DATABASE_URL is set.",
    );
  }
  const url = new URL(TEST_DATABASE_URL);
  url.username = APP_LOGIN_ROLE;
  url.password = APP_LOGIN_PASSWORD;
  return new pg.Pool({ connectionString: url.toString() });
}

/**
 * Idempotently provision the LOGIN member of the per-database app role
 * (`<database>_app`, created by migration 021) that `createAppPool` connects
 * as. The login role itself is CLUSTER-global (shared across the per-agent test
 * databases; it accumulates one group membership per test DB — harmless), so
 * tolerate concurrent creation/GRANT races from teammate-run suites on sibling
 * databases: `duplicate_object` on CREATE is swallowed inside the DO block, and
 * a GRANT that collides on the shared `pg_auth_members` row surfaces as
 * "tuple concurrently updated" — retry that once.
 */
export async function provisionAppRole(ownerPool: pg.Pool): Promise<void> {
  const sql = `
    DO $$
    DECLARE app_role text := current_database() || '_app';
    BEGIN
      BEGIN
        CREATE ROLE ${APP_LOGIN_ROLE} LOGIN PASSWORD '${APP_LOGIN_PASSWORD}';
      EXCEPTION WHEN duplicate_object THEN NULL;
      END;
      EXECUTE format('GRANT %I TO ${APP_LOGIN_ROLE}', app_role);
    END $$;
  `;
  try {
    await ownerPool.query(sql);
  } catch (err) {
    // Cross-database concurrent GRANTs touch the same global pg_auth_members
    // tuple for the shared login role; Postgres reports XX000 "tuple
    // concurrently updated". Retry once — the second attempt serialises behind
    // the first now-committed writer.
    if (
      err instanceof Error &&
      /tuple concurrently updated/.test(err.message)
    ) {
      await ownerPool.query(sql);
    } else {
      throw err;
    }
  }
}

/**
 * Run migrations against the OWNER test pool (idempotent), then provision the
 * restricted app login role so `createAppPool` can connect. Callers pass the
 * owner pool from `createTestPool`.
 */
export async function runTestMigrations(pool: pg.Pool): Promise<void> {
  await runMigrations(pool);
  await provisionAppRole(pool);
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
