/**
 * Tests for packages/hub/src/operations/heartbeat.ts
 *
 * The whole point of /heartbeat is the presence-vs-claim split: it bumps the
 * session's last_heartbeat_at (presence stays live) but must NEVER renew a
 * claim's expires_at. The CRITICAL test below proves that end-to-end.
 *
 * All DB-dependent tests are gated on `dbAvailable`.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  createAppPool,
  runTestMigrations,
  truncateAll,
} from "../setup.js";
import {
  createAgent,
  createSession,
  insertWorkItem,
  getSession,
  insertAnnouncement,
} from "../../src/repo.js";
import { withContext } from "../../src/scopedDb.js";
import { initContext, resetContext } from "../../src/context.js";
import { heartbeat } from "../../src/operations/heartbeat.js";
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
  opts: { suffix?: string } = {},
): Promise<{ agentId: string; agentName: string; sessionId: string }> {
  const repo = "my-repo";
  const branch = "main";
  const human = "alice";
  const suffix = opts.suffix ?? Math.random().toString(36).slice(2, 8);
  const program = `my-prog-${suffix}`;
  const model = "claude-3";
  const name = `agent-${suffix}`;

  return withContext(pool, { kind: "workspace", workspaceId }, async (tx) => {
    const agent = await createAgent(tx, {
      workspaceId,
      name,
      human,
      program,
      model,
    });
    const session = await createSession(tx, {
      workspaceId,
      agentId: agent.id,
      repo,
      branch,
    });
    return { agentId: agent.id, agentName: agent.name, sessionId: session.id };
  });
}

/** Seed a work item owned by a session with a known expires_at. Returns id. */
async function seedWorkItem(
  pool: pg.Pool,
  sessionId: string,
  expiresAt: Date,
  ttlSeconds = 300,
): Promise<string> {
  return withContext(pool, { kind: "workspace", workspaceId }, (tx) =>
    insertWorkItem(tx, {
      workspaceId,
      sessionId,
      repo: "my-repo",
      intentText: "do some work",
      pathGlobs: ["src/**/*.ts"],
      ttlSeconds,
      expiresAt,
    }),
  );
}

/** Read raw session + work_item rows for assertions. */
async function readSessionHeartbeat(
  pool: pg.Pool,
  sessionId: string,
): Promise<Date> {
  const { rows } = await pool.query<{ last_heartbeat_at: Date }>(
    `SELECT last_heartbeat_at FROM sessions WHERE id = $1`,
    [sessionId],
  );
  return rows[0]!.last_heartbeat_at;
}

async function readClaimExpiry(
  pool: pg.Pool,
  workItemId: string,
): Promise<Date> {
  const { rows } = await pool.query<{ expires_at: Date }>(
    `SELECT expires_at FROM work_items WHERE id = $1`,
    [workItemId],
  );
  return rows[0]!.expires_at;
}

// ---------------------------------------------------------------------------
// DB-gated suite
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)("heartbeat operation — DB-dependent", () => {
  let pool: pg.Pool;
  let appPool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
    appPool = createAppPool();
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      ["test-ws", "test-ws"],
    );
    workspaceId = rows[0]!.id;
    tenant = { workspaceId, via: "team" };
    initContext({ pool: appPool, config: TEST_CONFIG });
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    resetContext();
    await appPool.end();
    await pool.end();
  });

  // -------------------------------------------------------------------------
  // Happy path: bumps last_heartbeat_at, returns { ok: true }
  // -------------------------------------------------------------------------
  describe("happy path", () => {
    it("bumps last_heartbeat_at and returns { ok: true }", async () => {
      const sess = await seedAgentAndSession(pool, { suffix: "hb" });

      // Backdate the session's heartbeat so we can observe a forward bump.
      const old = new Date(Date.now() - 60_000);
      await pool.query(
        `UPDATE sessions SET last_heartbeat_at = $1 WHERE id = $2`,
        [old, sess.sessionId],
      );
      const before = await readSessionHeartbeat(pool, sess.sessionId);

      const result = await heartbeat({ sessionId: sess.sessionId }, tenant);
      expect(result).toEqual({ ok: true, announcements: [] });

      const after = await readSessionHeartbeat(pool, sess.sessionId);
      expect(after.getTime()).toBeGreaterThan(before.getTime());
    });
  });

  // -------------------------------------------------------------------------
  // CRITICAL: heartbeat does NOT renew an active claim's expires_at
  // -------------------------------------------------------------------------
  describe("CRITICAL: presence without claim renewal", () => {
    it("does NOT change an active claim's expires_at", async () => {
      const sess = await seedAgentAndSession(pool, { suffix: "noredo" });

      // A claim with a known, fixed expires_at well in the past relative to a
      // would-be renewal (renewal would push it ~300s into the future).
      const knownExpiry = new Date(Date.now() + 30_000);
      const workItemId = await seedWorkItem(
        pool,
        sess.sessionId,
        knownExpiry,
        300,
      );

      const expiryBefore = await readClaimExpiry(pool, workItemId);

      const result = await heartbeat({ sessionId: sess.sessionId }, tenant);
      expect(result).toEqual({ ok: true, announcements: [] });

      const expiryAfter = await readClaimExpiry(pool, workItemId);
      // Unchanged to the millisecond — heartbeat must not touch the lease.
      expect(expiryAfter.getTime()).toBe(expiryBefore.getTime());
    });
  });

  // -------------------------------------------------------------------------
  // #5: an attached change report refreshes change records (no claim renewal)
  // -------------------------------------------------------------------------
  describe("#5: change-report ingestion on heartbeat", () => {
    const sampleReport = {
      branch: "feature",
      baseBranch: "main",
      head: "deadbeef",
      truncated: false,
      entries: [
        {
          kind: "committed" as const,
          sha: "deadbeef",
          message: "wip auth",
          paths: ["src/auth/**"],
        },
      ],
    };

    it("stores the agent's change records from the report", async () => {
      const sess = await seedAgentAndSession(pool, { suffix: "cr" });

      await heartbeat(
        { sessionId: sess.sessionId, changeReport: sampleReport },
        tenant,
      );

      const { rows } = await pool.query<{
        kind: string;
        commit_sha: string | null;
        path_globs: string[];
        branch: string;
      }>(
        `SELECT kind, commit_sha, path_globs, branch
         FROM change_records WHERE agent_id = $1`,
        [sess.agentId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe("committed");
      expect(rows[0]!.commit_sha).toBe("deadbeef");
      expect(rows[0]!.path_globs).toEqual(["src/auth/**"]);
      expect(rows[0]!.branch).toBe("feature");
    });

    it("updates the session's branch from the report", async () => {
      const sess = await seedAgentAndSession(pool, { suffix: "crbranch" });

      await heartbeat(
        { sessionId: sess.sessionId, changeReport: sampleReport },
        tenant,
      );

      const { rows } = await pool.query<{ branch: string }>(
        `SELECT branch FROM sessions WHERE id = $1`,
        [sess.sessionId],
      );
      expect(rows[0]!.branch).toBe("feature");
    });

    it("still does NOT renew an active claim's expires_at when a report is attached", async () => {
      const sess = await seedAgentAndSession(pool, { suffix: "crnoredo" });
      const knownExpiry = new Date(Date.now() + 30_000);
      const workItemId = await seedWorkItem(
        pool,
        sess.sessionId,
        knownExpiry,
        300,
      );
      const expiryBefore = await readClaimExpiry(pool, workItemId);

      await heartbeat(
        { sessionId: sess.sessionId, changeReport: sampleReport },
        tenant,
      );

      const expiryAfter = await readClaimExpiry(pool, workItemId);
      expect(expiryAfter.getTime()).toBe(expiryBefore.getTime());
    });

    it("a clean-tree report clears the agent's records (committed + uncommitted)", async () => {
      const sess = await seedAgentAndSession(pool, { suffix: "crclear" });

      // First a report with one committed + one uncommitted entry...
      await heartbeat(
        {
          sessionId: sess.sessionId,
          changeReport: {
            ...sampleReport,
            entries: [
              ...sampleReport.entries,
              {
                kind: "uncommitted" as const,
                sha: null,
                message: "dirty edits",
                paths: ["src/dirty.ts"],
              },
            ],
          },
        },
        tenant,
      );

      // ...then a clean tree (no entries): nothing dirty AND nothing unlanded.
      // Committed records now reflect the agent's CURRENT reported set, so the
      // committed `deadbeef` clears along with the uncommitted row.
      await heartbeat(
        {
          sessionId: sess.sessionId,
          changeReport: { ...sampleReport, entries: [] },
        },
        tenant,
      );

      const { rows } = await pool.query<{
        kind: string;
        commit_sha: string | null;
      }>(`SELECT kind, commit_sha FROM change_records WHERE agent_id = $1`, [
        sess.agentId,
      ]);
      expect(rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Opt-in announcement delivery: only when deliverAnnouncements is set
  // -------------------------------------------------------------------------
  describe("opt-in announcement delivery", () => {
    /** Seed a broadcast announcement in test-ws/my-repo from a separate sender. */
    async function seedBroadcast(
      recipientSessionId: string,
      body: string,
    ): Promise<void> {
      const sender = await seedAgentAndSession(pool, { suffix: "sender" });
      await withContext(pool, { kind: "workspace", workspaceId }, (tx) =>
        insertAnnouncement(tx, {
          workspaceId,
          repo: "my-repo",
          fromSessionId: sender.sessionId,
          targetAgentName: null,
          body,
        }),
      );
      // sanity: a different session, so it's deliverable to the recipient
      expect(sender.sessionId).not.toBe(recipientSessionId);
    }

    it("two-phase: the fetch beat does NOT mark delivered; only an ack does", async () => {
      const sess = await seedAgentAndSession(pool, { suffix: "deliver" });
      await seedBroadcast(sess.sessionId, "ship it");

      const first = await heartbeat(
        {
          sessionId: sess.sessionId,
          deliverAnnouncements: true,
        },
        tenant,
      );
      expect(first.ok).toBe(true);
      expect(first.announcements).toHaveLength(1);
      expect(first.announcements[0]!.body).toBe("ship it");

      // NOT yet acked → a second fetch beat still returns it (the bug fix: the
      // hub never marks delivered before the client confirms its local write).
      const second = await heartbeat(
        {
          sessionId: sess.sessionId,
          deliverAnnouncements: true,
        },
        tenant,
      );
      expect(second.announcements).toHaveLength(1);

      // Ack the id (client confirmed its local write) → now it is delivered.
      const ackId = first.announcements[0]!.id;
      const ack = await heartbeat(
        {
          sessionId: sess.sessionId,
          ackAnnouncementIds: [ackId],
        },
        tenant,
      );
      expect(ack.ok).toBe(true);
      expect(ack.announcements).toHaveLength(0);

      // A subsequent fetch beat gets nothing more — delivered exactly once.
      const third = await heartbeat(
        {
          sessionId: sess.sessionId,
          deliverAnnouncements: true,
        },
        tenant,
      );
      expect(third.announcements).toHaveLength(0);
      // Four sequential DB round-trips: give it headroom over the 5s default so
      // it stays green when the jsdom "ui" project runs concurrently and starves
      // the event loop (both projects run in one `vitest run`).
    }, 20000);

    it("does NOT consume or return announcements without the flag (old invariant)", async () => {
      const sess = await seedAgentAndSession(pool, { suffix: "noflag" });
      await seedBroadcast(sess.sessionId, "still waiting");

      const plain = await heartbeat({ sessionId: sess.sessionId }, tenant);
      expect(plain.announcements).toEqual([]);

      // The announcement was NOT consumed — an opt-in beat still finds it.
      const optIn = await heartbeat(
        {
          sessionId: sess.sessionId,
          deliverAnnouncements: true,
        },
        tenant,
      );
      expect(optIn.announcements).toHaveLength(1);
      expect(optIn.announcements[0]!.body).toBe("still waiting");
    });

    it("still does NOT renew an active claim's expires_at when delivering announcements", async () => {
      const sess = await seedAgentAndSession(pool, { suffix: "delivernoredo" });
      const knownExpiry = new Date(Date.now() + 30_000);
      const workItemId = await seedWorkItem(
        pool,
        sess.sessionId,
        knownExpiry,
        300,
      );
      const expiryBefore = await readClaimExpiry(pool, workItemId);

      await heartbeat(
        { sessionId: sess.sessionId, deliverAnnouncements: true },
        tenant,
      );

      const expiryAfter = await readClaimExpiry(pool, workItemId);
      expect(expiryAfter.getTime()).toBe(expiryBefore.getTime());
    });
  });

  // -------------------------------------------------------------------------
  // Edge: unknown session throws UnknownSessionError
  // -------------------------------------------------------------------------
  describe("edge: unknown sessionId", () => {
    it("throws UnknownSessionError for a nonexistent session", async () => {
      const { UnknownSessionError } = await import("../../src/errors.js");
      await expect(
        heartbeat(
          { sessionId: "00000000-0000-0000-0000-000000000000" },
          tenant,
        ),
      ).rejects.toBeInstanceOf(UnknownSessionError);
    });
  });
});

// ---------------------------------------------------------------------------
// Pure (no DB) suite — always runs
// ---------------------------------------------------------------------------

describe("heartbeat operation — pure (no Postgres needed)", () => {
  it("dbAvailable is a boolean", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });

  it("heartbeat is a function", async () => {
    const { heartbeat: hbOp } =
      await import("../../src/operations/heartbeat.js");
    expect(typeof hbOp).toBe("function");
  });
});
