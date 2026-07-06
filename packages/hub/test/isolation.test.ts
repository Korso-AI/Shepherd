/**
 * CROSS-TENANT ISOLATION INVARIANT SUITE (Task 4.1) — the security gate.
 *
 * Design §4.5: a credential bound to workspace A can NEVER read or mutate
 * workspace B's data on ANY endpoint, and a client-supplied `x-account-id`
 * without a valid `x-internal-token` is rejected before any handler runs. This
 * suite is DB-backed and must never be skipped/yellow when Postgres is
 * available — it is the teeth behind the multi-tenancy boundary.
 *
 * It runs against a HOSTED hub (BFF_INTERNAL_TOKEN set) so two real workspaces A
 * and B can coexist. Each workspace has a distinct account (admin membership) and
 * a distinct agent shp_ token scoped to that workspace. Every assertion proves
 * one of four isolation properties at the HTTP layer (app.inject):
 *
 *   A. sessionId-replay across ALL SIX session-bearing ops (work/done/sync/
 *      heartbeat/leave/announce): a non-secret session UUID minted in B, replayed
 *      with A's bearer, must not cross tenants — and write nothing in EITHER ws.
 *   B. per-endpoint cross-tenant read/write on the management/:id routes: an
 *      A-bound credential hitting /workspaces/{B}/... is 404 (generic, no
 *      existence leak); B's rows are unchanged. Agent token A against
 *      /workspaces/{B}/tokens is pinned to A's workspace (never returns B's).
 *   C. join cross-tenant (C1 guard): A's token with a body naming B's slug → 403,
 *      no agent/session row created.
 *   D. forged-account negative platform contract: x-account-id for B with no /
 *      wrong x-internal-token → 401, before any handler runs.
 *
 * Harness mirrors members.test.ts / workspaceAnnounceAdmin.test.ts: a real pool,
 * the onRequest hook hits the DB, seed workspaces + memberships + account_profiles
 * + tokens by hand (idempotent). truncateAll + truncateTenancy reset between
 * tests; the rate limiter is reset in afterEach. The cross-tenant SESSION rows for
 * the replay tests are minted directly under workspace B via createAgent/
 * createSession (the op layer here only ever knows A's or B's own tenant).
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
} from "vitest";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  runTestMigrations,
  truncateAll,
  truncateTenancy,
} from "./setup.js";
import { initContext, resetContext } from "../src/context.js";
import { buildServer } from "../src/server.js";
import { __resetRateLimiter, hashToken } from "../src/tenant.js";
import {
  createAgent,
  createSession,
  insertWorkItem,
} from "../src/repo.js";
import { withTransaction } from "../src/db.js";
import type { Config } from "../src/config.js";
import type { FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// Config / credentials
// ---------------------------------------------------------------------------

const TEST_TOKEN = "secret-test-token";
const ALLOWED_WS = "test-ws"; // the self-host workspace slug (unused by A/B here)
const INTERNAL_TOKEN = "internal-bff-secret";

const SLUG_A = "iso-ws-a";
const SLUG_B = "iso-ws-b";
const ACCOUNT_A = "acct-a";
const ACCOUNT_B = "acct-b";
const RAW_TOKEN_A = "shp_iso_token_a";
const RAW_TOKEN_B = "shp_iso_token_b";
// Account-scoped token for account A (workspace_id NULL): carries no route
// workspace, so operations resolve + authorize the session's workspace by live
// membership. Account A is a member of wsA ONLY.
const RAW_ACCT_TOKEN_A = "shp_iso_acct_a";
const REPO = "org/repo";
const BRANCH = "main";

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

// ---------------------------------------------------------------------------
// Header helpers — the three credential shapes resolveTenant accepts
// ---------------------------------------------------------------------------

/** BFF browser headers (bodyless GET/DELETE): trusted x-internal-token + account. */
function bffAuthHeaders(accountId: string, extra: Record<string, string> = {}) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "x-account-id": accountId,
    ...extra,
  };
}

/** BFF browser headers for a JSON-body request (POST). */
function bffHeaders(accountId: string, extra: Record<string, string> = {}) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "x-account-id": accountId,
    "content-type": "application/json",
    ...extra,
  };
}

/** Agent shp_ token bearer headers for a JSON-body request. */
function agentHeaders(raw: string, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${raw}`,
    "content-type": "application/json",
    ...extra,
  };
}

/** Agent shp_ token bearer headers for a bodyless request (GET/DELETE). */
function agentAuthHeaders(raw: string, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${raw}`,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Seed helpers (idempotent — truncateTenancy clears between tests)
// ---------------------------------------------------------------------------

async function seedWorkspace(pool: pg.Pool, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [slug, slug]
  );
  return rows[0]!.id;
}

async function seedMembership(
  pool: pg.Pool,
  accountId: string,
  workspaceId: string,
  role: "admin" | "member" = "admin"
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (account_id, workspace_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (account_id, workspace_id) DO UPDATE SET role = EXCLUDED.role`,
    [accountId, workspaceId, role]
  );
}

async function seedProfile(pool: pg.Pool, accountId: string): Promise<void> {
  await pool.query(
    `INSERT INTO account_profiles (account_id, display_name, github_login)
     VALUES ($1, $1, $1) ON CONFLICT (account_id) DO NOTHING`,
    [accountId]
  );
}

/** Seed a live (non-revoked) api_token for (accountId, workspaceId); returns its id. */
async function seedToken(
  pool: pg.Pool,
  accountId: string,
  workspaceId: string,
  raw: string
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO api_tokens (workspace_id, account_id, token_hash, name)
     VALUES ($1, $2, $3, NULL) RETURNING id`,
    [workspaceId, accountId, hashToken(raw)]
  );
  return rows[0]!.id;
}

/**
 * Seed a live ACCOUNT-scoped api_token (workspace_id NULL) for `accountId`;
 * returns its id. Mirrors resolveTenant's account-scoped branch — the token
 * names no workspace, so the operation layer authorizes membership per request.
 */
async function seedAccountToken(
  pool: pg.Pool,
  accountId: string,
  raw: string
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO api_tokens (workspace_id, account_id, token_hash, name)
     VALUES (NULL, $1, $2, NULL) RETURNING id`,
    [accountId, hashToken(raw)]
  );
  return rows[0]!.id;
}

/**
 * Mint a real session in `workspaceId` directly (bypassing the op layer, which
 * here only ever knows A's or B's OWN tenant). Returns the session id.
 */
async function mintSession(
  pool: pg.Pool,
  workspaceId: string,
  human: string
): Promise<string> {
  return withTransaction(pool, async (tx) => {
    const agent = await createAgent(tx, {
      workspaceId,
      name: `victim-${human}`,
      human,
      program: "claude",
      model: null,
    });
    const session = await createSession(tx, {
      workspaceId,
      agentId: agent.id,
      repo: REPO,
      branch: BRANCH,
    });
    return session.id;
  });
}

/** Mint a session AND an active work item under `workspaceId`; returns both ids. */
async function mintSessionWithClaim(
  pool: pg.Pool,
  workspaceId: string,
  human: string
): Promise<{ sessionId: string; workItemId: string }> {
  return withTransaction(pool, async (tx) => {
    const agent = await createAgent(tx, {
      workspaceId,
      name: `victim-claim-${human}`,
      human,
      program: "claude",
      model: null,
    });
    const session = await createSession(tx, {
      workspaceId,
      agentId: agent.id,
      repo: REPO,
      branch: BRANCH,
    });
    const now = new Date();
    const workItemId = await insertWorkItem(tx, {
      workspaceId,
      sessionId: session.id,
      repo: REPO,
      intentText: "B's protected work",
      pathGlobs: ["src/**"],
      ttlSeconds: 1800,
      expiresAt: new Date(now.getTime() + 1800 * 1000),
    });
    return { sessionId: session.id, workItemId };
  });
}

// --- Assertion helpers ------------------------------------------------------

async function countWorkItems(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM work_items`
  );
  return Number(rows[0]!.n);
}

async function countAnnouncements(
  pool: pg.Pool,
  workspaceId: string
): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM announcements WHERE workspace_id = $1`,
    [workspaceId]
  );
  return Number(rows[0]!.n);
}

async function countAgents(
  pool: pg.Pool,
  workspaceId: string
): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM agents WHERE workspace_id = $1`,
    [workspaceId]
  );
  return Number(rows[0]!.n);
}

async function sessionHeartbeat(pool: pg.Pool, sessionId: string): Promise<Date> {
  const { rows } = await pool.query<{ last_heartbeat_at: Date }>(
    `SELECT last_heartbeat_at FROM sessions WHERE id = $1`,
    [sessionId]
  );
  return rows[0]!.last_heartbeat_at;
}

async function workItemStatus(
  pool: pg.Pool,
  workItemId: string
): Promise<string> {
  const { rows } = await pool.query<{ status: string }>(
    `SELECT status FROM work_items WHERE id = $1`,
    [workItemId]
  );
  return rows[0]!.status;
}

async function workItemExpiry(
  pool: pg.Pool,
  workItemId: string
): Promise<Date> {
  const { rows } = await pool.query<{ expires_at: Date }>(
    `SELECT expires_at FROM work_items WHERE id = $1`,
    [workItemId]
  );
  return rows[0]!.expires_at;
}

// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Cross-tenant ISOLATION invariants (DB-gated)" +
    (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    let pool: pg.Pool;
    let app: FastifyInstance;
    let wsA: string;
    let wsB: string;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      initContext({ pool, config: makeTestConfig() });
      app = buildServer();
      await app.ready();
    });

    /**
     * Seed the two-workspace world fresh per test. truncateTenancy clears
     * everything (CASCADE drops coordination rows too); truncateAll first gives a
     * clean failure surface. Re-seed A and B with their accounts + tokens.
     */
    async function seedWorld(): Promise<void> {
      wsA = await seedWorkspace(pool, SLUG_A);
      wsB = await seedWorkspace(pool, SLUG_B);
      await seedProfile(pool, ACCOUNT_A);
      await seedProfile(pool, ACCOUNT_B);
      // Each account is an ADMIN of its OWN workspace only.
      await seedMembership(pool, ACCOUNT_A, wsA, "admin");
      await seedMembership(pool, ACCOUNT_B, wsB, "admin");
      // A distinct agent shp_ token scoped to each workspace.
      await seedToken(pool, ACCOUNT_A, wsA, RAW_TOKEN_A);
      await seedToken(pool, ACCOUNT_B, wsB, RAW_TOKEN_B);
      // An ACCOUNT-scoped token for A (no route workspace); A is a member of
      // wsA ONLY, so it must be rejected on any session living in wsB.
      await seedAccountToken(pool, ACCOUNT_A, RAW_ACCT_TOKEN_A);
    }

    beforeAll(async () => {
      // Clear any tenancy rows left by a PRIOR process run (afterAll only ends the
      // pool; seedToken is not idempotent on token_hash) so the first seed is clean.
      await truncateAll(pool);
      await truncateTenancy(pool);
      await seedWorld();
    });

    afterEach(async () => {
      __resetRateLimiter();
      await truncateAll(pool);
      await truncateTenancy(pool);
      // Re-establish the world for the next test (seeds are not in beforeEach
      // upstream; we rebuild here so every test starts from the same two-ws state).
      await seedWorld();
    });

    afterAll(async () => {
      await app.close();
      resetContext();
      await pool.end();
    });

    // =======================================================================
    // A. sessionId-replay across ALL SIX session-bearing ops (key decision #6)
    //
    // The headline P1 case. A session minted in B, replayed with A's bearer
    // token, must not cross tenants. work/done/sync/heartbeat/announce all run
    // getSession(db, workspaceIdA, sessionIdB) → not found → UnknownSessionError
    // → 404. As of Task 2.2 `leave` ALSO routes
    // through resolveSession (so account-scoped tokens work on it), so a
    // cross-tenant sessionId now 404s like the rest instead of the old
    // idempotent 200 no-op — a strictly stronger isolation posture. Every op
    // asserts NO row crosses.
    // =======================================================================

    it("A. replay: work with B's sessionId via A's token → 404, no work_item written in either ws", async () => {
      const sessionIdB = await mintSession(pool, wsB, "dave");

      const res = await app.inject({
        method: "POST",
        url: "/work",
        headers: agentHeaders(RAW_TOKEN_A),
        payload: {
          sessionId: sessionIdB,
          intent: "cross-tenant write attempt",
          pathGlobs: ["src/**"],
        },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: string }>().error).toBe(`Session not found: ${sessionIdB}`);
      // Nothing written anywhere.
      expect(await countWorkItems(pool)).toBe(0);
    });

    it("A. replay: sync with B's sessionId via A's token → 404, no claim renewed", async () => {
      const { sessionId: sessionIdB, workItemId } = await mintSessionWithClaim(
        pool,
        wsB,
        "dave"
      );
      // Capture the renewal-bearing fields BEFORE the replay. sync renews via
      // touchHeartbeat, which mutates the claim's expires_at and the session's
      // last_heartbeat_at (NOT status/count) — so we assert THESE are byte-
      // identical afterwards to prove no cross-tenant renewal happened, mirroring
      // the heartbeat-replay case rather than relying on it.
      const expiryBefore = await workItemExpiry(pool, workItemId);
      const heartbeatBefore = await sessionHeartbeat(pool, sessionIdB);

      const res = await app.inject({
        method: "POST",
        url: "/sync",
        headers: agentHeaders(RAW_TOKEN_A),
        payload: { sessionId: sessionIdB },
      });
      expect(res.statusCode).toBe(404);
      // B's pre-existing claim is the only work_item; sync created none and
      // could not have renewed/mutated B's claim (it never resolved the session).
      expect(await countWorkItems(pool)).toBe(1);
      expect(await workItemStatus(pool, workItemId)).toBe("active");
      // Renewal fields untouched: getSession 404s before touchHeartbeat runs.
      expect((await workItemExpiry(pool, workItemId)).getTime()).toBe(
        expiryBefore.getTime()
      );
      expect((await sessionHeartbeat(pool, sessionIdB)).getTime()).toBe(
        heartbeatBefore.getTime()
      );
    });

    it("A. replay: announce with B's sessionId via A's token → 404, no announcement in B", async () => {
      const sessionIdB = await mintSession(pool, wsB, "dave");

      const res = await app.inject({
        method: "POST",
        url: "/announce",
        headers: agentHeaders(RAW_TOKEN_A),
        payload: { sessionId: sessionIdB, body: "leak attempt" },
      });
      expect(res.statusCode).toBe(404);
      expect(await countAnnouncements(pool, wsB)).toBe(0);
      expect(await countAnnouncements(pool, wsA)).toBe(0);
    });

    it("A. replay: done with B's sessionId + B's workItemId via A's token → 404, B's claim NOT released", async () => {
      const { sessionId: sessionIdB, workItemId } = await mintSessionWithClaim(
        pool,
        wsB,
        "dave"
      );

      const res = await app.inject({
        method: "POST",
        url: "/done",
        headers: agentHeaders(RAW_TOKEN_A),
        payload: { sessionId: sessionIdB, workItemId },
      });
      expect(res.statusCode).toBe(404);
      // done resolves the session (getSession) BEFORE releasing, so the replay is
      // rejected and B's claim remains active — never released cross-tenant.
      expect(await workItemStatus(pool, workItemId)).toBe("active");
    });

    it("A. replay: heartbeat with B's sessionId via A's token → 404, B's presence NOT bumped", async () => {
      const sessionIdB = await mintSession(pool, wsB, "dave");
      // Backdate B's presence so we can prove the heartbeat did NOT refresh it.
      const backdated = new Date(Date.now() - 300_000);
      await pool.query(
        `UPDATE sessions SET last_heartbeat_at = $1 WHERE id = $2`,
        [backdated, sessionIdB]
      );

      const res = await app.inject({
        method: "POST",
        url: "/heartbeat",
        headers: agentHeaders(RAW_TOKEN_A),
        payload: { sessionId: sessionIdB },
      });
      expect(res.statusCode).toBe(404);
      // Presence unchanged: getSession scoped to A never finds B's session.
      const after = await sessionHeartbeat(pool, sessionIdB);
      expect(after.getTime()).toBe(backdated.getTime());
    });

    it("A. replay: leave with B's sessionId via A's token → 404 (Task 2.2), B's presence untouched", async () => {
      const sessionIdB = await mintSession(pool, wsB, "dave");
      const before = await sessionHeartbeat(pool, sessionIdB);

      const res = await app.inject({
        method: "POST",
        url: "/leave",
        headers: agentHeaders(RAW_TOKEN_A),
        payload: { sessionId: sessionIdB },
      });
      // As of Task 2.2 leave resolves the session via resolveSession FIRST:
      // scoped to A's workspace, B's session is not found → 404 (no longer the
      // old idempotent 200 no-op). B's presence is untouched either way — the
      // resolve 404s before expireSessionPresence would run.
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: string }>().error).toBe(`Session not found: ${sessionIdB}`);
      const after = await sessionHeartbeat(pool, sessionIdB);
      expect(after.getTime()).toBe(before.getTime());
    });

    // =======================================================================
    // A2. sessionId-replay via an ACCOUNT-SCOPED token (Task 2.2, both kinds).
    //
    // The same headline replay, but the credential is account A's ACCOUNT-scoped
    // token (workspace_id NULL). It carries no route workspace, so each op reads
    // the session unscoped and authorizes account A against ITS workspace via
    // live membership. Account A is a member of wsA ONLY, so a session minted in
    // wsB is rejected with the SAME 404 as an unknown session — no existence
    // disclosure, no cross-tenant mutation — across ALL SIX ops (leave included).
    // A positive control proves the account-scoped hot path works on A's OWN ws.
    // =======================================================================

    it("A2. account-scoped A: work with B's sessionId → 404, no work_item written", async () => {
      const sessionIdB = await mintSession(pool, wsB, "dave");
      const res = await app.inject({
        method: "POST",
        url: "/work",
        headers: agentHeaders(RAW_ACCT_TOKEN_A),
        payload: {
          sessionId: sessionIdB,
          intent: "cross-tenant write attempt",
          pathGlobs: ["src/**"],
        },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: string }>().error).toBe(`Session not found: ${sessionIdB}`);
      expect(await countWorkItems(pool)).toBe(0);
    });

    it("A2. account-scoped A: sync with B's sessionId → 404, B's claim not renewed", async () => {
      const { sessionId: sessionIdB, workItemId } = await mintSessionWithClaim(
        pool,
        wsB,
        "dave"
      );
      const expiryBefore = await workItemExpiry(pool, workItemId);
      const heartbeatBefore = await sessionHeartbeat(pool, sessionIdB);

      const res = await app.inject({
        method: "POST",
        url: "/sync",
        headers: agentHeaders(RAW_ACCT_TOKEN_A),
        payload: { sessionId: sessionIdB },
      });
      expect(res.statusCode).toBe(404);
      expect(await countWorkItems(pool)).toBe(1);
      expect(await workItemStatus(pool, workItemId)).toBe("active");
      expect((await workItemExpiry(pool, workItemId)).getTime()).toBe(
        expiryBefore.getTime()
      );
      expect((await sessionHeartbeat(pool, sessionIdB)).getTime()).toBe(
        heartbeatBefore.getTime()
      );
    });

    it("A2. account-scoped A: announce with B's sessionId → 404, no announcement in either ws", async () => {
      const sessionIdB = await mintSession(pool, wsB, "dave");
      const res = await app.inject({
        method: "POST",
        url: "/announce",
        headers: agentHeaders(RAW_ACCT_TOKEN_A),
        payload: { sessionId: sessionIdB, body: "leak attempt" },
      });
      expect(res.statusCode).toBe(404);
      expect(await countAnnouncements(pool, wsB)).toBe(0);
      expect(await countAnnouncements(pool, wsA)).toBe(0);
    });

    it("A2. account-scoped A: done with B's sessionId + workItemId → 404, B's claim NOT released", async () => {
      const { sessionId: sessionIdB, workItemId } = await mintSessionWithClaim(
        pool,
        wsB,
        "dave"
      );
      const res = await app.inject({
        method: "POST",
        url: "/done",
        headers: agentHeaders(RAW_ACCT_TOKEN_A),
        payload: { sessionId: sessionIdB, workItemId },
      });
      expect(res.statusCode).toBe(404);
      expect(await workItemStatus(pool, workItemId)).toBe("active");
    });

    it("A2. account-scoped A: heartbeat with B's sessionId → 404, B's presence NOT bumped", async () => {
      const sessionIdB = await mintSession(pool, wsB, "dave");
      const backdated = new Date(Date.now() - 300_000);
      await pool.query(
        `UPDATE sessions SET last_heartbeat_at = $1 WHERE id = $2`,
        [backdated, sessionIdB]
      );
      const res = await app.inject({
        method: "POST",
        url: "/heartbeat",
        headers: agentHeaders(RAW_ACCT_TOKEN_A),
        payload: { sessionId: sessionIdB },
      });
      expect(res.statusCode).toBe(404);
      const after = await sessionHeartbeat(pool, sessionIdB);
      expect(after.getTime()).toBe(backdated.getTime());
    });

    it("A2. account-scoped A: leave with B's sessionId → 404, B's presence untouched", async () => {
      const sessionIdB = await mintSession(pool, wsB, "dave");
      const before = await sessionHeartbeat(pool, sessionIdB);
      const res = await app.inject({
        method: "POST",
        url: "/leave",
        headers: agentHeaders(RAW_ACCT_TOKEN_A),
        payload: { sessionId: sessionIdB },
      });
      expect(res.statusCode).toBe(404);
      const after = await sessionHeartbeat(pool, sessionIdB);
      expect(after.getTime()).toBe(before.getTime());
    });

    it("A2. control: account-scoped A on a session in A's OWN workspace → work succeeds", async () => {
      // Proves the account-scoped hot path works when membership DOES authorize.
      const sessionIdA = await mintSession(pool, wsA, "alice");
      const res = await app.inject({
        method: "POST",
        url: "/work",
        headers: agentHeaders(RAW_ACCT_TOKEN_A),
        payload: {
          sessionId: sessionIdA,
          intent: "own-workspace work",
          pathGlobs: ["src/**"],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ workItemId: string }>().workItemId).toBeTruthy();
      // The one claim is scoped to A's workspace.
      expect(await countWorkItems(pool)).toBe(1);
    });

    // =======================================================================
    // B. Per-endpoint cross-tenant read/write on the /workspaces/:id/* routes.
    //
    // account-A's BFF credential hitting /workspaces/{B}/... must 404 (not a
    // member of B) with the GENERIC "Not found" body (no existence leak), and
    // B's rows must be unchanged. Covers tokens (GET/DELETE), invites
    // (GET-list via create is POST; here POST create + revoke), members
    // (GET/DELETE + leave), landscape (GET), announce (POST).
    // =======================================================================

    it("B. browser A → GET /workspaces/{B}/landscape → 404 generic (no existence leak)", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${wsB}/landscape`,
        headers: bffAuthHeaders(ACCOUNT_A),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: string }>().error).toBe("Not found");
    });

    it("B. browser A → GET /workspaces/{B}/tokens → 404; B's tokens never returned", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${wsB}/tokens`,
        headers: bffAuthHeaders(ACCOUNT_A),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: string }>().error).toBe("Not found");
    });

    it("B. browser A → DELETE /workspaces/{B}/tokens/{tokenB} → 404; B's token NOT revoked", async () => {
      const tokenBId = await seedToken(pool, ACCOUNT_B, wsB, "shp_b_extra");
      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsB}/tokens/${tokenBId}`,
        headers: bffAuthHeaders(ACCOUNT_A),
      });
      expect(res.statusCode).toBe(404);
      const { rows } = await pool.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM api_tokens WHERE id = $1`,
        [tokenBId]
      );
      expect(rows[0]!.revoked_at).toBeNull();
    });

    it("B. browser A → POST /workspaces/{B}/invites → 404; no invite created in B", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsB}/invites`,
        headers: bffHeaders(ACCOUNT_A),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::int AS n FROM invites WHERE workspace_id = $1`,
        [wsB]
      );
      expect(Number(rows[0]!.n)).toBe(0);
    });

    it("B. browser A → POST /workspaces/{B}/invites/{code}/revoke → 404; B's invite NOT revoked", async () => {
      // Seed an invite owned by B's admin so there is a real target row.
      const { rows: invRows } = await pool.query<{ code: string }>(
        `INSERT INTO invites (workspace_id, code, role_granted, created_by, max_uses)
         VALUES ($1, 'bcode123', 'member', $2, 1) RETURNING code`,
        [wsB, ACCOUNT_B]
      );
      const code = invRows[0]!.code;

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsB}/invites/${code}/revoke`,
        headers: bffHeaders(ACCOUNT_A),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      const { rows } = await pool.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM invites WHERE workspace_id = $1 AND code = $2`,
        [wsB, code]
      );
      expect(rows[0]!.revoked_at).toBeNull();
    });

    it("B. browser A → GET /workspaces/{B}/members → 404; B's roster never returned", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${wsB}/members`,
        headers: bffAuthHeaders(ACCOUNT_A),
      });
      expect(res.statusCode).toBe(404);
      expect(res.json<{ error: string }>().error).toBe("Not found");
    });

    it("B. browser A → DELETE /workspaces/{B}/members/{acctB} → 404; B's membership untouched", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsB}/members/${ACCOUNT_B}`,
        headers: bffAuthHeaders(ACCOUNT_A),
      });
      expect(res.statusCode).toBe(404);
      const { rows } = await pool.query(
        `SELECT 1 FROM memberships WHERE account_id = $1 AND workspace_id = $2`,
        [ACCOUNT_B, wsB]
      );
      expect(rows.length).toBe(1);
    });

    it("B. browser A → POST /workspaces/{B}/leave → 404; B's membership untouched", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsB}/leave`,
        headers: bffHeaders(ACCOUNT_A),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
      // A is not a member of B, so there is nothing to leave; B's own admin stays.
      const { rows } = await pool.query(
        `SELECT 1 FROM memberships WHERE account_id = $1 AND workspace_id = $2`,
        [ACCOUNT_B, wsB]
      );
      expect(rows.length).toBe(1);
    });

    it("B. browser A → POST /workspaces/{B}/announce → 404; no announcement written in B", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsB}/announce`,
        headers: bffHeaders(ACCOUNT_A),
        payload: { body: "operator leak", repo: REPO },
      });
      expect(res.statusCode).toBe(404);
      expect(await countAnnouncements(pool, wsB)).toBe(0);
    });

    // --- Agent-token semantics: token A is PINNED to A's workspace -----------
    // resolveTenant ignores the route :id for agent tokens (workspaceId comes
    // from the token row). So token A against /workspaces/{B}/tokens resolves to
    // A's workspace and returns A's OWN tokens — B's tokens are NEVER exposed.

    it("B. agent token A → GET /workspaces/{B}/tokens returns A's tokens, NEVER B's", async () => {
      // Give A two distinct tokens and B one, so the lists are unambiguous.
      const aExtraId = await seedToken(pool, ACCOUNT_A, wsA, "shp_a_extra");
      const bTokenId = await seedToken(pool, ACCOUNT_B, wsB, "shp_b_only");

      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${wsB}/tokens`,
        headers: agentAuthHeaders(RAW_TOKEN_A),
      });
      // The agent token authenticates fine; the route :id is IGNORED — the
      // response is scoped to the TOKEN's workspace (A), never B's.
      expect(res.statusCode).toBe(200);
      const body = res.json<{ tokens: Array<{ id: string }> }>();
      const ids = body.tokens.map((t) => t.id);
      // A's tokens (the seeded RAW_TOKEN_A row + aExtra) are present.
      expect(ids).toContain(aExtraId);
      // B's token id must NOT appear — B's data never crosses to an A credential.
      expect(ids).not.toContain(bTokenId);
    });

    // =======================================================================
    // C. join cross-tenant (C1 guard): A's token + body naming B's slug → 403.
    // =======================================================================

    it("C. agent token A → POST /join with body.workspace = B's slug → 403, no agent/session created", async () => {
      const beforeAgentsA = await countAgents(pool, wsA);
      const beforeAgentsB = await countAgents(pool, wsB);

      const res = await app.inject({
        method: "POST",
        url: "/join",
        headers: agentHeaders(RAW_TOKEN_A),
        payload: {
          workspace: SLUG_B, // naming B while the token is scoped to A
          repo: REPO,
          branch: BRANCH,
          human: "alice",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
      });
      expect(res.statusCode).toBe(403);
      // No agent/session created in EITHER workspace (the guard fires pre-insert).
      expect(await countAgents(pool, wsA)).toBe(beforeAgentsA);
      expect(await countAgents(pool, wsB)).toBe(beforeAgentsB);
    });

    it("C. control: agent token A → POST /join with body.workspace = A's own slug → 200", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/join",
        headers: agentHeaders(RAW_TOKEN_A),
        payload: {
          workspace: SLUG_A,
          repo: REPO,
          branch: BRANCH,
          human: "alice",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ sessionId: string }>();
      expect(body.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
    });

    // =======================================================================
    // D. Forged-account negative platform contract: x-account-id WITHOUT a
    // valid x-internal-token is rejected 401 before any handler runs.
    // =======================================================================

    it("D. forged x-account-id (B) with NO x-internal-token on a :id route → 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${wsB}/landscape`,
        headers: { "x-account-id": ACCOUNT_B }, // no internal token → falls to bearer path → 401
      });
      expect(res.statusCode).toBe(401);
    });

    it("D. forged x-account-id (B) with WRONG x-internal-token on a :id route → 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${wsB}/landscape`,
        headers: {
          "x-internal-token": "not-the-real-secret",
          "x-account-id": ACCOUNT_B,
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it("D. forged x-account-id (B) with NO x-internal-token on a management route → 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: `/workspaces`,
        headers: { "x-account-id": ACCOUNT_B },
      });
      expect(res.statusCode).toBe(401);
    });

    it("D. forged x-account-id (B) with WRONG x-internal-token on a management route → 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/workspaces`,
        headers: {
          "x-internal-token": "not-the-real-secret",
          "x-account-id": ACCOUNT_B,
          "content-type": "application/json",
        },
        payload: { name: "Forged" },
      });
      expect(res.statusCode).toBe(401);
    });
  }
);
