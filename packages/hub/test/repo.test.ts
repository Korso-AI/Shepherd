/**
 * Tests for packages/hub/src/repo.ts
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
} from "./setup.js";
import {
  createAgent,
  findAgentByName,
  createSession,
  getSession,
  touchHeartbeat,
  touchPresence,
  insertWorkItem,
  listActiveClaims,
  listSessionClaims,
  releaseWorkItem,
  insertAnnouncement,
  fetchPendingAnnouncements,
  recordAnnouncementDeliveries,
  reservedAgentNamesForHandle,
  replaceChangeRecords,
  listOtherChangeRecords,
  pruneChangeRecords,
  updateSessionBranch,
  getWorkspaceLandscape,
  upsertAccountProfile,
  getAccountProfile,
  type SessionWithAgent,
} from "../src/repo.js";
import { withTransaction } from "../src/db.js";

// ---------------------------------------------------------------------------
// Workspace seeding (migration 011)
//
// Coordination tables now carry `workspace_id uuid NOT NULL REFERENCES
// workspaces(id)`, and `truncateAll` deliberately leaves the `workspaces` table
// intact. These tests historically passed free-text workspace SLUGS ("acme",
// "alpha", …) as the workspace scope; we keep that ergonomics by seeding a
// workspaces row per distinct slug in beforeAll and resolving the slug to its
// uuid through `wsId`. Seeding is idempotent (ON CONFLICT by slug) so it is safe
// to re-run across the suite's several beforeAll blocks, and the rows survive
// afterEach truncation.
// ---------------------------------------------------------------------------

/** Distinct workspace slugs every suite below scopes against. */
const WORKSPACE_SLUGS = ["acme", "alpha", "beta", "other-ws"] as const;

/** slug → workspaces.id, populated by seedWorkspaces in beforeAll. */
const workspaceIds = new Map<string, string>();

/** Seed (idempotently) every known workspace slug and cache its uuid. */
async function seedWorkspaces(pool: pg.Pool): Promise<void> {
  for (const slug of WORKSPACE_SLUGS) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [slug, slug]
    );
    workspaceIds.set(slug, rows[0]!.id);
  }
}

/** The seeded uuid for a workspace slug (must have been seeded in beforeAll). */
function wsId(slug: string): string {
  const id = workspaceIds.get(slug);
  if (!id) throw new Error(`workspace slug not seeded: ${slug}`);
  return id;
}

/**
 * Remove the workspaces this file seeded (and CASCADE any coordination rows that
 * still reference them). `truncateAll` deliberately leaves tenancy rows in place,
 * so without an afterAll cleanup these slugs ("acme", …) would persist on the
 * SHARED test DB and collide with other suites that create a workspace by the
 * same slug (e.g. repo.tenancy.test.ts creates slug "acme"). Scoped to our own
 * slugs so it cannot race-delete another worker's tenancy rows; each describe
 * re-seeds idempotently in beforeAll.
 */
async function cleanupWorkspaces(pool: pg.Pool): Promise<void> {
  await pool.query(`DELETE FROM workspaces WHERE slug = ANY($1)`, [[...WORKSPACE_SLUGS]]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake config-like staleAfterSeconds value. */
const STALE_AFTER_SECONDS = 120;

/** Change-record TTL used by reservedAgentNamesForHandle tests (3 days). */
const CHANGE_RECORD_TTL_SECONDS = 259200;

/** Uncommitted-record grace window (15 min) for visibility + name parking. */
const UNCOMMITTED_GRACE_SECONDS = 900;

/** Returns a Date N seconds in the past relative to `now`. */
function secsAgo(now: Date, secs: number): Date {
  return new Date(now.getTime() - secs * 1000);
}

/** Returns a Date N seconds in the future relative to `now`. */
function secsFromNow(now: Date, secs: number): Date {
  return new Date(now.getTime() + secs * 1000);
}

// ---------------------------------------------------------------------------
// Helper: seed a full agent + session pair in one transaction
// ---------------------------------------------------------------------------
async function seedAgentAndSession(
  pool: pg.Pool,
  opts: {
    workspaceId?: string;
    repo?: string;
    branch?: string;
    human?: string;
    program?: string;
    model?: string;
    agentNameSuffix?: string;
  } = {}
): Promise<{ agentId: string; agentName: string; sessionId: string }> {
  const workspaceId = opts.workspaceId ?? wsId("acme");
  const repo = opts.repo ?? "my-repo";
  const branch = opts.branch ?? "main";
  const human = opts.human ?? "alice";
  const suffix = opts.agentNameSuffix ?? Math.random().toString(36).slice(2, 8);
  // Agent identity is unique on (workspace_id, name). The per-call suffix varies
  // the name so two seeds with default opts are DISTINCT agents; `program` keeps
  // its suffix too for clarity.
  const program = opts.program ?? `my-prog-${suffix}`;
  const model = opts.model ?? "claude-3";
  const name = `agent-${suffix}`;

  return withTransaction(pool, async (tx) => {
    const agent = await createAgent(tx, { workspaceId, name, human, program, model });
    const session = await createSession(tx, {
      workspaceId,
      agentId: agent.id,
      repo,
      branch,
    });
    return { agentId: agent.id, agentName: agent.name, sessionId: session.id };
  });
}

/**
 * Seed an agent with an EXACT name plus one session whose last_heartbeat_at is
 * set explicitly (so we can control live vs stale). Used by the
 * liveAgentNamesForHandle / listOtherChangeRecords presence tests.
 */
async function seedNamedAgentWithSession(
  pool: pg.Pool,
  opts: {
    workspaceId?: string;
    repo?: string;
    branch?: string;
    name: string;
    human?: string;
    program?: string;
    model?: string | null;
    heartbeatAt: Date;
    withSession?: boolean;
  }
): Promise<{ agentId: string; agentName: string; sessionId: string | null }> {
  const workspaceId = opts.workspaceId ?? wsId("acme");
  const repo = opts.repo ?? "my-repo";
  const branch = opts.branch ?? "main";
  const human = opts.human ?? "alice";
  const program = opts.program ?? `prog-${opts.name}`;
  const model = opts.model === undefined ? "claude-3" : opts.model;
  const withSession = opts.withSession ?? true;

  return withTransaction(pool, async (tx) => {
    const agent = await createAgent(tx, {
      workspaceId,
      name: opts.name,
      human,
      program,
      model: model ?? undefined,
    });
    let sessionId: string | null = null;
    if (withSession) {
      const session = await createSession(tx, {
        workspaceId,
        agentId: agent.id,
        repo,
        branch,
      });
      await tx.query(`UPDATE sessions SET last_heartbeat_at = $1 WHERE id = $2`, [
        opts.heartbeatAt,
        session.id,
      ]);
      sessionId = session.id;
    }
    return { agentId: agent.id, agentName: agent.name, sessionId };
  });
}

// ---------------------------------------------------------------------------
// DB-gated suite
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)("repo — DB-dependent", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
    await seedWorkspaces(pool);
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await cleanupWorkspaces(pool);
    await pool.end();
  });

  // -------------------------------------------------------------------------
  // 1. createAgent round-trip (lookup by name — findAgent was removed)
  // -------------------------------------------------------------------------
  describe("createAgent", () => {
    it("round-trips: create then findAgentByName returns the same agent", async () => {
      const params = {
        workspaceId: wsId("acme"),
        name: "agent-alpha",
        human: "alice",
        program: "my-prog",
        model: "claude-3",
      };

      const created = await withTransaction(pool, (tx) => createAgent(tx, params));
      expect(created).toHaveProperty("id");
      expect(created.name).toBe("agent-alpha");

      const found = await findAgentByName(pool, wsId("acme"), "agent-alpha");
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe("agent-alpha");
    });
  });

  // -------------------------------------------------------------------------
  // 2. insertWorkItem + listActiveClaims
  // -------------------------------------------------------------------------
  describe("insertWorkItem / listActiveClaims", () => {
    it("an active work_item is visible to a DIFFERENT session in the same workspace", async () => {
      const now = new Date();

      // Owner session
      const owner = await seedAgentAndSession(pool, { agentNameSuffix: "owner" });
      // Requester session
      const requester = await seedAgentAndSession(pool, { agentNameSuffix: "req" });

      await withTransaction(pool, async (tx) => {
        await insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId: owner.sessionId,
          repo: "my-repo",
          intentText: "fix bug",
          pathGlobs: ["src/**/*.ts"],
          ttlSeconds: 300,
          expiresAt: secsFromNow(now, 300),
        });
      });

      const claims = await listActiveClaims(pool, wsId("acme"), "my-repo", now, STALE_AFTER_SECONDS, {
        excludeSessionId: requester.sessionId,
      });

      expect(claims).toHaveLength(1);
      expect(claims[0]!.intent).toBe("fix bug");
      expect(claims[0]!.pathGlobs).toEqual(["src/**/*.ts"]);
      expect(claims[0]!.agentName).toBe(owner.agentName);
    });

    it("excludes the owner's own session from the results", async () => {
      const now = new Date();
      const owner = await seedAgentAndSession(pool, { agentNameSuffix: "self" });

      await withTransaction(pool, async (tx) => {
        await insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId: owner.sessionId,
          repo: "my-repo",
          intentText: "self claim",
          pathGlobs: ["**/*"],
          ttlSeconds: 300,
          expiresAt: secsFromNow(now, 300),
        });
      });

      const claims = await listActiveClaims(pool, wsId("acme"), "my-repo", now, STALE_AFTER_SECONDS, {
        excludeSessionId: owner.sessionId,
      });

      expect(claims).toHaveLength(0);
    });

    it("#4: listSessionClaims returns the caller's OWN active claims (which listActiveClaims hides)", async () => {
      const now = new Date();
      const owner = await seedAgentAndSession(pool, { agentNameSuffix: "ownclaims" });

      const workItemId = await withTransaction(pool, (tx) =>
        insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId: owner.sessionId,
          repo: "my-repo",
          intentText: "my own claim",
          pathGlobs: ["src/feed/**"],
          ttlSeconds: 300,
          expiresAt: secsFromNow(now, 300),
        })
      );

      // listActiveClaims (excluding self) hides it...
      const others = await listActiveClaims(pool, wsId("acme"), "my-repo", now, STALE_AFTER_SECONDS, {
        excludeSessionId: owner.sessionId,
      });
      expect(others).toHaveLength(0);

      // ...but listSessionClaims surfaces it so the agent can self-verify.
      const mine = await listSessionClaims(pool, owner.sessionId, now);
      expect(mine).toHaveLength(1);
      expect(mine[0]!.workItemId).toBe(workItemId);
      expect(mine[0]!.intent).toBe("my own claim");
      expect(mine[0]!.pathGlobs).toEqual(["src/feed/**"]);
    });

    it("#4: listSessionClaims excludes the caller's EXPIRED and RELEASED claims", async () => {
      const now = new Date();
      const owner = await seedAgentAndSession(pool, { agentNameSuffix: "ownclaims2" });

      // An expired claim
      await withTransaction(pool, (tx) =>
        insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId: owner.sessionId,
          repo: "my-repo",
          intentText: "expired own claim",
          pathGlobs: ["**/*"],
          ttlSeconds: 10,
          expiresAt: secsAgo(now, 5),
        })
      );
      // An active-then-released claim
      const releasedId = await withTransaction(pool, (tx) =>
        insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId: owner.sessionId,
          repo: "my-repo",
          intentText: "released own claim",
          pathGlobs: ["**/*"],
          ttlSeconds: 300,
          expiresAt: secsFromNow(now, 300),
        })
      );
      await withTransaction(pool, (tx) =>
        releaseWorkItem(tx, owner.sessionId, releasedId, now)
      );

      const mine = await listSessionClaims(pool, owner.sessionId, now);
      expect(mine).toHaveLength(0);
    });

    it("excludes an EXPIRED work_item (expires_at < now)", async () => {
      const now = new Date();
      const owner = await seedAgentAndSession(pool, { agentNameSuffix: "expired" });
      const viewer = await seedAgentAndSession(pool, { agentNameSuffix: "viewer" });

      await withTransaction(pool, async (tx) => {
        await insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId: owner.sessionId,
          repo: "my-repo",
          intentText: "old claim",
          pathGlobs: ["**/*"],
          ttlSeconds: 10,
          // expired 5 seconds ago
          expiresAt: secsAgo(now, 5),
        });
      });

      const claims = await listActiveClaims(pool, wsId("acme"), "my-repo", now, STALE_AFTER_SECONDS, {
        excludeSessionId: viewer.sessionId,
      });

      expect(claims).toHaveLength(0);
    });

    it("#3: a claim whose session is STALE is HIDDEN even while its TTL holds", async () => {
      // Visibility now requires a LIVE owning session as well as a live TTL: a
      // dead agent's claim disappears once its session goes stale, so callers
      // never conflict with a ghost. (The 60s background heartbeat keeps a
      // genuinely-live heads-down session fresh, so this can't hide a live one.)
      const now = new Date();
      const owner = await seedAgentAndSession(pool, { agentNameSuffix: "stale" });
      const viewer = await seedAgentAndSession(pool, { agentNameSuffix: "viewer2" });

      await withTransaction(pool, async (tx) => {
        await insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId: owner.sessionId,
          repo: "my-repo",
          intentText: "stale-session claim",
          pathGlobs: ["**/*"],
          ttlSeconds: 9999,
          expiresAt: secsFromNow(now, 9999),
        });
      });

      // Owner session hasn't heart-beaten in longer than the stale window: even
      // though the claim's TTL is nowhere near expiry, it must now be hidden.
      await pool.query(
        `UPDATE sessions SET last_heartbeat_at = $1 WHERE id = $2`,
        [secsAgo(now, STALE_AFTER_SECONDS + 1), owner.sessionId]
      );

      const claims = await listActiveClaims(pool, wsId("acme"), "my-repo", now, STALE_AFTER_SECONDS, {
        excludeSessionId: viewer.sessionId,
      });

      expect(claims).toHaveLength(0);
    });

    it("#3b: a claim whose session is FRESH is visible while its TTL holds", async () => {
      // The live-session counterpart to #3: a freshly-heart-beaten owner's claim
      // is visible to others (seedAgentAndSession leaves last_heartbeat_at = now).
      const now = new Date();
      const owner = await seedAgentAndSession(pool, { agentNameSuffix: "fresh" });
      const viewer = await seedAgentAndSession(pool, { agentNameSuffix: "viewer3" });

      await withTransaction(pool, async (tx) => {
        await insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId: owner.sessionId,
          repo: "my-repo",
          intentText: "fresh-session claim",
          pathGlobs: ["**/*"],
          ttlSeconds: 9999,
          expiresAt: secsFromNow(now, 9999),
        });
      });

      const claims = await listActiveClaims(pool, wsId("acme"), "my-repo", now, STALE_AFTER_SECONDS, {
        excludeSessionId: viewer.sessionId,
      });

      expect(claims).toHaveLength(1);
      expect(claims[0]!.intent).toBe("fresh-session claim");
    });
  });

  // -------------------------------------------------------------------------
  // 3. touchHeartbeat renewal with different ttl_seconds
  // -------------------------------------------------------------------------
  describe("touchHeartbeat", () => {
    it("renews each work_item using its OWN ttl_seconds", async () => {
      const now = new Date();
      const { sessionId } = await seedAgentAndSession(pool, { agentNameSuffix: "hb" });

      let workItemIdShort: string;
      let workItemIdLong: string;

      await withTransaction(pool, async (tx) => {
        workItemIdShort = await insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId,
          repo: "my-repo",
          intentText: "short ttl claim",
          pathGlobs: ["**/*"],
          ttlSeconds: 60,
          expiresAt: secsFromNow(now, 60),
        });
        workItemIdLong = await insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId,
          repo: "my-repo",
          intentText: "long ttl claim",
          pathGlobs: ["**/*"],
          ttlSeconds: 3600,
          expiresAt: secsFromNow(now, 3600),
        });
      });

      // Advance time by 30 seconds and touch heartbeat.
      const renewalTime = secsFromNow(now, 30);
      await withTransaction(pool, (tx) => touchHeartbeat(tx, sessionId, renewalTime));

      // Check that each claim's expires_at = renewalTime + its own ttl.
      const { rows } = await pool.query<{
        id: string;
        intent_text: string;
        ttl_seconds: number;
        expires_at: Date;
      }>(
        `SELECT id, intent_text, ttl_seconds, expires_at
         FROM work_items
         WHERE session_id = $1 AND status = 'active'
         ORDER BY ttl_seconds`,
        [sessionId]
      );

      expect(rows).toHaveLength(2);

      const short = rows.find((r) => r.ttl_seconds === 60)!;
      const expectedShortExpiry = secsFromNow(renewalTime, 60);
      expect(Math.abs(short.expires_at.getTime() - expectedShortExpiry.getTime())).toBeLessThan(
        1000
      );

      const long = rows.find((r) => r.ttl_seconds === 3600)!;
      const expectedLongExpiry = secsFromNow(renewalTime, 3600);
      expect(Math.abs(long.expires_at.getTime() - expectedLongExpiry.getTime())).toBeLessThan(
        1000
      );
    });
  });

  // -------------------------------------------------------------------------
  // 3b. touchPresence (Task 2.3): presence WITHOUT claim renewal
  // -------------------------------------------------------------------------
  describe("touchPresence", () => {
    it("bumps last_heartbeat_at but leaves every active claim's expires_at untouched", async () => {
      const now = new Date();
      const { sessionId } = await seedAgentAndSession(pool, { agentNameSuffix: "tp1" });

      const originalExpiry = secsFromNow(now, 300);
      await withTransaction(pool, (tx) =>
        insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId,
          repo: "my-repo",
          intentText: "presence claim",
          pathGlobs: ["**/*"],
          ttlSeconds: 300,
          expiresAt: originalExpiry,
        })
      );

      // Backdate heartbeat so we can detect the bump.
      await pool.query(`UPDATE sessions SET last_heartbeat_at = $1 WHERE id = $2`, [
        secsAgo(now, 600),
        sessionId,
      ]);

      // Read expires_at BEFORE.
      const before = await pool.query<{ expires_at: Date }>(
        `SELECT expires_at FROM work_items WHERE session_id = $1 AND status = 'active'`,
        [sessionId]
      );
      expect(before.rows).toHaveLength(1);

      const presenceTime = secsFromNow(now, 30);
      await withTransaction(pool, (tx) => touchPresence(tx, sessionId, presenceTime));

      // Heartbeat bumped to presenceTime.
      const hb = await pool.query<{ last_heartbeat_at: Date }>(
        `SELECT last_heartbeat_at FROM sessions WHERE id = $1`,
        [sessionId]
      );
      expect(
        Math.abs(hb.rows[0]!.last_heartbeat_at.getTime() - presenceTime.getTime())
      ).toBeLessThan(1000);

      // expires_at UNCHANGED.
      const after = await pool.query<{ expires_at: Date }>(
        `SELECT expires_at FROM work_items WHERE session_id = $1 AND status = 'active'`,
        [sessionId]
      );
      expect(after.rows[0]!.expires_at.getTime()).toBe(
        before.rows[0]!.expires_at.getTime()
      );
    });

    it("a session that only ever calls touchPresence has its claims lapse at TTL", async () => {
      const now = new Date();
      const owner = await seedAgentAndSession(pool, { agentNameSuffix: "tp2owner" });
      const viewer = await seedAgentAndSession(pool, { agentNameSuffix: "tp2viewer" });

      await withTransaction(pool, (tx) =>
        insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId: owner.sessionId,
          repo: "my-repo",
          intentText: "lapsing claim",
          pathGlobs: ["**/*"],
          ttlSeconds: 60,
          expiresAt: secsFromNow(now, 60),
        })
      );

      // Backdate the claim's expires_at past its TTL (touchPresence will NOT renew).
      await pool.query(`UPDATE work_items SET expires_at = $1 WHERE session_id = $2`, [
        secsAgo(now, 5),
        owner.sessionId,
      ]);

      // touchPresence proves liveness but must NOT renew the claim.
      await withTransaction(pool, (tx) => touchPresence(tx, owner.sessionId, now));

      const claims = await listActiveClaims(pool, wsId("acme"), "my-repo", now, STALE_AFTER_SECONDS, {
        excludeSessionId: viewer.sessionId,
      });
      expect(claims).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Announcement delivery ledger
  // -------------------------------------------------------------------------
  describe("fetchPendingAnnouncements / recordAnnouncementDeliveries", () => {
    it("returns a broadcast to everyone EXCEPT the sender", async () => {
      const now = new Date();
      const sender = await seedAgentAndSession(pool, { agentNameSuffix: "sender" });
      const recipient = await seedAgentAndSession(pool, { agentNameSuffix: "recip" });

      await withTransaction(pool, async (tx) => {
        await insertAnnouncement(tx, {
          workspaceId: wsId("acme"),
          repo: "my-repo",
          fromSessionId: sender.sessionId,
          targetAgentName: null, // broadcast
          body: "hello everyone",
        });
      });

      const recipientSession = await getSession(pool, wsId("acme"), recipient.sessionId);

      const announcements = await withTransaction(pool, (tx) =>
        fetchPendingAnnouncements(tx, recipientSession)
      );

      expect(announcements).toHaveLength(1);
      expect(announcements[0]!.body).toBe("hello everyone");
      expect(announcements[0]!.fromAgentName).toBe(sender.agentName);
      expect(announcements[0]!.targetAgentName).toBeNull();
    });

    it("does NOT return a broadcast to the sender themselves", async () => {
      const now = new Date();
      const sender = await seedAgentAndSession(pool, { agentNameSuffix: "selfannounce" });

      await withTransaction(pool, async (tx) => {
        await insertAnnouncement(tx, {
          workspaceId: wsId("acme"),
          repo: "my-repo",
          fromSessionId: sender.sessionId,
          targetAgentName: null,
          body: "I am talking to myself",
        });
      });

      const senderSession = await getSession(pool, wsId("acme"), sender.sessionId);

      const announcements = await withTransaction(pool, (tx) =>
        fetchPendingAnnouncements(tx, senderSession)
      );

      expect(announcements).toHaveLength(0);
    });

    it("returns a targeted announcement ONLY to the named agent's session", async () => {
      const now = new Date();
      const sender = await seedAgentAndSession(pool, { agentNameSuffix: "sender2" });
      const target = await seedAgentAndSession(pool, { agentNameSuffix: "target" });
      const bystander = await seedAgentAndSession(pool, { agentNameSuffix: "bystander" });

      await withTransaction(pool, async (tx) => {
        await insertAnnouncement(tx, {
          workspaceId: wsId("acme"),
          repo: "my-repo",
          fromSessionId: sender.sessionId,
          targetAgentName: target.agentName,
          body: "targeted message",
        });
      });

      const targetSession = await getSession(pool, wsId("acme"), target.sessionId);
      const bystanderSession = await getSession(pool, wsId("acme"), bystander.sessionId);

      const targetAnnouncements = await withTransaction(pool, (tx) =>
        fetchPendingAnnouncements(tx, targetSession)
      );
      expect(targetAnnouncements).toHaveLength(1);
      expect(targetAnnouncements[0]!.body).toBe("targeted message");

      const bystanderAnnouncements = await withTransaction(pool, (tx) =>
        fetchPendingAnnouncements(tx, bystanderSession)
      );
      expect(bystanderAnnouncements).toHaveLength(0);
    });

    it("after recordAnnouncementDeliveries the same session does NOT get those again", async () => {
      const now = new Date();
      const sender = await seedAgentAndSession(pool, { agentNameSuffix: "sender3" });
      const recipient = await seedAgentAndSession(pool, { agentNameSuffix: "recip2" });

      let announcementId: number;
      await withTransaction(pool, async (tx) => {
        announcementId = await insertAnnouncement(tx, {
          workspaceId: wsId("acme"),
          repo: "my-repo",
          fromSessionId: sender.sessionId,
          targetAgentName: null,
          body: "deliver once",
        });
      });

      const recipientSession = await getSession(pool, wsId("acme"), recipient.sessionId);

      // First fetch — should have 1 announcement.
      const first = await withTransaction(pool, (tx) =>
        fetchPendingAnnouncements(tx, recipientSession)
      );
      expect(first).toHaveLength(1);

      // Record delivery.
      await withTransaction(pool, (tx) =>
        recordAnnouncementDeliveries(tx, recipient.sessionId, [announcementId!])
      );

      // Second fetch — should be empty.
      const second = await withTransaction(pool, (tx) =>
        fetchPendingAnnouncements(tx, recipientSession)
      );
      expect(second).toHaveLength(0);
    });

    it("a DIFFERENT session still gets the announcement after another session records delivery", async () => {
      const now = new Date();
      const sender = await seedAgentAndSession(pool, { agentNameSuffix: "sender4" });
      const recipA = await seedAgentAndSession(pool, { agentNameSuffix: "recipA" });
      const recipB = await seedAgentAndSession(pool, { agentNameSuffix: "recipB" });

      let announcementId: number;
      await withTransaction(pool, async (tx) => {
        announcementId = await insertAnnouncement(tx, {
          workspaceId: wsId("acme"),
          repo: "my-repo",
          fromSessionId: sender.sessionId,
          targetAgentName: null,
          body: "broadcast for all",
        });
      });

      const recipASession = await getSession(pool, wsId("acme"), recipA.sessionId);
      const recipBSession = await getSession(pool, wsId("acme"), recipB.sessionId);

      // Session A records delivery.
      await withTransaction(pool, (tx) =>
        recordAnnouncementDeliveries(tx, recipA.sessionId, [announcementId!])
      );

      // Session B should still get the announcement.
      const recipBPending = await withTransaction(pool, (tx) =>
        fetchPendingAnnouncements(tx, recipBSession)
      );
      expect(recipBPending).toHaveLength(1);
      expect(recipBPending[0]!.body).toBe("broadcast for all");
    });

    it("recordAnnouncementDeliveries is idempotent (ON CONFLICT DO NOTHING)", async () => {
      const now = new Date();
      const sender = await seedAgentAndSession(pool, { agentNameSuffix: "sender5" });
      const recipient = await seedAgentAndSession(pool, { agentNameSuffix: "recip3" });

      let announcementId: number;
      await withTransaction(pool, async (tx) => {
        announcementId = await insertAnnouncement(tx, {
          workspaceId: wsId("acme"),
          repo: "my-repo",
          fromSessionId: sender.sessionId,
          targetAgentName: null,
          body: "idempotent test",
        });
      });

      const recipientSession = await getSession(pool, wsId("acme"), recipient.sessionId);

      // Record delivery twice — should not throw.
      await withTransaction(pool, (tx) =>
        recordAnnouncementDeliveries(tx, recipient.sessionId, [announcementId!])
      );
      await expect(
        withTransaction(pool, (tx) =>
          recordAnnouncementDeliveries(tx, recipient.sessionId, [announcementId!])
        )
      ).resolves.not.toThrow();

      // Still not pending.
      const pending = await withTransaction(pool, (tx) =>
        fetchPendingAnnouncements(tx, recipientSession)
      );
      expect(pending).toHaveLength(0);
    });

    it("recordAnnouncementDeliveries is a no-op for an empty list", async () => {
      await expect(
        withTransaction(pool, (tx) =>
          recordAnnouncementDeliveries(tx, "00000000-0000-0000-0000-000000000000", [])
        )
      ).resolves.not.toThrow();
    });

    /**
     * Out-of-order commit guard (P1-2 regression).
     *
     * Full two-connection test is not easy with the current harness (we can't
     * hold an uncommitted transaction open while another commits). We instead
     * assert the equivalent invariant: recordAnnouncementDeliveries only marks
     * the IDs it is given as delivered; any ID never passed to it remains
     * pending. This proves that delivery is a strict ledger — an announcement
     * not explicitly handed to the function will keep appearing in future fetches.
     */
    it("P1-2 regression: only explicitly handed IDs are marked delivered; unhanded IDs remain pending", async () => {
      const now = new Date();
      const sender = await seedAgentAndSession(pool, { agentNameSuffix: "p12sender" });
      const recipient = await seedAgentAndSession(pool, { agentNameSuffix: "p12recip" });

      let idLow: number;
      let idHigh: number;

      await withTransaction(pool, async (tx) => {
        idLow = await insertAnnouncement(tx, {
          workspaceId: wsId("acme"),
          repo: "my-repo",
          fromSessionId: sender.sessionId,
          targetAgentName: null,
          body: "low id announcement",
        });
        idHigh = await insertAnnouncement(tx, {
          workspaceId: wsId("acme"),
          repo: "my-repo",
          fromSessionId: sender.sessionId,
          targetAgentName: null,
          body: "high id announcement",
        });
      });

      // Only record delivery for the HIGH id (simulates: low id not yet seen).
      await withTransaction(pool, (tx) =>
        recordAnnouncementDeliveries(tx, recipient.sessionId, [idHigh!])
      );

      const recipientSession = await getSession(pool, wsId("acme"), recipient.sessionId);

      // Low id should still appear as pending.
      const pending = await withTransaction(pool, (tx) =>
        fetchPendingAnnouncements(tx, recipientSession)
      );

      expect(pending).toHaveLength(1);
      expect(pending[0]!.body).toBe("low id announcement");
      expect(Number(pending[0]!.id)).toBe(idLow!);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Workspace scoping
  // -------------------------------------------------------------------------
  describe("workspace scoping", () => {
    it("a work_item in workspace A is invisible to listActiveClaims for workspace B", async () => {
      const now = new Date();

      // Agent in workspace "alpha"
      const ownerAlpha = await seedAgentAndSession(pool, {
        workspaceId: wsId("alpha"),
        repo: "shared-repo",
        agentNameSuffix: "wsA",
        human: "alice",
        program: "prog",
        model: "claude-3",
      });

      await withTransaction(pool, async (tx) => {
        await insertWorkItem(tx, {
          workspaceId: wsId("alpha"),
          sessionId: ownerAlpha.sessionId,
          repo: "shared-repo",
          intentText: "claim in alpha",
          pathGlobs: ["**/*"],
          ttlSeconds: 300,
          expiresAt: secsFromNow(now, 300),
        });
      });

      // Viewer in workspace "beta" — different workspace, same repo name
      const viewerBeta = await seedAgentAndSession(pool, {
        workspaceId: wsId("beta"),
        repo: "shared-repo",
        agentNameSuffix: "wsB",
        human: "bob",
        program: "prog",
        model: "claude-3",
      });

      const claims = await listActiveClaims(pool, wsId("beta"), "shared-repo", now, STALE_AFTER_SECONDS, {
        excludeSessionId: viewerBeta.sessionId,
      });

      expect(claims).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 6. getSession
  // -------------------------------------------------------------------------
  describe("getSession", () => {
    it("returns session with agentName joined from agents table", async () => {
      const { sessionId, agentName } = await seedAgentAndSession(pool, {
        agentNameSuffix: "gstest",
      });

      const session = await getSession(pool, wsId("acme"), sessionId);

      expect(session.id).toBe(sessionId);
      expect(session.agentName).toBe(agentName);
      expect(session.workspaceId).toBe(wsId("acme"));
      expect(session.repo).toBe("my-repo");
    });

    it("throws UnknownSessionError for a missing sessionId", async () => {
      const { UnknownSessionError } = await import("../src/errors.js");
      await expect(
        getSession(pool, wsId("acme"), "00000000-0000-0000-0000-000000000000")
      ).rejects.toBeInstanceOf(UnknownSessionError);
    });
  });

  // -------------------------------------------------------------------------
  // 7. releaseWorkItem
  // -------------------------------------------------------------------------
  describe("releaseWorkItem", () => {
    it("releases an active work_item and returns rowCount 1", async () => {
      const now = new Date();
      const { sessionId } = await seedAgentAndSession(pool, { agentNameSuffix: "rel" });

      const workItemId = await withTransaction(pool, (tx) =>
        insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId,
          repo: "my-repo",
          intentText: "to be released",
          pathGlobs: ["**/*"],
          ttlSeconds: 300,
          expiresAt: secsFromNow(now, 300),
        })
      );

      const rowCount = await withTransaction(pool, (tx) =>
        releaseWorkItem(tx, sessionId, workItemId, now)
      );
      expect(rowCount).toBe(1);

      const { rows } = await pool.query<{ status: string }>(
        `SELECT status FROM work_items WHERE id = $1`,
        [workItemId]
      );
      expect(rows[0]!.status).toBe("released");
    });

    it("returns 0 (idempotent) when the work_item is already released", async () => {
      const now = new Date();
      const { sessionId } = await seedAgentAndSession(pool, { agentNameSuffix: "rel2" });

      const workItemId = await withTransaction(pool, (tx) =>
        insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId,
          repo: "my-repo",
          intentText: "release twice",
          pathGlobs: ["**/*"],
          ttlSeconds: 300,
          expiresAt: secsFromNow(now, 300),
        })
      );

      await withTransaction(pool, (tx) =>
        releaseWorkItem(tx, sessionId, workItemId, now)
      );
      const secondRowCount = await withTransaction(pool, (tx) =>
        releaseWorkItem(tx, sessionId, workItemId, now)
      );
      expect(secondRowCount).toBe(0);
    });

    it("returns 0 when sessionId does not own the work_item (owner-scoped)", async () => {
      const now = new Date();
      const owner = await seedAgentAndSession(pool, { agentNameSuffix: "relowner" });
      const other = await seedAgentAndSession(pool, { agentNameSuffix: "relother" });

      const workItemId = await withTransaction(pool, (tx) =>
        insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId: owner.sessionId,
          repo: "my-repo",
          intentText: "owner's claim",
          pathGlobs: ["**/*"],
          ttlSeconds: 300,
          expiresAt: secsFromNow(now, 300),
        })
      );

      const rowCount = await withTransaction(pool, (tx) =>
        releaseWorkItem(tx, other.sessionId, workItemId, now)
      );
      expect(rowCount).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Task 2.4 — identity recycling + change records
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)("repo — Task 2.4 (identity + change records)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
    await seedWorkspaces(pool);
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await cleanupWorkspaces(pool);
    await pool.end();
  });

  // -------------------------------------------------------------------------
  // reservedAgentNamesForHandle
  // -------------------------------------------------------------------------
  describe("reservedAgentNamesForHandle", () => {
    it("returns names in the handle family with a live session; excludes stale-and-unreferenced and out-of-family", async () => {
      const now = new Date();
      // Live members of the "alex" family.
      await seedNamedAgentWithSession(pool, {
        name: "alex-1",
        heartbeatAt: secsAgo(now, 10),
      });
      await seedNamedAgentWithSession(pool, {
        name: "alex-2",
        heartbeatAt: secsAgo(now, 10),
      });
      // Stale member of the family with NO claims and NO change records → its
      // ordinal is free to recycle, so it must NOT be reserved.
      await seedNamedAgentWithSession(pool, {
        name: "alex-3",
        heartbeatAt: secsAgo(now, STALE_AFTER_SECONDS + 5),
      });
      // Live agent OUTSIDE the family.
      await seedNamedAgentWithSession(pool, {
        name: "jordan-1",
        heartbeatAt: secsAgo(now, 10),
      });

      const names = await reservedAgentNamesForHandle(
        pool,
        wsId("acme"),
        "alex",
        now,
        STALE_AFTER_SECONDS,
        CHANGE_RECORD_TTL_SECONDS,
        UNCOMMITTED_GRACE_SECONDS
      );

      expect(names.sort()).toEqual(["alex-1", "alex-2"]);
    });

    it("#2: reserves a stale session's name while it holds an active, non-expired claim", async () => {
      const now = new Date();
      // Stale session (would be unreserved on presence alone)...
      const stale = await seedNamedAgentWithSession(pool, {
        name: "alex-1",
        heartbeatAt: secsAgo(now, STALE_AFTER_SECONDS + 5),
      });
      // ...but it still holds a live claim, so its name must stay parked.
      await withTransaction(pool, async (tx) => {
        await insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId: stale.sessionId!,
          repo: "my-repo",
          intentText: "unfinished work",
          pathGlobs: ["src/**"],
          ttlSeconds: 1800,
          expiresAt: secsFromNow(now, 1800),
        });
      });

      const names = await reservedAgentNamesForHandle(
        pool,
        wsId("acme"),
        "alex",
        now,
        STALE_AFTER_SECONDS,
        CHANGE_RECORD_TTL_SECONDS,
        UNCOMMITTED_GRACE_SECONDS
      );
      expect(names).toEqual(["alex-1"]);
    });

    it("#2: does NOT reserve a stale session whose claim has expired", async () => {
      const now = new Date();
      const stale = await seedNamedAgentWithSession(pool, {
        name: "alex-1",
        heartbeatAt: secsAgo(now, STALE_AFTER_SECONDS + 5),
      });
      // An expired claim is no longer outstanding, so it parks nothing.
      await withTransaction(pool, async (tx) => {
        await insertWorkItem(tx, {
          workspaceId: wsId("acme"),
          sessionId: stale.sessionId!,
          repo: "my-repo",
          intentText: "long-gone work",
          pathGlobs: ["src/**"],
          ttlSeconds: 1800,
          expiresAt: secsAgo(now, 5),
        });
      });

      const names = await reservedAgentNamesForHandle(
        pool,
        wsId("acme"),
        "alex",
        now,
        STALE_AFTER_SECONDS,
        CHANGE_RECORD_TTL_SECONDS,
        UNCOMMITTED_GRACE_SECONDS
      );
      expect(names).toEqual([]);
    });

    it("#2: reserves a stale session's name while it has an outstanding change record", async () => {
      const now = new Date();
      const stale = await seedNamedAgentWithSession(pool, {
        name: "alex-1",
        heartbeatAt: secsAgo(now, STALE_AFTER_SECONDS + 5),
      });
      await withTransaction(pool, async (tx) => {
        await replaceChangeRecords(tx, {
          agentId: stale.agentId,
          agentName: "alex-1",
          workspaceId: wsId("acme"),
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
        });
      });

      const names = await reservedAgentNamesForHandle(
        pool,
        wsId("acme"),
        "alex",
        now,
        STALE_AFTER_SECONDS,
        CHANGE_RECORD_TTL_SECONDS,
        UNCOMMITTED_GRACE_SECONDS
      );
      expect(names).toEqual(["alex-1"]);
    });

    it("#2: does NOT reserve a stale session whose change record has aged past the TTL", async () => {
      const now = new Date();
      const stale = await seedNamedAgentWithSession(pool, {
        name: "alex-1",
        heartbeatAt: secsAgo(now, STALE_AFTER_SECONDS + 5),
      });
      await withTransaction(pool, async (tx) => {
        await replaceChangeRecords(tx, {
          agentId: stale.agentId,
          agentName: "alex-1",
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "main",
          entries: [
            {
              kind: "committed",
              commitSha: "abc123",
              message: "ancient work",
              paths: ["src/auth/**"],
            },
          ],
        });
        // Backdate the record past the TTL so it no longer counts.
        await tx.query(
          `UPDATE change_records SET updated_at = $1 WHERE agent_id = $2`,
          [secsAgo(now, CHANGE_RECORD_TTL_SECONDS + 60), stale.agentId]
        );
      });

      const names = await reservedAgentNamesForHandle(
        pool,
        wsId("acme"),
        "alex",
        now,
        STALE_AFTER_SECONDS,
        CHANGE_RECORD_TTL_SECONDS,
        UNCOMMITTED_GRACE_SECONDS
      );
      expect(names).toEqual([]);
    });

    it("reserves a name whose only footprint is an UNCOMMITTED record, while within the grace window", async () => {
      const now = new Date();
      // Offline (past staleness) but still within the uncommitted grace window.
      const offline = await seedNamedAgentWithSession(pool, {
        name: "alex-1",
        heartbeatAt: secsAgo(now, STALE_AFTER_SECONDS + 5),
      });
      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId: offline.agentId,
          agentName: "alex-1",
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "feat",
          entries: [
            { kind: "uncommitted", commitSha: null, message: "wip", paths: ["src/x.ts"] },
          ],
        })
      );

      const names = await reservedAgentNamesForHandle(
        pool,
        wsId("acme"),
        "alex",
        now,
        STALE_AFTER_SECONDS,
        CHANGE_RECORD_TTL_SECONDS,
        UNCOMMITTED_GRACE_SECONDS
      );
      expect(names).toEqual(["alex-1"]);
    });

    it("does NOT reserve a name whose only footprint is an UNCOMMITTED record past the grace window", async () => {
      const now = new Date();
      // Session last alive beyond the grace window — its dirty snapshot is no
      // longer shown, so its ordinal must be free to recycle.
      const gone = await seedNamedAgentWithSession(pool, {
        name: "alex-1",
        heartbeatAt: secsAgo(now, UNCOMMITTED_GRACE_SECONDS + 60),
      });
      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId: gone.agentId,
          agentName: "alex-1",
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "feat",
          entries: [
            { kind: "uncommitted", commitSha: null, message: "wip", paths: ["src/x.ts"] },
          ],
        })
      );

      const names = await reservedAgentNamesForHandle(
        pool,
        wsId("acme"),
        "alex",
        now,
        STALE_AFTER_SECONDS,
        CHANGE_RECORD_TTL_SECONDS,
        UNCOMMITTED_GRACE_SECONDS
      );
      expect(names).toEqual([]);
    });

    it("is scoped by workspace", async () => {
      const now = new Date();
      await seedNamedAgentWithSession(pool, {
        workspaceId: wsId("other-ws"),
        name: "alex-1",
        heartbeatAt: secsAgo(now, 10),
      });

      const names = await reservedAgentNamesForHandle(
        pool,
        wsId("acme"),
        "alex",
        now,
        STALE_AFTER_SECONDS,
        CHANGE_RECORD_TTL_SECONDS,
        UNCOMMITTED_GRACE_SECONDS
      );
      expect(names).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // findAgentByName
  // -------------------------------------------------------------------------
  describe("findAgentByName", () => {
    it("returns the row for an existing (workspace, name)", async () => {
      const { agentId } = await seedNamedAgentWithSession(pool, {
        name: "casey-1",
        heartbeatAt: new Date(),
        withSession: false,
      });

      const found = await findAgentByName(pool, wsId("acme"), "casey-1");
      expect(found).not.toBeNull();
      expect(found!.id).toBe(agentId);
      expect(found!.name).toBe("casey-1");
    });

    it("returns null for an absent name", async () => {
      const found = await findAgentByName(pool, wsId("acme"), "nobody-9");
      expect(found).toBeNull();
    });

    it("is scoped by workspace", async () => {
      await seedNamedAgentWithSession(pool, {
        workspaceId: wsId("other-ws"),
        name: "casey-1",
        heartbeatAt: new Date(),
        withSession: false,
      });
      const found = await findAgentByName(pool, wsId("acme"), "casey-1");
      expect(found).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // createAgent with null/omitted model
  // -------------------------------------------------------------------------
  describe("createAgent with optional model", () => {
    it("inserts NULL when model is omitted and returns model: null", async () => {
      const created = await withTransaction(pool, (tx) =>
        createAgent(tx, {
          workspaceId: wsId("acme"),
          name: "nomodel-1",
          human: "alice",
          program: "prog",
        })
      );
      expect(created.model).toBeNull();
    });

    it("inserts NULL when model is explicitly null", async () => {
      const created = await withTransaction(pool, (tx) =>
        createAgent(tx, {
          workspaceId: wsId("acme"),
          name: "nomodel-2",
          human: "alice",
          program: "prog",
          model: null,
        })
      );
      expect(created.model).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // replaceChangeRecords
  // -------------------------------------------------------------------------
  describe("replaceChangeRecords", () => {
    async function countRecords(agentId: string): Promise<number> {
      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM change_records WHERE agent_id = $1`,
        [agentId]
      );
      return Number(rows[0]!.n);
    }

    it("wholesale-replaces uncommitted AND drops committed rows from a branch the agent left", async () => {
      const { agentId, agentName } = await seedNamedAgentWithSession(pool, {
        name: "rcr-1",
        heartbeatAt: new Date(),
        withSession: false,
      });

      // First report: one committed (aaa) + one uncommitted, on main.
      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId,
          agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "main",
          entries: [
            { kind: "committed", commitSha: "aaa", message: "first", paths: ["src/a.ts"] },
            { kind: "uncommitted", commitSha: null, message: null, paths: ["src/b.ts"] },
          ],
        })
      );
      expect(await countRecords(agentId)).toBe(2);

      // Second report on a DIFFERENT branch: a different committed, NO uncommitted.
      // `aaa` was on `main`, which this agent no longer reports → it is dropped
      // (no more 72h ghost on the abandoned branch). `bbb` is added; the prior
      // uncommitted is cleared.
      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId,
          agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "feature",
          entries: [
            { kind: "committed", commitSha: "bbb", message: "latest", paths: ["src/c.ts"] },
          ],
        })
      );

      const { rows } = await pool.query<{
        commit_sha: string | null;
        kind: string;
      }>(`SELECT commit_sha, kind FROM change_records WHERE agent_id = $1 ORDER BY commit_sha`, [
        agentId,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.kind).toBe("committed");
      expect(rows[0]!.commit_sha).toBe("bbb");
    });

    it("drops a committed row the agent stops reporting on the SAME branch (squash/rebase)", async () => {
      const { agentId, agentName } = await seedNamedAgentWithSession(pool, {
        name: "rcr-squash",
        heartbeatAt: new Date(),
        withSession: false,
      });

      // Two unlanded commits on main.
      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId,
          agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "main",
          entries: [
            { kind: "committed", commitSha: "p", message: "p", paths: ["src/p.ts"] },
            { kind: "committed", commitSha: "q", message: "q", paths: ["src/q.ts"] },
          ],
        })
      );
      expect(await countRecords(agentId)).toBe(2);

      // After a squash/rebase, `q` is gone from base..HEAD → next report omits it.
      // It must be removed, not linger 72h showing a wrong "unpushed" hint.
      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId,
          agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "main",
          entries: [
            { kind: "committed", commitSha: "p", message: "p", paths: ["src/p.ts"] },
          ],
        })
      );

      const { rows } = await pool.query<{ commit_sha: string | null }>(
        `SELECT commit_sha FROM change_records WHERE agent_id = $1`,
        [agentId]
      );
      expect(rows.map((r) => r.commit_sha)).toEqual(["p"]);
    });

    it("#6: a commit reported by two agents is stored once, owned by the first reporter", async () => {
      const a = await seedNamedAgentWithSession(pool, {
        name: "rcr-owner",
        heartbeatAt: new Date(),
        withSession: false,
      });
      const b = await seedNamedAgentWithSession(pool, {
        name: "rcr-puller",
        heartbeatAt: new Date(),
        withSession: false,
      });

      const reportShared = (agentId: string, agentName: string) =>
        withTransaction(pool, (tx) =>
          replaceChangeRecords(tx, {
            agentId,
            agentName,
            workspaceId: wsId("acme"),
            repo: "my-repo",
            branch: "main",
            entries: [
              { kind: "committed", commitSha: "shared", message: "shared work", paths: ["src/s.ts"] },
            ],
          })
        );

      await reportShared(a.agentId, a.agentName); // A commits it first → owns it
      await reportShared(b.agentId, b.agentName); // B pulled it; only refreshes

      const { rows } = await pool.query<{ agent_id: string; agent_name: string }>(
        `SELECT agent_id, agent_name FROM change_records
         WHERE workspace_id = $1 AND repo = 'my-repo' AND branch = 'main' AND commit_sha = 'shared'`,
        [wsId("acme")]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.agent_id).toBe(a.agentId);
      expect(rows[0]!.agent_name).toBe(a.agentName);
    });

    it("P1-1: the same commit reported under two DIFFERENT branches is stored once (per-commit dedup)", async () => {
      const a = await seedNamedAgentWithSession(pool, {
        name: "rcr-xbranch-a",
        heartbeatAt: new Date(),
        withSession: false,
      });
      const b = await seedNamedAgentWithSession(pool, {
        name: "rcr-xbranch-b",
        heartbeatAt: new Date(),
        withSession: false,
      });

      // A reports `merged` while on a feature branch (first reporter → owns the
      // row, snapshots branch="feat").
      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId: a.agentId,
          agentName: a.agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "feat",
          entries: [
            { kind: "committed", commitSha: "merged", message: "shared work", paths: ["src/s.ts"] },
          ],
        })
      );

      // B reports the SAME sha from `main` (it fast-forward-merged the branch).
      // Pre-009 this created a second row keyed on branch; now it dedups to one.
      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId: b.agentId,
          agentName: b.agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "main",
          entries: [
            { kind: "committed", commitSha: "merged", message: "shared work", paths: ["src/s.ts"] },
          ],
        })
      );

      const { rows } = await pool.query<{
        agent_id: string;
        agent_name: string;
        branch: string;
      }>(
        `SELECT agent_id, agent_name, branch FROM change_records
         WHERE workspace_id = $1 AND repo = 'my-repo' AND commit_sha = 'merged'`,
        [wsId("acme")]
      );
      expect(rows).toHaveLength(1);
      // First reporter still owns identity AND the branch snapshot.
      expect(rows[0]!.agent_id).toBe(a.agentId);
      expect(rows[0]!.agent_name).toBe(a.agentName);
      expect(rows[0]!.branch).toBe("feat");
    });

    it("empty entries clear ALL of the agent's rows (committed + uncommitted), leaving other agents' untouched", async () => {
      const a = await seedNamedAgentWithSession(pool, {
        name: "rcr-a",
        heartbeatAt: new Date(),
        withSession: false,
      });
      const b = await seedNamedAgentWithSession(pool, {
        name: "rcr-b",
        heartbeatAt: new Date(),
        withSession: false,
      });

      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId: a.agentId,
          agentName: a.agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "main",
          entries: [
            { kind: "committed", commitSha: "x", message: "m", paths: ["src/x.ts"] },
            { kind: "uncommitted", commitSha: null, message: null, paths: ["src/xu.ts"] },
          ],
        })
      );
      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId: b.agentId,
          agentName: b.agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "main",
          entries: [
            { kind: "committed", commitSha: "y", message: "m", paths: ["src/y.ts"] },
          ],
        })
      );

      // A reports a clean tree (empty) — nothing dirty AND nothing unlanded. Both
      // its uncommitted and its committed rows clear; B's row is untouched (the
      // committed delete is scoped to agent_id).
      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId: a.agentId,
          agentName: a.agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "main",
          entries: [],
        })
      );

      expect(await countRecords(a.agentId)).toBe(0);
      const { rows: bRows } = await pool.query<{ commit_sha: string | null }>(
        `SELECT commit_sha FROM change_records WHERE agent_id = $1`,
        [b.agentId]
      );
      expect(bRows.map((r) => r.commit_sha)).toEqual(["y"]);
    });
  });

  // -------------------------------------------------------------------------
  // listOtherChangeRecords
  // -------------------------------------------------------------------------
  describe("listOtherChangeRecords", () => {
    it("returns only OTHER agents' records, with author presence enrichment", async () => {
      const now = new Date();
      const caller = await seedNamedAgentWithSession(pool, {
        name: "caller-1",
        heartbeatAt: secsAgo(now, 5),
      });
      const liveAuthor = await seedNamedAgentWithSession(pool, {
        name: "live-1",
        human: "bob",
        heartbeatAt: secsAgo(now, 10),
      });

      // Caller's own record (must be excluded).
      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId: caller.agentId,
          agentName: caller.agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "main",
          entries: [
            { kind: "committed", commitSha: "own", message: "mine", paths: ["src/own.ts"] },
          ],
        })
      );
      // Live author's record.
      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId: liveAuthor.agentId,
          agentName: liveAuthor.agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "feat",
          entries: [
            {
              kind: "uncommitted",
              commitSha: null,
              message: "wip",
              paths: ["src/live.ts"],
            },
          ],
        })
      );

      const records = await listOtherChangeRecords(
        pool,
        wsId("acme"),
        "my-repo",
        caller.agentId,
        now,
        STALE_AFTER_SECONDS,
        UNCOMMITTED_GRACE_SECONDS
      );

      expect(records).toHaveLength(1);
      const r = records[0]!;
      expect(r.agentName).toBe("live-1");
      expect(r.human).toBe("bob");
      expect(r.branch).toBe("feat");
      expect(r.kind).toBe("uncommitted");
      expect(r.commitSha).toBeNull();
      expect(r.message).toBe("wip");
      expect(r.paths).toEqual(["src/live.ts"]);
      expect(r.authorIsLive).toBe(true);
      expect(typeof r.authorLastActiveAt).toBe("string");
      expect(typeof r.updatedAt).toBe("string");
    });

    it("authorIsLive is false when the author's heartbeat is older than staleAfterSeconds", async () => {
      const now = new Date();
      const caller = await seedNamedAgentWithSession(pool, {
        name: "caller-2",
        heartbeatAt: secsAgo(now, 5),
      });
      const staleAuthor = await seedNamedAgentWithSession(pool, {
        name: "stale-1",
        heartbeatAt: secsAgo(now, STALE_AFTER_SECONDS + 30),
      });

      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId: staleAuthor.agentId,
          agentName: staleAuthor.agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "feat",
          entries: [
            { kind: "committed", commitSha: "s", message: "m", paths: ["src/s.ts"] },
          ],
        })
      );

      const records = await listOtherChangeRecords(
        pool,
        wsId("acme"),
        "my-repo",
        caller.agentId,
        now,
        STALE_AFTER_SECONDS,
        UNCOMMITTED_GRACE_SECONDS
      );
      expect(records).toHaveLength(1);
      expect(records[0]!.authorIsLive).toBe(false);
    });

    it("an author with NO session still has its records returned with authorIsLive=false", async () => {
      const now = new Date();
      const caller = await seedNamedAgentWithSession(pool, {
        name: "caller-3",
        heartbeatAt: secsAgo(now, 5),
      });
      const noSession = await seedNamedAgentWithSession(pool, {
        name: "nosess-1",
        heartbeatAt: now,
        withSession: false,
      });

      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId: noSession.agentId,
          agentName: noSession.agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "feat",
          entries: [
            { kind: "committed", commitSha: "n", message: "m", paths: ["src/n.ts"] },
          ],
        })
      );

      const records = await listOtherChangeRecords(
        pool,
        wsId("acme"),
        "my-repo",
        caller.agentId,
        now,
        STALE_AFTER_SECONDS,
        UNCOMMITTED_GRACE_SECONDS
      );
      expect(records).toHaveLength(1);
      expect(records[0]!.authorIsLive).toBe(false);
      expect(typeof records[0]!.authorLastActiveAt).toBe("string");
    });

    it("excludes an UNCOMMITTED record when the author is past the grace window", async () => {
      const now = new Date();
      const caller = await seedNamedAgentWithSession(pool, {
        name: "caller-4",
        heartbeatAt: secsAgo(now, 5),
      });
      const staleAuthor = await seedNamedAgentWithSession(pool, {
        name: "stale-2",
        heartbeatAt: secsAgo(now, UNCOMMITTED_GRACE_SECONDS + 30),
      });

      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId: staleAuthor.agentId,
          agentName: staleAuthor.agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "feat",
          entries: [
            { kind: "uncommitted", commitSha: null, message: "wip", paths: ["src/u.ts"] },
          ],
        })
      );

      const records = await listOtherChangeRecords(
        pool,
        wsId("acme"),
        "my-repo",
        caller.agentId,
        now,
        STALE_AFTER_SECONDS,
        UNCOMMITTED_GRACE_SECONDS
      );
      // Past the grace window the "may change" hint is dropped — a long-dead
      // session can no longer change anything.
      expect(records).toHaveLength(0);
    });

    it("KEEPS an UNCOMMITTED record while the author is offline but within the grace window", async () => {
      const now = new Date();
      const caller = await seedNamedAgentWithSession(pool, {
        name: "caller-grace",
        heartbeatAt: secsAgo(now, 5),
      });
      // Past staleness (offline label) but still inside the grace window — e.g. a
      // just-crashed agent that may restart and resume these edits.
      const offlineAuthor = await seedNamedAgentWithSession(pool, {
        name: "offline-grace",
        heartbeatAt: secsAgo(now, STALE_AFTER_SECONDS + 30),
      });

      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId: offlineAuthor.agentId,
          agentName: offlineAuthor.agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "feat",
          entries: [
            { kind: "uncommitted", commitSha: null, message: "wip", paths: ["src/u.ts"] },
          ],
        })
      );

      const records = await listOtherChangeRecords(
        pool,
        wsId("acme"),
        "my-repo",
        caller.agentId,
        now,
        STALE_AFTER_SECONDS,
        UNCOMMITTED_GRACE_SECONDS
      );
      expect(records).toHaveLength(1);
      expect(records[0]!.kind).toBe("uncommitted");
      // Shown for awareness, but honestly labelled offline (not live).
      expect(records[0]!.authorIsLive).toBe(false);
    });

    it("excludes an UNCOMMITTED record when the author has NO session", async () => {
      const now = new Date();
      const caller = await seedNamedAgentWithSession(pool, {
        name: "caller-5",
        heartbeatAt: secsAgo(now, 5),
      });
      const noSession = await seedNamedAgentWithSession(pool, {
        name: "nosess-2",
        heartbeatAt: now,
        withSession: false,
      });

      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId: noSession.agentId,
          agentName: noSession.agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "feat",
          entries: [
            { kind: "uncommitted", commitSha: null, message: "wip", paths: ["src/u.ts"] },
          ],
        })
      );

      const records = await listOtherChangeRecords(
        pool,
        wsId("acme"),
        "my-repo",
        caller.agentId,
        now,
        STALE_AFTER_SECONDS,
        UNCOMMITTED_GRACE_SECONDS
      );
      expect(records).toHaveLength(0);
    });

    it("keeps a past-grace author's COMMITTED record but drops their UNCOMMITTED one", async () => {
      const now = new Date();
      const caller = await seedNamedAgentWithSession(pool, {
        name: "caller-6",
        heartbeatAt: secsAgo(now, 5),
      });
      const staleAuthor = await seedNamedAgentWithSession(pool, {
        name: "stale-3",
        heartbeatAt: secsAgo(now, UNCOMMITTED_GRACE_SECONDS + 30),
      });

      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId: staleAuthor.agentId,
          agentName: staleAuthor.agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "feat",
          entries: [
            { kind: "committed", commitSha: "abc123", message: "landed", paths: ["src/c.ts"] },
            { kind: "uncommitted", commitSha: null, message: "wip", paths: ["src/u.ts"] },
          ],
        })
      );

      const records = await listOtherChangeRecords(
        pool,
        wsId("acme"),
        "my-repo",
        caller.agentId,
        now,
        STALE_AFTER_SECONDS,
        UNCOMMITTED_GRACE_SECONDS
      );
      expect(records).toHaveLength(1);
      expect(records[0]!.kind).toBe("committed");
      expect(records[0]!.authorIsLive).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // pruneChangeRecords
  // -------------------------------------------------------------------------
  describe("pruneChangeRecords", () => {
    it("deletes records older than TTL, keeps fresh, and is scoped by (workspace, repo)", async () => {
      const now = new Date();
      const agent = await seedNamedAgentWithSession(pool, {
        name: "prune-1",
        heartbeatAt: now,
        withSession: false,
      });

      // Insert one stale + one fresh in (acme, my-repo), and one fresh in another repo.
      await withTransaction(pool, async (tx) => {
        await replaceChangeRecords(tx, {
          agentId: agent.agentId,
          agentName: agent.agentName,
          workspaceId: wsId("acme"),
          repo: "my-repo",
          branch: "main",
          entries: [
            { kind: "committed", commitSha: "old", message: "old", paths: ["src/old.ts"] },
            { kind: "committed", commitSha: "new", message: "new", paths: ["src/new.ts"] },
          ],
        });
      });
      // Backdate the "old" one well past TTL.
      const ttlSeconds = 3600;
      await pool.query(
        `UPDATE change_records SET updated_at = $1 WHERE commit_sha = 'old'`,
        [secsAgo(now, ttlSeconds + 100)]
      );
      // A record in a DIFFERENT repo, also stale — must survive (scoped prune).
      // Authored by a DIFFERENT agent because replaceChangeRecords is per-agent
      // wholesale (it would otherwise delete this same agent's my-repo rows).
      const other = await seedNamedAgentWithSession(pool, {
        name: "prune-2",
        heartbeatAt: now,
        withSession: false,
      });
      await withTransaction(pool, (tx) =>
        replaceChangeRecords(tx, {
          agentId: other.agentId,
          agentName: other.agentName,
          workspaceId: wsId("acme"),
          repo: "other-repo",
          branch: "main",
          entries: [
            { kind: "committed", commitSha: "otherrepo", message: "m", paths: ["x.ts"] },
          ],
        })
      );
      await pool.query(
        `UPDATE change_records SET updated_at = $1 WHERE commit_sha = 'otherrepo'`,
        [secsAgo(now, ttlSeconds + 100)]
      );

      await withTransaction(pool, (tx) =>
        pruneChangeRecords(tx, wsId("acme"), "my-repo", now, ttlSeconds)
      );

      const { rows } = await pool.query<{ commit_sha: string | null }>(
        `SELECT commit_sha FROM change_records ORDER BY commit_sha`
      );
      const shas = rows.map((r) => r.commit_sha).sort();
      // "old" deleted; "new" kept; "otherrepo" kept (different repo).
      expect(shas).toEqual(["new", "otherrepo"]);
    });
  });

  // -------------------------------------------------------------------------
  // updateSessionBranch
  // -------------------------------------------------------------------------
  describe("updateSessionBranch", () => {
    it("changes sessions.branch and a subsequent read reflects it", async () => {
      const { sessionId } = await seedNamedAgentWithSession(pool, {
        name: "branch-1",
        heartbeatAt: new Date(),
      });

      await withTransaction(pool, (tx) =>
        updateSessionBranch(tx, sessionId!, "new-branch")
      );

      const session = await getSession(pool, wsId("acme"), sessionId!);
      expect(session.branch).toBe("new-branch");
    });
  });
});

// ---------------------------------------------------------------------------
// Wallboard — getWorkspaceLandscape (whole-workspace read)
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)("repo — getWorkspaceLandscape", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
    await seedWorkspaces(pool);
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    await cleanupWorkspaces(pool);
    await pool.end();
  });

  describe("agents list", () => {
    it("returns every agent in the workspace joined to its most-recent session", async () => {
      const now = new Date();
      const withSess = await seedNamedAgentWithSession(pool, {
        workspaceId: wsId("acme"),
        repo: "my-repo",
        branch: "feat/x",
        name: "WithSession-1",
        human: "alice",
        heartbeatAt: secsAgo(now, 10),
      });

      const result = await getWorkspaceLandscape(pool, wsId("acme"), now, STALE_AFTER_SECONDS);

      expect(result.agents).toHaveLength(1);
      const a = result.agents[0]!;
      expect(a.name).toBe(withSess.agentName);
      expect(a.human).toBe("alice");
      expect(a.repo).toBe("my-repo");
      expect(a.branch).toBe("feat/x");
      expect(a.lastHeartbeatAt).toBeInstanceOf(Date);
    });

    it("a sessionless agent has null repo/branch/lastHeartbeatAt", async () => {
      const now = new Date();
      await seedNamedAgentWithSession(pool, {
        workspaceId: wsId("acme"),
        name: "NoSession-1",
        heartbeatAt: now,
        withSession: false,
      });

      const result = await getWorkspaceLandscape(pool, wsId("acme"), now, STALE_AFTER_SECONDS);
      expect(result.agents).toHaveLength(1);
      const a = result.agents[0]!;
      expect(a.repo).toBeNull();
      expect(a.branch).toBeNull();
      expect(a.lastHeartbeatAt).toBeNull();
    });

    it("uses the most-recent session when an agent has several", async () => {
      const now = new Date();
      const seeded = await seedNamedAgentWithSession(pool, {
        workspaceId: wsId("acme"),
        repo: "my-repo",
        branch: "old-branch",
        name: "Multi-1",
        heartbeatAt: secsAgo(now, 600),
      });
      // A newer session on a different branch.
      await withTransaction(pool, async (tx) => {
        const s = await createSession(tx, {
          workspaceId: wsId("acme"),
          agentId: seeded.agentId,
          repo: "my-repo",
          branch: "new-branch",
        });
        await tx.query(`UPDATE sessions SET last_heartbeat_at = $1 WHERE id = $2`, [
          secsAgo(now, 5),
          s.id,
        ]);
      });

      const result = await getWorkspaceLandscape(pool, wsId("acme"), now, STALE_AFTER_SECONDS);
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0]!.branch).toBe("new-branch");
    });

    it("is scoped to the requested workspace", async () => {
      const now = new Date();
      await seedNamedAgentWithSession(pool, {
        workspaceId: wsId("other-ws"),
        name: "Elsewhere-1",
        heartbeatAt: now,
      });
      const result = await getWorkspaceLandscape(pool, wsId("acme"), now, STALE_AFTER_SECONDS);
      expect(result.agents).toHaveLength(0);
    });
  });

  describe("tasks list", () => {
    it("returns a live-owner active claim as status 'active' with endedAt null", async () => {
      const now = new Date();
      const owner = await seedNamedAgentWithSession(pool, {
        workspaceId: wsId("acme"), repo: "my-repo", name: "Owner-1", heartbeatAt: secsAgo(now, 8),
      });
      await withTransaction(pool, (tx) =>
        insertWorkItem(tx, {
          workspaceId: wsId("acme"), sessionId: owner.sessionId!, repo: "my-repo",
          intentText: "claim intent", pathGlobs: ["src/feed/**"],
          ttlSeconds: 300, expiresAt: secsFromNow(now, 300),
        })
      );

      const result = await getWorkspaceLandscape(pool, wsId("acme"), now, STALE_AFTER_SECONDS);
      expect(result.tasks).toHaveLength(1);
      const t = result.tasks[0]!;
      expect(t.agentName).toBe("Owner-1");
      expect(t.intent).toBe("claim intent");
      expect(t.repo).toBe("my-repo");
      expect(t.pathGlobs).toEqual(["src/feed/**"]);
      expect(t.status).toBe("active");
      expect(t.endedAt).toBeNull();
      expect(t.createdAt).toBeInstanceOf(Date);
    });

    it("returns a released claim as status 'done' with endedAt = released_at", async () => {
      const now = new Date();
      const owner = await seedNamedAgentWithSession(pool, {
        workspaceId: wsId("acme"), repo: "my-repo", name: "Owner-2", heartbeatAt: secsAgo(now, 8),
      });
      const id = await withTransaction(pool, (tx) =>
        insertWorkItem(tx, {
          workspaceId: wsId("acme"), sessionId: owner.sessionId!, repo: "my-repo",
          intentText: "done work", pathGlobs: ["**/*"],
          ttlSeconds: 300, expiresAt: secsFromNow(now, 300),
        })
      );
      await withTransaction(pool, (tx) => releaseWorkItem(tx, owner.sessionId!, id, now));

      const result = await getWorkspaceLandscape(pool, wsId("acme"), now, STALE_AFTER_SECONDS);
      const done = result.tasks.find((t) => t.intent === "done work")!;
      expect(done.status).toBe("done");
      expect(done.endedAt).toBeInstanceOf(Date);
    });

    it("returns an unreleased claim whose owner is STALE as status 'dropped'", async () => {
      const now = new Date();
      const owner = await seedNamedAgentWithSession(pool, {
        workspaceId: wsId("acme"), repo: "my-repo", name: "StaleOwner",
        heartbeatAt: secsAgo(now, STALE_AFTER_SECONDS + 60),
      });
      await withTransaction(pool, (tx) =>
        insertWorkItem(tx, {
          workspaceId: wsId("acme"), sessionId: owner.sessionId!, repo: "my-repo",
          intentText: "abandoned", pathGlobs: ["**/*"],
          ttlSeconds: 9999, expiresAt: secsFromNow(now, 9999),
        })
      );

      const result = await getWorkspaceLandscape(pool, wsId("acme"), now, STALE_AFTER_SECONDS);
      const dropped = result.tasks.find((t) => t.intent === "abandoned")!;
      expect(dropped.status).toBe("dropped");
      expect(dropped.endedAt).toBeInstanceOf(Date); // owner's last heartbeat
    });

    it("classifies a claim exactly AT the staleness boundary as 'dropped' (board mirrors listActiveClaims' strict-'>' liveness)", async () => {
      // `now` is injected, so this exact-boundary case is deterministic, not
      // flaky. The board's active set uses `last_heartbeat_at > now - boundary`
      // (matching listActiveClaims / the conflict path), so a heartbeat exactly
      // AT the boundary is NOT active and falls to the history `<=` branch as
      // dropped — even though presenceFor would still read the agent as "live"
      // at that same instant. Documents that deliberate one-instant divergence.
      const now = new Date();
      const owner = await seedNamedAgentWithSession(pool, {
        workspaceId: wsId("acme"), repo: "my-repo", name: "BoundaryOwner",
        heartbeatAt: secsAgo(now, STALE_AFTER_SECONDS),
      });
      await withTransaction(pool, (tx) =>
        insertWorkItem(tx, {
          workspaceId: wsId("acme"), sessionId: owner.sessionId!, repo: "my-repo",
          intentText: "at the boundary", pathGlobs: ["**/*"],
          ttlSeconds: 9999, expiresAt: secsFromNow(now, 9999),
        })
      );

      const result = await getWorkspaceLandscape(pool, wsId("acme"), now, STALE_AFTER_SECONDS);
      const task = result.tasks.find((t) => t.intent === "at the boundary")!;
      expect(task.status).toBe("dropped");
    });
  });

  describe("announcements list", () => {
    it("returns announcements newest-first", async () => {
      const now = new Date();
      const sender = await seedNamedAgentWithSession(pool, {
        workspaceId: wsId("acme"),
        repo: "my-repo",
        name: "Sender-1",
        human: "alice",
        heartbeatAt: now,
      });
      await withTransaction(pool, async (tx) => {
        await insertAnnouncement(tx, {
          workspaceId: wsId("acme"),
          repo: "my-repo",
          fromSessionId: sender.sessionId!,
          targetAgentName: null,
          body: "first",
        });
        await insertAnnouncement(tx, {
          workspaceId: wsId("acme"),
          repo: "my-repo",
          fromSessionId: sender.sessionId!,
          targetAgentName: "Someone",
          body: "second",
        });
      });

      const result = await getWorkspaceLandscape(pool, wsId("acme"), now, STALE_AFTER_SECONDS);
      expect(result.announcements).toHaveLength(2);
      expect(result.announcements[0]!.body).toBe("second");
      expect(result.announcements[0]!.fromAgentName).toBe("Sender-1");
      expect(result.announcements[0]!.fromHuman).toBe("alice");
      expect(result.announcements[0]!.targetAgentName).toBe("Someone");
      expect(result.announcements[1]!.body).toBe("first");
      expect(result.announcements[1]!.targetAgentName).toBeNull();
    });

    it("caps the feed at 50, keeping the most recent", async () => {
      const now = new Date();
      const sender = await seedNamedAgentWithSession(pool, {
        workspaceId: wsId("acme"),
        repo: "my-repo",
        name: "Sender-2",
        heartbeatAt: now,
      });
      await withTransaction(pool, async (tx) => {
        for (let i = 0; i < 55; i++) {
          await insertAnnouncement(tx, {
            workspaceId: wsId("acme"),
            repo: "my-repo",
            fromSessionId: sender.sessionId!,
            targetAgentName: null,
            body: `msg-${i}`,
          });
        }
      });

      const result = await getWorkspaceLandscape(pool, wsId("acme"), now, STALE_AFTER_SECONDS);
      expect(result.announcements).toHaveLength(50);
      // Newest first => msg-54 is first; the oldest 5 (msg-0..msg-4) are dropped.
      expect(result.announcements[0]!.body).toBe("msg-54");
      expect(result.announcements.some((a) => a.body === "msg-0")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// account_profiles — the BFF display snapshot
//
// The snapshot is refreshed on every browser-via-BFF request from trusted
// x-display-name / x-email / x-github-login / x-avatar-url headers. A request
// that authenticates the account but happens to omit one of those headers must
// NOT wipe the previously-good value: an absent header means "no news", not
// "erase it". Regression guard for the member roster collapsing to the raw
// accountId after a header-less request clobbered a good profile with NULLs.
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)("upsertAccountProfile — display snapshot", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
  });

  afterEach(async () => {
    await pool.query(`DELETE FROM account_profiles WHERE account_id LIKE 'prof-%'`);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("inserts a fresh profile row from the supplied headers", async () => {
    await upsertAccountProfile(pool, {
      accountId: "prof-new",
      displayName: "Korso Admin",
      githubLogin: null,
      email: null,
      avatarUrl: null,
    });

    const p = await getAccountProfile(pool, "prof-new");
    expect(p).toEqual({
      display_name: "Korso Admin",
      github_login: null,
      email: null,
    });
  });

  it("does NOT clobber a good display_name when a later request omits the header", async () => {
    // First request: the trusted BFF snapshot lands with a real name.
    await upsertAccountProfile(pool, {
      accountId: "prof-keep",
      displayName: "Korso Admin",
      githubLogin: null,
      email: null,
      avatarUrl: null,
    });

    // Second request authenticates the same account but arrives WITHOUT any
    // display headers (all null). The good name must survive.
    await upsertAccountProfile(pool, {
      accountId: "prof-keep",
      displayName: null,
      githubLogin: null,
      email: null,
      avatarUrl: null,
    });

    const p = await getAccountProfile(pool, "prof-keep");
    expect(p?.display_name).toBe("Korso Admin");
  });

  it("still overwrites with a NEW non-null value (updates are not blocked)", async () => {
    await upsertAccountProfile(pool, {
      accountId: "prof-update",
      displayName: "Old Name",
      githubLogin: "old-login",
      email: "old@example.com",
      avatarUrl: null,
    });

    await upsertAccountProfile(pool, {
      accountId: "prof-update",
      displayName: "New Name",
      githubLogin: null, // omitted this time — must be preserved
      email: "new@example.com",
      avatarUrl: null,
    });

    const p = await getAccountProfile(pool, "prof-update");
    expect(p).toEqual({
      display_name: "New Name",
      github_login: "old-login", // preserved from the first request
      email: "new@example.com",
    });
  });

  it("preserves avatar_url too when a later request omits it", async () => {
    await upsertAccountProfile(pool, {
      accountId: "prof-avatar",
      displayName: "Korso Admin",
      githubLogin: null,
      email: null,
      avatarUrl: "https://example.com/a.png",
    });
    await upsertAccountProfile(pool, {
      accountId: "prof-avatar",
      displayName: null,
      githubLogin: null,
      email: null,
      avatarUrl: null,
    });

    const { rows } = await pool.query<{ avatar_url: string | null }>(
      `SELECT avatar_url FROM account_profiles WHERE account_id = $1`,
      ["prof-avatar"]
    );
    expect(rows[0]?.avatar_url).toBe("https://example.com/a.png");
  });
});

// ---------------------------------------------------------------------------
// Pure (no DB) suite — always runs
// ---------------------------------------------------------------------------

describe("repo — pure (no Postgres needed)", () => {
  it("dbAvailable is a boolean", () => {
    expect(typeof dbAvailable).toBe("boolean");
  });

  it("HubError, UnknownSessionError, ValidationError are importable", async () => {
    const { HubError, UnknownSessionError, ValidationError } = await import(
      "../src/errors.js"
    );
    expect(new HubError("test")).toBeInstanceOf(Error);
    expect(new UnknownSessionError("abc")).toBeInstanceOf(HubError);
    expect(new ValidationError("bad")).toBeInstanceOf(HubError);
  });

  it("UnknownSessionError.name is UnknownSessionError", async () => {
    const { UnknownSessionError } = await import("../src/errors.js");
    const err = new UnknownSessionError("sess-123");
    expect(err.name).toBe("UnknownSessionError");
    expect(err.message).toContain("sess-123");
  });
});
