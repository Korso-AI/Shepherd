/**
 * Tests for the ADMIN GATE on operator/dashboard announcements (Task 3.7).
 *
 * `workspaceAnnounce` (operations/workspaceAnnounce.ts) backs BOTH the hosted
 * `/workspaces/:id/announce` route and the self-host `/workspace/announce`
 * alias. Design §4.4 makes operator announcements admin-only in HOSTED mode
 * while preserving self-host (TEAM_TOKEN) behavior, which has no role concept.
 *
 * The op-level guard keys off `tenant.accountId`:
 *   - account-bearing caller (hosted browser-via-BFF, OR an agent shp_ token) →
 *     requireAdmin(tenant): admin passes, member/no-membership → 403.
 *   - self-host TEAM_TOKEN (no accountId) → guard skipped, full access.
 *
 * Setup mirrors members.test.ts: a real pool, the onRequest hook hits the DB,
 * and we seed workspaces + memberships + account_profiles + tokens by hand.
 * truncateAll + truncateTenancy reset between tests; the rate limiter is reset
 * in afterEach. A specific `repo` is broadcast so a row is written without
 * needing a live agent session.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
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
import type { Config } from "../src/config.js";
import type { FastifyInstance } from "fastify";

// ---------------------------------------------------------------------------
// Config / credentials
// ---------------------------------------------------------------------------

const TEST_TOKEN = "secret-test-token";
const ALLOWED_WS = "test-ws";
const INTERNAL_TOKEN = "internal-bff-secret";
const ADMIN_LABEL = "admin@example.test";

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
    HUB_ADMIN_LABEL: ADMIN_LABEL,
    ...overrides,
  };
}

/** BFF headers for a JSON-body request asserting `accountId`. */
function bffHeaders(accountId: string, extra: Record<string, string> = {}) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "x-account-id": accountId,
    "content-type": "application/json",
    ...extra,
  };
}

/** Self-host TEAM_TOKEN bearer headers for a JSON-body request. */
function teamHeaders(extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${TEST_TOKEN}`,
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

/** Seed a live (non-revoked) api_token for (accountId, workspaceId); returns its id. */
async function seedToken(
  pool: pg.Pool,
  accountId: string,
  workspaceId: string,
  raw: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO api_tokens (workspace_id, account_id, token_hash, name)
     VALUES ($1, $2, $3, NULL) RETURNING id`,
    [workspaceId, accountId, hashToken(raw)],
  );
  return rows[0]!.id;
}

/** Count announcement rows for a workspace (the side-effect assertion). */
async function countAnnouncements(
  pool: pg.Pool,
  workspaceId: string,
): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM announcements WHERE workspace_id = $1`,
    [workspaceId],
  );
  return Number(rows[0]!.n);
}

// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "workspaceAnnounce admin gate (DB-gated)" +
    (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    let pool: pg.Pool;
    let app: FastifyInstance;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      initContext({ pool, config: makeTestConfig() });
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
      await pool.end();
    });

    // --- Hosted browser-via-BFF on /workspaces/:id/announce -----------------

    it("hosted ADMIN may announce: row written with from_admin=true", async () => {
      const wsId = await seedWorkspace(pool, "announce-admin");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/announce`,
        headers: bffHeaders("acct-admin"),
        payload: { body: "Standup in 5", repo: "org/repo" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        ok: boolean;
        announcementIds: number[];
      };
      expect(body.ok).toBe(true);
      expect(body.announcementIds).toHaveLength(1);

      const { rows } = await pool.query<{ from_admin: boolean }>(
        `SELECT from_admin FROM announcements WHERE id = $1`,
        [body.announcementIds[0]],
      );
      expect(rows[0]!.from_admin).toBe(true);
      expect(await countAnnouncements(pool, wsId)).toBe(1);
    });

    it("hosted MEMBER (non-admin) is rejected 403 with NO row written", async () => {
      const wsId = await seedWorkspace(pool, "announce-member");
      await seedMembership(pool, "acct-member", wsId, "member");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/announce`,
        headers: bffHeaders("acct-member"),
        payload: { body: "I should not be allowed", repo: "org/repo" },
      });
      expect(res.statusCode).toBe(403);
      // The guard fires before any insert.
      expect(await countAnnouncements(pool, wsId)).toBe(0);
    });

    // --- Self-host TEAM_TOKEN on /workspace/announce ------------------------

    it("self-host TEAM_TOKEN may announce (no role concept) → success", async () => {
      // resolveTenant looks the self-host workspace up by ALLOWED_WORKSPACE slug.
      const wsId = await seedWorkspace(pool, ALLOWED_WS);

      const res = await app.inject({
        method: "POST",
        url: `/workspace/announce`,
        headers: teamHeaders(),
        payload: { body: "self-host notice", repo: "org/repo" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; announcementIds: number[] };
      expect(body.ok).toBe(true);
      expect(body.announcementIds).toHaveLength(1);
      expect(await countAnnouncements(pool, wsId)).toBe(1);
    });

    // --- Agent shp_ token, gated by the minter's role -----------------------

    it("agent token minted by a MEMBER is rejected 403 with NO row written", async () => {
      const wsId = await seedWorkspace(pool, "announce-agent-member");
      await seedMembership(pool, "acct-member", wsId, "member");
      await seedToken(pool, "acct-member", wsId, "shp_member_tok");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/announce`,
        headers: agentHeaders("shp_member_tok"),
        payload: { body: "agent member announce", repo: "org/repo" },
      });
      expect(res.statusCode).toBe(403);
      expect(await countAnnouncements(pool, wsId)).toBe(0);
    });

    it("agent token minted by an ADMIN may announce → success", async () => {
      const wsId = await seedWorkspace(pool, "announce-agent-admin");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      await seedToken(pool, "acct-admin", wsId, "shp_admin_tok");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/announce`,
        headers: agentHeaders("shp_admin_tok"),
        payload: { body: "agent admin announce", repo: "org/repo" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { ok: boolean; announcementIds: number[] };
      expect(body.ok).toBe(true);
      expect(await countAnnouncements(pool, wsId)).toBe(1);
    });
  },
);
