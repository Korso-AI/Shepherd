/**
 * RLS coverage meta-test — the "forgot about RLS" tripwire.
 *
 * Audits pg_catalog after migrations: every application table must have RLS
 * ENABLED + FORCED, at least one policy, and EXACTLY the app-role grants in
 * GRANTS_BY_TABLE — least privilege is enforced in both directions (a missing
 * verb fails here or in the app-role suite; an extra verb fails here). The app
 * role is PER-DATABASE, named `<database>_app` (see 021_rls.sql).
 * schema_migrations is the one exception: SELECT-only for the app role (boot's
 * assertMigrationsCurrent reads it on the serving pool) and no RLS — the
 * migration runner alone writes it.
 *
 * Adding a table? The failure message below prints the exact SQL your new
 * migration must include. See docs/rls.md for the add-a-table checklist.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type pg from "pg";
import type { DbContext } from "../src/scopedDb.js";
import { dbAvailable, createTestPool, runTestMigrations } from "./setup.js";

/**
 * The verbs the serving code actually issues per table (repo.ts is the ground
 * truth; 021_rls.sql grants exactly this map). A table absent from this map
 * fails the audit with instructions — decide its verbs deliberately, never
 * default to all four. Grants deliberately withheld: invites DELETE (workspace
 * deletion rides the FK cascade, which runs as the table owner), feedback
 * UPDATE/DELETE (detach is the FK's ON DELETE SET NULL; src never updates or
 * deletes feedback), and UPDATE on the insert-and-delete lifecycle tables
 * (agents, announcements, announcement_deliveries).
 */
const GRANTS_BY_TABLE: Record<string, readonly string[]> = {
  agents: ["SELECT", "INSERT", "DELETE"],
  sessions: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  work_items: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  announcements: ["SELECT", "INSERT", "DELETE"],
  announcement_deliveries: ["SELECT", "INSERT", "DELETE"],
  change_records: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  workspaces: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  memberships: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  api_tokens: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  invites: ["SELECT", "INSERT", "UPDATE"],
  account_profiles: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  feedback: ["SELECT", "INSERT"],
  workspace_entitlements: ["SELECT", "INSERT", "UPDATE", "DELETE"],
};

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

  it("every app table has RLS enabled+forced, >=1 policy, and exactly its mapped grants", async () => {
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
      const expected = GRANTS_BY_TABLE[t.relname];
      if (expected === undefined) {
        problems.push(
          `Table "${t.relname}" has no entry in GRANTS_BY_TABLE (this file). Decide which\n` +
            `verbs the serving code issues on it, add the entry, and grant EXACTLY those\n` +
            `verbs in your migration:\n` +
            `  GRANT <verbs> ON ${t.relname} TO ${appRole};`,
        );
        continue;
      }
      const { rows: grants } = await pool.query(
        `SELECT privilege_type FROM information_schema.role_table_grants
         WHERE grantee = $2 AND table_schema = 'public' AND table_name = $1`,
        [t.relname, appRole],
      );
      const have = new Set(grants.map((g) => g.privilege_type));
      for (const g of expected) {
        if (!have.has(g)) {
          problems.push(
            `Table "${t.relname}" missing grant. Your migration must include:\n` +
              `  GRANT ${g} ON ${t.relname} TO ${appRole};`,
          );
        }
      }
      for (const g of have) {
        if (!expected.includes(g)) {
          problems.push(
            `Table "${t.relname}" carries an EXTRA grant (${g}) beyond GRANTS_BY_TABLE —\n` +
              `either the serving code now needs it (update the map + this comment's\n` +
              `rationale) or revoke it: REVOKE ${g} ON ${t.relname} FROM ${appRole};`,
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

  it("every sequence in public carries USAGE for the app role", async () => {
    // 021's `GRANT USAGE ON ALL SEQUENCES` covered only the sequences existing
    // when it ran. A later serial/identity table would pass the table audit yet
    // fail app-role inserts with "permission denied for sequence" — this trips
    // first, with the remediation for the new migration.
    const { rows: seqs } = await pool.query<{ relname: string }>(`
      SELECT c.relname
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'S'
      ORDER BY c.relname
    `);
    expect(seqs.length).toBeGreaterThanOrEqual(1);
    const problems: string[] = [];
    for (const s of seqs) {
      const { rows } = await pool.query<{ ok: boolean }>(
        `SELECT has_sequence_privilege($1, $2::regclass, 'USAGE') AS ok`,
        [appRole, `public.${s.relname}`],
      );
      if (!rows[0]!.ok) {
        problems.push(
          `Sequence "${s.relname}" lacks USAGE. Your migration must include:\n` +
            `  GRANT USAGE ON SEQUENCE ${s.relname} TO ${appRole};`,
        );
      }
    }
    expect(problems, problems.join("\n\n")).toEqual([]);
  });

  it("the app role exists, cannot log in, cannot bypass RLS, cannot CREATE in public", async () => {
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
    // The schema-backdoor pin: PG15 fresh databases already deny PUBLIC CREATE,
    // and 021 revokes it on upgraded/restored ones — either way the app role
    // must not be able to create persistent objects in public.
    const { rows: create } = await pool.query<{ ok: boolean }>(
      `SELECT has_schema_privilege($1, 'public', 'CREATE') AS ok`,
      [appRole],
    );
    expect(create[0]!.ok).toBe(false);
  });

  it("policy context literals exactly cover the DbContext union", async () => {
    // Meta-pin: every `app_context() = '<kind>'` literal in any policy must be
    // a real DbContext kind, and every kind must appear in at least one policy
    // — a typo'd kind in SQL, or a kind with no policy at all, fails here.
    // KINDS is TYPE-LINKED to the union: adding a seventh kind to DbContext
    // without extending this record is a compile error, not a stale pass.
    const KIND_RECORD: Record<DbContext["kind"], true> = {
      workspace: true,
      account: true,
      auth: true,
      internal: true,
      operator: true,
      maintenance: true,
    };
    const KINDS = Object.keys(KIND_RECORD);
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
