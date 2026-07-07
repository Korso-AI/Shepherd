/**
 * Hub integration test harness — end-to-end scenarios against a real Postgres.
 *
 * Gated on `dbAvailable`: the entire suite skips with a clear message when
 * neither TEST_DATABASE_URL nor DATABASE_URL is set, so CI without Postgres
 * still passes (unit tests run unaffected).
 *
 * Each describe block calls truncateAll in afterEach for isolation.
 *
 * Tenancy (Task 2.5): operations now take `(input, tenant)` and scope by
 * `tenant.workspaceId` (a uuid), never config.ALLOWED_WORKSPACE or the request
 * body. Every suite seeds its workspace row in beforeAll (slug == the config's
 * ALLOWED_WORKSPACE for the self-host TEAM_TOKEN path) and captures its uuid as
 * the tenant scope. The cross-tenant isolation scenarios seed a SECOND workspace
 * and assert that a credential minted for workspace A can never read or write
 * workspace B's rows — the core P1 isolation invariant.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  runTestMigrations,
  truncateAll,
} from "./setup.js";
import { initContext, resetContext } from "../src/context.js";
import { join } from "../src/operations/join.js";
import { work } from "../src/operations/work.js";
import { done } from "../src/operations/done.js";
import { announce } from "../src/operations/announce.js";
import { sync } from "../src/operations/sync.js";
import { buildServer } from "../src/server.js";
import {
  createAgent,
  createSession,
  insertWorkItem,
  listActiveClaims,
} from "../src/repo.js";
import { withTransaction } from "../src/db.js";
import { UnknownSessionError } from "../src/errors.js";
import { __resetRateLimiter } from "../src/tenant.js";
import type { Config } from "../src/config.js";
import type { TenantContext } from "../src/tenant.js";

// ---------------------------------------------------------------------------
// Shared config factory — one consistent definition for this suite
// ---------------------------------------------------------------------------

export function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_URL: "postgres://localhost/test",
    TEAM_TOKEN: "integration-test-token",
    HUB_PORT: 8080,
    ALLOWED_WORKSPACE: "team-a",
    DEFAULT_TTL_SECONDS: 1800,
    MIN_TTL_SECONDS: 30,
    STALE_AFTER_SECONDS: 120,
    CHANGE_RECORD_TTL_SECONDS: 604800,
    HUB_ADMIN_LABEL: "admin",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constants shared across scenarios
// ---------------------------------------------------------------------------

const WS = "team-a";
const REPO = "org/repo";
const BRANCH = "main";

/**
 * Seed (idempotently) a workspace and return its uuid. The shared test DB keeps
 * tenancy tables across suites (truncateAll only clears coordination rows), so
 * every seed upserts by slug.
 */
async function seedWorkspace(pool: pg.Pool, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [slug, slug],
  );
  return rows[0]!.id;
}

/** Minimal join payload for agent A in the shared workspace */
function joinPayloadA() {
  return {
    workspace: WS,
    repo: REPO,
    branch: BRANCH,
    human: "alice",
    program: "claude",
    model: "claude-3-5-sonnet",
  };
}

/** Minimal join payload for agent B (different human identity) */
function joinPayloadB() {
  return {
    workspace: WS,
    repo: REPO,
    branch: BRANCH,
    human: "bob",
    program: "claude",
    model: "claude-3-5-sonnet",
  };
}

/** Minimal join payload for agent C (third participant) */
function joinPayloadC() {
  return {
    workspace: WS,
    repo: REPO,
    branch: BRANCH,
    human: "carol",
    program: "claude",
    model: "claude-3-5-sonnet",
  };
}

// ---------------------------------------------------------------------------
// Suite: Claim → conflict → release → re-claim
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Integration: claim → conflict → release → re-claim" +
    (!dbAvailable
      ? " (SKIPPED: no TEST_DATABASE_URL or DATABASE_URL configured)"
      : ""),
  () => {
    let pool: pg.Pool;
    let tenant: TenantContext;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      const workspaceId = await seedWorkspace(pool, WS);
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

    it("B is warned about A's overlapping claim; after A calls done, B re-works warned-free", async () => {
      // A joins and claims src/auth/**. Capture A's agentName DIRECTLY from its
      // join response — each join now mints a per-session identity, so we must
      // NOT re-join the same human to "recover" the name (that yields a new
      // ordinal, e.g. alice-2, not the original).
      const joinA = await join(joinPayloadA(), tenant);
      const sessionA = joinA.sessionId;
      const agentNameA = joinA.agentName;
      const workA = await work(
        {
          sessionId: sessionA,
          intent: "refactor auth module",
          pathGlobs: ["src/auth/**"],
        },
        tenant,
      );
      expect(workA.workItemId).toBeTruthy();
      // A's own landscape should have no conflicts
      expect(workA.landscape.conflicts).toHaveLength(0);

      // B joins and claims a narrower path that overlaps: src/auth/login.ts
      const joinB = await join(joinPayloadB(), tenant);
      const workB = await work(
        {
          sessionId: joinB.sessionId,
          intent: "fix login bug",
          pathGlobs: ["src/auth/login.ts"],
        },
        tenant,
      );

      // B must see A's session as a conflict (glob overlap: src/auth/** vs src/auth/login.ts)
      expect(workB.landscape.conflicts.length).toBeGreaterThan(0);
      const conflictEntry = workB.landscape.conflicts[0]!;
      expect(conflictEntry.agentName).toBe(agentNameA);
      expect(conflictEntry.human).toBe("alice");
      expect(conflictEntry.pathGlobs).toContain("src/auth/**");

      // A releases its claim (using the original session + workItemId)
      const doneA = await done(
        {
          sessionId: sessionA,
          workItemId: workA.workItemId,
        },
        tenant,
      );
      expect(doneA.ok).toBe(true);

      // B re-works the same path — should now be warned-free for A's old claim
      const workB2 = await work(
        {
          sessionId: joinB.sessionId,
          intent: "fix login bug again",
          pathGlobs: ["src/auth/login.ts"],
        },
        tenant,
      );

      // A's claim is released; B's own previous claim may still show as
      // activeClaim (its own session is excluded from activeClaims by design).
      // The conflicts list should not include any entry from A's human "alice".
      const aliceConflicts = workB2.landscape.conflicts.filter(
        (c) => c.human === "alice",
      );
      expect(aliceConflicts).toHaveLength(0);
    });
  },
);

// ---------------------------------------------------------------------------
// Suite: Announce → delivery (broadcast, exactly-once)
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Integration: announce → delivery (broadcast)" +
    (!dbAvailable
      ? " (SKIPPED: no TEST_DATABASE_URL or DATABASE_URL configured)"
      : ""),
  () => {
    let pool: pg.Pool;
    let tenant: TenantContext;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      const workspaceId = await seedWorkspace(pool, WS);
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

    it("B's first sync includes A's broadcast; B's second sync does not", async () => {
      const joinA = await join(joinPayloadA(), tenant);
      const joinB = await join(joinPayloadB(), tenant);

      // A broadcasts an announcement
      const ann = await announce(
        {
          sessionId: joinA.sessionId,
          body: "Heads-up: refactoring auth",
        },
        tenant,
      );
      expect(ann.ok).toBe(true);
      expect(typeof ann.announcementId).toBe("number");

      // B's first sync should include the announcement
      const sync1 = await sync({ sessionId: joinB.sessionId }, tenant);
      expect(sync1.landscape.announcements).toHaveLength(1);
      expect(sync1.landscape.announcements[0]!.id).toBe(ann.announcementId);
      expect(sync1.landscape.announcements[0]!.body).toBe(
        "Heads-up: refactoring auth",
      );
      expect(sync1.landscape.announcements[0]!.fromHuman).toBe("alice");
      expect(sync1.landscape.announcements[0]!.targetAgentName).toBeNull();

      // B's second sync must NOT re-deliver the same announcement
      const sync2 = await sync({ sessionId: joinB.sessionId }, tenant);
      expect(sync2.landscape.announcements).toHaveLength(0);
    });

    it("sender does not receive their own broadcast in sync", async () => {
      const joinA = await join(joinPayloadA(), tenant);

      await announce(
        {
          sessionId: joinA.sessionId,
          body: "Self-announcement should not be delivered back",
        },
        tenant,
      );

      const syncA = await sync({ sessionId: joinA.sessionId }, tenant);
      expect(syncA.landscape.announcements).toHaveLength(0);
    });
  },
);

// ---------------------------------------------------------------------------
// Suite: Targeted announce
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Integration: targeted announce — only target receives it" +
    (!dbAvailable
      ? " (SKIPPED: no TEST_DATABASE_URL or DATABASE_URL configured)"
      : ""),
  () => {
    let pool: pg.Pool;
    let tenant: TenantContext;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      const workspaceId = await seedWorkspace(pool, WS);
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

    it("targeted announcement reaches B but not C", async () => {
      const joinA = await join(joinPayloadA(), tenant);
      const joinB = await join(joinPayloadB(), tenant);
      const joinC = await join(joinPayloadC(), tenant);

      // A targets B by name
      const ann = await announce(
        {
          sessionId: joinA.sessionId,
          body: "Hey Bob, watch out for login.ts",
          targetAgentName: joinB.agentName,
        },
        tenant,
      );
      expect(ann.ok).toBe(true);

      // B's sync includes the targeted announcement
      const syncB = await sync({ sessionId: joinB.sessionId }, tenant);
      expect(syncB.landscape.announcements).toHaveLength(1);
      expect(syncB.landscape.announcements[0]!.id).toBe(ann.announcementId);
      expect(syncB.landscape.announcements[0]!.targetAgentName).toBe(
        joinB.agentName,
      );

      // C's sync must NOT include the targeted announcement
      const syncC = await sync({ sessionId: joinC.sessionId }, tenant);
      const matchingAnn = syncC.landscape.announcements.filter(
        (a) => a.id === ann.announcementId,
      );
      expect(matchingAnn).toHaveLength(0);
    });
  },
);

// ---------------------------------------------------------------------------
// Suite: TTL expiry — expired claim is invisible to other sessions
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Integration: TTL expiry" +
    (!dbAvailable
      ? " (SKIPPED: no TEST_DATABASE_URL or DATABASE_URL configured)"
      : ""),
  () => {
    let pool: pg.Pool;
    let tenant: TenantContext;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      const workspaceId = await seedWorkspace(pool, WS);
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

    it("after expires_at is backdated to the past, B's work on overlapping path has no conflict from A", async () => {
      const joinA = await join(joinPayloadA(), tenant);
      const workA = await work(
        {
          sessionId: joinA.sessionId,
          intent: "big refactor",
          pathGlobs: ["src/**"],
          ttlSeconds: 1800,
        },
        tenant,
      );

      // Artificially expire A's claim by backdating expires_at to the past
      await pool.query(
        `UPDATE work_items
         SET expires_at = NOW() - INTERVAL '1 second'
         WHERE id = $1`,
        [workA.workItemId],
      );

      const joinB = await join(joinPayloadB(), tenant);
      const workB = await work(
        {
          sessionId: joinB.sessionId,
          intent: "also touching src",
          pathGlobs: ["src/api.ts"],
        },
        tenant,
      );

      // A's claim is expired; B should see no conflicts from alice
      const aliceConflicts = workB.landscape.conflicts.filter(
        (c) => c.human === "alice",
      );
      expect(aliceConflicts).toHaveLength(0);

      // A also doesn't appear in activeClaims
      const aliceActive = workB.landscape.activeClaims.filter(
        (c) => c.human === "alice",
      );
      expect(aliceActive).toHaveLength(0);
    });
  },
);

// ---------------------------------------------------------------------------
// Suite: Staleness — stale session's claims are invisible; sync revives them
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Integration: staleness" +
    (!dbAvailable
      ? " (SKIPPED: no TEST_DATABASE_URL or DATABASE_URL configured)"
      : ""),
  () => {
    let pool: pg.Pool;
    let tenant: TenantContext;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      const workspaceId = await seedWorkspace(pool, WS);
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

    it("#1: a stale session's claims DISAPPEAR from B's landscape (live session required)", async () => {
      const joinA = await join(joinPayloadA(), tenant);
      await work(
        {
          sessionId: joinA.sessionId,
          intent: "long-running task",
          pathGlobs: ["src/core/**"],
        },
        tenant,
      );

      // Backdate A's session heartbeat well past STALE_AFTER_SECONDS=120. A is
      // now indistinguishable from a dead agent (the 60s background heartbeat
      // would otherwise keep a genuinely-live session fresh), so A's claim must
      // drop out of everyone else's landscape even though its TTL is far off.
      await pool.query(
        `UPDATE sessions
         SET last_heartbeat_at = NOW() - INTERVAL '200 seconds'
         WHERE id = $1`,
        [joinA.sessionId],
      );

      const joinB = await join(joinPayloadB(), tenant);
      const workB = await work(
        {
          sessionId: joinB.sessionId,
          intent: "overlapping work",
          pathGlobs: ["src/core/auth.ts"],
        },
        tenant,
      );

      // A's claim is hidden and raises no advisory conflict against B.
      const aliceActive = workB.landscape.activeClaims.filter(
        (c) => c.human === "alice",
      );
      expect(aliceActive).toHaveLength(0);
      const aliceConflicts = workB.landscape.conflicts.filter(
        (c) => c.human === "alice",
      );
      expect(aliceConflicts).toHaveLength(0);
    });

    it("a stale session's sync refreshes its heartbeat (claim stays visible throughout)", async () => {
      const joinA = await join(joinPayloadA(), tenant);
      await work(
        {
          sessionId: joinA.sessionId,
          intent: "long-running task",
          pathGlobs: ["src/core/**"],
        },
        tenant,
      );

      // Backdate A's heartbeat to simulate a long-quiet session.
      await pool.query(
        `UPDATE sessions
         SET last_heartbeat_at = NOW() - INTERVAL '200 seconds'
         WHERE id = $1`,
        [joinA.sessionId],
      );

      // A calls sync — this refreshes its heartbeat and renews its claims' TTL.
      await sync({ sessionId: joinA.sessionId }, tenant);

      const { rows } = await pool.query<{ last_heartbeat_at: Date }>(
        `SELECT last_heartbeat_at FROM sessions WHERE id = $1`,
        [joinA.sessionId],
      );
      const heartbeatAge =
        (Date.now() - rows[0]!.last_heartbeat_at.getTime()) / 1000;
      expect(heartbeatAge).toBeLessThan(5);

      // B works on an overlapping path — A's claim is visible (as it was before).
      const joinB = await join(joinPayloadB(), tenant);
      const workB = await work(
        {
          sessionId: joinB.sessionId,
          intent: "overlapping work",
          pathGlobs: ["src/core/auth.ts"],
        },
        tenant,
      );
      const aliceActive = workB.landscape.activeClaims.filter(
        (c) => c.human === "alice",
      );
      expect(aliceActive.length).toBeGreaterThan(0);
    });
  },
);

// ---------------------------------------------------------------------------
// Suite: Workspace isolation — team-a claims are invisible to team-b queries
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Integration: workspace isolation" +
    (!dbAvailable
      ? " (SKIPPED: no TEST_DATABASE_URL or DATABASE_URL configured)"
      : ""),
  () => {
    let pool: pg.Pool;
    let tenantA: TenantContext;
    let workspaceIdA: string;
    let workspaceIdB: string;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      workspaceIdA = await seedWorkspace(pool, WS);
      workspaceIdB = await seedWorkspace(pool, "team-b");
      tenantA = { workspaceId: workspaceIdA };
      initContext({ pool, config: makeTestConfig() });
    });

    afterEach(async () => {
      await truncateAll(pool);
    });

    afterAll(async () => {
      resetContext();
      await pool.end();
    });

    it("a claim in workspace team-a never appears in workspace team-b's landscape", async () => {
      // Normal op-layer join for team-a (tenant scopes by workspaceIdA).
      const joinA = await join(joinPayloadA(), tenantA);
      await work(
        {
          sessionId: joinA.sessionId,
          intent: "team-a work",
          pathGlobs: ["src/**"],
        },
        tenantA,
      );

      // Seed a team-b agent + session + work item directly under workspaceIdB.
      await withTransaction(pool, async (tx) => {
        const agentB = await createAgent(tx, {
          workspaceId: workspaceIdB,
          name: "TeamBAgent",
          human: "dave",
          program: "claude",
          model: "claude-3-5-sonnet",
        });
        const sessionB = await createSession(tx, {
          workspaceId: workspaceIdB,
          agentId: agentB.id,
          repo: REPO,
          branch: BRANCH,
        });
        const now = new Date();
        await insertWorkItem(tx, {
          workspaceId: workspaceIdB,
          sessionId: sessionB.id,
          repo: REPO,
          intentText: "team-b work",
          pathGlobs: ["src/**"],
          ttlSeconds: 1800,
          expiresAt: new Date(now.getTime() + 1800 * 1000),
        });

        // Assert from team-b's perspective: listActiveClaims for team-b should
        // NOT include anything from team-a.
        // Read via `tx` (NOT pool): the team-b rows above are still uncommitted,
        // so a separate pool connection could never see them. listActiveClaims
        // accepts a PoolClient (P1-1 widening), which is exactly what lets this
        // in-transaction read work.
        const teamBClaims = await listActiveClaims(
          tx,
          workspaceIdB,
          REPO,
          now,
          120,
          { excludeSessionId: "00000000-0000-0000-0000-000000000000" },
        );

        const teamAClaims = teamBClaims.filter((c) => c.human === "alice");
        expect(teamAClaims).toHaveLength(0);

        // Team-b's own claim IS present
        expect(teamBClaims.some((c) => c.human === "dave")).toBe(true);
      });

      // Also assert from team-a's side: listActiveClaims for team-a has no team-b row
      const now = new Date();
      const teamAClaims = await listActiveClaims(
        pool,
        workspaceIdA,
        REPO,
        now,
        120,
        {
          excludeSessionId: "00000000-0000-0000-0000-000000000000",
        },
      );
      const daveClaims = teamAClaims.filter((c) => c.human === "dave");
      expect(daveClaims).toHaveLength(0);
    });

    // ----- P1 ISOLATION GATE: cross-tenant sessionId replay -----------------
    //
    // The headline invariant: a session minted in workspace B, replayed through
    // a credential scoped to workspace A, must be REJECTED (UnknownSessionError →
    // 404) and write NOTHING — never a silent cross-tenant read or a 500. The
    // gate is the workspace-scoped getSession(db, workspaceId, sessionId) at the
    // top of every session-bearing op.
    it("a sessionId minted in team-b, replayed via the team-a tenant, is rejected 404 with no row written", async () => {
      // Mint a real session in team-b directly (bypassing the op layer, which
      // only knows team-a's tenant here).
      const sessionIdB = await withTransaction(pool, async (tx) => {
        const agentB = await createAgent(tx, {
          workspaceId: workspaceIdB,
          name: "TeamBVictim",
          human: "dave",
          program: "claude",
          model: null,
        });
        const sessionB = await createSession(tx, {
          workspaceId: workspaceIdB,
          agentId: agentB.id,
          repo: REPO,
          branch: BRANCH,
        });
        return sessionB.id;
      });

      // Replay team-b's sessionId through the team-a tenant. getSession scopes by
      // workspaceIdA, so the row is invisible → UnknownSessionError (→ 404).
      await expect(
        work(
          {
            sessionId: sessionIdB,
            intent: "cross-tenant write attempt",
            pathGlobs: ["src/**"],
          },
          tenantA,
        ),
      ).rejects.toBeInstanceOf(UnknownSessionError);

      // The same replay across the other session-bearing ops is rejected too.
      await expect(
        sync({ sessionId: sessionIdB }, tenantA),
      ).rejects.toBeInstanceOf(UnknownSessionError);
      await expect(
        announce({ sessionId: sessionIdB, body: "leak" }, tenantA),
      ).rejects.toBeInstanceOf(UnknownSessionError);

      // No work_item was written in EITHER workspace by the rejected calls.
      const { rows } = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM work_items`,
      );
      expect(Number(rows[0]!.count)).toBe(0);

      // And no announcement landed in team-b (the targeted victim) either.
      const annRows = await pool.query<{ count: string }>(
        `SELECT COUNT(*)::int AS count FROM announcements WHERE workspace_id = $1`,
        [workspaceIdB],
      );
      expect(Number(annRows.rows[0]!.count)).toBe(0);
    });
  },
);

// ---------------------------------------------------------------------------
// Suite: HTTP layer — auth + routing via buildServer().inject()
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Integration: HTTP auth + routing (buildServer)" +
    (!dbAvailable
      ? " (SKIPPED: no TEST_DATABASE_URL or DATABASE_URL configured)"
      : ""),
  () => {
    let pool: pg.Pool;
    let app: Awaited<ReturnType<typeof buildServer>>;
    const TOKEN = "integration-test-token";
    const AUTH_HEADER = `Bearer ${TOKEN}`;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      await seedWorkspace(pool, WS);
      initContext({ pool, config: makeTestConfig() });
      app = buildServer();
      await app.ready();
    });

    afterEach(async () => {
      __resetRateLimiter();
      await truncateAll(pool);
    });

    afterAll(async () => {
      await app.close();
      resetContext();
      await pool.end();
    });

    it("POST /join with valid bearer returns 200 with agentName and sessionId", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/join",
        headers: {
          authorization: AUTH_HEADER,
          "content-type": "application/json",
        },
        payload: {
          workspace: WS,
          repo: REPO,
          branch: BRANCH,
          human: "alice",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ agentName: string; sessionId: string }>();
      expect(typeof body.agentName).toBe("string");
      expect(body.agentName.length).toBeGreaterThan(0);
      expect(body.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });

    it("POST /join with no Authorization header returns 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/join",
        headers: { "content-type": "application/json" },
        payload: {
          workspace: WS,
          repo: REPO,
          branch: BRANCH,
          human: "alice",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it("POST /join with wrong bearer token returns 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/join",
        headers: {
          authorization: "Bearer wrong-token",
          "content-type": "application/json",
        },
        payload: {
          workspace: WS,
          repo: REPO,
          branch: BRANCH,
          human: "alice",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
      });

      expect(res.statusCode).toBe(401);
    });

    it("GET /workspaces/:id/landscape (self-host TEAM_TOKEN) returns this workspace's wallboard", async () => {
      // Seed a live agent in the self-host workspace.
      const joinRes = await app.inject({
        method: "POST",
        url: "/join",
        headers: {
          authorization: AUTH_HEADER,
          "content-type": "application/json",
        },
        payload: {
          workspace: WS,
          repo: REPO,
          branch: BRANCH,
          human: "alice",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
      });
      expect(joinRes.statusCode).toBe(200);

      // The :id segment is ignored on the TEAM_TOKEN path (single-workspace
      // deployment); the response is always scoped to the token's workspace.
      const res = await app.inject({
        method: "GET",
        url: "/workspaces/any-id-here/landscape",
        headers: { authorization: AUTH_HEADER },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ agents: Array<{ human: string }> }>();
      expect(body.agents.some((a) => a.human === "alice")).toBe(true);
    });
  },
);

// ---------------------------------------------------------------------------
// Suite: Hosted (BFF) routing — :id membership gate on /workspaces/:id/landscape
// ---------------------------------------------------------------------------
//
// The hosted browser path (x-internal-token + x-account-id) is the only mode
// where the `/workspaces/:id/*` membership check applies: resolveTenant looks up
// findMembership(accountId, :id) and returns 404 when absent — never revealing
// whether the workspace exists. This suite seeds two workspaces + an account
// that is a member of ONLY team-a, and asserts the cross-workspace request 404s.

describe.skipIf(!dbAvailable)(
  "Integration: hosted :id membership gate" +
    (!dbAvailable
      ? " (SKIPPED: no TEST_DATABASE_URL or DATABASE_URL configured)"
      : ""),
  () => {
    let pool: pg.Pool;
    let app: Awaited<ReturnType<typeof buildServer>>;
    let workspaceIdA: string;
    let workspaceIdB: string;
    const INTERNAL_TOKEN = "bff-internal-secret";
    const ACCOUNT = "gh|42";

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      workspaceIdA = await seedWorkspace(pool, WS);
      workspaceIdB = await seedWorkspace(pool, "team-b");
      // Account is a member of team-a only.
      await pool.query(
        `INSERT INTO account_profiles (account_id, display_name, github_login)
         VALUES ($1, 'Mallory', 'mallory') ON CONFLICT (account_id) DO NOTHING`,
        [ACCOUNT],
      );
      await pool.query(
        `INSERT INTO memberships (account_id, workspace_id, role)
         VALUES ($1, $2, 'member') ON CONFLICT (account_id, workspace_id) DO NOTHING`,
        [ACCOUNT, workspaceIdA],
      );
      // Hosted config: BFF_INTERNAL_TOKEN set enables the browser-via-BFF path.
      initContext({
        pool,
        config: makeTestConfig({ BFF_INTERNAL_TOKEN: INTERNAL_TOKEN }),
      });
      app = buildServer();
      await app.ready();
    });

    afterEach(async () => {
      __resetRateLimiter();
      await truncateAll(pool);
    });

    afterAll(async () => {
      await app.close();
      resetContext();
      await pool.end();
    });

    function bffHeaders(): Record<string, string> {
      return {
        "x-internal-token": INTERNAL_TOKEN,
        "x-account-id": ACCOUNT,
        "x-github-login": "mallory",
      };
    }

    it("member of team-a → GET /workspaces/:idA/landscape returns 200", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceIdA}/landscape`,
        headers: bffHeaders(),
      });
      expect(res.statusCode).toBe(200);
    });

    it("member of team-a → GET /workspaces/:idB/landscape (not a member) returns 404", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${workspaceIdB}/landscape`,
        headers: bffHeaders(),
      });
      expect(res.statusCode).toBe(404);
      // Generic message — never reveals whether team-b exists.
      const body = res.json<{ error: string }>();
      expect(body.error).toBe("Not found");
    });
  },
);
