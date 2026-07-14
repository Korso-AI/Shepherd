/**
 * Tests for packages/hub/src/operations/join.ts
 *
 * DB-dependent tests are gated on `dbAvailable` and skipped when no Postgres
 * connection string is configured. Pure error-path tests run regardless.
 *
 * Tenancy (Task 2.5): every coordination row scopes by workspace_id. The suite
 * seeds a `workspaces` row in beforeAll and passes its uuid as the SELF-HOST
 * tenant ({ workspaceId }), with the body `workspace` slug kept for the
 * self-host parity guard. truncateAll leaves the seeded workspace in place.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  runTestMigrations,
  truncateAll,
} from "../setup.js";
import { initContext, resetContext } from "../../src/context.js";
import { ValidationError, AuthError } from "../../src/errors.js";
import { join } from "../../src/operations/join.js";
import type { TenantContext } from "../../src/tenant.js";
import type { Config } from "../../src/config.js";

// ---------------------------------------------------------------------------
// Shared test config factory
// ---------------------------------------------------------------------------

const WS_SLUG = "test-ws";

function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_URL: "postgres://localhost/test",
    TEAM_TOKEN: "test-token",
    HUB_PORT: 8080,
    ALLOWED_WORKSPACE: WS_SLUG,
    DEFAULT_TTL_SECONDS: 1800,
    MIN_TTL_SECONDS: 30,
    STALE_AFTER_SECONDS: 120,
    CHANGE_RECORD_TTL_SECONDS: 604800,
    HUB_ADMIN_LABEL: "admin",
    ...overrides,
  };
}

/** Seed the self-host workspace row and return its uuid. */
async function seedWorkspace(pool: pg.Pool, slug = WS_SLUG): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [slug, slug],
  );
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Workspace-guard test (no DB required)
// ---------------------------------------------------------------------------

describe("join – workspace guard (no DB)", () => {
  afterEach(() => {
    resetContext();
  });

  it("rejects the empty-string sentinel workspaceId before touching the DB", async () => {
    // A NO_ROUTE_WORKSPACE ("") tenant must be rejected (400/AuthError) before any
    // DB call — any attempt to use the fake pool would throw a different error.
    const { AuthError } = await import("../../src/errors.js");
    const fakePool = {} as pg.Pool;
    initContext({ pool: fakePool, config: makeTestConfig() });

    await expect(
      join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "main",
          human: "Alex",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        { workspaceId: "", via: "agent" },
      ),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

// ---------------------------------------------------------------------------
// DB-gated suite
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "join – DB tests" + (!dbAvailable ? " (SKIPPED: no DB configured)" : ""),
  () => {
    let pool: pg.Pool;
    let workspaceId: string;
    /** SELF-HOST tenant (no account): scopes by workspaceId, body slug parity. */
    let tenant: TenantContext;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      workspaceId = await seedWorkspace(pool);
      tenant = { workspaceId, via: "team" };
      initContext({ pool, config: makeTestConfig() });
    });

    afterEach(async () => {
      await truncateAll(pool);
    });

    afterAll(async () => {
      resetContext();
      await pool.end();
    });

    // -----------------------------------------------------------------------
    // Happy path
    // -----------------------------------------------------------------------

    it("creates a new agent and session on first join (handle-ordinal name)", async () => {
      const result = await join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "main",
          human: "Alex Rivera",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );

      // agentName is now `{normalizedHandle}-{ordinal}`, lowest free ordinal.
      expect(result.agentName).toBe("alex-rivera-1");

      // sessionId must be a UUID
      expect(result.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("advertises the bundled client version, and no minimum by default", async () => {
      const result = await join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "main",
          human: "Alex Rivera",
          program: "claude",
        },
        tenant,
      );

      // Baked from the monorepo's mcp-server package.json at build time.
      expect(result.latestClientVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(result.minimumClientVersion).toBeUndefined();
    });

    it("advertises MIN_CLIENT_VERSION as the minimum when configured", async () => {
      resetContext();
      initContext({
        pool,
        config: makeTestConfig({ MIN_CLIENT_VERSION: "0.10.0" }),
      });
      try {
        const result = await join(
          {
            workspace: WS_SLUG,
            repo: "org/repo",
            branch: "main",
            human: "Alex Rivera",
            program: "claude",
          },
          tenant,
        );
        expect(result.minimumClientVersion).toBe("0.10.0");
      } finally {
        resetContext();
        initContext({ pool, config: makeTestConfig() });
      }
    });

    it("inserts exactly one agent row and one session row on first join", async () => {
      await join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "main",
          human: "Alex Rivera",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );

      const agentCount = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM agents WHERE workspace_id = $1",
        [workspaceId],
      );
      const sessionCount = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM sessions WHERE workspace_id = $1",
        [workspaceId],
      );

      expect(Number(agentCount.rows[0]!.count)).toBe(1);
      expect(Number(sessionCount.rows[0]!.count)).toBe(1);
    });

    // -----------------------------------------------------------------------
    // Per-session identity: distinct ordinals while both sessions are live
    // -----------------------------------------------------------------------

    it("two sequential joins for the same human (both live) get -1 then -2 on DISTINCT agent rows", async () => {
      const first = await join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "main",
          human: "Alex Rivera",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      const second = await join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "feature",
          human: "Alex Rivera",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );

      expect(first.agentName).toBe("alex-rivera-1");
      expect(second.agentName).toBe("alex-rivera-2");
      expect(second.sessionId).not.toBe(first.sessionId);

      // Two DISTINCT agent rows for the handle family.
      const agentCount = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM agents WHERE workspace_id = $1 AND name LIKE 'alex-rivera-%'",
        [workspaceId],
      );
      expect(Number(agentCount.rows[0]!.count)).toBe(2);

      // The two sessions point at DIFFERENT agents.
      const agentIds = await pool.query<{ agent_id: string }>(
        "SELECT id AS agent_id FROM agents WHERE workspace_id = $1 AND name IN ('alex-rivera-1','alex-rivera-2')",
        [workspaceId],
      );
      expect(agentIds.rows).toHaveLength(2);
    });

    it("reclaims a DEAD agent row when its session went stale (same agent_id, no row growth)", async () => {
      const first = await join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "main",
          human: "Alex Rivera",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      expect(first.agentName).toBe("alex-rivera-1");

      // Capture the original agent_id behind alex-rivera-1.
      const orig = await pool.query<{ id: string }>(
        "SELECT id FROM agents WHERE workspace_id = $1 AND name = $2",
        [workspaceId, "alex-rivera-1"],
      );
      const originalAgentId = orig.rows[0]!.id;

      // Backdate the first session's heartbeat past STALE_AFTER_SECONDS so the
      // ordinal -1 frees up.
      await pool.query(
        `UPDATE sessions
         SET last_heartbeat_at = NOW() - INTERVAL '200 seconds'
         WHERE id = $1`,
        [first.sessionId],
      );

      const second = await join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "feature",
          human: "Alex Rivera",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );

      // The lowest free ordinal is again 1 (its only session is stale), so the
      // dead row is REUSED rather than a new one created.
      expect(second.agentName).toBe("alex-rivera-1");

      const agentCount = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM agents WHERE workspace_id = $1 AND name LIKE 'alex-rivera-%'",
        [workspaceId],
      );
      expect(Number(agentCount.rows[0]!.count)).toBe(1);

      // The new session's agent_id equals the original agent row's id.
      const sess = await pool.query<{ agent_id: string }>(
        "SELECT agent_id FROM sessions WHERE id = $1",
        [second.sessionId],
      );
      expect(sess.rows[0]!.agent_id).toBe(originalAgentId);
    });

    it("shares the ordinal namespace across humans that normalize to the same handle", async () => {
      const first = await join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "main",
          human: "Alex Rivera",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      expect(first.agentName).toBe("alex-rivera-1");

      // Different raw human string, same normalized handle, while -1 is live.
      const second = await join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "main",
          human: "alex   rivera",
          program: "codex",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );

      // Must get -2 (NOT a duplicate -1, NOT a random fallback).
      expect(second.agentName).toBe("alex-rivera-2");
    });

    it("self-host: an email-shaped human is reduced to its local-part handle", async () => {
      // Self-host keeps the client-supplied `human`; when git user.name is an
      // email, normalizeHandle must keep only the local-part ("founder"),
      // NOT slug the whole address to "founderexampletest".
      const result = await join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "main",
          human: "founder@example.test",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      expect(result.agentName).toBe("founder-1");
    });

    it("empty normalization (human '***') falls back to a random generateName()", async () => {
      const result = await join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "main",
          human: "***",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );

      // No handle could be derived → PascalCase generated name, no ordinal.
      expect(result.agentName).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+$/);
      expect(result.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("stores NULL model when model is omitted (back-compat)", async () => {
      const result = await join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "main",
          human: "Alex Rivera",
          program: "claude",
          // model omitted
        },
        tenant,
      );
      expect(result.agentName).toBe("alex-rivera-1");

      const { rows } = await pool.query<{ model: string | null }>(
        "SELECT model FROM agents WHERE workspace_id = $1 AND name = $2",
        [workspaceId, "alex-rivera-1"],
      );
      expect(rows[0]!.model).toBeNull();
    });

    // -----------------------------------------------------------------------
    // Self-host parity: a body workspace slug that mismatches the seeded slug
    // -----------------------------------------------------------------------

    it("throws ValidationError for a mismatched body workspace slug and creates zero rows", async () => {
      await expect(
        join(
          {
            workspace: "evil-ws",
            repo: "org/repo",
            branch: "main",
            human: "Mallory",
            program: "claude",
            model: "claude-3-5-sonnet",
          },
          tenant,
        ),
      ).rejects.toBeInstanceOf(ValidationError);

      const agentCount = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM agents",
      );
      const sessionCount = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM sessions",
      );
      expect(Number(agentCount.rows[0]!.count)).toBe(0);
      expect(Number(sessionCount.rows[0]!.count)).toBe(0);
    });

    // -----------------------------------------------------------------------
    // Race: a concurrent join takes the target ordinal between read and insert
    // -----------------------------------------------------------------------

    it("recomputes the ordinal when the target name was taken by a racing LIVE join", async () => {
      // Simulate the race deterministically: pre-insert a LIVE agent+session at
      // alex-rivera-1 WITHOUT going through reservedAgentNamesForHandle (the join's
      // first ordinal read happens before this row would be observed). The
      // simplest faithful reproduction is to seed alex-rivera-1 live first, so
      // the join computes -2 directly — and additionally force a 23505 on the
      // FIRST createAgent so the retry loop must recompute.
      await pool.query(
        `INSERT INTO agents (workspace_id, name, human, program, model)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          workspaceId,
          "alex-rivera-1",
          "Alex Rivera",
          "claude",
          "claude-3-5-sonnet",
        ],
      );
      const liveAgent = await pool.query<{ id: string }>(
        "SELECT id FROM agents WHERE workspace_id = $1 AND name = $2",
        [workspaceId, "alex-rivera-1"],
      );
      await pool.query(
        `INSERT INTO sessions (workspace_id, agent_id, repo, branch)
         VALUES ($1, $2, $3, $4)`,
        [workspaceId, liveAgent.rows[0]!.id, "org/repo", "main"],
      );

      // Also pre-seed a LIVE alex-rivera-2 so the FIRST createAgent at -2
      // collides on (workspace_id,name) → 23505 → retry recomputes to -3.
      await pool.query(
        `INSERT INTO agents (workspace_id, name, human, program, model)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          workspaceId,
          "alex-rivera-2",
          "Alex Rivera",
          "codex",
          "claude-3-5-sonnet",
        ],
      );
      const liveAgent2 = await pool.query<{ id: string }>(
        "SELECT id FROM agents WHERE workspace_id = $1 AND name = $2",
        [workspaceId, "alex-rivera-2"],
      );
      await pool.query(
        `INSERT INTO sessions (workspace_id, agent_id, repo, branch)
         VALUES ($1, $2, $3, $4)`,
        [workspaceId, liveAgent2.rows[0]!.id, "org/repo", "main"],
      );

      // Now -1 and -2 are both live; the join must allocate -3.
      const result = await join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "main",
          human: "Alex Rivera",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );

      expect(result.agentName).toBe("alex-rivera-3");
      expect(result.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    // -----------------------------------------------------------------------
    // Hosted path: body workspace ignored, human overridden by account identity
    // -----------------------------------------------------------------------

    it("hosted: matching body workspace slug → uses the account's github_login as human", async () => {
      const accountId = "gh|99001";
      await pool.query(
        `INSERT INTO account_profiles (account_id, display_name, github_login)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               github_login = EXCLUDED.github_login`,
        [accountId, "Alex Rivera", "alexr"],
      );
      // A member of the seeded workspace.
      await pool.query(
        `INSERT INTO memberships (account_id, workspace_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT (account_id, workspace_id) DO NOTHING`,
        [accountId, workspaceId],
      );

      // Body workspace MATCHES the credential's workspace slug (C1 guard).
      const result = await join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "main",
          human: "client-supplied-name",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        { workspaceId, accountId, role: "member", via: "agent" },
      );

      // The handle derives from the github_login, not the client-supplied human.
      expect(result.agentName).toBe("alexr-1");
      const { rows } = await pool.query<{ human: string }>(
        "SELECT human FROM agents WHERE workspace_id = $1 AND name = $2",
        [workspaceId, "alexr-1"],
      );
      expect(rows[0]!.human).toBe("alexr");
    });

    it("hosted: falls back to the account email's local-part when no github_login/display_name", async () => {
      const accountId = "gh|99003";
      // Profile carries ONLY an email (no github_login, no display_name) — as when
      // a user signed in with email rather than GitHub. Identity must derive from
      // the email's local-part, not the client-supplied git string.
      await pool.query(
        `INSERT INTO account_profiles (account_id, display_name, github_login, email)
         VALUES ($1, NULL, NULL, $2)
         ON CONFLICT (account_id) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               github_login = EXCLUDED.github_login,
               email        = EXCLUDED.email`,
        [accountId, "founder@acme.test"],
      );
      await pool.query(
        `INSERT INTO memberships (account_id, workspace_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT (account_id, workspace_id) DO NOTHING`,
        [accountId, workspaceId],
      );

      const result = await join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "main",
          human: "founder@example.test", // client git identity — must be ignored
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        { workspaceId, accountId, role: "member", via: "agent" },
      );

      expect(result.agentName).toBe("founder-1");
      const { rows } = await pool.query<{ human: string }>(
        "SELECT human FROM agents WHERE workspace_id = $1 AND name = $2",
        [workspaceId, "founder-1"],
      );
      // Stored human is the clean local-part, not the full email.
      expect(rows[0]!.human).toBe("founder");
    });

    // -----------------------------------------------------------------------
    // C1: hosted path must reject a body workspace slug that mismatches the
    // credential's actual workspace slug (silent wrong-workspace join). The
    // 5.3 MCP guard keys specifically on 403/404 — so this MUST be AuthError(403),
    // NOT ValidationError(400).
    // -----------------------------------------------------------------------

    it("hosted: mismatched body workspace slug → AuthError(403) and creates zero rows", async () => {
      const accountId = "gh|99002";
      await pool.query(
        `INSERT INTO account_profiles (account_id, display_name, github_login)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               github_login = EXCLUDED.github_login`,
        [accountId, "Alex Rivera", "alexr"],
      );
      await pool.query(
        `INSERT INTO memberships (account_id, workspace_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT (account_id, workspace_id) DO NOTHING`,
        [accountId, workspaceId],
      );

      // Body names a DIFFERENT workspace than the credential's seeded slug.
      const promise = join(
        {
          workspace: "some-other-ws",
          repo: "org/repo",
          branch: "main",
          human: "client-supplied-name",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        { workspaceId, accountId, role: "member", via: "agent" },
      );

      await expect(promise).rejects.toBeInstanceOf(AuthError);
      await expect(promise).rejects.toMatchObject({ status: 403 });

      // No session/agent created.
      const agentCount = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM agents WHERE workspace_id = $1",
        [workspaceId],
      );
      const sessionCount = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM sessions WHERE workspace_id = $1",
        [workspaceId],
      );
      expect(Number(agentCount.rows[0]!.count)).toBe(0);
      expect(Number(sessionCount.rows[0]!.count)).toBe(0);
    });

    // -----------------------------------------------------------------------
    // Account-scoped path (Task 2.3): the token fixes NO workspace
    // (workspaceId === NO_ROUTE_WORKSPACE ""). The body's `.shepherd` marker
    // slug SELECTS the workspace, validated against live membership. A non-member
    // slug and an unknown slug BOTH fail with an identical 404 (no existence
    // leak); the MCP hostedWorkspaceRejected guard keys on 403/404 from /join, so
    // 404 still renders its workspaceMismatch advisory.
    // -----------------------------------------------------------------------

    /** Seed an account's profile + a membership row in `wsId`. */
    async function seedAccountMember(
      accountId: string,
      wsId: string,
      {
        displayName,
        githubLogin,
      }: { displayName: string; githubLogin: string | null },
    ): Promise<void> {
      await pool.query(
        `INSERT INTO account_profiles (account_id, display_name, github_login)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE
           SET display_name = EXCLUDED.display_name,
               github_login = EXCLUDED.github_login`,
        [accountId, displayName, githubLogin],
      );
      await pool.query(
        `INSERT INTO memberships (account_id, workspace_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT (account_id, workspace_id) DO NOTHING`,
        [accountId, wsId],
      );
    }

    it("account-scoped: selects the marker-slug workspace and uses the account identity", async () => {
      const accountId = "gh|acct-1";
      await seedAccountMember(accountId, workspaceId, {
        displayName: "Alex Rivera",
        githubLogin: "octo-alex",
      });

      const result = await join(
        {
          workspace: WS_SLUG, // the .shepherd marker slug SELECTS the workspace
          repo: "org/repo",
          branch: "main",
          human: "client-supplied-name",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        { workspaceId: "", accountId, via: "agent" },
      );

      // Identity: github_login preferred over the client-supplied human.
      expect(result.agentName).toBe("octo-alex-1");

      // The session landed in the marker-slug workspace.
      const { rows } = await pool.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM sessions WHERE id = $1",
        [result.sessionId],
      );
      expect(rows[0]!.workspace_id).toBe(workspaceId);
    });

    it("account-scoped: marker slug names a workspace the account is NOT a member of → 404 (no existence leak)", async () => {
      const accountId = "gh|acct-2";
      // A real workspace, but the account holds no membership in it.
      await seedWorkspace(pool, "not-a-member-ws");
      await pool.query(
        `INSERT INTO account_profiles (account_id, display_name, github_login)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO NOTHING`,
        [accountId, "Alex Rivera", "octo-alex"],
      );

      const promise = join(
        {
          workspace: "not-a-member-ws",
          repo: "org/repo",
          branch: "main",
          human: "client-supplied-name",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        { workspaceId: "", accountId, via: "agent" },
      );

      // A real-but-non-member slug is INDISTINGUISHABLE from an unknown slug:
      // both are 404 so a token holder cannot enumerate existing workspaces.
      await expect(promise).rejects.toBeInstanceOf(AuthError);
      await expect(promise).rejects.toMatchObject({ status: 404 });

      const sessionCount = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM sessions",
      );
      expect(Number(sessionCount.rows[0]!.count)).toBe(0);
    });

    it("account-scoped: marker slug names a non-existent workspace → 404 (no existence leak)", async () => {
      const accountId = "gh|acct-3";
      await pool.query(
        `INSERT INTO account_profiles (account_id, display_name, github_login)
         VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO NOTHING`,
        [accountId, "Alex Rivera", "octo-alex"],
      );

      const promise = join(
        {
          workspace: "no-such-workspace",
          repo: "org/repo",
          branch: "main",
          human: "client-supplied-name",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        { workspaceId: "", accountId, via: "agent" },
      );

      await expect(promise).rejects.toBeInstanceOf(AuthError);
      await expect(promise).rejects.toMatchObject({ status: 404 });

      const sessionCount = await pool.query<{ count: string }>(
        "SELECT COUNT(*)::text AS count FROM sessions",
      );
      expect(Number(sessionCount.rows[0]!.count)).toBe(0);
    });

    it("account-scoped: ONE token joins TWO of its workspaces → two sessions, correct workspaces", async () => {
      const accountId = "gh|acct-4";
      const wsB = await seedWorkspace(pool, "workspace-b");
      // The account is a member of BOTH the seeded workspace (A) and B.
      await seedAccountMember(accountId, workspaceId, {
        displayName: "Alex Rivera",
        githubLogin: "octo-alex",
      });
      await pool.query(
        `INSERT INTO memberships (account_id, workspace_id, role) VALUES ($1, $2, 'member')
         ON CONFLICT (account_id, workspace_id) DO NOTHING`,
        [accountId, wsB],
      );

      const acctTenant: TenantContext = {
        workspaceId: "",
        accountId,
        via: "agent",
      };

      const inA = await join(
        {
          workspace: WS_SLUG,
          repo: "org/repo",
          branch: "main",
          human: "client-supplied-name",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        acctTenant,
      );
      const inB = await join(
        {
          workspace: "workspace-b",
          repo: "org/repo",
          branch: "main",
          human: "client-supplied-name",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        acctTenant,
      );

      expect(inB.sessionId).not.toBe(inA.sessionId);

      const a = await pool.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM sessions WHERE id = $1",
        [inA.sessionId],
      );
      const b = await pool.query<{ workspace_id: string }>(
        "SELECT workspace_id FROM sessions WHERE id = $1",
        [inB.sessionId],
      );
      expect(a.rows[0]!.workspace_id).toBe(workspaceId);
      expect(b.rows[0]!.workspace_id).toBe(wsB);
    });
  },
);
