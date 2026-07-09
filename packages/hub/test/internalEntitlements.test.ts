/**
 * Tests for the internal per-workspace entitlements endpoints:
 *   PUT    /internal/workspaces/:id/entitlements — upsert the caps record
 *   GET    /internal/workspaces/:id/entitlements — record + effective + usage
 *   DELETE /internal/workspaces/:id/entitlements — revert to deployment defaults
 *
 * All three are gated on the INTERNAL tenant (matched BFF token + /internal/
 * pathname + NO x-account-id — the service-call discriminator). The security
 * matrix below pins every other credential shape out.
 *
 * Harness mirrors entitlementLimits.test.ts (fixture default caps 4/5/30).
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
import {
  WorkspaceEntitlements,
  EntitlementsStatusResponse,
} from "@shepherd/shared";

const TEST_TOKEN = "secret-test-token";
const ALLOWED_WS = "test-ws";
const INTERNAL_TOKEN = "internal-bff-secret";
const DEFAULT_LIMITS = { seatsLimit: 4, reposLimit: 5, retentionDays: 30 };

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
    ENTITLEMENTS_DEFAULT_LIMITS: DEFAULT_LIMITS,
    ...overrides,
  };
}

/** Headers for the INTERNAL service-call path: matched token, NO account. */
function internalHeaders(extra: Record<string, string> = {}) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "content-type": "application/json",
    ...extra,
  };
}

async function seedWorkspace(pool: pg.Pool, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [slug, slug],
  );
  return rows[0]!.id;
}

describe.skipIf(!dbAvailable)(
  "internal entitlements endpoints (DB-gated)" +
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

    function entitlementsUrl(workspaceId: string, query = ""): string {
      return `/internal/workspaces/${workspaceId}/entitlements${query}`;
    }

    // --- PUT -----------------------------------------------------------------

    it("PUT upserts and returns the record; a second PUT updates in place", async () => {
      const wsId = await seedWorkspace(pool, "int-put");

      const first = await app.inject({
        method: "PUT",
        url: entitlementsUrl(wsId),
        headers: internalHeaders(),
        payload: {
          seatsLimit: 50,
          reposLimit: null,
          retentionDays: 365,
          expiresAt: null,
        },
      });
      expect(first.statusCode).toBe(200);
      const record = WorkspaceEntitlements.parse(first.json());
      expect(record.seatsLimit).toBe(50);
      expect(record.reposLimit).toBeNull();
      expect(record.retentionDays).toBe(365);
      expect(record.expiresAt).toBeNull();

      const expiresAt = "2026-12-31T00:00:00.000Z";
      const second = await app.inject({
        method: "PUT",
        url: entitlementsUrl(wsId),
        headers: internalHeaders(),
        payload: {
          seatsLimit: 8,
          reposLimit: 10,
          retentionDays: 60,
          expiresAt,
        },
      });
      expect(second.statusCode).toBe(200);
      const updated = WorkspaceEntitlements.parse(second.json());
      expect(updated.seatsLimit).toBe(8);
      expect(new Date(updated.expiresAt!).toISOString()).toBe(expiresAt);

      // Still exactly one row.
      const { rows } = await pool.query(
        `SELECT count(*) AS count FROM workspace_entitlements WHERE workspace_id = $1`,
        [wsId],
      );
      expect(Number(rows[0]!.count)).toBe(1);
    });

    it("PUT for an unknown workspace id → 404", async () => {
      const res = await app.inject({
        method: "PUT",
        url: entitlementsUrl("00000000-0000-0000-0000-000000000000"),
        headers: internalHeaders(),
        payload: {
          seatsLimit: 8,
          reposLimit: 10,
          retentionDays: 60,
          expiresAt: null,
        },
      });
      expect(res.statusCode).toBe(404);
    });

    // --- GET -----------------------------------------------------------------

    it("GET returns record, effective limits, and usage", async () => {
      const wsId = await seedWorkspace(pool, "int-get");
      // Usage: 2 members, 1 distinct session repo.
      await pool.query(
        `INSERT INTO memberships (account_id, workspace_id, role)
         VALUES ('acct-a', $1, 'admin'), ('acct-b', $1, 'member')`,
        [wsId],
      );
      const { rows: agents } = await pool.query<{ id: string }>(
        `INSERT INTO agents (workspace_id, name, human, program, model)
         VALUES ($1, 'int-agent', 'alice', 'prog', 'model') RETURNING id`,
        [wsId],
      );
      await pool.query(
        `INSERT INTO sessions (workspace_id, agent_id, repo, branch)
         VALUES ($1, $2, 'usage-repo', 'main')`,
        [wsId, agents[0]!.id],
      );
      await pool.query(
        `INSERT INTO workspace_entitlements (workspace_id, seats_limit) VALUES ($1, 50)`,
        [wsId],
      );

      // Query string exercises the pathname check (via stays internal).
      const res = await app.inject({
        method: "GET",
        url: entitlementsUrl(wsId, "?source=test"),
        headers: internalHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const status = EntitlementsStatusResponse.parse(res.json());
      expect(status.record?.seatsLimit).toBe(50);
      // Live record wins verbatim: its null caps mean unlimited.
      expect(status.effective).toEqual({
        seatsLimit: 50,
        reposLimit: null,
        retentionDays: null,
      });
      expect(status.usage).toEqual({ seatsUsed: 2, reposUsed: 1 });
    });

    it("GET with no record reports null record and the deployment defaults", async () => {
      const wsId = await seedWorkspace(pool, "int-get-empty");
      const res = await app.inject({
        method: "GET",
        url: entitlementsUrl(wsId),
        headers: internalHeaders(),
      });
      expect(res.statusCode).toBe(200);
      const status = EntitlementsStatusResponse.parse(res.json());
      expect(status.record).toBeNull();
      expect(status.effective).toEqual(DEFAULT_LIMITS);
      expect(status.usage).toEqual({ seatsUsed: 0, reposUsed: 0 });
    });

    it("after a PUT with a past expiresAt, GET's effective equals the deployment defaults", async () => {
      const wsId = await seedWorkspace(pool, "int-get-expired");
      const put = await app.inject({
        method: "PUT",
        url: entitlementsUrl(wsId),
        headers: internalHeaders(),
        payload: {
          seatsLimit: 50,
          reposLimit: 60,
          retentionDays: 365,
          expiresAt: "2020-01-01T00:00:00.000Z",
        },
      });
      expect(put.statusCode).toBe(200);

      const res = await app.inject({
        method: "GET",
        url: entitlementsUrl(wsId),
        headers: internalHeaders(),
      });
      const status = EntitlementsStatusResponse.parse(res.json());
      expect(status.record?.seatsLimit).toBe(50); // stored record still visible
      expect(status.effective).toEqual(DEFAULT_LIMITS); // but inert
    });

    // --- DELETE ----------------------------------------------------------------

    it("DELETE reports deleted:true then deleted:false; workspace reverts to defaults", async () => {
      const wsId = await seedWorkspace(pool, "int-del");
      await pool.query(
        `INSERT INTO workspace_entitlements (workspace_id, seats_limit) VALUES ($1, 50)`,
        [wsId],
      );

      const first = await app.inject({
        method: "DELETE",
        url: entitlementsUrl(wsId),
        headers: internalHeaders(),
      });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ deleted: true });

      const second = await app.inject({
        method: "DELETE",
        url: entitlementsUrl(wsId),
        headers: internalHeaders(),
      });
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ deleted: false });

      const res = await app.inject({
        method: "GET",
        url: entitlementsUrl(wsId),
        headers: internalHeaders(),
      });
      const status = EntitlementsStatusResponse.parse(res.json());
      expect(status.record).toBeNull();
      expect(status.effective).toEqual(DEFAULT_LIMITS);
    });

    // --- Security matrix -------------------------------------------------------

    it("the routes reject every non-internal credential shape", async () => {
      const wsId = await seedWorkspace(pool, "int-sec");
      // TEAM_TOKEN resolves ALLOWED_WORKSPACE by slug — seed it so that path
      // authenticates (via: "team") and hits requireInternal's 403, not a 401.
      await seedWorkspace(pool, ALLOWED_WS);
      await pool.query(
        `INSERT INTO memberships (account_id, workspace_id, role) VALUES ('acct-adm', $1, 'admin')`,
        [wsId],
      );
      await pool.query(
        `INSERT INTO api_tokens (workspace_id, account_id, token_hash, name)
         VALUES ($1, 'acct-adm', $2, 'sec-token')`,
        [wsId, hashToken("shp_sec_token")],
      );
      const payload = {
        seatsLimit: 8,
        reposLimit: 10,
        retentionDays: 60,
        expiresAt: null,
      };

      // Matched token but WITH x-account-id (proxied browser) → 403.
      const proxied = await app.inject({
        method: "PUT",
        url: entitlementsUrl(wsId),
        headers: internalHeaders({ "x-account-id": "acct-adm" }),
        payload,
      });
      expect(proxied.statusCode).toBe(403);

      // Agent shp_ token → 403.
      const agent = await app.inject({
        method: "PUT",
        url: entitlementsUrl(wsId),
        headers: {
          authorization: "Bearer shp_sec_token",
          "content-type": "application/json",
        },
        payload,
      });
      expect(agent.statusCode).toBe(403);

      // Self-host TEAM_TOKEN → 403.
      const team = await app.inject({
        method: "PUT",
        url: entitlementsUrl(wsId),
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          "content-type": "application/json",
        },
        payload,
      });
      expect(team.statusCode).toBe(403);

      // Wrong internal token → 401.
      const wrong = await app.inject({
        method: "PUT",
        url: entitlementsUrl(wsId),
        headers: {
          "x-internal-token": "not-the-secret",
          "content-type": "application/json",
        },
        payload,
      });
      expect(wrong.statusCode).toBe(401);

      // Nothing was written by any of them.
      const { rows } = await pool.query(
        `SELECT count(*) AS count FROM workspace_entitlements WHERE workspace_id = $1`,
        [wsId],
      );
      expect(Number(rows[0]!.count)).toBe(0);
    });
  },
);
