/**
 * Tests for the workspace create/list endpoints (Task 3.3):
 *   POST /workspaces  — a signed-in account mints a new workspace + becomes its admin.
 *   GET  /workspaces  — list the caller's workspaces (agent-token reachable).
 *
 * Both routes are NON-`:id` routes, so resolveTenant resolves the browser-via-BFF
 * path to `{ workspaceId: NO_ROUTE_WORKSPACE, accountId }` (no route workspace to
 * validate) and the agent `shp_` path to `{ workspaceId: <token ws>, accountId }`.
 * The self-host TEAM_TOKEN path carries NO accountId, so management is rejected.
 *
 * Tenancy setup mirrors server.test.ts: a real pool with the self-host workspace
 * seeded (the onRequest hook hits the DB before the handler). We additionally seed
 * account_profiles + api_tokens by hand so the BFF and agent credential paths
 * resolve. truncateTenancy resets the tenancy tables between tests.
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
import type { Config } from "../src/config.js";
import type { FastifyInstance } from "fastify";
import {
  CreateWorkspaceResponse,
  ListWorkspacesResponse,
} from "@shepherd/shared";

// ---------------------------------------------------------------------------
// Config / credentials
// ---------------------------------------------------------------------------

const TEST_TOKEN = "secret-test-token";
const ALLOWED_WS = "test-ws";
const INTERNAL_TOKEN = "internal-bff-secret";

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

/** Headers for a browser-via-BFF caller asserting `accountId`. */
function bffHeaders(accountId: string, extra: Record<string, string> = {}) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "x-account-id": accountId,
    "content-type": "application/json",
    ...extra,
  };
}

/** Seed (idempotently) the self-host workspace and return its uuid. */
async function seedWorkspace(pool: pg.Pool, slug = ALLOWED_WS): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [slug, slug]
  );
  return rows[0]!.id;
}

/** Seed an api_token (agent credential) for (accountId, workspaceId); returns the raw bearer. */
async function seedAgentToken(
  pool: pg.Pool,
  accountId: string,
  workspaceId: string
): Promise<string> {
  const raw = `shp_${accountId}_${workspaceId}`;
  await pool.query(
    `INSERT INTO api_tokens (workspace_id, account_id, token_hash, name)
     VALUES ($1, $2, $3, 'test-token')`,
    [workspaceId, accountId, hashToken(raw)]
  );
  return raw;
}

// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Workspace endpoints (DB-gated)" + (!dbAvailable ? " (SKIPPED: no DB)" : ""),
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

    // --- POST /workspaces ---------------------------------------------------

    it("creates a workspace and makes the caller its admin (both rows in DB)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/workspaces",
        headers: bffHeaders("acct-alice"),
        payload: { name: "My Project" },
      });

      expect(res.statusCode).toBe(200);
      const ws = CreateWorkspaceResponse.parse(res.json());
      expect(ws.name).toBe("My Project");
      expect(ws.slug).toBe("my-project");
      expect(ws.role).toBe("admin");

      // The workspaces row exists with the caller as created_by.
      const wsRow = await pool.query<{ created_by: string; slug: string }>(
        `SELECT created_by, slug FROM workspaces WHERE id = $1`,
        [ws.id]
      );
      expect(wsRow.rows).toHaveLength(1);
      expect(wsRow.rows[0]!.created_by).toBe("acct-alice");

      // The membership row exists, admin.
      const memRow = await pool.query<{ role: string }>(
        `SELECT role FROM memberships WHERE account_id = $1 AND workspace_id = $2`,
        ["acct-alice", ws.id]
      );
      expect(memRow.rows).toHaveLength(1);
      expect(memRow.rows[0]!.role).toBe("admin");
    });

    it("falls back to a non-empty slug for an all-symbol name", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/workspaces",
        headers: bffHeaders("acct-bob"),
        payload: { name: "!!!" },
      });

      expect(res.statusCode).toBe(200);
      const ws = CreateWorkspaceResponse.parse(res.json());
      expect(ws.slug.length).toBeGreaterThan(0);
      expect(ws.slug).toMatch(/^[a-z0-9-]+$/);
    });

    it("suffixes the slug on collision so each workspace is unique", async () => {
      const first = await app.inject({
        method: "POST",
        url: "/workspaces",
        headers: bffHeaders("acct-carol"),
        payload: { name: "Shared Name" },
      });
      const second = await app.inject({
        method: "POST",
        url: "/workspaces",
        headers: bffHeaders("acct-carol"),
        payload: { name: "Shared Name" },
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const w1 = CreateWorkspaceResponse.parse(first.json());
      const w2 = CreateWorkspaceResponse.parse(second.json());
      expect(w1.slug).toBe("shared-name");
      expect(w2.slug).not.toBe(w1.slug);
      expect(w2.slug.startsWith("shared-name")).toBe(true);
    });

    it("rejects the 11th workspace for one account with 403 (cap)", async () => {
      for (let i = 0; i < 10; i++) {
        const res = await app.inject({
          method: "POST",
          url: "/workspaces",
          headers: bffHeaders("acct-capper"),
          payload: { name: `Cap ${i}` },
        });
        expect(res.statusCode).toBe(200);
      }
      const eleventh = await app.inject({
        method: "POST",
        url: "/workspaces",
        headers: bffHeaders("acct-capper"),
        payload: { name: "Cap 11" },
      });
      expect(eleventh.statusCode).toBe(403);
      // Exactly 10 landed.
      const count = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM workspaces WHERE created_by = $1`,
        ["acct-capper"]
      );
      expect(Number(count.rows[0]!.count)).toBe(10);
    });

    it("rejects creation from a self-host TEAM_TOKEN (no accountId) with 401", async () => {
      // The hook needs the self-host workspace seeded to resolve the TEAM_TOKEN.
      await seedWorkspace(pool);
      const res = await app.inject({
        method: "POST",
        url: "/workspaces",
        headers: { authorization: `Bearer ${TEST_TOKEN}`, "content-type": "application/json" },
        payload: { name: "Forbidden" },
      });
      expect(res.statusCode).toBe(401);
    });

    // --- GET /workspaces ----------------------------------------------------

    it("lists exactly the caller's workspaces with roles, leaking none", async () => {
      // alice creates two; bob creates one; alice is added as member to bob's.
      const a1 = CreateWorkspaceResponse.parse(
        (await app.inject({
          method: "POST",
          url: "/workspaces",
          headers: bffHeaders("acct-alice"),
          payload: { name: "Alice One" },
        })).json()
      );
      CreateWorkspaceResponse.parse(
        (await app.inject({
          method: "POST",
          url: "/workspaces",
          headers: bffHeaders("acct-alice"),
          payload: { name: "Alice Two" },
        })).json()
      );
      const b1 = CreateWorkspaceResponse.parse(
        (await app.inject({
          method: "POST",
          url: "/workspaces",
          headers: bffHeaders("acct-bob"),
          payload: { name: "Bob One" },
        })).json()
      );
      // Add alice as a member of bob's workspace.
      await pool.query(
        `INSERT INTO memberships (account_id, workspace_id, role) VALUES ($1, $2, 'member')`,
        ["acct-alice", b1.id]
      );

      const res = await app.inject({
        method: "GET",
        url: "/workspaces",
        headers: bffHeaders("acct-alice"),
      });
      expect(res.statusCode).toBe(200);
      const list = ListWorkspacesResponse.parse(res.json());

      // Alice sees her two (admin) + bob's (member) = 3, never bob's-only ones leak.
      expect(list.workspaces).toHaveLength(3);
      const byId = new Map(list.workspaces.map((w) => [w.id, w]));
      expect(byId.get(a1.id)!.role).toBe("admin");
      expect(byId.get(b1.id)!.role).toBe("member");
      // Bob's own listing must NOT include alice's private workspaces.
      const bobRes = await app.inject({
        method: "GET",
        url: "/workspaces",
        headers: bffHeaders("acct-bob"),
      });
      const bobList = ListWorkspacesResponse.parse(bobRes.json());
      expect(bobList.workspaces).toHaveLength(1);
      expect(bobList.workspaces[0]!.id).toBe(b1.id);
    });

    it("GET /workspaces with an agent shp_ token returns ALL the account's workspaces", async () => {
      // alice creates two workspaces via the browser path.
      const a1 = CreateWorkspaceResponse.parse(
        (await app.inject({
          method: "POST",
          url: "/workspaces",
          headers: bffHeaders("acct-alice"),
          payload: { name: "Alice One" },
        })).json()
      );
      const a2 = CreateWorkspaceResponse.parse(
        (await app.inject({
          method: "POST",
          url: "/workspaces",
          headers: bffHeaders("acct-alice"),
          payload: { name: "Alice Two" },
        })).json()
      );
      // An agent token scoped to ONLY workspace a1.
      const bearer = await seedAgentToken(pool, "acct-alice", a1.id);

      const res = await app.inject({
        method: "GET",
        url: "/workspaces",
        headers: { authorization: `Bearer ${bearer}` },
      });
      expect(res.statusCode).toBe(200);
      const list = ListWorkspacesResponse.parse(res.json());
      // Despite the token being scoped to a1, the listing covers BOTH (scoped by accountId).
      const ids = new Set(list.workspaces.map((w) => w.id));
      expect(ids.has(a1.id)).toBe(true);
      expect(ids.has(a2.id)).toBe(true);
    });

    it("rejects GET /workspaces from a self-host TEAM_TOKEN (no accountId) with 401", async () => {
      await seedWorkspace(pool);
      const res = await app.inject({
        method: "GET",
        url: "/workspaces",
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.statusCode).toBe(401);
    });
  }
);
