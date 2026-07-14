/**
 * Tests for DELETE /workspaces/:id (delete a workspace) and the framework-error
 * hardening that fixed the bodyless-POST 500 on /workspaces/:id/leave.
 *
 * DELETE /workspaces/:id is admin-only and permanent: resolveTenant validates the
 * browser caller's membership of `:id` and sets `tenant.role`; deleteWorkspace
 * gates on requireAdmin (ANY admin, regardless of member count) and wipes every
 * workspace-scoped row in one transaction (deleteWorkspaceCascade). Of the tables
 * referencing workspaces(id), only memberships + invites cascade and feedback is
 * SET NULL, so the six no-cascade tables (agents, sessions, work_items,
 * announcements, change_records, api_tokens) are deleted explicitly — this suite
 * seeds one row in each and proves they are all gone (feedback survives, detached).
 *
 * Setup mirrors members.test.ts: a real pool, the onRequest hook hits the DB, and
 * we seed tenancy + coordination rows by hand. truncateAll + truncateTenancy reset
 * between tests; the rate limiter is reset in afterEach.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  createAppPool,
  runTestMigrations,
  truncateAll,
  truncateTenancy,
} from "./setup.js";
import { initContext, resetContext } from "../src/context.js";
import { buildServer } from "../src/server.js";
import { __resetRateLimiter, hashToken } from "../src/tenant.js";
import type { Config } from "../src/config.js";
import type { FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// Config / credentials
// ---------------------------------------------------------------------------

const TEST_TOKEN = "secret-test-token";
const ALLOWED_WS = "test-ws";
const INTERNAL_TOKEN = "internal-bff-secret";

function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_URL: "postgres://localhost/test",
    TEAM_TOKEN: TEST_TOKEN,
    HUB_PORT: 8080,
    ALLOWED_WORKSPACE: ALLOWED_WS,
    BFF_INTERNAL_TOKEN: INTERNAL_TOKEN,
    DEFAULT_TTL_SECONDS: 1800,
    MIN_TTL_SECONDS: 30,
    STALE_AFTER_SECONDS: 120,
    CHANGE_RECORD_TTL_SECONDS: 604800,
    HUB_ADMIN_LABEL: "admin",
    ...overrides,
  };
}

/** BFF headers for a BODYLESS request (DELETE); no content-type (see leave note). */
function bffAuthHeaders(accountId: string, extra: Record<string, string> = {}) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "x-account-id": accountId,
    ...extra,
  };
}

/** Seed a workspace by slug (idempotent); returns its uuid. */
async function seedWorkspace(pool: pg.Pool, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [slug, slug],
  );
  return rows[0]!.id;
}

/** Seed a membership for (accountId, workspaceId) at `role` (idempotent). */
async function seedMembership(
  pool: pg.Pool,
  accountId: string,
  workspaceId: string,
  role: "admin" | "member" = "member",
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (account_id, workspace_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (account_id, workspace_id) DO UPDATE SET role = EXCLUDED.role`,
    [accountId, workspaceId, role],
  );
}

/**
 * Seed one row in every workspace-scoped table so a delete has something to
 * cascade through: an agent → session → work_item / announcement (+delivery) /
 * change_record, plus an api_token, an invite, and a feedback row. Returns the
 * feedback id so a test can assert it survives (detached) after the delete.
 */
async function seedFullWorkspaceData(
  pool: pg.Pool,
  workspaceId: string,
  accountId: string,
): Promise<{ feedbackId: string }> {
  const { rows: agentRows } = await pool.query<{ id: string }>(
    `INSERT INTO agents (workspace_id, name, human, program, model)
     VALUES ($1, 'agent-1', 'Human', 'claude', 'opus') RETURNING id`,
    [workspaceId],
  );
  const agentId = agentRows[0]!.id;

  const { rows: sessionRows } = await pool.query<{ id: string }>(
    `INSERT INTO sessions (workspace_id, agent_id, repo, branch)
     VALUES ($1, $2, 'acme/repo', 'main') RETURNING id`,
    [workspaceId, agentId],
  );
  const sessionId = sessionRows[0]!.id;

  await pool.query(
    `INSERT INTO work_items
       (workspace_id, session_id, repo, intent_text, path_globs, ttl_seconds, expires_at)
     VALUES ($1, $2, 'acme/repo', 'refactor', ARRAY['src/**'], 1800, now() + interval '1 hour')`,
    [workspaceId, sessionId],
  );

  const { rows: annRows } = await pool.query<{ id: string }>(
    `INSERT INTO announcements (workspace_id, repo, from_session_id, body)
     VALUES ($1, 'acme/repo', $2, 'heads up') RETURNING id`,
    [workspaceId, sessionId],
  );
  await pool.query(
    `INSERT INTO announcement_deliveries (session_id, announcement_id) VALUES ($1, $2)`,
    [sessionId, annRows[0]!.id],
  );

  await pool.query(
    `INSERT INTO change_records
       (workspace_id, repo, agent_id, agent_name, branch, kind, path_globs)
     VALUES ($1, 'acme/repo', $2, 'agent-1', 'main', 'uncommitted', ARRAY['src/**'])`,
    [workspaceId, agentId],
  );

  await pool.query(
    `INSERT INTO api_tokens (workspace_id, account_id, token_hash, name)
     VALUES ($1, $2, $3, NULL)`,
    [workspaceId, accountId, hashToken("shp_delete_me")],
  );

  await pool.query(
    `INSERT INTO invites (workspace_id, code, created_by, role_granted, max_uses)
     VALUES ($1, 'invite-code', $2, 'member', 5)`,
    [workspaceId, accountId],
  );

  const { rows: fbRows } = await pool.query<{ id: string }>(
    `INSERT INTO feedback (workspace_id, account_id, type, body)
     VALUES ($1, $2, 'bug', 'something broke') RETURNING id`,
    [workspaceId, accountId],
  );

  return { feedbackId: fbRows[0]!.id };
}

/** count(*) of a table where workspace_id = $1. */
async function countByWorkspace(
  pool: pg.Pool,
  table: string,
  workspaceId: string,
): Promise<number> {
  // `table` is a hardcoded test-local literal, never user input — safe to inline.
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM ${table} WHERE workspace_id = $1`,
    [workspaceId],
  );
  return Number(rows[0]!.count);
}

/** Whether a workspace row still exists. */
async function workspaceExists(
  pool: pg.Pool,
  workspaceId: string,
): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM workspaces WHERE id = $1`, [
    workspaceId,
  ]);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Delete workspace (DB-gated)" + (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    // Owner pool: seed fixtures + raw count/exists asserts. Restricted app-role
    // pool: the server (buildServer resolves its pool from the shared context),
    // so the delete-cascade runs under RLS. The explicit per-table DELETEs run
    // in workspace context (permitted by the *_workspace ALL arms); memberships/
    // invites cascade and feedback SET NULL are FK actions that run as the table
    // owner and are not subject to RLS.
    let pool: pg.Pool;
    let appPool: pg.Pool;
    let app: FastifyInstance;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      appPool = createAppPool();
      initContext({ pool: appPool, config: makeTestConfig() });
      app = buildServer();
      await app.ready();
    });

    afterEach(async () => {
      __resetRateLimiter();
      await truncateAll(pool);
      await truncateTenancy(pool);
    });

    afterAll(async () => {
      await app.close();
      resetContext();
      await appPool.end();
      await pool.end();
    });

    it("an admin deletes the workspace: workspace + every workspace-scoped row is gone, feedback survives detached", async () => {
      const wsId = await seedWorkspace(pool, "delete-full");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      await seedMembership(pool, "acct-member", wsId, "member");
      const { feedbackId } = await seedFullWorkspaceData(
        pool,
        wsId,
        "acct-admin",
      );

      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}`,
        headers: bffAuthHeaders("acct-admin"),
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ deleted: true });

      // The workspace and every workspace-scoped table is empty for this id.
      expect(await workspaceExists(pool, wsId)).toBe(false);
      for (const table of [
        "agents",
        "sessions",
        "work_items",
        "announcements",
        "change_records",
        "api_tokens",
        "invites",
        "memberships",
      ]) {
        expect(await countByWorkspace(pool, table, wsId)).toBe(0);
      }

      // Feedback history is preserved but detached (workspace_id SET NULL).
      const { rows } = await pool.query<{ workspace_id: string | null }>(
        `SELECT workspace_id FROM feedback WHERE id = $1`,
        [feedbackId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.workspace_id).toBeNull();
    });

    it("a sole-member admin can delete (covers the reported stuck case)", async () => {
      const wsId = await seedWorkspace(pool, "sole-admin");
      await seedMembership(pool, "acct-solo", wsId, "admin");

      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}`,
        headers: bffAuthHeaders("acct-solo"),
      });
      expect(res.statusCode).toBe(200);
      expect(await workspaceExists(pool, wsId)).toBe(false);
    });

    it("a non-admin member cannot delete → 403, workspace untouched", async () => {
      const wsId = await seedWorkspace(pool, "member-delete");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      await seedMembership(pool, "acct-member", wsId, "member");

      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}`,
        headers: bffAuthHeaders("acct-member"),
      });
      expect(res.statusCode).toBe(403);
      expect(await workspaceExists(pool, wsId)).toBe(true);
    });

    it("a non-member cannot delete → 404, workspace untouched", async () => {
      const wsId = await seedWorkspace(pool, "stranger-delete");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}`,
        headers: bffAuthHeaders("acct-stranger"),
      });
      expect(res.statusCode).toBe(404);
      expect(await workspaceExists(pool, wsId)).toBe(true);
    });

    it("delete is scoped: a second workspace's data is untouched", async () => {
      const wsA = await seedWorkspace(pool, "scoped-a");
      const wsB = await seedWorkspace(pool, "scoped-b");
      await seedMembership(pool, "acct-admin", wsA, "admin");
      await seedMembership(pool, "acct-admin", wsB, "admin");
      await seedFullWorkspaceData(pool, wsB, "acct-admin");

      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsA}`,
        headers: bffAuthHeaders("acct-admin"),
      });
      expect(res.statusCode).toBe(200);

      // wsB is fully intact.
      expect(await workspaceExists(pool, wsB)).toBe(true);
      expect(await countByWorkspace(pool, "agents", wsB)).toBe(1);
      expect(await countByWorkspace(pool, "sessions", wsB)).toBe(1);
      expect(await countByWorkspace(pool, "api_tokens", wsB)).toBe(1);
      expect(await countByWorkspace(pool, "memberships", wsB)).toBe(1);
    });

    // --- Framework-error hardening: bodyless POST with a JSON content-type ---

    it("a bodyless POST /workspaces/:id/leave with a JSON content-type reaches the handler and succeeds", async () => {
      // The original bug: an empty body with content-type application/json made
      // Fastify throw FST_ERR_CTP_EMPTY_JSON_BODY, first surfacing as a 500,
      // then (after the setErrorHandler statusCode branch) as an honest 400.
      // The same combination then broke invite-link redeem through the console
      // BFF, so the hub's JSON parser now treats an empty body as "no body" and
      // the request succeeds like any other bodyless leave.
      const wsId = await seedWorkspace(pool, "empty-body-leave");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      await seedMembership(pool, "acct-leaver", wsId, "member");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/leave`,
        headers: {
          "x-internal-token": INTERNAL_TOKEN,
          "x-account-id": "acct-leaver",
          "content-type": "application/json",
        },
        // No payload → empty body with a JSON content-type.
      });
      expect(res.statusCode).toBe(200);
    });

    it("a leave with NO content-type reaches the handler and succeeds (200)", async () => {
      // The client fix (omit content-type on bodyless requests) makes a normal
      // leave reach the handler instead of tripping the empty-JSON-body parser.
      const wsId = await seedWorkspace(pool, "clean-leave");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      await seedMembership(pool, "acct-leaver", wsId, "member");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/leave`,
        headers: bffAuthHeaders("acct-leaver"),
      });
      expect(res.statusCode).toBe(200);
    });
  },
);
