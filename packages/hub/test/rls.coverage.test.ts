/**
 * RLS coverage meta-test — the "forgot about RLS" tripwire.
 *
 * Audits pg_catalog after migrations: every application table must have RLS
 * ENABLED + FORCED, at least one policy, and the expected app-role grants.
 * The app role is PER-DATABASE, named `<database>_app` (see 021_rls.sql).
 * schema_migrations is the one exception: SELECT-only for the app role (boot's
 * assertMigrationsCurrent reads it on the serving pool) and no RLS — the
 * migration runner alone writes it.
 *
 * Adding a table? The failure message below prints the exact SQL your new
 * migration must include. See docs/rls.md for the add-a-table checklist.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import { dbAvailable, createTestPool, runTestMigrations } from "./setup.js";

const EXPECTED_GRANTS = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

describe.skipIf(!dbAvailable)("RLS coverage", () => {
  let pool: pg.Pool;
  let appRole: string; // `<database>_app` — matches 021_rls.sql's derivation
  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
    const { rows } = await pool.query(`SELECT current_database() AS db`);
    appRole = `${rows[0].db}_app`;
  });
  afterAll(async () => pool.end());

  it("every app table has RLS enabled+forced, >=1 policy, and app-role grants", async () => {
    const { rows: tables } = await pool.query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      policies: string;
    }>(`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS policies
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r'
        AND c.relname <> 'schema_migrations'
      ORDER BY c.relname
    `);
    expect(tables.length).toBeGreaterThanOrEqual(13);

    const problems: string[] = [];
    for (const t of tables) {
      if (
        !t.relrowsecurity ||
        !t.relforcerowsecurity ||
        Number(t.policies) < 1
      ) {
        problems.push(
          `Table "${t.relname}" is not RLS-covered. Your migration must include:\n` +
            `  ALTER TABLE ${t.relname} ENABLE ROW LEVEL SECURITY;\n` +
            `  ALTER TABLE ${t.relname} FORCE ROW LEVEL SECURITY;\n` +
            `  CREATE POLICY ${t.relname}_workspace ON ${t.relname} FOR ALL\n` +
            `    USING (app_context() = 'workspace' AND workspace_id = app_workspace_id())\n` +
            `    WITH CHECK (app_context() = 'workspace' AND workspace_id = app_workspace_id());\n` +
            `(adjust the policy to the table's actual scoping — see docs/rls.md)`,
        );
      }
      const { rows: grants } = await pool.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = $2 AND table_schema = 'public' AND table_name = $1`,
        [t.relname, appRole],
      );
      const have = new Set(grants.map((g) => g.privilege_type));
      for (const g of EXPECTED_GRANTS) {
        if (!have.has(g)) {
          problems.push(
            `Table "${t.relname}" missing grant. Your migration must include:\n` +
              `  GRANT ${g} ON ${t.relname} TO ${appRole};`,
          );
        }
      }
    }
    expect(problems, problems.join("\n\n")).toEqual([]);
  });

  it("schema_migrations: app role may SELECT (boot assertion) but never write", async () => {
    const { rows } = await pool.query(
      `SELECT privilege_type FROM information_schema.role_table_grants
       WHERE grantee = $1 AND table_name = 'schema_migrations'`,
      [appRole],
    );
    expect(rows.map((r) => r.privilege_type).sort()).toEqual(["SELECT"]);
  });

  it("the app role exists, cannot log in, and cannot bypass RLS", async () => {
    const { rows } = await pool.query(
      `SELECT rolcanlogin, rolbypassrls, rolsuper, rolcreaterole, rolcreatedb
       FROM pg_roles WHERE rolname = $1`,
      [appRole],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      rolcanlogin: false,
      rolbypassrls: false,
      rolsuper: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
  });

  it("policy context literals exactly cover the DbContext union", async () => {
    // Meta-pin: every `app_context() = '<kind>'` literal in any policy must be
    // a real DbContext kind, and every kind must appear in at least one policy
    // — a typo'd kind in SQL, or a kind with no policy at all, fails here.
    const KINDS = [
      "workspace",
      "account",
      "auth",
      "internal",
      "operator",
      "maintenance",
    ];
    const { rows } = await pool.query<{ def: string }>(
      `SELECT coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
              coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') AS def
       FROM pg_policy p`,
    );
    const used = new Set<string>();
    for (const r of rows) {
      for (const m of r.def.matchAll(/app_context\(\)\s*=\s*'([a-z_]+)'/g)) {
        used.add(m[1]!);
      }
    }
    expect([...used].sort()).toEqual([...KINDS].sort());
  });
});
