/**
 * Tests for account self-deletion (DELETE /account).
 *
 * A non-`:id` route, so resolveTenant does no route-membership check — the
 * operation pins the trust itself (the redeemInvite pattern): it accepts ONLY
 * the browser-via-BFF account path and rejects an agent `shp_` token (403) and
 * a self-host TEAM_TOKEN (no accountId → 401 via requireAccountId).
 *
 * Per-workspace semantics under test (see operations/account.ts):
 *  - sole member                       → workspace cascaded away entirely
 *  - last admin w/ other members       → 409, NOTHING mutated (one transaction)
 *  - plain member / co-admined admin   → membership removed, ws tokens revoked
 * Then account-wide: ALL live tokens revoked (including account-scoped
 * workspace_id-IS-NULL ones) and the profile row deleted.
 *
 * Setup mirrors invites.test.ts: real pool, seed workspaces/memberships by
 * hand, truncate + rate-limiter reset between tests.
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
import { DeleteAccountResponse } from "@shepherd/shared";

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

/** BFF headers asserting `accountId` (the browser-session path). */
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

/** Seed an account profile row so its deletion can be asserted. */
async function seedProfile(pool: pg.Pool, accountId: string): Promise<void> {
  await pool.query(
    `INSERT INTO account_profiles (account_id, display_name)
     VALUES ($1, $1) ON CONFLICT (account_id) DO NOTHING`,
    [accountId],
  );
}

/** Seed a workspace-scoped agent token; returns its plaintext. */
async function seedAgentToken(
  pool: pg.Pool,
  accountId: string,
  workspaceId: string,
  plaintext: string,
): Promise<string> {
  await pool.query(
    `INSERT INTO api_tokens (account_id, workspace_id, token_hash, name)
     VALUES ($1, $2, $3, 'test-token')`,
    [accountId, workspaceId, hashToken(plaintext)],
  );
  return plaintext;
}

/** Seed an ACCOUNT-scoped token (workspace_id NULL); returns its plaintext. */
async function seedAccountScopedToken(
  pool: pg.Pool,
  accountId: string,
  plaintext: string,
): Promise<string> {
  await pool.query(
    `INSERT INTO api_tokens (account_id, workspace_id, token_hash, name)
     VALUES ($1, NULL, $2, 'account-scoped-test')`,
    [accountId, hashToken(plaintext)],
  );
  return plaintext;
}

async function countLiveTokens(
  pool: pg.Pool,
  accountId: string,
): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*) AS n FROM api_tokens WHERE account_id = $1 AND revoked_at IS NULL`,
    [accountId],
  );
  return Number(rows[0]!.n);
}

async function profileExists(
  pool: pg.Pool,
  accountId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM account_profiles WHERE account_id = $1`,
    [accountId],
  );
  return rows.length > 0;
}

async function workspaceExists(
  pool: pg.Pool,
  workspaceId: string,
): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM workspaces WHERE id = $1`, [
    workspaceId,
  ]);
  return rows.length > 0;
}

async function membershipExists(
  pool: pg.Pool,
  accountId: string,
  workspaceId: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM memberships WHERE account_id = $1 AND workspace_id = $2`,
    [accountId, workspaceId],
  );
  return rows.length > 0;
}

// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "DELETE /account (DB-gated)" + (!dbAvailable ? " (SKIPPED: no DB)" : ""),
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

    // --- Trust pinning -------------------------------------------------------

    it("rejects the self-host TEAM_TOKEN (no account to delete) → 401", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/account",
        headers: { authorization: `Bearer ${TEST_TOKEN}` },
      });
      expect(res.statusCode).toBe(401);
    });

    it("rejects an agent shp_ token → 403 (a leaked agent token must not erase its owner)", async () => {
      const wsId = await seedWorkspace(pool, "agent-token-ws");
      await seedMembership(pool, "acct-agent", wsId, "admin");
      const plaintext = await seedAgentToken(
        pool,
        "acct-agent",
        wsId,
        "shp_delete_account_attempt",
      );

      const res = await app.inject({
        method: "DELETE",
        url: "/account",
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(res.statusCode).toBe(403);

      // Nothing happened: membership, workspace, and token are all intact.
      expect(await membershipExists(pool, "acct-agent", wsId)).toBe(true);
      expect(await workspaceExists(pool, wsId)).toBe(true);
      expect(await countLiveTokens(pool, "acct-agent")).toBe(1);
    });

    // --- Happy path ----------------------------------------------------------

    it("sole member: deletes the workspace outright, revokes ALL tokens, drops the profile", async () => {
      const wsId = await seedWorkspace(pool, "solo-ws");
      await seedMembership(pool, "acct-solo", wsId, "admin");
      await seedProfile(pool, "acct-solo");
      await seedAgentToken(pool, "acct-solo", wsId, "shp_solo_ws_token");
      await seedAccountScopedToken(pool, "acct-solo", "shp_solo_acct_token");

      const res = await app.inject({
        method: "DELETE",
        url: "/account",
        headers: bffHeaders("acct-solo"),
      });
      expect(res.statusCode).toBe(200);
      expect(DeleteAccountResponse.parse(res.json())).toEqual({
        deleted: true,
      });

      // The sole-member workspace is gone entirely (cascade), not orphaned.
      expect(await workspaceExists(pool, wsId)).toBe(false);
      // Every live token died — including the account-scoped NULL-workspace one.
      expect(await countLiveTokens(pool, "acct-solo")).toBe(0);
      expect(await profileExists(pool, "acct-solo")).toBe(false);
    });

    it("plain member of a shared workspace: leaves it intact and only removes the caller", async () => {
      const wsId = await seedWorkspace(pool, "shared-ws");
      await seedMembership(pool, "acct-owner", wsId, "admin");
      await seedMembership(pool, "acct-leaver", wsId, "member");
      await seedProfile(pool, "acct-leaver");
      await seedAgentToken(pool, "acct-owner", wsId, "shp_owner_token");
      await seedAgentToken(pool, "acct-leaver", wsId, "shp_leaver_token");

      const res = await app.inject({
        method: "DELETE",
        url: "/account",
        headers: bffHeaders("acct-leaver"),
      });
      expect(res.statusCode).toBe(200);

      // The workspace and the OTHER member are untouched.
      expect(await workspaceExists(pool, wsId)).toBe(true);
      expect(await membershipExists(pool, "acct-owner", wsId)).toBe(true);
      expect(await countLiveTokens(pool, "acct-owner")).toBe(1);
      // The caller is fully gone.
      expect(await membershipExists(pool, "acct-leaver", wsId)).toBe(false);
      expect(await countLiveTokens(pool, "acct-leaver")).toBe(0);
      expect(await profileExists(pool, "acct-leaver")).toBe(false);
    });

    // --- Last-admin guard ----------------------------------------------------

    it("last admin of a workspace that still has other members → 409, and NOTHING is mutated", async () => {
      // The caller is: sole member of ws A (deletable), but last admin of ws B
      // which has another member. The 409 must roll back A's deletion too —
      // the whole operation is one transaction.
      const wsA = await seedWorkspace(pool, "guard-solo-ws");
      const wsB = await seedWorkspace(pool, "guard-shared-ws");
      await seedMembership(pool, "acct-lastadmin", wsA, "admin");
      await seedMembership(pool, "acct-lastadmin", wsB, "admin");
      await seedMembership(pool, "acct-other", wsB, "member");
      await seedProfile(pool, "acct-lastadmin");
      await seedAccountScopedToken(pool, "acct-lastadmin", "shp_guard_token");

      const res = await app.inject({
        method: "DELETE",
        url: "/account",
        headers: bffHeaders("acct-lastadmin"),
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toMatch(/last admin/i);

      // Full rollback: both workspaces, both memberships, token, profile intact.
      expect(await workspaceExists(pool, wsA)).toBe(true);
      expect(await workspaceExists(pool, wsB)).toBe(true);
      expect(await membershipExists(pool, "acct-lastadmin", wsA)).toBe(true);
      expect(await membershipExists(pool, "acct-lastadmin", wsB)).toBe(true);
      expect(await countLiveTokens(pool, "acct-lastadmin")).toBe(1);
      expect(await profileExists(pool, "acct-lastadmin")).toBe(true);
    });

    it("an admin with a CO-admin can delete: the workspace survives under the other admin", async () => {
      const wsId = await seedWorkspace(pool, "coadmin-ws");
      await seedMembership(pool, "acct-admin1", wsId, "admin");
      await seedMembership(pool, "acct-admin2", wsId, "admin");
      await seedProfile(pool, "acct-admin1");

      const res = await app.inject({
        method: "DELETE",
        url: "/account",
        headers: bffHeaders("acct-admin1"),
      });
      expect(res.statusCode).toBe(200);

      expect(await workspaceExists(pool, wsId)).toBe(true);
      expect(await membershipExists(pool, "acct-admin1", wsId)).toBe(false);
      expect(await membershipExists(pool, "acct-admin2", wsId)).toBe(true);
      expect(await profileExists(pool, "acct-admin1")).toBe(false);
    });
  },
);
