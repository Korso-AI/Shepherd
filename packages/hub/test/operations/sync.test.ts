/**
 * Tests for packages/hub/src/operations/sync.ts
 *
 * DB-dependent tests are gated on `dbAvailable` and skipped when no Postgres
 * connection string is configured.
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
import { sync } from "../../src/operations/sync.js";
import { join } from "../../src/operations/join.js";
import { work } from "../../src/operations/work.js";
import type { Config } from "../../src/config.js";
import {
  insertAnnouncement,
  fetchPendingAnnouncements,
  recordAnnouncementDeliveries,
} from "../../src/repo.js";
import { withContext } from "../../src/scopedDb.js";
import type { TenantContext } from "../../src/tenant.js";

// ---------------------------------------------------------------------------
// Shared test config factory
// ---------------------------------------------------------------------------

function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_URL: "postgres://localhost/test",
    TEAM_TOKEN: "test-token",
    HUB_PORT: 8080,
    ALLOWED_WORKSPACE: "test-ws",
    DEFAULT_TTL_SECONDS: 1800,
    MIN_TTL_SECONDS: 30,
    STALE_AFTER_SECONDS: 120,
    CHANGE_RECORD_TTL_SECONDS: 604800,
    HUB_ADMIN_LABEL: "admin",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// DB-gated suite
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "sync – DB tests" + (!dbAvailable ? " (SKIPPED: no DB configured)" : ""),
  () => {
    let pool: pg.Pool;
    let workspaceId: string;
    let tenant: TenantContext;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        ["test-ws", "test-ws"],
      );
      workspaceId = rows[0]!.id;
      tenant = { workspaceId };
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
    // Happy path: sync returns other sessions' active claims + pending announcements
    // -----------------------------------------------------------------------

    it("happy: sync returns other sessions' active claims and pending announcements", async () => {
      // Agent A joins and claims some files
      const sessionA = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "main",
          human: "Alice",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      await work(
        {
          sessionId: sessionA.sessionId,
          intent: "Working on auth module",
          pathGlobs: ["src/auth/**"],
        },
        tenant,
      );

      // Agent B joins
      const sessionB = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "feature",
          human: "Bob",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );

      // Agent B syncs — should see A's claims
      const result = await sync({ sessionId: sessionB.sessionId }, tenant);

      expect(result.landscape).toBeDefined();
      expect(result.landscape.activeClaims).toHaveLength(1);
      expect(result.landscape.activeClaims[0]!.intent).toBe(
        "Working on auth module",
      );
      expect(result.landscape.activeClaims[0]!.pathGlobs).toEqual([
        "src/auth/**",
      ]);
      // No conflicts for B since B has no claims of its own
      expect(result.landscape.conflicts).toHaveLength(0);
    });

    it("#4: sync reports the caller's OWN claims in yourClaims (not in activeClaims)", async () => {
      const sessionA = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "main",
          human: "Alice",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      await work(
        {
          sessionId: sessionA.sessionId,
          intent: "Working on auth module",
          pathGlobs: ["src/auth/**"],
        },
        tenant,
      );

      // A syncs and must be able to confirm its own claim is live.
      const aSync = await sync({ sessionId: sessionA.sessionId }, tenant);
      expect(aSync.landscape.yourClaims).toHaveLength(1);
      expect(aSync.landscape.yourClaims[0]!.intent).toBe(
        "Working on auth module",
      );
      // A's own claim is NOT echoed back as an "other agent" claim.
      expect(aSync.landscape.activeClaims).toHaveLength(0);

      // From B's perspective the same claim is an OTHER agent's claim, and B has
      // none of its own.
      const sessionB = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "feature",
          human: "Bob",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      const bSync = await sync({ sessionId: sessionB.sessionId }, tenant);
      expect(bSync.landscape.activeClaims).toHaveLength(1);
      expect(bSync.landscape.yourClaims).toHaveLength(0);
    });

    it("happy: second sync does NOT re-deliver already-delivered announcements", async () => {
      // A and B join
      const sessionA = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "main",
          human: "Alice",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      const sessionB = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "feature",
          human: "Bob",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );

      // A sends announcement (broadcast). NOTE: join canonicalizes the session
      // repo "org/repo" → "repo" (PR #9), so the announcement must be inserted
      // under the canonical repo to match B's delivery query (which filters on the
      // session's canonical repo). The real `announce` op derives repo from the
      // session, so it is always canonical; this test inserts directly, so it must
      // canonicalize itself.
      await withContext(
        pool,
        { kind: "workspace", workspaceId },
        async (tx) => {
          await insertAnnouncement(tx, {
            workspaceId,
            repo: "repo",
            fromSessionId: sessionA.sessionId,
            targetAgentName: null,
            body: "Hello from A!",
          });
        },
      );

      // First sync by B should deliver the announcement
      const firstSync = await sync({ sessionId: sessionB.sessionId }, tenant);
      expect(firstSync.landscape.announcements).toHaveLength(1);
      expect(firstSync.landscape.announcements[0]!.body).toBe("Hello from A!");

      // Second sync by B should NOT re-deliver
      const secondSync = await sync({ sessionId: sessionB.sessionId }, tenant);
      expect(secondSync.landscape.announcements).toHaveLength(0);
      // But still sees active claims (none in this case since A never claimed)
      expect(secondSync.landscape.activeClaims).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // Edge: sync renews the caller's claims — a claim about to expire stays alive
    // -----------------------------------------------------------------------

    it("edge-ttl: sync renews caller's claims so an about-to-expire claim stays active", async () => {
      // Agent A joins with a very short TTL claim (inserted with explicit past timestamp)
      const sessionA = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "main",
          human: "Alice",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      await work(
        {
          sessionId: sessionA.sessionId,
          intent: "About to expire",
          pathGlobs: ["src/foo/**"],
          ttlSeconds: 60, // 60-second TTL
        },
        tenant,
      );

      // Manually set expires_at to be nearly expired (5 seconds from now)
      const nearExpiry = new Date(Date.now() + 5000);
      await pool.query(
        `UPDATE work_items
         SET expires_at = $1
         WHERE session_id = $2 AND status = 'active'`,
        [nearExpiry, sessionA.sessionId],
      );

      // Verify that agent B can see A's claims (they're still active)
      const sessionB = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "feature",
          human: "Bob",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      const beforeSync = await sync({ sessionId: sessionB.sessionId }, tenant);
      expect(beforeSync.landscape.activeClaims).toHaveLength(1);

      // A calls sync, which should renew its claims
      await sync({ sessionId: sessionA.sessionId }, tenant);

      // Check that A's work item's expires_at is now much further in the future
      const { rows } = await pool.query<{ expires_at: Date }>(
        `SELECT expires_at FROM work_items WHERE session_id = $1 AND status = 'active'`,
        [sessionA.sessionId],
      );
      expect(rows).toHaveLength(1);
      // After renewal, the expiry should be > 50s in the future (original 60s TTL from now)
      const renewedExpiry = rows[0]!.expires_at;
      const secondsUntilExpiry = (renewedExpiry.getTime() - Date.now()) / 1000;
      expect(secondsUntilExpiry).toBeGreaterThan(50);
    });

    it("edge-ttl: sync renews with each claim's OWN TTL, not DEFAULT_TTL_SECONDS", async () => {
      // A joins with a custom-TTL claim of 300 seconds
      const sessionA = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "main",
          human: "Alice",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      await work(
        {
          sessionId: sessionA.sessionId,
          intent: "Custom TTL claim",
          pathGlobs: ["src/custom/**"],
          ttlSeconds: 300, // custom TTL, not DEFAULT (1800)
        },
        tenant,
      );

      // A syncs — this should renew with 300s, not 1800s
      await sync({ sessionId: sessionA.sessionId }, tenant);

      const { rows } = await pool.query<{
        expires_at: Date;
        ttl_seconds: number;
      }>(
        `SELECT expires_at, ttl_seconds FROM work_items WHERE session_id = $1 AND status = 'active'`,
        [sessionA.sessionId],
      );
      expect(rows).toHaveLength(1);
      const renewedExpiry = rows[0]!.expires_at;
      const ttlSeconds = rows[0]!.ttl_seconds;

      // The stored TTL should still be 300 (unchanged)
      expect(ttlSeconds).toBe(300);

      // The expiry should be approximately now + 300s (not now + 1800s)
      const secondsUntilExpiry = (renewedExpiry.getTime() - Date.now()) / 1000;
      expect(secondsUntilExpiry).toBeGreaterThan(290);
      expect(secondsUntilExpiry).toBeLessThan(310);
    });

    // -----------------------------------------------------------------------
    // Edge (staleness recovery): stale session recovers via sync
    // -----------------------------------------------------------------------

    it("#1 edge-stale: a stale session's claim is hidden from peers until its own sync revives it", async () => {
      // A joins and claims
      const sessionA = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "main",
          human: "Alice",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      await work(
        {
          sessionId: sessionA.sessionId,
          intent: "Auth work",
          pathGlobs: ["src/auth/**"],
        },
        tenant,
      );

      // Simulate a long-quiet session: heartbeat 200s ago (past STALE_AFTER=120s).
      // Visibility now requires a live owning session, so A reads as dead and its
      // claim drops out for peers until A heartbeats again.
      const staleTime = new Date(Date.now() - 200_000);
      await pool.query(
        `UPDATE sessions SET last_heartbeat_at = $1 WHERE id = $2`,
        [staleTime, sessionA.sessionId],
      );

      // B syncs: A's claim is HIDDEN while A is stale.
      const sessionB = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "feature",
          human: "Bob",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      const beforeRecovery = await sync(
        { sessionId: sessionB.sessionId },
        tenant,
      );
      expect(beforeRecovery.landscape.activeClaims).toHaveLength(0);

      // A calls sync — this updates its heartbeat (used for presence/TTL),
      // reviving its claim's visibility to peers.
      await sync({ sessionId: sessionA.sessionId }, tenant);

      const { rows: sessionRows } = await pool.query<{
        last_heartbeat_at: Date;
      }>(`SELECT last_heartbeat_at FROM sessions WHERE id = $1`, [
        sessionA.sessionId,
      ]);
      const heartbeatAge =
        (Date.now() - sessionRows[0]!.last_heartbeat_at.getTime()) / 1000;
      expect(heartbeatAge).toBeLessThan(5); // Updated within the last 5 seconds

      // B syncs again: A is live once more, so its claim is visible again.
      const afterRecovery = await sync(
        { sessionId: sessionB.sessionId },
        tenant,
      );
      expect(afterRecovery.landscape.activeClaims).toHaveLength(1);
      expect(afterRecovery.landscape.activeClaims[0]!.intent).toBe("Auth work");
    });

    // -----------------------------------------------------------------------
    // Edge (collision-after-claim): A claimed glob, B later claims overlapping
    // -----------------------------------------------------------------------

    it("edge-collision: A's sync shows B in conflicts when B later claims overlapping glob", async () => {
      // A joins and claims src/auth/**
      const sessionA = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "main",
          human: "Alice",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      await work(
        {
          sessionId: sessionA.sessionId,
          intent: "Auth refactor",
          pathGlobs: ["src/auth/**"],
        },
        tenant,
      );

      // B joins and claims src/auth/x.ts (overlaps with A's src/auth/**)
      const sessionB = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "feature",
          human: "Bob",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      await work(
        {
          sessionId: sessionB.sessionId,
          intent: "Fix auth file",
          pathGlobs: ["src/auth/x.ts"],
        },
        tenant,
      );

      // A syncs — should see B in conflicts
      const syncResult = await sync({ sessionId: sessionA.sessionId }, tenant);

      // activeClaims includes all OTHER sessions' claims (B's)
      expect(syncResult.landscape.activeClaims).toHaveLength(1);
      expect(syncResult.landscape.activeClaims[0]!.intent).toBe(
        "Fix auth file",
      );

      // conflicts: B overlaps A's src/auth/**
      expect(syncResult.landscape.conflicts).toHaveLength(1);
      expect(syncResult.landscape.conflicts[0]!.intent).toBe("Fix auth file");
    });

    it("changeReport: sync stores records, updates branch, and shows overlapping peer records", async () => {
      // A joins, claims src/auth/**, and reports a change via sync.
      const sessionA = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "main",
          human: "Alice",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      await work(
        {
          sessionId: sessionA.sessionId,
          intent: "Auth work",
          pathGlobs: ["src/auth/**"],
        },
        tenant,
      );
      await sync(
        {
          sessionId: sessionA.sessionId,
          changeReport: {
            branch: "feat/auth",
            baseBranch: "main",
            head: "h1",
            truncated: false,
            entries: [
              {
                kind: "committed",
                sha: "s1",
                message: "m1",
                paths: ["src/auth/a.ts"],
              },
              {
                kind: "uncommitted",
                sha: null,
                message: null,
                paths: ["src/auth/b.ts"],
              },
            ],
          },
        },
        tenant,
      );

      // A's session branch was updated by the changeReport.
      const { rows: branchRows } = await pool.query<{ branch: string }>(
        "SELECT branch FROM sessions WHERE id = $1",
        [sessionA.sessionId],
      );
      expect(branchRows[0]!.branch).toBe("feat/auth");

      // B joins, claims an overlapping glob, then syncs -> sees A's records.
      const sessionB = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "feature",
          human: "Bob",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      await work(
        {
          sessionId: sessionB.sessionId,
          intent: "Auth fix",
          pathGlobs: ["src/auth/**"],
        },
        tenant,
      );
      const bSync = await sync({ sessionId: sessionB.sessionId }, tenant);

      expect(bSync.landscape.changeRecords).toHaveLength(2);
      expect(bSync.landscape.changeRecords[0]!.agentName).toBe(
        bSync.landscape.changeRecords[1]!.agentName,
      );

      // A syncs with [] -> a clean tree with nothing unlanded. Both its
      // uncommitted AND its committed records clear (committed now reflects A's
      // current reported set, not a durable history), so B sees nothing from A.
      await sync(
        {
          sessionId: sessionA.sessionId,
          changeReport: {
            branch: "feat/auth",
            baseBranch: "main",
            head: "h2",
            truncated: false,
            entries: [],
          },
        },
        tenant,
      );
      const bSync2 = await sync({ sessionId: sessionB.sessionId }, tenant);
      expect(bSync2.landscape.changeRecords).toHaveLength(0);
    });

    it("changeReport: sync with no changeReport does not touch records (back-compat)", async () => {
      const sessionA = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "main",
          human: "Alice",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      await work(
        {
          sessionId: sessionA.sessionId,
          intent: "Auth work",
          pathGlobs: ["src/auth/**"],
          changeReport: {
            branch: "feat/auth",
            baseBranch: "main",
            head: "h1",
            truncated: false,
            entries: [
              {
                kind: "committed",
                sha: "s1",
                message: "m1",
                paths: ["src/auth/a.ts"],
              },
            ],
          },
        },
        tenant,
      );

      // A syncs with no changeReport -> record persists.
      await sync({ sessionId: sessionA.sessionId }, tenant);

      const sessionB = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "feature",
          human: "Bob",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      await work(
        {
          sessionId: sessionB.sessionId,
          intent: "Auth fix",
          pathGlobs: ["src/auth/**"],
        },
        tenant,
      );
      const bSync = await sync({ sessionId: sessionB.sessionId }, tenant);
      expect(bSync.landscape.changeRecords).toHaveLength(1);
      expect(bSync.landscape.changeRecords[0]!.commitSha).toBe("s1");
    });

    it("edge-collision: no conflicts when claims do not overlap", async () => {
      // A claims src/auth/**
      const sessionA = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "main",
          human: "Alice",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      await work(
        {
          sessionId: sessionA.sessionId,
          intent: "Auth work",
          pathGlobs: ["src/auth/**"],
        },
        tenant,
      );

      // B claims something completely different
      const sessionB = await join(
        {
          workspace: "test-ws",
          repo: "org/repo",
          branch: "feature",
          human: "Bob",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
        tenant,
      );
      await work(
        {
          sessionId: sessionB.sessionId,
          intent: "UI work",
          pathGlobs: ["src/ui/**"],
        },
        tenant,
      );

      // A syncs — should see B's claims but no conflicts
      const syncResult = await sync({ sessionId: sessionA.sessionId }, tenant);

      expect(syncResult.landscape.activeClaims).toHaveLength(1);
      expect(syncResult.landscape.activeClaims[0]!.intent).toBe("UI work");
      expect(syncResult.landscape.conflicts).toHaveLength(0);
    });
  },
);
