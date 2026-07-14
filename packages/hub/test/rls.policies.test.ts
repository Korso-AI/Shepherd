/**
 * Per-context RLS policy pins (Task 9) — the behavioral contract of
 * migration 021, exercised as the restricted app role.
 *
 * rls.coverage.test.ts audits the CATALOG (every table enabled+forced, grants
 * shaped right); the Task 8 sweep proves the app's real code paths stay green
 * under the policies. This suite pins the policy SEMANTICS directly, one
 * context at a time, with raw SQL on `withContext` transactions:
 *
 *   - missing context fails LOUDLY (app_context() RAISEs), never empty-result;
 *   - schema_migrations is read-only to the app role (boot's
 *     assertMigrationsCurrent needs the SELECT; the migration runner is the
 *     sole writer);
 *   - account context sees only its own memberships until a workspace is
 *     FOCUSED, and can never insert a membership for another account (the
 *     invite-redemption pin);
 *   - invite access is CODE-scoped: no capability, no rows (invites carry
 *     invitee emails — enumeration is the attack this closes);
 *   - account_profiles in workspace context are own-row OR current-member
 *     rows only;
 *   - feedback reads are pinned to the submitter's workspace/account (the
 *     arms exist for INSERT...RETURNING, not a browse surface);
 *   - internal context reaches only the GUC-named workspace's entitlements;
 *   - operator context reads across tenants but its writes fail: DELETE is
 *     silently filtered to 0 rows (grant present, no policy), INSERT throws
 *     (WITH CHECK violation).
 *
 * Fixtures are seeded on the OWNER pool (superuser — RLS-exempt by design);
 * every probe runs on the app pool. World: workspaces A and B; acct1 admin of
 * A, acct2 member of BOTH, acct3 member of B only; one invite, one
 * entitlements row, one agent+session per workspace; one feedback row each.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  createAppPool,
  runTestMigrations,
  truncateAll,
  truncateTenancy,
} from "./setup.js";
import { withContext } from "../src/scopedDb.js";
import { createAgent, createSession } from "../src/repo.js";

const ACCT_1 = "rls-acct-1"; // admin of wsA only
const ACCT_2 = "rls-acct-2"; // member of BOTH workspaces
const ACCT_3 = "rls-acct-3"; // member of wsB only
const CODE_A = "rls-code-a";
const CODE_B = "rls-code-b";

describe.skipIf(!dbAvailable)("RLS contexts (policy pins, Task 9)", () => {
  let pool: pg.Pool;
  let appPool: pg.Pool;
  let wsA: string;
  let wsB: string;

  async function seedWorkspace(slug: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $1, 'tester')
       RETURNING id`,
      [slug],
    );
    return rows[0]!.id;
  }

  /** Mint one agent + session in `workspaceId` (owner pool — fixture only). */
  async function mintSession(workspaceId: string, human: string) {
    await withContext(pool, { kind: "workspace", workspaceId }, async (tx) => {
      const agent = await createAgent(tx, {
        workspaceId,
        name: `rls-agent-${human}`,
        human,
        program: "claude",
        model: null,
      });
      await createSession(tx, {
        workspaceId,
        agentId: agent.id,
        repo: "org/repo",
        branch: "main",
      });
    });
  }

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
    appPool = createAppPool();
    await truncateAll(pool);
    await truncateTenancy(pool);

    wsA = await seedWorkspace("rls-pol-a");
    wsB = await seedWorkspace("rls-pol-b");
    for (const acct of [ACCT_1, ACCT_2, ACCT_3]) {
      await pool.query(
        `INSERT INTO account_profiles (account_id, display_name, github_login)
         VALUES ($1, $1, $1)`,
        [acct],
      );
    }
    await pool.query(
      `INSERT INTO memberships (account_id, workspace_id, role) VALUES
         ($1, $4, 'admin'), ($2, $4, 'member'), ($2, $5, 'member'), ($3, $5, 'member')`,
      [ACCT_1, ACCT_2, ACCT_3, wsA, wsB],
    );
    await pool.query(
      `INSERT INTO invites (workspace_id, code, role_granted, created_by, max_uses)
       VALUES ($1, $3, 'member', $5, 5), ($2, $4, 'member', $6, 5)`,
      [wsA, wsB, CODE_A, CODE_B, ACCT_1, ACCT_3],
    );
    await pool.query(
      `INSERT INTO workspace_entitlements (workspace_id, seats_limit) VALUES ($1, 5), ($2, 5)`,
      [wsA, wsB],
    );
    await mintSession(wsA, "alice");
    await mintSession(wsB, "bob");
    await pool.query(
      `INSERT INTO feedback (workspace_id, account_id, type, body) VALUES
         ($1, $3, 'bug', 'feedback-in-a'), ($2, $4, 'bug', 'feedback-in-b')`,
      [wsA, wsB, ACCT_1, ACCT_3],
    );
  });

  afterAll(async () => {
    await truncateAll(pool);
    await truncateTenancy(pool);
    await appPool.end();
    await pool.end();
  });

  it("no context at all fails LOUDLY, not with empty results", async () => {
    const client = await appPool.connect();
    try {
      await expect(client.query(`SELECT * FROM agents`)).rejects.toThrow(
        /app\.context is not set/,
      );
    } finally {
      client.release();
    }
  });

  it("schema_migrations: app role can SELECT (boot assertion) but never write", async () => {
    // No RLS on schema_migrations, so even a context-less read works — the
    // wall here is the SELECT-only GRANT, not a policy.
    const { rows } = await appPool.query<{ version: string }>(
      `SELECT version FROM schema_migrations`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(21);
    expect(rows.some((r) => /^021/.test(r.version))).toBe(true);

    await expect(
      appPool.query(`INSERT INTO schema_migrations (version) VALUES ('999_x')`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      appPool.query(`UPDATE schema_migrations SET applied_at = now()`),
    ).rejects.toThrow(/permission denied/);
    await expect(
      appPool.query(`DELETE FROM schema_migrations`),
    ).rejects.toThrow(/permission denied/);
  });

  it("account context sees only its own memberships until a workspace is focused", async () => {
    // Unfocused: acct2 belongs to both workspaces and sees exactly its own two
    // rows — nobody else's, in either workspace.
    await withContext(
      appPool,
      { kind: "account", accountId: ACCT_2 },
      async (db) => {
        const { rows } = await db.query<{ account_id: string }>(
          `SELECT account_id FROM memberships`,
        );
        expect(rows.length).toBe(2);
        expect(rows.every((r) => r.account_id === ACCT_2)).toBe(true);
      },
    );
    // Focused on wsA: the FULL roster of the focused workspace opens up (the
    // sanctioned seat-count/roster surface) — and only that workspace's.
    await withContext(
      appPool,
      { kind: "account", accountId: ACCT_1, workspaceId: wsA },
      async (db) => {
        const { rows } = await db.query<{
          account_id: string;
          workspace_id: string;
        }>(`SELECT account_id, workspace_id FROM memberships`);
        const rosterA = rows.filter((r) => r.workspace_id === wsA);
        expect(rosterA.map((r) => r.account_id).sort()).toEqual([
          ACCT_1,
          ACCT_2,
        ]);
        // Focus on A never reveals B's roster beyond the caller's own rows.
        expect(
          rows
            .filter((r) => r.workspace_id === wsB)
            .every((r) => r.account_id === ACCT_1),
        ).toBe(true);
      },
    );
  });

  it("account context cannot insert a membership for another account (redemption pin)", async () => {
    await expect(
      withContext(
        appPool,
        { kind: "account", accountId: ACCT_1, workspaceId: wsA },
        (db) =>
          db.query(
            `INSERT INTO memberships (account_id, workspace_id, role)
             VALUES ($1, $2, 'member')`,
            [ACCT_3, wsA],
          ),
      ),
    ).rejects.toThrow(/row-level security/);
    // Owner pool: acct3 is still not a member of wsA.
    const { rows } = await pool.query(
      `SELECT 1 FROM memberships WHERE account_id = $1 AND workspace_id = $2`,
      [ACCT_3, wsA],
    );
    expect(rows.length).toBe(0);
  });

  it("invite access is CODE-scoped: no capability GUC, no rows", async () => {
    // Plain account context (no invite code): invites carry invitee emails, so
    // the policy fails CLOSED to zero rows — enumeration is impossible.
    await withContext(
      appPool,
      { kind: "account", accountId: ACCT_1 },
      async (db) => {
        const { rows } = await db.query(`SELECT code FROM invites`);
        expect(rows).toEqual([]);
      },
    );
    // With the code in context (a cross-workspace redemption: acct1 proves
    // possession of wsB's code): EXACTLY the matching invite, nothing else.
    await withContext(
      appPool,
      { kind: "account", accountId: ACCT_1, inviteCode: CODE_B },
      async (db) => {
        const { rows } = await db.query<{ code: string }>(
          `SELECT code FROM invites`,
        );
        expect(rows).toEqual([{ code: CODE_B }]);
      },
    );
  });

  it("account_profiles in workspace context: own row OR current members only", async () => {
    // Workspace context for A sees exactly A's roster profiles — acct3 (a
    // member of B only) stays invisible.
    await withContext(
      appPool,
      { kind: "workspace", workspaceId: wsA },
      async (db) => {
        const { rows } = await db.query<{ account_id: string }>(
          `SELECT account_id FROM account_profiles`,
        );
        expect(rows.map((r) => r.account_id).sort()).toEqual([ACCT_1, ACCT_2]);
      },
    );
    // The own-row disjunct: with acct3's account in a wsA-workspace context,
    // its OWN profile becomes readable alongside the roster.
    await withContext(
      appPool,
      { kind: "workspace", workspaceId: wsA, accountId: ACCT_3 },
      async (db) => {
        const { rows } = await db.query<{ account_id: string }>(
          `SELECT account_id FROM account_profiles`,
        );
        expect(rows.map((r) => r.account_id).sort()).toEqual([
          ACCT_1,
          ACCT_2,
          ACCT_3,
        ]);
      },
    );
  });

  it("feedback reads are pinned to the submitter's workspace/account", async () => {
    // Workspace context A (the INSERT...RETURNING back-read shape): A's rows
    // only — B's feedback from another account never crosses.
    await withContext(
      appPool,
      { kind: "workspace", workspaceId: wsA, accountId: ACCT_1 },
      async (db) => {
        const { rows } = await db.query<{ body: string }>(
          `SELECT body FROM feedback`,
        );
        expect(rows).toEqual([{ body: "feedback-in-a" }]);
      },
    );
    // Account context: own-account rows only.
    await withContext(
      appPool,
      { kind: "account", accountId: ACCT_1 },
      async (db) => {
        const { rows } = await db.query<{ body: string }>(
          `SELECT body FROM feedback`,
        );
        expect(rows).toEqual([{ body: "feedback-in-a" }]);
      },
    );
  });

  it("internal context reaches only the GUC-named workspace's entitlements", async () => {
    await withContext(
      appPool,
      { kind: "internal", workspaceId: wsA },
      async (db) => {
        const { rows } = await db.query<{ workspace_id: string }>(
          `SELECT workspace_id FROM workspace_entitlements`,
        );
        expect(rows.length).toBe(1);
        expect(rows.every((r) => r.workspace_id === wsA)).toBe(true);
      },
    );
  });

  it("operator context reads across workspaces but cannot write", async () => {
    await withContext(appPool, { kind: "operator" }, async (db) => {
      const { rows } = await db.query<{ workspace_id: string }>(
        `SELECT DISTINCT workspace_id FROM sessions`,
      );
      expect(rows.length).toBeGreaterThanOrEqual(2);
      // The role holds the DELETE grant but NO operator DELETE policy exists:
      // Postgres does NOT raise — RLS silently filters every row out of the
      // delete's scope (DELETE 0). Assert the count, then row survival below.
      const { rowCount } = await db.query(`DELETE FROM sessions`);
      expect(rowCount).toBe(0);
      // An operator INSERT, by contrast, DOES throw (WITH CHECK violation):
      await expect(
        db.query(
          `INSERT INTO feedback (workspace_id, type, body) VALUES (NULL, 'other', 'x')`,
        ),
      ).rejects.toThrow(/row-level security/);
    });
    // Owner pool (bypasses RLS): every seeded session survived the DELETE.
    const { rows } = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM sessions`,
    );
    expect(rows[0]!.n).toBeGreaterThanOrEqual(2);
  });
});
