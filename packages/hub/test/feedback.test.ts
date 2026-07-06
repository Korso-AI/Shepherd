/**
 * Tests for POST /feedback — the feedback-widget capture endpoint.
 *
 * Unlike the /workspaces/:id/* routes, this is a FLAT route: any resolved
 * tenant may call it (self-host TEAM_TOKEN, an agent shp_ token, or a hosted
 * browser call with no route-derived workspace), and the operation records
 * whatever workspace/account context the tenant happened to carry rather than
 * requiring either.
 *
 * Setup mirrors members.test.ts: a real pool, the onRequest hook hits the DB,
 * and we seed a workspace by hand. truncateAll + truncateTenancy reset between
 * tests; the rate limiter is reset in afterEach.
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
import { __resetRateLimiter } from "../src/tenant.js";
import type { Config } from "../src/config.js";
import type { FastifyInstance } from "fastify";
import { FeedbackResponse } from "@shepherd/shared";

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

/** BFF headers for a JSON-body request asserting `accountId`. */
function bffHeaders(accountId: string, extra: Record<string, string> = {}) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "x-account-id": accountId,
    "content-type": "application/json",
    ...extra,
  };
}

/** Seed a workspace by slug (idempotent); returns its uuid. */
async function seedWorkspace(pool: pg.Pool, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [slug, slug]
  );
  return rows[0]!.id;
}

/** Seed a membership for (accountId, workspaceId) at `role` (idempotent). */
async function seedMembership(
  pool: pg.Pool,
  accountId: string,
  workspaceId: string,
  role: "admin" | "member" = "member"
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (account_id, workspace_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (account_id, workspace_id) DO UPDATE SET role = EXCLUDED.role`,
    [accountId, workspaceId, role]
  );
}

/** Read back the row a submission produced, by id. */
async function fetchFeedback(
  pool: pg.Pool,
  id: string
): Promise<{ workspace_id: string | null; account_id: string | null; type: string; body: string }> {
  const { rows } = await pool.query(
    `SELECT workspace_id, account_id, type, body FROM feedback WHERE id = $1`,
    [id]
  );
  return rows[0]!;
}

// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "POST /feedback (DB-gated)" + (!dbAvailable ? " (SKIPPED: no DB)" : ""),
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

    it("a hosted browser member submits feedback: row carries workspace + account", async () => {
      const wsId = await seedWorkspace(pool, "fb-ws");
      await seedMembership(pool, "acct-alice", wsId, "member");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/feedback`,
        headers: bffHeaders("acct-alice"),
        payload: { type: "bug", body: "the button is broken" },
      });

      expect(res.statusCode).toBe(200);
      const parsed = FeedbackResponse.parse(res.json());
      expect(parsed.ok).toBe(true);

      const row = await fetchFeedback(pool, parsed.id);
      expect(row.workspace_id).toBe(wsId);
      expect(row.account_id).toBe("acct-alice");
      expect(row.type).toBe("bug");
      expect(row.body).toBe("the button is broken");
    });

    it("a hosted browser call with no workspace still submits feedback (null workspace, real account)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/feedback",
        headers: bffHeaders("acct-bob"),
        payload: { type: "suggestion", body: "add dark mode" },
      });

      expect(res.statusCode).toBe(200);
      const parsed = FeedbackResponse.parse(res.json());

      const row = await fetchFeedback(pool, parsed.id);
      expect(row.workspace_id).toBeNull();
      expect(row.account_id).toBe("acct-bob");
      expect(row.type).toBe("suggestion");
    });

    it("a self-host TEAM_TOKEN call submits feedback (real workspace, null account)", async () => {
      const wsId = await seedWorkspace(pool, ALLOWED_WS);

      const res = await app.inject({
        method: "POST",
        url: "/feedback",
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
        payload: { type: "other", body: "just saying hi" },
      });

      expect(res.statusCode).toBe(200);
      const parsed = FeedbackResponse.parse(res.json());

      const row = await fetchFeedback(pool, parsed.id);
      expect(row.workspace_id).toBe(wsId);
      expect(row.account_id).toBeNull();
    });

    it("rejects an empty body with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/feedback",
        headers: bffHeaders("acct-alice"),
        payload: { type: "bug", body: "" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an unknown type with 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/feedback",
        headers: bffHeaders("acct-alice"),
        payload: { type: "praise", body: "great job" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("rejects an unauthenticated call with 401", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/feedback",
        payload: { type: "bug", body: "x" },
      });
      expect(res.statusCode).toBe(401);
    });
  }
);
