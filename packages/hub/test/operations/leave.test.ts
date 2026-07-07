/**
 * Tests for packages/hub/src/operations/leave.ts
 *
 * `leave` is the clean-shutdown presence signal: it marks the session offline
 * immediately (so live claims stop surfacing) WITHOUT releasing claims or
 * clearing change records. All DB-dependent tests are gated on `dbAvailable`.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  runTestMigrations,
  truncateAll,
} from "../setup.js";
import {
  createAgent,
  createSession,
  insertWorkItem,
  listActiveClaims,
  replaceChangeRecords,
  addMembership,
} from "../../src/repo.js";
import { withTransaction } from "../../src/db.js";
import { initContext, resetContext } from "../../src/context.js";
import { leave } from "../../src/operations/leave.js";
import { UnknownSessionError } from "../../src/errors.js";
import type { Config } from "../../src/config.js";
import { NO_ROUTE_WORKSPACE, type TenantContext } from "../../src/tenant.js";

/** The suite's seeded workspace uuid + self-host tenant, set in beforeAll. */
let workspaceId: string;
let tenant: TenantContext;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function secsFromNow(now: Date, secs: number): Date {
  return new Date(now.getTime() + secs * 1000);
}

const STALE_AFTER_SECONDS = 120;

const TEST_CONFIG: Config = {
  DATABASE_URL: "placeholder",
  TEAM_TOKEN: "test-token",
  HUB_PORT: 8080,
  ALLOWED_WORKSPACE: "test-ws",
  DEFAULT_TTL_SECONDS: 1800,
  MIN_TTL_SECONDS: 30,
  STALE_AFTER_SECONDS,
  CHANGE_RECORD_TTL_SECONDS: 604800,
  HUB_ADMIN_LABEL: "admin",
};

async function seedAgentAndSession(
  pool: pg.Pool,
  opts: { suffix?: string } = {},
): Promise<{ agentId: string; agentName: string; sessionId: string }> {
  const suffix = opts.suffix ?? Math.random().toString(36).slice(2, 8);
  return withTransaction(pool, async (tx) => {
    const agent = await createAgent(tx, {
      workspaceId,
      name: `agent-${suffix}`,
      human: "alice",
      program: `my-prog-${suffix}`,
      model: "claude-3",
    });
    const session = await createSession(tx, {
      workspaceId,
      agentId: agent.id,
      repo: "my-repo",
      branch: "main",
    });
    return { agentId: agent.id, agentName: agent.name, sessionId: session.id };
  });
}

// ---------------------------------------------------------------------------
// DB-gated suite
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)("leave operation — DB-dependent", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      ["test-ws", "test-ws"],
    );
    workspaceId = rows[0]!.id;
    tenant = { workspaceId };
    initContext({ pool, config: TEST_CONFIG });
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    resetContext();
    await pool.end();
  });

  it("marks the session offline so its live claim disappears from a peer's landscape", async () => {
    const now = new Date();
    const owner = await seedAgentAndSession(pool, { suffix: "owner" });
    const peer = await seedAgentAndSession(pool, { suffix: "peer" });

    await withTransaction(pool, (tx) =>
      insertWorkItem(tx, {
        workspaceId,
        sessionId: owner.sessionId,
        repo: "my-repo",
        intentText: "auth work",
        pathGlobs: ["src/auth/**"],
        ttlSeconds: 1800,
        expiresAt: secsFromNow(now, 1800),
      }),
    );

    // Visible before leaving (owner is freshly heart-beaten).
    const before = await listActiveClaims(
      pool,
      workspaceId,
      "my-repo",
      now,
      STALE_AFTER_SECONDS,
      { excludeSessionId: peer.sessionId },
    );
    expect(before).toHaveLength(1);

    const result = await leave({ sessionId: owner.sessionId }, tenant);
    expect(result).toEqual({ ok: true });

    // Hidden after leaving — the owner now reads as offline.
    const after = await listActiveClaims(
      pool,
      workspaceId,
      "my-repo",
      now,
      STALE_AFTER_SECONDS,
      { excludeSessionId: peer.sessionId },
    );
    expect(after).toHaveLength(0);
  });

  it("does NOT release the claim row (status stays active; it merely goes invisible)", async () => {
    const now = new Date();
    const owner = await seedAgentAndSession(pool, { suffix: "owner2" });

    const workItemId = await withTransaction(pool, (tx) =>
      insertWorkItem(tx, {
        workspaceId,
        sessionId: owner.sessionId,
        repo: "my-repo",
        intentText: "auth work",
        pathGlobs: ["src/auth/**"],
        ttlSeconds: 1800,
        expiresAt: secsFromNow(now, 1800),
      }),
    );

    await leave({ sessionId: owner.sessionId }, tenant);

    const { rows } = await pool.query<{ status: string }>(
      "SELECT status FROM work_items WHERE id = $1",
      [workItemId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("active");
  });

  it("does NOT clear the session's change records", async () => {
    const owner = await seedAgentAndSession(pool, { suffix: "owner3" });

    await withTransaction(pool, (tx) =>
      replaceChangeRecords(tx, {
        agentId: owner.agentId,
        agentName: owner.agentName,
        workspaceId,
        repo: "my-repo",
        branch: "main",
        entries: [
          {
            kind: "committed",
            commitSha: "abc123",
            message: "unlanded auth work",
            paths: ["src/auth/**"],
          },
        ],
      }),
    );

    await leave({ sessionId: owner.sessionId }, tenant);

    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM change_records WHERE agent_id = $1",
      [owner.agentId],
    );
    expect(Number(rows[0]!.count)).toBe(1);
  });

  // Task 2.2 DELIBERATE BEHAVIOR CHANGE: leave now resolves + authorizes the
  // session via resolveSession before expiring presence (so account-scoped
  // tokens work on this path). An UNKNOWN session id therefore surfaces as
  // UnknownSessionError (→ 404) instead of the old silent no-op — the
  // idempotency guarantee for a non-existent session is intentionally dropped.
  it("unknown session → UnknownSessionError (404), NOT a silent no-op (was idempotent pre-2.2)", async () => {
    await expect(
      leave({ sessionId: "00000000-0000-0000-0000-000000000000" }, tenant),
    ).rejects.toThrow(UnknownSessionError);
  });

  // A session row that still EXISTS (even one already marked offline by a prior
  // leave) resolves fine, so leaving a real session twice remains ok — only a
  // genuinely non-existent id 404s.
  it("leaving a real session twice still returns ok (the row exists both times)", async () => {
    const owner = await seedAgentAndSession(pool, { suffix: "twice" });
    expect(await leave({ sessionId: owner.sessionId }, tenant)).toEqual({
      ok: true,
    });
    expect(await leave({ sessionId: owner.sessionId }, tenant)).toEqual({
      ok: true,
    });
  });

  // Account-scoped credential: a member of the session's workspace can leave via
  // an account-scoped token (no route workspace), expiring presence for the
  // session's OWN workspace.
  it("account-scoped member: leave expires presence for the session's workspace", async () => {
    await withTransaction(pool, (tx) =>
      addMembership(tx, {
        workspaceId,
        accountId: "acct-member",
        role: "member",
      }),
    );
    const now = new Date();
    const owner = await seedAgentAndSession(pool, { suffix: "acct" });
    await withTransaction(pool, (tx) =>
      insertWorkItem(tx, {
        workspaceId,
        sessionId: owner.sessionId,
        repo: "my-repo",
        intentText: "auth work",
        pathGlobs: ["src/auth/**"],
        ttlSeconds: 1800,
        expiresAt: secsFromNow(now, 1800),
      }),
    );
    const accountTenant: TenantContext = {
      workspaceId: NO_ROUTE_WORKSPACE,
      accountId: "acct-member",
      via: "agent",
    };

    const result = await leave({ sessionId: owner.sessionId }, accountTenant);
    expect(result).toEqual({ ok: true });

    // The owner now reads as offline — its live claim disappears from the repo.
    const after = await listActiveClaims(
      pool,
      workspaceId,
      "my-repo",
      now,
      STALE_AFTER_SECONDS,
      { excludeSessionId: "00000000-0000-0000-0000-000000000000" },
    );
    expect(after).toHaveLength(0);
  });

  it("account-scoped non-member: leave on a session in a non-member workspace → 404, presence untouched", async () => {
    const { rows: wsRows } = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      ["leave-other-ws", "leave-other-ws"],
    );
    const otherWs = wsRows[0]!.id;
    // Seed an agent + session directly under the OTHER workspace.
    const otherSessionId = await withTransaction(pool, async (tx) => {
      const agent = await createAgent(tx, {
        workspaceId: otherWs,
        name: "outsider-agent",
        human: "outsider",
        program: "claude",
        model: "claude-3",
      });
      const session = await createSession(tx, {
        workspaceId: otherWs,
        agentId: agent.id,
        repo: "my-repo",
        branch: "main",
      });
      return session.id;
    });
    const before = await pool.query<{ last_heartbeat_at: Date }>(
      `SELECT last_heartbeat_at FROM sessions WHERE id = $1`,
      [otherSessionId],
    );
    const accountTenant: TenantContext = {
      workspaceId: NO_ROUTE_WORKSPACE,
      accountId: "acct-outsider",
      via: "agent",
    };

    await expect(
      leave({ sessionId: otherSessionId }, accountTenant),
    ).rejects.toThrow(UnknownSessionError);

    // Presence untouched — resolveSession 404s before expireSessionPresence runs.
    const after = await pool.query<{ last_heartbeat_at: Date }>(
      `SELECT last_heartbeat_at FROM sessions WHERE id = $1`,
      [otherSessionId],
    );
    expect(after.rows[0]!.last_heartbeat_at.getTime()).toBe(
      before.rows[0]!.last_heartbeat_at.getTime(),
    );
  });
});
