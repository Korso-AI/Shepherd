/**
 * Tests for packages/hub/src/operations/done.ts
 *
 * All DB-dependent tests are gated on `dbAvailable`.
 * When no Postgres is configured, the suite is skipped with a clear message.
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
  insertAnnouncement,
  listActiveClaims,
} from "../../src/repo.js";
import { withTransaction } from "../../src/db.js";
import { initContext, resetContext } from "../../src/context.js";
import { done } from "../../src/operations/done.js";
import type { Config } from "../../src/config.js";
import type { TenantContext } from "../../src/tenant.js";

/** The suite's seeded workspace uuid + self-host tenant, set in beforeAll. */
let workspaceId: string;
let tenant: TenantContext;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function secsFromNow(now: Date, secs: number): Date {
  return new Date(now.getTime() + secs * 1000);
}

const TEST_CONFIG: Config = {
  DATABASE_URL: "placeholder",
  TEAM_TOKEN: "test-token",
  HUB_PORT: 8080,
  ALLOWED_WORKSPACE: "test-ws",
  DEFAULT_TTL_SECONDS: 1800,
  MIN_TTL_SECONDS: 30,
  STALE_AFTER_SECONDS: 120,
  CHANGE_RECORD_TTL_SECONDS: 604800,
  HUB_ADMIN_LABEL: "admin",
};

/** Seed an agent + session pair in one transaction. */
async function seedAgentAndSession(
  pool: pg.Pool,
  opts: {
    workspaceId?: string;
    repo?: string;
    branch?: string;
    human?: string;
    program?: string;
    model?: string;
    suffix?: string;
  } = {}
): Promise<{ agentId: string; agentName: string; sessionId: string }> {
  const ws = opts.workspaceId ?? workspaceId;
  const repo = opts.repo ?? "my-repo";
  const branch = opts.branch ?? "main";
  const human = opts.human ?? "alice";
  const suffix = opts.suffix ?? Math.random().toString(36).slice(2, 8);
  // The agents unique key is (workspace, human, program, model) — NOT name.
  // Fold the per-call suffix into `program` so two seeds with default opts are
  // DISTINCT agents (previously only `name` varied, causing a collision on
  // agents_workspace_human_program_model_key).
  const program = opts.program ?? `my-prog-${suffix}`;
  const model = opts.model ?? "claude-3";
  const name = `agent-${suffix}`;

  return withTransaction(pool, async (tx) => {
    const agent = await createAgent(tx, { workspaceId: ws, name, human, program, model });
    const session = await createSession(tx, {
      workspaceId: ws,
      agentId: agent.id,
      repo,
      branch,
    });
    return { agentId: agent.id, agentName: agent.name, sessionId: session.id };
  });
}

/** Seed a work item owned by a session. Returns the workItemId. */
async function seedWorkItem(
  pool: pg.Pool,
  sessionId: string,
  opts: {
    workspaceId?: string;
    repo?: string;
    intent?: string;
    pathGlobs?: string[];
    ttlSeconds?: number;
  } = {}
): Promise<string> {
  const now = new Date();
  const ttlSeconds = opts.ttlSeconds ?? 300;
  return withTransaction(pool, (tx) =>
    insertWorkItem(tx, {
      workspaceId: opts.workspaceId ?? workspaceId,
      sessionId,
      repo: opts.repo ?? "my-repo",
      intentText: opts.intent ?? "do some work",
      pathGlobs: opts.pathGlobs ?? ["src/**/*.ts"],
      ttlSeconds,
      expiresAt: secsFromNow(now, ttlSeconds),
    })
  );
}

// ---------------------------------------------------------------------------
// DB-gated suite
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)("done operation — DB-dependent", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      ["test-ws", "test-ws"]
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

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------
  describe("happy path", () => {
    it("done releases a work item and it no longer appears in a peer's active claims", async () => {
      const owner = await seedAgentAndSession(pool, { suffix: "owner" });
      const peer = await seedAgentAndSession(pool, { suffix: "peer" });

      const workItemId = await seedWorkItem(pool, owner.sessionId);

      // Confirm the claim is visible to the peer before done().
      const now = new Date();
      const before = await listActiveClaims(pool, workspaceId, "my-repo", now, TEST_CONFIG.STALE_AFTER_SECONDS, {
        excludeSessionId: peer.sessionId,
      });
      expect(before).toHaveLength(1);
      expect(before[0]!.workItemId).toBe(workItemId);

      // Release via done().
      const result = await done({ sessionId: owner.sessionId, workItemId }, tenant);
      expect(result).toEqual({ ok: true, announcements: [] });

      // Confirm the claim is no longer visible to the peer.
      const after = await listActiveClaims(pool, workspaceId, "my-repo", now, TEST_CONFIG.STALE_AFTER_SECONDS, {
        excludeSessionId: peer.sessionId,
      });
      expect(after).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Edge: double-done is idempotent
  // -------------------------------------------------------------------------
  describe("edge: calling done twice on the same workItemId", () => {
    it("both calls return { ok: true }", async () => {
      const owner = await seedAgentAndSession(pool, { suffix: "double" });
      const workItemId = await seedWorkItem(pool, owner.sessionId);

      const first = await done({ sessionId: owner.sessionId, workItemId }, tenant);
      expect(first).toEqual({ ok: true, announcements: [] });

      const second = await done({ sessionId: owner.sessionId, workItemId }, tenant);
      expect(second).toEqual({ ok: true, announcements: [] });
    });
  });

  // -------------------------------------------------------------------------
  // Edge: cross-session done is a no-op, owner's claim is protected
  // -------------------------------------------------------------------------
  describe("edge: session X calling done on session Y's workItemId", () => {
    it("returns { ok: true } and Y's claim remains active in a peer's landscape", async () => {
      const sessionY = await seedAgentAndSession(pool, { suffix: "sessY" });
      const sessionX = await seedAgentAndSession(pool, { suffix: "sessX" });
      const peer = await seedAgentAndSession(pool, { suffix: "peer2" });

      const workItemId = await seedWorkItem(pool, sessionY.sessionId);

      // Session X tries to release Y's work item — should silently succeed.
      const result = await done({ sessionId: sessionX.sessionId, workItemId }, tenant);
      expect(result).toEqual({ ok: true, announcements: [] });

      // Y's claim must still be visible to the peer (WHERE clause protected it).
      const now = new Date();
      const claims = await listActiveClaims(pool, workspaceId, "my-repo", now, TEST_CONFIG.STALE_AFTER_SECONDS, {
        excludeSessionId: peer.sessionId,
      });
      expect(claims).toHaveLength(1);
      expect(claims[0]!.workItemId).toBe(workItemId);
    });
  });

  // -------------------------------------------------------------------------
  // #4: done delivers the caller's pending announcements
  // -------------------------------------------------------------------------
  describe("#4: announcement delivery on done", () => {
    it("returns pending announcements for the caller and marks them delivered", async () => {
      const owner = await seedAgentAndSession(pool, { suffix: "owner" });
      const sender = await seedAgentAndSession(pool, { suffix: "sender" });
      const workItemId = await seedWorkItem(pool, owner.sessionId);

      // Sender broadcasts a message the owner should receive.
      const announcementId = await withTransaction(pool, (tx) =>
        insertAnnouncement(tx, {
          workspaceId,
          repo: "my-repo",
          fromSessionId: sender.sessionId,
          targetAgentName: null,
          body: "heads up",
        })
      );

      // done() delivers it in its response.
      const result = await done({ sessionId: owner.sessionId, workItemId }, tenant);
      expect(result.ok).toBe(true);
      expect(result.announcements).toHaveLength(1);
      expect(result.announcements[0]!.id).toBe(announcementId);
      expect(result.announcements[0]!.body).toBe("heads up");

      // Marked delivered: a second done does not re-deliver it.
      const second = await done({ sessionId: owner.sessionId, workItemId }, tenant);
      expect(second.announcements).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Edge: unknown session throws UnknownSessionError
  // -------------------------------------------------------------------------
  describe("edge: unknown sessionId", () => {
    it("throws UnknownSessionError for a nonexistent session", async () => {
      const { UnknownSessionError } = await import("../../src/errors.js");
      await expect(
        done({
          sessionId: "00000000-0000-0000-0000-000000000000",
          workItemId: "00000000-0000-0000-0000-000000000001",
        }, tenant)
      ).rejects.toBeInstanceOf(UnknownSessionError);
    });
  });
});

// ---------------------------------------------------------------------------
// Pure (no DB) suite — always runs
// ---------------------------------------------------------------------------

describe("done operation — pure (no Postgres needed)", () => {
  it("dbAvailable is a boolean", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });

  it("done is a function", async () => {
    const { done: doneOp } = await import("../../src/operations/done.js");
    expect(typeof doneOp).toBe("function");
  });
});
