/**
 * Tests for workspace cap ENFORCEMENT at the server boundary:
 *   - seat cap on POST /invites/:code/redeem (assertSeatAvailable)
 *
 * Harness mirrors workspaces.test.ts / invites.test.ts: a real pool, the
 * onRequest hook hits the DB, tenancy rows seeded by hand, truncateAll +
 * truncateTenancy + limiter/throttle resets between tests.
 *
 * The enforcing describes run a config with deployment-default caps
 * (ENTITLEMENTS_DEFAULT_LIMITS) — deliberately small fixture numbers (4 seats
 * / 5 repos / 30 days) so cap arithmetic stays readable. A separate describe
 * runs WITHOUT the env to pin the inert-by-default guarantee.
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
import { __resetRateLimiter } from "../src/tenant.js";
import { __resetRedeemThrottle } from "../src/operations/invites.js";
import type { Config } from "../src/config.js";
import type { FastifyInstance } from "fastify";
import { LimitExceededErrorBody } from "@shepherd/shared";

// ---------------------------------------------------------------------------
// Config / credentials
// ---------------------------------------------------------------------------

const TEST_TOKEN = "secret-test-token";
const ALLOWED_WS = "test-ws";
const INTERNAL_TOKEN = "internal-bff-secret";

/** Fixture deployment-default caps (see file header). */
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

/** Headers for a browser-via-BFF caller asserting `accountId`. */
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

/** Seed `n` members (acct-seed-1 … acct-seed-n) into the workspace. */
async function seedMembers(
  pool: pg.Pool,
  workspaceId: string,
  n: number,
): Promise<void> {
  for (let i = 1; i <= n; i++) {
    await seedMembership(pool, `acct-seed-${i}`, workspaceId);
  }
}

/** Seed a multi-use invite code directly (unexpired, member role). */
async function seedInvite(
  pool: pg.Pool,
  workspaceId: string,
  code: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO invites (workspace_id, code, created_by, role_granted, max_uses, expires_at)
     VALUES ($1, $2, 'acct-admin', 'member', 25, now() + interval '7 days')`,
    [workspaceId, code],
  );
}

async function countMemberships(
  pool: pg.Pool,
  workspaceId: string,
): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM memberships WHERE workspace_id = $1`,
    [workspaceId],
  );
  return Number(rows[0]!.count);
}

async function readUseCount(pool: pg.Pool, code: string): Promise<number> {
  const { rows } = await pool.query<{ use_count: number }>(
    `SELECT use_count FROM invites WHERE code = $1`,
    [code],
  );
  return rows[0]!.use_count;
}

// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Seat cap on invite redemption (DB-gated)" +
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
      __resetRedeemThrottle();
      await truncateAll(pool);
      await truncateTenancy(pool);
    });

    afterAll(async () => {
      await app.close();
      resetContext();
      await pool.end();
    });

    async function redeem(accountId: string, code: string) {
      return app.inject({
        method: "POST",
        url: `/invites/${code}/redeem`,
        headers: bffHeaders(accountId),
        payload: {},
      });
    }

    it("admits up to the default cap, then 402s with limit_exceeded and burns no use", async () => {
      const wsId = await seedWorkspace(pool, "seat-cap-default");
      await seedMembers(pool, wsId, 3);
      await seedInvite(pool, wsId, "seatcapdefault01");

      // 4th member fills the 4-seat default cap.
      const fourth = await redeem("acct-fourth", "seatcapdefault01");
      expect(fourth.statusCode).toBe(200);
      expect(await countMemberships(pool, wsId)).toBe(4);
      expect(await readUseCount(pool, "seatcapdefault01")).toBe(1);

      // 5th is over the cap: 402, machine-readable body, nothing written.
      const fifth = await redeem("acct-fifth", "seatcapdefault01");
      expect(fifth.statusCode).toBe(402);
      const body = LimitExceededErrorBody.parse(fifth.json());
      expect(body.code).toBe("limit_exceeded");
      expect(body.limit).toBe("seats");
      expect(body.current).toBe(4);
      expect(body.max).toBe(4);

      expect(await countMemberships(pool, wsId)).toBe(4);
      // The guard runs BEFORE incrementInviteUse: a blocked redeem must not
      // burn an invite use.
      expect(await readUseCount(pool, "seatcapdefault01")).toBe(1);
    });

    it("a live entitlements row raises the cap over the defaults", async () => {
      const wsId = await seedWorkspace(pool, "seat-cap-raised");
      await pool.query(
        `INSERT INTO workspace_entitlements (workspace_id, seats_limit) VALUES ($1, 50)`,
        [wsId],
      );
      await seedMembers(pool, wsId, 4);
      await seedInvite(pool, wsId, "seatcapraised01");

      const fifth = await redeem("acct-fifth", "seatcapraised01");
      expect(fifth.statusCode).toBe(200);
      expect(await countMemberships(pool, wsId)).toBe(5);
    });

    it("an EXPIRED entitlements row is ignored — the defaults apply again", async () => {
      const wsId = await seedWorkspace(pool, "seat-cap-expired");
      await pool.query(
        `INSERT INTO workspace_entitlements (workspace_id, seats_limit, expires_at)
         VALUES ($1, 50, now() - interval '1 day')`,
        [wsId],
      );
      await seedMembers(pool, wsId, 4);
      await seedInvite(pool, wsId, "seatcapexpired01");

      const fifth = await redeem("acct-fifth", "seatcapexpired01");
      expect(fifth.statusCode).toBe(402);
      const body = LimitExceededErrorBody.parse(fifth.json());
      expect(body.limit).toBe("seats");
      expect(await countMemberships(pool, wsId)).toBe(4);
    });

    it("a null seats cap in a live row means unlimited seats", async () => {
      const wsId = await seedWorkspace(pool, "seat-cap-null");
      await pool.query(
        `INSERT INTO workspace_entitlements (workspace_id, seats_limit) VALUES ($1, NULL)`,
        [wsId],
      );
      await seedMembers(pool, wsId, 4);
      await seedInvite(pool, wsId, "seatcapnull01");

      const fifth = await redeem("acct-fifth", "seatcapnull01");
      expect(fifth.statusCode).toBe(200);
      expect(await countMemberships(pool, wsId)).toBe(5);
    });

    it("two parallel redeems at one seat remaining admit exactly one (advisory lock)", async () => {
      const wsId = await seedWorkspace(pool, "seat-cap-race");
      await seedMembers(pool, wsId, 3);
      // Two DIFFERENT codes: nothing but the workspace-level advisory lock
      // serializes these (the invite-row lock cannot — different rows).
      await seedInvite(pool, wsId, "seatcaprace01");
      await seedInvite(pool, wsId, "seatcaprace02");

      const [a, b] = await Promise.all([
        redeem("acct-racer-a", "seatcaprace01"),
        redeem("acct-racer-b", "seatcaprace02"),
      ]);
      const statuses = [a.statusCode, b.statusCode].sort();
      expect(statuses).toEqual([200, 402]);
      expect(await countMemberships(pool, wsId)).toBe(4);
    });

    it("an already-member redeem is still a no-op success at the cap", async () => {
      const wsId = await seedWorkspace(pool, "seat-cap-member");
      await seedMembers(pool, wsId, 4);
      await seedInvite(pool, wsId, "seatcapmember01");

      // acct-seed-1 is already IN the full workspace — landing again must not 402.
      const res = await redeem("acct-seed-1", "seatcapmember01");
      expect(res.statusCode).toBe(200);
      expect(await countMemberships(pool, wsId)).toBe(4);
    });
  },
);

describe.skipIf(!dbAvailable)(
  "Caps are inert with ENTITLEMENTS_DEFAULT_LIMITS unset (DB-gated)" +
    (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    let pool: pg.Pool;
    let app: FastifyInstance;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      initContext({
        pool,
        config: makeTestConfig({ ENTITLEMENTS_DEFAULT_LIMITS: undefined }),
      });
      app = buildServer();
      await app.ready();
    });

    afterEach(async () => {
      __resetRateLimiter();
      __resetRedeemThrottle();
      await truncateAll(pool);
      await truncateTenancy(pool);
    });

    afterAll(async () => {
      await app.close();
      resetContext();
      await pool.end();
    });

    it("redeems past every fixture cap succeed — no limits of any kind", async () => {
      const wsId = await seedWorkspace(pool, "seat-cap-off");
      await seedMembers(pool, wsId, 6);
      await seedInvite(pool, wsId, "seatcapoff01");

      const res = await app.inject({
        method: "POST",
        url: `/invites/seatcapoff01/redeem`,
        headers: bffHeaders("acct-seventh"),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(await countMemberships(pool, wsId)).toBe(7);
    });
  },
);
