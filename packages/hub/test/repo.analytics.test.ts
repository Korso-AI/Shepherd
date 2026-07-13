/**
 * Tests for the range-aware operator analytics rollup:
 * repo.ts `getShepherdAnalytics`.
 *
 * These exercise the deterministic surface — a single injected `now` and a
 * validated preset `range` drive the current/previous windows, the hourly
 * (24h) vs daily (else) bucketing, the aligned comparison KPIs, the observed
 * timing percentiles, and the per-workspace window-scoped leaderboard. Every
 * window-scoped number is asserted against seeded rows placed at explicit
 * timestamps relative to a fixed `NOW`, so the assertions never depend on the
 * wall clock. The whole rollup is also parsed against the canonical
 * `ShepherdAnalyticsResponse` contract in a couple of tests so shape drift
 * fails loudly here.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  runTestMigrations,
  truncateAll,
  truncateTenancy,
} from "./setup.js";
import { ShepherdAnalyticsResponse } from "@shepherd/shared";
import { getShepherdAnalytics } from "../src/repo.js";

// A fixed reference clock. All seeded rows are placed relative to this, and it
// is the injected `now`, so every window boundary is deterministic.
const NOW = new Date("2026-06-15T12:00:00.000Z");
const LIVE_WINDOW_SECONDS = 120;

const SECOND = 1000;
const DAY = 24 * 60 * 60 * SECOND;

function daysBefore(base: Date, days: number): Date {
  return new Date(base.getTime() - days * DAY);
}
function secondsAfter(base: Date, s: number): Date {
  return new Date(base.getTime() + s * SECOND);
}

describe.skipIf(!dbAvailable)(
  "getShepherdAnalytics (range-aware rollup)" +
    (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    let pool: pg.Pool;

    // ---- seed helpers (explicit timestamps for deterministic windows) ----

    let accountSeq = 0;
    async function seedAccount(createdAt: Date): Promise<string> {
      const id = `acct-${++accountSeq}`;
      await pool.query(
        `INSERT INTO account_profiles (account_id, created_at, updated_at)
         VALUES ($1, $2, $2)`,
        [id, createdAt],
      );
      return id;
    }

    let wsSeq = 0;
    async function seedWorkspace(
      createdAt: Date = daysBefore(NOW, 400),
    ): Promise<string> {
      const slug = `ws-${++wsSeq}`;
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO workspaces (slug, name, created_by, created_at)
         VALUES ($1, $1, 'tester', $2) RETURNING id`,
        [slug, createdAt],
      );
      return rows[0]!.id;
    }

    async function seedMembership(workspaceId: string): Promise<void> {
      await pool.query(
        `INSERT INTO memberships (account_id, workspace_id, role)
         VALUES ($1, $2, 'member')`,
        [`m-${++accountSeq}`, workspaceId],
      );
    }

    let agentSeq = 0;
    async function seedAgent(
      workspaceId: string,
      createdAt: Date = daysBefore(NOW, 400),
    ): Promise<string> {
      const name = `agent-${++agentSeq}`;
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO agents (workspace_id, name, human, program, model, created_at)
         VALUES ($1, $2, 'human', 'prog', null, $3) RETURNING id`,
        [workspaceId, name, createdAt],
      );
      return rows[0]!.id;
    }

    async function seedSession(params: {
      workspaceId: string;
      agentId: string;
      createdAt: Date;
      lastHeartbeatAt?: Date;
    }): Promise<string> {
      const { workspaceId, agentId, createdAt } = params;
      const lastHeartbeatAt = params.lastHeartbeatAt ?? createdAt;
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO sessions (workspace_id, agent_id, repo, branch, created_at, last_heartbeat_at)
         VALUES ($1, $2, 'repo', 'main', $3, $4) RETURNING id`,
        [workspaceId, agentId, createdAt, lastHeartbeatAt],
      );
      return rows[0]!.id;
    }

    async function seedWorkItem(params: {
      workspaceId: string;
      sessionId: string;
      createdAt: Date;
      releasedAt?: Date | null;
    }): Promise<void> {
      const { workspaceId, sessionId, createdAt } = params;
      const releasedAt = params.releasedAt ?? null;
      await pool.query(
        `INSERT INTO work_items
           (workspace_id, session_id, repo, intent_text, path_globs, ttl_seconds,
            status, expires_at, created_at, released_at)
         VALUES ($1, $2, 'repo', 'intent', ARRAY['a/**'], 1800,
                 $5, $3::timestamptz + interval '1 hour', $3, $4)`,
        [
          workspaceId,
          sessionId,
          createdAt,
          releasedAt,
          releasedAt ? "released" : "active",
        ],
      );
    }

    let shaSeq = 0;
    async function seedCommit(params: {
      workspaceId: string;
      agentId: string;
      updatedAt: Date;
      kind?: "committed" | "uncommitted";
    }): Promise<void> {
      const { workspaceId, agentId, updatedAt } = params;
      const kind = params.kind ?? "committed";
      const sha = kind === "committed" ? `sha${++shaSeq}` : null;
      await pool.query(
        `INSERT INTO change_records
           (workspace_id, repo, agent_id, agent_name, branch, kind, commit_sha, message, path_globs, updated_at)
         VALUES ($1, 'repo', $2, 'agent', 'main', $3, $4, 'msg', ARRAY['a/**'], $5)`,
        [workspaceId, agentId, kind, sha, updatedAt],
      );
    }

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
    });

    beforeEach(async () => {
      await truncateAll(pool);
      await truncateTenancy(pool);
      accountSeq = 0;
      wsSeq = 0;
      agentSeq = 0;
      shaSeq = 0;
    });

    afterAll(async () => {
      await pool.end();
    });

    // -----------------------------------------------------------------------
    // Windows / buckets
    // -----------------------------------------------------------------------

    it("echoes range/bucket and computes the half-open window for every preset", async () => {
      const cases = [
        { range: "24h" as const, bucket: "hour", seconds: 24 * 60 * 60 },
        { range: "7d" as const, bucket: "day", seconds: (7 * DAY) / SECOND },
        { range: "30d" as const, bucket: "day", seconds: (30 * DAY) / SECOND },
        { range: "90d" as const, bucket: "day", seconds: (90 * DAY) / SECOND },
      ];
      for (const c of cases) {
        const res = await getShepherdAnalytics(pool, {
          range: c.range,
          now: NOW,
          liveWindowSeconds: LIVE_WINDOW_SECONDS,
        });
        expect(res.range).toBe(c.range);
        expect(res.bucket).toBe(c.bucket);
        expect(res.windowEnd).toBe(NOW.toISOString());
        expect(res.windowStart).toBe(
          new Date(NOW.getTime() - c.seconds * SECOND).toISOString(),
        );
        expect(res.generatedAt).toBe(NOW.toISOString());
      }
    });

    it("uses hourly buckets for 24h and daily buckets otherwise, both windows equal-length", async () => {
      const h = await getShepherdAnalytics(pool, {
        range: "24h",
        now: NOW,
        liveWindowSeconds: LIVE_WINDOW_SECONDS,
      });
      expect(h.bucket).toBe("hour");
      // 24h inclusive of both truncated hour boundaries → 25 hourly buckets.
      expect(h.trends.newAccounts.current).toHaveLength(25);
      expect(h.trends.newAccounts.previous).toHaveLength(25);
      // Hourly labels are ISO-ish timestamps.
      expect(h.trends.newAccounts.current[0]!.date).toContain("T");

      const d = await getShepherdAnalytics(pool, {
        range: "30d",
        now: NOW,
        liveWindowSeconds: LIVE_WINDOW_SECONDS,
      });
      expect(d.bucket).toBe("day");
      // 30d inclusive of both truncated day boundaries → 31 daily buckets.
      expect(d.trends.newAccounts.current).toHaveLength(31);
      expect(d.trends.newAccounts.previous).toHaveLength(31);
      expect(d.trends.newAccounts.current[0]!.date).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
    });

    it("zero-fills buckets and places counts in the right day", async () => {
      const ws = await seedWorkspace();
      const agent = await seedAgent(ws);
      // Two accounts on two distinct days inside the current 30d window.
      await seedAccount(daysBefore(NOW, 1));
      await seedAccount(daysBefore(NOW, 2));
      // One new session inside the window (distinct series).
      await seedSession({
        workspaceId: ws,
        agentId: agent,
        createdAt: daysBefore(NOW, 3),
      });

      const res = await getShepherdAnalytics(pool, {
        range: "30d",
        now: NOW,
        liveWindowSeconds: LIVE_WINDOW_SECONDS,
      });

      const totalAccounts = res.trends.newAccounts.current.reduce(
        (s, p) => s + p.count,
        0,
      );
      expect(totalAccounts).toBe(2);
      // Most buckets are zero-filled.
      const nonZero = res.trends.newAccounts.current.filter((p) => p.count > 0);
      expect(nonZero).toHaveLength(2);
      expect(nonZero.every((p) => p.count === 1)).toBe(true);

      const totalSessions = res.trends.newSessions.current.reduce(
        (s, p) => s + p.count,
        0,
      );
      expect(totalSessions).toBe(1);
    });

    // -----------------------------------------------------------------------
    // Aligned previous-window comparison + changePct edges
    // -----------------------------------------------------------------------

    it("compares the current window against the aligned previous window", async () => {
      const windowStart = daysBefore(NOW, 30);
      // 3 accounts in current window, 1 in the previous window.
      await seedAccount(daysBefore(NOW, 1));
      await seedAccount(daysBefore(NOW, 2));
      await seedAccount(daysBefore(NOW, 3));
      await seedAccount(
        secondsAfter(daysBefore(windowStart, 30), DAY / SECOND),
      );

      const res = await getShepherdAnalytics(pool, {
        range: "30d",
        now: NOW,
        liveWindowSeconds: LIVE_WINDOW_SECONDS,
      });

      expect(res.period.newAccounts.current).toBe(3);
      expect(res.period.newAccounts.previous).toBe(1);
      expect(res.period.newAccounts.changePct).toBe(200);

      // The previous trend twin sums to the previous-window count.
      const prevSum = res.trends.newAccounts.previous.reduce(
        (s, p) => s + p.count,
        0,
      );
      expect(prevSum).toBe(1);
    });

    it("changePct is null when previous is 0 (new), and negative on a decrease", async () => {
      const windowStart = daysBefore(NOW, 30);
      // previous === 0: 2 accounts this window, none before.
      await seedAccount(daysBefore(NOW, 1));
      await seedAccount(daysBefore(NOW, 2));
      // A decrease for sessions: 1 this window, 2 previous.
      const ws = await seedWorkspace();
      const agent = await seedAgent(ws);
      await seedSession({
        workspaceId: ws,
        agentId: agent,
        createdAt: daysBefore(NOW, 1),
      });
      await seedSession({
        workspaceId: ws,
        agentId: agent,
        createdAt: secondsAfter(daysBefore(windowStart, 30), DAY / SECOND),
      });
      await seedSession({
        workspaceId: ws,
        agentId: agent,
        createdAt: secondsAfter(
          daysBefore(windowStart, 30),
          2 * (DAY / SECOND),
        ),
      });

      const res = await getShepherdAnalytics(pool, {
        range: "30d",
        now: NOW,
        liveWindowSeconds: LIVE_WINDOW_SECONDS,
      });

      expect(res.period.newAccounts.current).toBe(2);
      expect(res.period.newAccounts.previous).toBe(0);
      expect(res.period.newAccounts.changePct).toBeNull();

      expect(res.period.newSessions.current).toBe(1);
      expect(res.period.newSessions.previous).toBe(2);
      expect(res.period.newSessions.changePct).toBe(-50);
    });

    it("rounds changePct to two decimals", async () => {
      const windowStart = daysBefore(NOW, 30);
      // current 1, previous 3 → (1-3)/3*100 = -66.666… → -66.67
      await seedAccount(daysBefore(NOW, 1));
      for (let i = 0; i < 3; i++) {
        await seedAccount(
          secondsAfter(daysBefore(windowStart, 30), (i + 1) * (DAY / SECOND)),
        );
      }
      const res = await getShepherdAnalytics(pool, {
        range: "30d",
        now: NOW,
        liveWindowSeconds: LIVE_WINDOW_SECONDS,
      });
      expect(res.period.newAccounts.current).toBe(1);
      expect(res.period.newAccounts.previous).toBe(3);
      expect(res.period.newAccounts.changePct).toBe(-66.67);
    });

    // -----------------------------------------------------------------------
    // Timing percentiles + nullability
    // -----------------------------------------------------------------------

    it("returns null percentiles when there are no source rows in the window", async () => {
      const res = await getShepherdAnalytics(pool, {
        range: "30d",
        now: NOW,
        liveWindowSeconds: LIVE_WINDOW_SECONDS,
      });
      expect(res.timing.sessionSpanSeconds).toEqual({ p50: null, p95: null });
      expect(res.timing.claimDurationSeconds).toEqual({ p50: null, p95: null });
    });

    it("computes observed session-span and claim-duration percentiles", async () => {
      const ws = await seedWorkspace();
      const agent = await seedAgent(ws);
      const created = daysBefore(NOW, 2);
      // One session spanning 100s (created_at -> last_heartbeat_at).
      const session = await seedSession({
        workspaceId: ws,
        agentId: agent,
        createdAt: created,
        lastHeartbeatAt: secondsAfter(created, 100),
      });
      // One released claim lasting 200s (created_at -> released_at).
      await seedWorkItem({
        workspaceId: ws,
        sessionId: session,
        createdAt: created,
        releasedAt: secondsAfter(created, 200),
      });

      const res = await getShepherdAnalytics(pool, {
        range: "30d",
        now: NOW,
        liveWindowSeconds: LIVE_WINDOW_SECONDS,
      });
      expect(res.timing.sessionSpanSeconds.p50).toBe(100);
      expect(res.timing.sessionSpanSeconds.p95).toBe(100);
      expect(res.timing.claimDurationSeconds.p50).toBe(200);
      expect(res.timing.claimDurationSeconds.p95).toBe(200);
    });

    // -----------------------------------------------------------------------
    // Workspace leaderboard: sorting + window-scoped activity
    // -----------------------------------------------------------------------

    it("sorts workspaces by members and scopes activity to the window", async () => {
      const before = daysBefore(NOW, 200); // well before any window
      const inWin = daysBefore(NOW, 1);

      // WS-A: 3 members, active inside the window.
      const wsA = await seedWorkspace();
      for (let i = 0; i < 3; i++) await seedMembership(wsA);
      const agentA = await seedAgent(wsA);
      const sessA1 = await seedSession({
        workspaceId: wsA,
        agentId: agentA,
        createdAt: inWin,
        lastHeartbeatAt: inWin,
      });
      await seedSession({
        workspaceId: wsA,
        agentId: agentA,
        createdAt: inWin,
        lastHeartbeatAt: inWin,
      });
      await seedCommit({ workspaceId: wsA, agentId: agentA, updatedAt: inWin });
      await seedCommit({ workspaceId: wsA, agentId: agentA, updatedAt: inWin });
      await seedWorkItem({
        workspaceId: wsA,
        sessionId: sessA1,
        createdAt: inWin,
        releasedAt: secondsAfter(inWin, 300),
      });

      // WS-B: 1 member, only activity BEFORE the window.
      const wsB = await seedWorkspace();
      await seedMembership(wsB);
      const agentB = await seedAgent(wsB);
      const sessB = await seedSession({
        workspaceId: wsB,
        agentId: agentB,
        createdAt: before,
        lastHeartbeatAt: before,
      });
      await seedCommit({
        workspaceId: wsB,
        agentId: agentB,
        updatedAt: before,
      });
      await seedWorkItem({
        workspaceId: wsB,
        sessionId: sessB,
        createdAt: before,
        releasedAt: secondsAfter(before, 500),
      });

      const res = await getShepherdAnalytics(pool, {
        range: "30d",
        now: NOW,
        liveWindowSeconds: LIVE_WINDOW_SECONDS,
      });

      expect(res.topWorkspaces).toHaveLength(2);
      const [a, b] = res.topWorkspaces;

      // Sorted by members DESC → A first.
      expect(a!.members).toBe(3);
      expect(a!.sessions).toBe(2);
      expect(a!.activeAgents).toBe(1);
      expect(a!.commits).toBe(2);
      expect(a!.claimsReleased).toBe(1);
      expect(a!.medianClaimSeconds).toBe(300);
      expect(a!.lastActivityAt).not.toBeNull();

      // B's activity is all outside the window → window-scoped counts are 0/null.
      expect(b!.members).toBe(1);
      expect(b!.sessions).toBe(0);
      expect(b!.activeAgents).toBe(0);
      expect(b!.commits).toBe(0);
      expect(b!.claimsReleased).toBe(0);
      expect(b!.medianClaimSeconds).toBeNull();
      expect(b!.lastActivityAt).toBeNull();

      // Whole rollup validates against the canonical contract.
      expect(() => ShepherdAnalyticsResponse.parse(res)).not.toThrow();
    });

    it("caps the leaderboard at 10, ordered by members DESC then name ASC, with activity intact", async () => {
      const inWin = daysBefore(NOW, 1);

      // 12 workspaces: ws-1 has 1 member … ws-12 has 12. The two smallest
      // (ws-1, ws-2) must be cut by the two-stage top-10 selection.
      const ids = new Map<string, string>();
      for (let n = 1; n <= 12; n++) {
        const id = await seedWorkspace();
        ids.set(`ws-${n}`, id);
        for (let m = 0; m < n; m++) await seedMembership(id);
      }
      // Window-scoped activity on the LARGEST workspace so we can assert the
      // heavy metrics are still computed for the surviving rows.
      const top = ids.get("ws-12")!;
      const agent = await seedAgent(top);
      await seedCommit({ workspaceId: top, agentId: agent, updatedAt: inWin });

      const res = await getShepherdAnalytics(pool, {
        range: "30d",
        now: NOW,
        liveWindowSeconds: LIVE_WINDOW_SECONDS,
      });

      expect(res.topWorkspaces).toHaveLength(10);
      // members DESC → 12, 11, …, 3; ws-1 and ws-2 are cut.
      expect(res.topWorkspaces.map((w) => w.members)).toEqual([
        12, 11, 10, 9, 8, 7, 6, 5, 4, 3,
      ]);
      const slugs = res.topWorkspaces.map((w) => w.slug);
      expect(slugs).not.toContain("ws-1");
      expect(slugs).not.toContain("ws-2");
      expect(res.topWorkspaces[0]!.slug).toBe("ws-12");
      expect(res.topWorkspaces[0]!.commits).toBe(1);
      expect(res.topWorkspaces[0]!.lastActivityAt).not.toBeNull();
    });

    // -----------------------------------------------------------------------
    // Supporting index (migration 020)
    // -----------------------------------------------------------------------

    it("has the partial time-leading work_items.released_at index (migration 020)", async () => {
      const { rows } = await pool.query<{ indexdef: string }>(`
        SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public' AND tablename = 'work_items'
          AND indexname = 'work_items_released_at_idx'
      `);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.indexdef).toMatch(/\(released_at\)/);
      expect(rows[0]!.indexdef).toMatch(
        /WHERE\s+\(?released_at IS NOT NULL\)?/,
      );
    });

    // -----------------------------------------------------------------------
    // No-data whole rollup
    // -----------------------------------------------------------------------

    it("produces a valid, zeroed rollup on an empty database", async () => {
      const res = await getShepherdAnalytics(pool, {
        range: "7d",
        now: NOW,
        liveWindowSeconds: LIVE_WINDOW_SECONDS,
      });

      expect(res.totals.accounts).toBe(0);
      expect(res.totals.workspaces).toBe(0);
      expect(res.topWorkspaces).toEqual([]);
      expect(res.feedbackByType).toEqual([]);

      for (const metric of Object.values(res.period)) {
        expect(metric).toEqual({ current: 0, previous: 0, changePct: null });
      }
      expect(res.timing.sessionSpanSeconds).toEqual({ p50: null, p95: null });
      expect(res.timing.claimDurationSeconds).toEqual({ p50: null, p95: null });

      // Trend series are zero-filled (7d daily → 8 inclusive buckets) and equal-length.
      for (const series of Object.values(res.trends)) {
        expect(series.current).toHaveLength(8);
        expect(series.previous).toHaveLength(series.current.length);
        expect(series.current.every((p) => p.count === 0)).toBe(true);
      }

      expect(() => ShepherdAnalyticsResponse.parse(res)).not.toThrow();
    });
  },
);
