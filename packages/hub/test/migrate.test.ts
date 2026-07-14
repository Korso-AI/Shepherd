import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  createAppPool,
  runTestMigrations,
  truncateAll,
  TEST_DATABASE_URL,
} from "./setup.js";
import { runMigrations, assertMigrationsCurrent } from "../src/migrate.js";

/**
 * Seed (idempotently) a workspace and return its uuid. Coordination tables
 * carry `workspace_id uuid NOT NULL REFERENCES workspaces(id)` after migration
 * 011, so every INSERT below needs a real workspace to point at. `truncateAll`
 * leaves the tenancy tables intact, so a single seed per beforeAll survives the
 * afterEach truncation.
 */
async function seedWorkspace(pool: pg.Pool, slug = "acme"): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [slug, slug],
  );
  return rows[0]!.id;
}

describe.skipIf(!dbAvailable)("migrate — DB-dependent", () => {
  let pool: pg.Pool;
  let workspaceId: string;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
    workspaceId = await seedWorkspace(pool);
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    // truncateAll leaves tenancy rows; remove the workspace we seeded so its
    // slug ("acme") does not persist on the shared test DB and collide with
    // other suites that create a workspace by the same slug.
    await pool.query(`DELETE FROM workspaces WHERE slug = 'acme'`);
    await pool.end();
  });

  it("creates the schema_migrations table with a row for 001_init", async () => {
    const { rows } = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(rows.map((r) => r.version)).toContain("001_init");
  });

  it("creates all five domain tables", async () => {
    const { rows } = await pool.query<{ tablename: string }>(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN (
          'agents', 'sessions', 'work_items',
          'announcements', 'announcement_deliveries'
        )
      ORDER BY tablename
    `);
    const names = rows.map((r) => r.tablename);
    expect(names).toContain("agents");
    expect(names).toContain("sessions");
    expect(names).toContain("work_items");
    expect(names).toContain("announcements");
    expect(names).toContain("announcement_deliveries");
  });

  it("second runMigrations call is a no-op (idempotent)", async () => {
    // If it re-applied 001 it would fail on CREATE TABLE (no IF NOT EXISTS).
    await expect(runMigrations(pool)).resolves.not.toThrow();
  });

  it("creates the identity/tenancy tables (migration 011)", async () => {
    const { rows } = await pool.query<{ tablename: string }>(`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN (
          'account_profiles', 'workspaces', 'memberships', 'api_tokens', 'invites'
        )
      ORDER BY tablename
    `);
    const names = rows.map((r) => r.tablename);
    expect(names).toContain("account_profiles");
    expect(names).toContain("workspaces");
    expect(names).toContain("memberships");
    expect(names).toContain("api_tokens");
    expect(names).toContain("invites");
  });

  it("records the 011 migration as applied", async () => {
    const { rows } = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = '011_multitenancy'",
    );
    expect(rows).toHaveLength(1);
  });

  it("re-keys the coordination tables onto workspace_id (011 dropped the free-text workspace column)", async () => {
    for (const table of [
      "agents",
      "sessions",
      "work_items",
      "announcements",
      "change_records",
    ]) {
      const { rows } = await pool.query<{ column_name: string }>(
        `SELECT column_name
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1`,
        [table],
      );
      const cols = rows.map((r) => r.column_name);
      expect(cols).toContain("workspace_id");
      expect(cols).not.toContain("workspace");
    }
  });

  it("agents.workspace_id is a NOT NULL uuid FK into workspaces (011)", async () => {
    const { rows } = await pool.query<{
      data_type: string;
      is_nullable: string;
    }>(
      `SELECT data_type, is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'agents'
         AND column_name = 'workspace_id'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.data_type).toBe("uuid");
    expect(rows[0]!.is_nullable).toBe("NO");

    const { rows: fkRows } = await pool.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint
       WHERE conrelid = 'agents'::regclass
         AND contype = 'f'
         AND conname = 'agents_workspace_id_fkey'`,
    );
    expect(fkRows).toHaveLength(1);
  });

  it("INSERT into agents works and unique (workspace_id, name) rejects duplicate", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `
      INSERT INTO agents (workspace_id, name, human, program, model)
      VALUES ($1, 'agent-alpha', 'alice', 'my-prog', 'claude-3')
      RETURNING id
    `,
      [workspaceId],
    );
    expect(rows[0]).toHaveProperty("id");

    await expect(
      pool.query(
        `
        INSERT INTO agents (workspace_id, name, human, program, model)
        VALUES ($1, 'agent-alpha', 'bob', 'other-prog', 'gpt-4')
      `,
        [workspaceId],
      ),
    ).rejects.toThrow(); // unique constraint violation
  });

  it("INSERT into sessions referencing an agent works", async () => {
    const { rows: agentRows } = await pool.query<{ id: string }>(
      `
      INSERT INTO agents (workspace_id, name, human, program, model)
      VALUES ($1, 'agent-beta', 'alice', 'prog', 'claude-3')
      RETURNING id
    `,
      [workspaceId],
    );
    const agentId = agentRows[0]!.id;

    const { rows } = await pool.query<{ id: string }>(
      `
      INSERT INTO sessions (workspace_id, agent_id, repo, branch)
      VALUES ($1, $2, 'my-repo', 'main')
      RETURNING id
    `,
      [workspaceId, agentId],
    );
    expect(rows[0]).toHaveProperty("id");
  });

  it("INSERT into work_items works", async () => {
    const { rows: agentRows } = await pool.query<{ id: string }>(
      `
      INSERT INTO agents (workspace_id, name, human, program, model)
      VALUES ($1, 'agent-gamma', 'alice', 'prog', 'claude-3')
      RETURNING id
    `,
      [workspaceId],
    );
    const { rows: sessionRows } = await pool.query<{ id: string }>(
      `
      INSERT INTO sessions (workspace_id, agent_id, repo, branch)
      VALUES ($1, $2, 'my-repo', 'main')
      RETURNING id
    `,
      [workspaceId, agentRows[0]!.id],
    );
    const sessionId = sessionRows[0]!.id;

    const { rows } = await pool.query<{ id: string }>(
      `
      INSERT INTO work_items
        (workspace_id, session_id, repo, intent_text, path_globs, ttl_seconds, expires_at)
      VALUES
        ($1, $2, 'my-repo', 'fix bug', '{src/**/*.ts}', 300,
         now() + interval '5 minutes')
      RETURNING id
    `,
      [workspaceId, sessionId],
    );
    expect(rows[0]).toHaveProperty("id");
  });

  it("INSERT into announcements and deliveries works", async () => {
    const { rows: agentRows } = await pool.query<{ id: string }>(
      `
      INSERT INTO agents (workspace_id, name, human, program, model)
      VALUES ($1, 'agent-delta', 'alice', 'prog', 'claude-3')
      RETURNING id
    `,
      [workspaceId],
    );
    const { rows: sessionRows } = await pool.query<{ id: string }>(
      `
      INSERT INTO sessions (workspace_id, agent_id, repo, branch)
      VALUES ($1, $2, 'my-repo', 'main')
      RETURNING id
    `,
      [workspaceId, agentRows[0]!.id],
    );
    const sessionId = sessionRows[0]!.id;

    const { rows: annRows } = await pool.query<{ id: string }>(
      `
      INSERT INTO announcements (workspace_id, repo, from_session_id, body)
      VALUES ($1, 'my-repo', $2, 'hello world')
      RETURNING id
    `,
      [workspaceId, sessionId],
    );
    const announcementId = annRows[0]!.id;

    const { rows: delRows } = await pool.query<{ session_id: string }>(
      `
      INSERT INTO announcement_deliveries (session_id, announcement_id)
      VALUES ($1, $2)
      RETURNING session_id
    `,
      [sessionId, announcementId],
    );
    expect(delRows[0]).toHaveProperty("session_id", sessionId);
  });

  it("concurrent runMigrations calls serialise (advisory lock)", async () => {
    // Run two concurrent migration calls; neither should throw and together
    // they should leave exactly one schema_migrations row (idempotent).
    await expect(
      Promise.all([runMigrations(pool), runMigrations(pool)]),
    ).resolves.not.toThrow();

    const { rows } = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = '001_init'",
    );
    expect(rows).toHaveLength(1);
  });
});

describe.skipIf(!dbAvailable)("migrate 003 — identity + change_records", () => {
  let pool: pg.Pool;
  let workspaceId: string;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
    workspaceId = await seedWorkspace(pool);
  });

  afterEach(async () => {
    // truncateAll (setup.ts) does not know about change_records; clean it up
    // ourselves before the shared truncate frees the agents it references.
    await pool.query("TRUNCATE TABLE change_records RESTART IDENTITY CASCADE");
    await truncateAll(pool);
  });

  afterAll(async () => {
    // truncateAll leaves tenancy rows; remove the workspace we seeded so its
    // slug ("acme") does not persist on the shared test DB and collide with
    // other suites that create a workspace by the same slug.
    await pool.query(`DELETE FROM workspaces WHERE slug = 'acme'`);
    await pool.end();
  });

  it("records the 003 migration as applied", async () => {
    const { rows } = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = '003_identity_and_change_records'",
    );
    expect(rows).toHaveLength(1);
  });

  it("creates the change_records table with all expected columns", async () => {
    const { rows } = await pool.query<{ column_name: string }>(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'change_records'
      ORDER BY column_name
    `);
    const cols = rows.map((r) => r.column_name);
    // Post-011: the free-text `workspace` column was re-keyed to `workspace_id`.
    for (const c of [
      "id",
      "workspace_id",
      "repo",
      "agent_id",
      "agent_name",
      "branch",
      "kind",
      "commit_sha",
      "message",
      "path_globs",
      "updated_at",
    ]) {
      expect(cols).toContain(c);
    }
    expect(cols).not.toContain("workspace");
  });

  it("creates both expected indexes on change_records (re-keyed onto workspace_id by 011)", async () => {
    const { rows } = await pool.query<{ indexdef: string }>(`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'change_records'
    `);
    const defs = rows.map((r) => r.indexdef);
    // (workspace_id, repo, agent_id)
    expect(
      defs.some((d) => /\(workspace_id,\s*repo,\s*agent_id\)/.test(d)),
    ).toBe(true);
    // (workspace_id, repo, updated_at)
    expect(
      defs.some((d) => /\(workspace_id,\s*repo,\s*updated_at\)/.test(d)),
    ).toBe(true);
  });

  it("the kind CHECK rejects an out-of-set value", async () => {
    const { rows: agentRows } = await pool.query<{ id: string }>(
      `
      INSERT INTO agents (workspace_id, name, human, program, model)
      VALUES ($1, 'agent-cr-1', 'alice', 'prog', 'claude-3')
      RETURNING id
    `,
      [workspaceId],
    );
    const agentId = agentRows[0]!.id;

    await expect(
      pool.query(
        `
        INSERT INTO change_records
          (workspace_id, repo, agent_id, agent_name, branch, kind, path_globs)
        VALUES ($1, 'my-repo', $2, 'agent-cr-1', 'main', 'bogus', '{src/**}')
        `,
        [workspaceId, agentId],
      ),
    ).rejects.toThrow();
  });

  it("accepts a valid change_records row", async () => {
    const { rows: agentRows } = await pool.query<{ id: string }>(
      `
      INSERT INTO agents (workspace_id, name, human, program, model)
      VALUES ($1, 'agent-cr-2', 'alice', 'prog', 'claude-3')
      RETURNING id
    `,
      [workspaceId],
    );
    const agentId = agentRows[0]!.id;

    const { rows } = await pool.query<{ id: string }>(
      `
      INSERT INTO change_records
        (workspace_id, repo, agent_id, agent_name, branch, kind, commit_sha, message, path_globs)
      VALUES ($1, 'my-repo', $2, 'agent-cr-2', 'main', 'committed', 'deadbeef', 'did a thing', '{src/**}')
      RETURNING id
      `,
      [workspaceId, agentId],
    );
    expect(rows[0]).toHaveProperty("id");
  });

  it("agents.model accepts NULL", async () => {
    const { rows } = await pool.query<{ id: string }>(
      `
      INSERT INTO agents (workspace_id, name, human, program, model)
      VALUES ($1, 'agent-null-model', 'alice', 'prog', NULL)
      RETURNING id
    `,
      [workspaceId],
    );
    expect(rows[0]).toHaveProperty("id");
  });

  it("drops the old identity-tuple unique constraint", async () => {
    const { rows } = await pool.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE conname = 'agents_workspace_human_program_model_key'
    `);
    expect(rows).toHaveLength(0);
  });

  it("keeps the agent-name unique constraint intact (re-keyed to (workspace_id, name) by 011)", async () => {
    // 011 dropped agents_workspace_name_key and recreated it as
    // agents_workspace_id_name_key UNIQUE (workspace_id, name).
    const { rows } = await pool.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE conname = 'agents_workspace_id_name_key'
    `);
    expect(rows).toHaveLength(1);

    const { rows: gone } = await pool.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE conname = 'agents_workspace_name_key'
    `);
    expect(gone).toHaveLength(0);
  });

  it("second runMigrations call is a no-op (003 idempotent)", async () => {
    const pool2 = createTestPool();
    try {
      await expect(runMigrations(pool2)).resolves.not.toThrow();
    } finally {
      await pool2.end();
    }
  });

  // ---- migration 004: index + constraint hardening -------------------------

  it("records the 004 migration as applied", async () => {
    const { rows } = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = '004_indexes_and_constraints'",
    );
    expect(rows).toHaveLength(1);
  });

  it("creates the text_pattern_ops prefix index on agents (PERF-4)", async () => {
    const { rows } = await pool.query<{ indexdef: string }>(`
      SELECT indexdef
      FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'agents'
    `);
    expect(rows.some((r) => /text_pattern_ops/.test(r.indexdef))).toBe(true);
  });

  it("the path_globs non-empty CHECK rejects an empty array (MIG-L1)", async () => {
    const { rows: agentRows } = await pool.query<{ id: string }>(
      `
      INSERT INTO agents (workspace_id, name, human, program, model)
      VALUES ($1, 'agent-cr-empty', 'alice', 'prog', 'claude-3')
      RETURNING id
    `,
      [workspaceId],
    );
    const agentId = agentRows[0]!.id;

    await expect(
      pool.query(
        `
        INSERT INTO change_records
          (workspace_id, repo, agent_id, agent_name, branch, kind, path_globs)
        VALUES ($1, 'my-repo', $2, 'agent-cr-empty', 'main', 'committed', '{}')
        `,
        [workspaceId, agentId],
      ),
    ).rejects.toThrow();
  });

  it("declares the change_records.agent_id FK as ON DELETE CASCADE (MIG-M1)", async () => {
    const { rows } = await pool.query<{ confdeltype: string }>(`
      SELECT confdeltype
      FROM pg_constraint
      WHERE conname = 'change_records_agent_id_fkey'
    `);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.confdeltype).toBe("c"); // 'c' = CASCADE
  });
});

describe.skipIf(!dbAvailable)("migrate 012 — tenancy indexes", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("records the 012 migration as applied", async () => {
    const { rows } = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = '012_tenancy_indexes'",
    );
    expect(rows).toHaveLength(1);
  });

  it("creates the workspace-scoped sessions index (P2.1)", async () => {
    const { rows } = await pool.query<{ indexdef: string }>(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'sessions'
    `);
    const defs = rows.map((r) => r.indexdef);
    expect(
      defs.some((d) => /\(workspace_id,\s*repo,\s*last_heartbeat_at\)/.test(d)),
    ).toBe(true);
  });

  it("creates the memberships(workspace_id) index (P2.2)", async () => {
    const { rows } = await pool.query<{ indexdef: string }>(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'memberships'
    `);
    expect(rows.some((r) => /\(workspace_id\)/.test(r.indexdef))).toBe(true);
  });

  it("creates the api_tokens(workspace_id, account_id) index (P2.3)", async () => {
    const { rows } = await pool.query<{ indexdef: string }>(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'api_tokens'
    `);
    expect(
      rows.some((r) => /\(workspace_id,\s*account_id\)/.test(r.indexdef)),
    ).toBe(true);
  });
});

describe.skipIf(!dbAvailable)("migrate 015 — account-scoped tokens", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("records the 015 migration as applied", async () => {
    const { rows } = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = '015_account_scoped_tokens'",
    );
    expect(rows).toHaveLength(1);
  });

  it("api_tokens.workspace_id is now nullable (account-scoped tokens)", async () => {
    const { rows } = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'api_tokens'
         AND column_name = 'workspace_id'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_nullable).toBe("YES");
  });
});

describe.skipIf(!dbAvailable)("migrate 021 — row-level security", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("records the 021 migration as applied", async () => {
    const { rows } = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = '021_rls'",
    );
    expect(rows).toHaveLength(1);
  });

  it("enables + forces RLS on a representative table (agents)", async () => {
    // The full enabled/forced/policy/grant audit lives in rls.coverage.test.ts;
    // this is the per-migration smoke that 021 actually ran the RLS DDL.
    const { rows } = await pool.query<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>(
      `SELECT relrowsecurity, relforcerowsecurity
       FROM pg_class WHERE oid = 'agents'::regclass`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.relrowsecurity).toBe(true);
    expect(rows[0]!.relforcerowsecurity).toBe(true);
  });
});

describe.skipIf(!dbAvailable)(
  "assertMigrationsCurrent — split-database boot guard",
  () => {
    // Owner pool runs the migrations and mutates schema_migrations; the app-role
    // pool models the SERVING connection in a two-role deployment.
    let pool: pg.Pool;
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

    it("passes on the database the migrations ran against", async () => {
      await expect(assertMigrationsCurrent(pool)).resolves.toBeUndefined();
    });

    it("passes on the restricted app-role serving pool (two-role deployment)", async () => {
      // In a split-role deployment boot runs assertMigrationsCurrent on the
      // SERVING pool, which connects as the app role. schema_migrations carries a
      // SELECT grant (RLS stays OFF on it) precisely so this read succeeds.
      await expect(assertMigrationsCurrent(appPool)).resolves.toBeUndefined();
    });

    it("fails loudly when the serving database is missing a migration", async () => {
      // Simulate the split-database boot (migrations landed elsewhere) by
      // removing the newest recorded version, then restore it.
      const { rows } = await pool.query<{ version: string }>(
        "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
      );
      const newest = rows[0]!.version;
      await pool.query("DELETE FROM schema_migrations WHERE version = $1", [
        newest,
      ]);
      try {
        await expect(assertMigrationsCurrent(pool)).rejects.toThrow(
          new RegExp(`missing applied migrations: .*${newest}`),
        );
      } finally {
        await pool.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [newest],
        );
      }
    });
  },
);

describe.skipIf(!dbAvailable)(
  "migrate 021 — app-role provisioning edge cases",
  () => {
    // These pins need DATABASES with specific pre-conditions, so each test
    // provisions (and drops) a throwaway database derived from the per-agent
    // base test DB name — no collision with sibling agents' runs. The owner
    // pool is a superuser, so CREATE/DROP DATABASE and CREATE ROLE work.
    let admin: pg.Pool;
    let baseDb: string;

    /** Quote an identifier (") — names here include multibyte characters. */
    const q = (s: string): string => `"${s.replaceAll(`"`, `""`)}"`;

    /** Pool onto `database` reusing the base URL's host/credentials. */
    function poolFor(database: string): pg.Pool {
      const url = new URL(TEST_DATABASE_URL!);
      return new pg.Pool({
        host: url.hostname,
        port: url.port ? Number(url.port) : 5432,
        user: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
        database,
      });
    }

    beforeAll(async () => {
      admin = createTestPool();
      const { rows } = await admin.query<{ db: string }>(
        `SELECT current_database() AS db`,
      );
      baseDb = rows[0]!.db;
    });

    afterAll(async () => admin.end());

    it(
      "refuses a pre-existing app role with unsafe attributes",
      { timeout: 30_000 },
      async () => {
        // Roles are cluster-level: a LOGIN role squatting on the derived name
        // must never silently receive the app grants.
        const db = `${baseDb}_dup`;
        const role = `${db}_app`;
        await admin.query(`DROP DATABASE IF EXISTS ${q(db)}`);
        await admin.query(`DROP ROLE IF EXISTS ${q(role)}`);
        await admin.query(`CREATE ROLE ${q(role)} LOGIN PASSWORD 'squatter'`);
        await admin.query(`CREATE DATABASE ${q(db)}`);
        const target = poolFor(db);
        try {
          await expect(runMigrations(target)).rejects.toThrow(
            /unsafe attributes \(LOGIN\)/,
          );
        } finally {
          await target.end();
          await admin.query(`DROP DATABASE IF EXISTS ${q(db)}`);
          await admin.query(`DROP ROLE IF EXISTS ${q(role)}`);
        }
      },
    );

    it(
      "adopts a pre-existing SAFE (NOLOGIN) app role and grants it",
      { timeout: 30_000 },
      async () => {
        // The legitimate duplicate: a recreated same-name database (the role
        // survives a DROP DATABASE) or a dump restored beside its old role.
        const db = `${baseDb}_re`;
        const role = `${db}_app`;
        await admin.query(`DROP DATABASE IF EXISTS ${q(db)}`);
        await admin.query(`DROP ROLE IF EXISTS ${q(role)}`);
        await admin.query(`CREATE ROLE ${q(role)} NOLOGIN`);
        await admin.query(`CREATE DATABASE ${q(db)}`);
        const target = poolFor(db);
        try {
          await expect(runMigrations(target)).resolves.not.toThrow();
          const { rows } = await target.query<{ privilege_type: string }>(
            `SELECT privilege_type FROM information_schema.role_table_grants
             WHERE grantee = $1 AND table_name = 'sessions'`,
            [role],
          );
          expect(rows.map((r) => r.privilege_type).sort()).toEqual([
            "DELETE",
            "INSERT",
            "SELECT",
            "UPDATE",
          ]);
        } finally {
          await target.end();
          await admin.query(`DROP DATABASE IF EXISTS ${q(db)}`);
          await admin.query(`DROP ROLE IF EXISTS ${q(role)}`);
        }
      },
    );

    it(
      "rejects a database whose derived role name exceeds 63 BYTES (not characters)",
      { timeout: 30_000 },
      async () => {
        // Identifiers truncate at 63 BYTES. Pad the base name with 3-byte
        // katakana so the database name itself fits (<= 63 bytes) and its
        // CHARACTER count stays far under 63 (a per-character check would
        // pass), while `<db>_app` overflows in bytes — Postgres would truncate
        // the role name and the grant block's exact lookup would miss it, so
        // the migration must refuse up front.
        const pad = Math.floor((63 - Buffer.byteLength(baseDb)) / 3);
        expect(pad).toBeGreaterThan(0);
        const db = baseDb + "ア".repeat(pad);
        await admin.query(`DROP DATABASE IF EXISTS ${q(db)}`);
        await admin.query(`CREATE DATABASE ${q(db)}`);
        const target = poolFor(db);
        try {
          await expect(runMigrations(target)).rejects.toThrow(/too long/);
        } finally {
          await target.end();
          await admin.query(`DROP DATABASE IF EXISTS ${q(db)}`);
        }
      },
    );
  },
);

describe("migrate — pure (no Postgres needed)", () => {
  it("dbAvailable flag is a boolean", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });
});
