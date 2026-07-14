/**
 * Tests for the agent-token mint/list/revoke endpoints (Task 3.4):
 *   POST   /workspaces/:id/tokens            — mint a raw `shp_` token (returned ONCE).
 *   GET    /workspaces/:id/tokens            — list the workspace's tokens (no secrets).
 *   DELETE /workspaces/:id/tokens/:tokenId   — revoke the CALLER'S OWN token.
 *
 * All three are `/workspaces/:id/*` routes, so resolveTenant has already validated
 * the browser-via-BFF caller is a MEMBER of `:id` (a non-member gets 404 before any
 * handler runs). The mint path additionally requires a concrete workspaceId and an
 * accountId; the revoke path enforces account OWNERSHIP of the token on top of the
 * workspace scope (a member must not revoke another member's token).
 *
 * Tenancy setup mirrors workspaces.test.ts: a real pool, the onRequest hook hits the
 * DB, and we seed workspaces + memberships + account_profiles by hand. truncateAll +
 * truncateTenancy reset between tests; the rate limiter is reset in afterEach.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  createAppPool,
  runTestMigrations,
  truncateAll,
  truncateTenancy,
} from "./setup.js";
import { initContext, resetContext } from "../src/context.js";
import { buildServer } from "../src/server.js";
import { __resetRateLimiter, hashToken } from "../src/tenant.js";
import type { Config } from "../src/config.js";
import type { FastifyInstance } from "fastify";
import { MintTokenResponse, ListTokensResponse } from "@shepherd/shared";

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

/** Headers for a browser-via-BFF caller asserting `accountId` on a JSON-body request. */
function bffHeaders(accountId: string, extra: Record<string, string> = {}) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "x-account-id": accountId,
    "content-type": "application/json",
    ...extra,
  };
}

/**
 * BFF headers for a BODYLESS request (GET/DELETE). Omits `content-type` so
 * Fastify's JSON body parser is never invoked on an empty body (which would 500).
 */
function bffAuthHeaders(accountId: string, extra: Record<string, string> = {}) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "x-account-id": accountId,
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

// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Agent-token endpoints (DB-gated)" +
    (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    let pool: pg.Pool;
    let appPool: pg.Pool;
    let app: FastifyInstance;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      appPool = createAppPool();
      initContext({ pool: appPool, config: makeTestConfig() });
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
      await appPool.end();
      await pool.end();
    });

    // --- POST /workspaces/:id/tokens (mint) ---------------------------------

    it("mints a shp_ token + id and stores ONLY its hash (raw not recoverable)", async () => {
      const wsId = await seedWorkspace(pool, "alpha");
      await seedMembership(pool, "acct-alice", wsId, "admin");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/tokens`,
        headers: bffHeaders("acct-alice"),
        payload: { name: "ci-runner" },
      });

      expect(res.statusCode).toBe(200);
      const minted = MintTokenResponse.parse(res.json());
      expect(minted.token).toMatch(/^shp_/);
      // ≥32 bytes of entropy → base64url is ≥43 chars; with the `shp_` prefix ≥47.
      expect(minted.token.length).toBeGreaterThanOrEqual(47);
      expect(minted.id.length).toBeGreaterThan(0);

      // The DB stores ONLY the hash — the raw token is nowhere in api_tokens.
      const row = await pool.query<{ token_hash: string; name: string | null }>(
        `SELECT token_hash, name FROM api_tokens WHERE id = $1`,
        [minted.id],
      );
      expect(row.rows).toHaveLength(1);
      expect(row.rows[0]!.name).toBe("ci-runner");
      // Stored value is the hash of the raw token, not the raw token itself.
      expect(row.rows[0]!.token_hash).toBe(hashToken(minted.token));
      expect(row.rows[0]!.token_hash).not.toBe(minted.token);
    });

    // --- Round-trip: mint → use → revoke → 401 (the headline test) ----------

    it("mint → authenticates a coordination request → revoke → SAME bearer is 401", async () => {
      const wsId = await seedWorkspace(pool, "round-trip");
      await seedMembership(pool, "acct-alice", wsId, "admin");

      // Mint via the browser/BFF path.
      const mintRes = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/tokens`,
        headers: bffHeaders("acct-alice"),
        payload: {},
      });
      expect(mintRes.statusCode).toBe(200);
      const { token, id: tokenId } = MintTokenResponse.parse(mintRes.json());

      // Use the raw token as a Bearer on a real coordination request.
      const useRes = await app.inject({
        method: "GET",
        url: `/workspaces/${wsId}/landscape`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(useRes.statusCode).toBe(200);

      // Revoke that token (caller is its owner).
      const revokeRes = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}/tokens/${tokenId}`,
        headers: bffAuthHeaders("acct-alice"),
      });
      expect(revokeRes.statusCode).toBe(200);

      // The SAME bearer now fails — and the status MUST be exactly 401 (MCP's
      // auth-failure detection keys on 401, not 403/404).
      const deniedRes = await app.inject({
        method: "GET",
        url: `/workspaces/${wsId}/landscape`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(deniedRes.statusCode).toBe(401);
    });

    // --- GET /workspaces/:id/tokens (list) ----------------------------------

    it("lists workspace tokens but NEVER exposes the raw token or its hash", async () => {
      const wsId = await seedWorkspace(pool, "listing");
      await seedMembership(pool, "acct-alice", wsId, "admin");

      const mintRes = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/tokens`,
        headers: bffHeaders("acct-alice"),
        payload: { name: "visible-name" },
      });
      const { token } = MintTokenResponse.parse(mintRes.json());

      const listRes = await app.inject({
        method: "GET",
        url: `/workspaces/${wsId}/tokens`,
        headers: bffAuthHeaders("acct-alice"),
      });
      expect(listRes.statusCode).toBe(200);
      const list = ListTokensResponse.parse(listRes.json());
      expect(list.tokens).toHaveLength(1);
      expect(list.tokens[0]!.name).toBe("visible-name");
      expect(list.tokens[0]!.revokedAt).toBeNull();

      // Neither the raw token nor its hash appears anywhere in the serialized body.
      const serialized = JSON.stringify(list);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(hashToken(token));
    });

    it("list EXCLUDES revoked tokens and is bounded to the LIMIT", async () => {
      const wsId = await seedWorkspace(pool, "active-only");
      await seedMembership(pool, "acct-alice", wsId, "admin");

      // Mint two tokens, then revoke one — only the live one should list.
      const keep = MintTokenResponse.parse(
        (
          await app.inject({
            method: "POST",
            url: `/workspaces/${wsId}/tokens`,
            headers: bffHeaders("acct-alice"),
            payload: { name: "keep" },
          })
        ).json(),
      );
      const drop = MintTokenResponse.parse(
        (
          await app.inject({
            method: "POST",
            url: `/workspaces/${wsId}/tokens`,
            headers: bffHeaders("acct-alice"),
            payload: { name: "drop" },
          })
        ).json(),
      );
      const revokeRes = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}/tokens/${drop.id}`,
        headers: bffAuthHeaders("acct-alice"),
      });
      expect(revokeRes.statusCode).toBe(200);

      const listRes = await app.inject({
        method: "GET",
        url: `/workspaces/${wsId}/tokens`,
        headers: bffAuthHeaders("acct-alice"),
      });
      expect(listRes.statusCode).toBe(200);
      const list = ListTokensResponse.parse(listRes.json());
      // Only the un-revoked token surfaces; the revoked one is hidden.
      expect(list.tokens).toHaveLength(1);
      expect(list.tokens[0]!.id).toBe(keep.id);
      expect(list.tokens.some((t) => t.id === drop.id)).toBe(false);

      // The query caps results at LIMIT 200 — seed past the cap and confirm.
      await pool.query(
        `INSERT INTO api_tokens (workspace_id, account_id, token_hash, name)
         SELECT $1, 'acct-alice', 'hash-' || g, 'bulk-' || g
         FROM generate_series(1, 250) AS g`,
        [wsId],
      );
      const bounded = ListTokensResponse.parse(
        (
          await app.inject({
            method: "GET",
            url: `/workspaces/${wsId}/tokens`,
            headers: bffAuthHeaders("acct-alice"),
          })
        ).json(),
      );
      expect(bounded.tokens).toHaveLength(200);
    });

    // --- Membership gate (from resolveTenant) -------------------------------

    it("a member of A calling /workspaces/<B>/tokens gets 404 on mint/list/revoke", async () => {
      const wsA = await seedWorkspace(pool, "ws-a");
      const wsB = await seedWorkspace(pool, "ws-b");
      await seedMembership(pool, "acct-alice", wsA, "admin");
      // alice is NOT a member of wsB.

      const mint = await app.inject({
        method: "POST",
        url: `/workspaces/${wsB}/tokens`,
        headers: bffHeaders("acct-alice"),
        payload: {},
      });
      expect(mint.statusCode).toBe(404);

      const list = await app.inject({
        method: "GET",
        url: `/workspaces/${wsB}/tokens`,
        headers: bffAuthHeaders("acct-alice"),
      });
      expect(list.statusCode).toBe(404);

      const del = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsB}/tokens/00000000-0000-0000-0000-000000000000`,
        headers: bffAuthHeaders("acct-alice"),
      });
      expect(del.statusCode).toBe(404);
    });

    // --- Cross-account revoke (own-token-only scope) ------------------------

    it("a member cannot revoke another member's token in the same workspace (404), and the victim's token still authenticates", async () => {
      const wsId = await seedWorkspace(pool, "shared-ws");
      await seedMembership(pool, "acct-alice", wsId, "member");
      await seedMembership(pool, "acct-bob", wsId, "member");

      // Bob mints a token.
      const bobMint = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/tokens`,
        headers: bffHeaders("acct-bob"),
        payload: { name: "bob-token" },
      });
      const bob = MintTokenResponse.parse(bobMint.json());

      // Alice (a member of the SAME workspace) tries to revoke Bob's token.
      const aliceRevoke = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}/tokens/${bob.id}`,
        headers: bffAuthHeaders("acct-alice"),
      });
      expect(aliceRevoke.statusCode).toBe(404);

      // Bob's token STILL authenticates afterward (it was not revoked).
      const useRes = await app.inject({
        method: "GET",
        url: `/workspaces/${wsId}/landscape`,
        headers: { authorization: `Bearer ${bob.token}` },
      });
      expect(useRes.statusCode).toBe(200);
    });

    it("revoking an already-revoked / non-existent token returns 404", async () => {
      const wsId = await seedWorkspace(pool, "revoke-edge");
      await seedMembership(pool, "acct-alice", wsId, "admin");

      const mintRes = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/tokens`,
        headers: bffHeaders("acct-alice"),
        payload: {},
      });
      const { id: tokenId } = MintTokenResponse.parse(mintRes.json());

      // First revoke succeeds.
      const first = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}/tokens/${tokenId}`,
        headers: bffAuthHeaders("acct-alice"),
      });
      expect(first.statusCode).toBe(200);

      // Second revoke (already revoked) → 404.
      const second = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}/tokens/${tokenId}`,
        headers: bffAuthHeaders("acct-alice"),
      });
      expect(second.statusCode).toBe(404);

      // A wholly unknown tokenId → 404.
      const unknown = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}/tokens/00000000-0000-0000-0000-000000000000`,
        headers: bffAuthHeaders("acct-alice"),
      });
      expect(unknown.statusCode).toBe(404);
    });

    // --- Self-host TEAM_TOKEN (no accountId) cannot mint --------------------

    it("rejects mint from a self-host TEAM_TOKEN (no accountId) with 401", async () => {
      // The TEAM_TOKEN resolves to the seeded ALLOWED_WORKSPACE with no account.
      const wsId = await seedWorkspace(pool, ALLOWED_WS);
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/tokens`,
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          "content-type": "application/json",
        },
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });

    // --- Regression: workspace-scoped mint stores a NON-NULL workspace_id ----

    it("mint via /workspaces/:id/tokens still narrows the token to that workspace (non-null)", async () => {
      const wsId = await seedWorkspace(pool, "narrowed");
      await seedMembership(pool, "acct-alice", wsId, "admin");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/tokens`,
        headers: bffHeaders("acct-alice"),
        payload: { name: "ci" },
      });
      expect(res.statusCode).toBe(200);
      const { id } = MintTokenResponse.parse(res.json());

      const row = await pool.query<{ workspace_id: string | null }>(
        `SELECT workspace_id FROM api_tokens WHERE id = $1`,
        [id],
      );
      expect(row.rows[0]!.workspace_id).toBe(wsId);
    });

    // -----------------------------------------------------------------------
    // Flat, ACCOUNT-scoped routes (Task 1.3):
    //   POST   /tokens            — mint an account-wide token (workspace_id NULL).
    //   GET    /tokens            — list every token the account owns (no secrets).
    //   DELETE /tokens/:tokenId   — revoke the caller's OWN token.
    //
    // These are NON-`:id` routes, so resolveTenant yields {workspaceId: "",
    // accountId} for the browser-via-BFF path (and for an account-scoped agent
    // token) and rejects a self-host TEAM_TOKEN (no accountId) via requireAccountId.
    // -----------------------------------------------------------------------

    it("POST /tokens (browser/BFF) mints an ACCOUNT-scoped token (workspace_id NULL), returned ONCE", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/tokens`,
        headers: bffHeaders("acct-alice"),
        payload: { name: "laptop" },
      });
      expect(res.statusCode).toBe(200);
      const minted = MintTokenResponse.parse(res.json());
      expect(minted.token).toMatch(/^shp_/);
      expect(minted.token.length).toBeGreaterThanOrEqual(47);

      const row = await pool.query<{
        workspace_id: string | null;
        token_hash: string;
      }>(`SELECT workspace_id, token_hash FROM api_tokens WHERE id = $1`, [
        minted.id,
      ]);
      expect(row.rows).toHaveLength(1);
      // Account-scoped: not locked to any workspace.
      expect(row.rows[0]!.workspace_id).toBeNull();
      // Only the hash is stored — never the raw token.
      expect(row.rows[0]!.token_hash).toBe(hashToken(minted.token));
    });

    it("GET /tokens lists the account's tokens as metadata (no raw token, no hash), then DELETE /tokens/:id revokes own", async () => {
      const mintRes = await app.inject({
        method: "POST",
        url: `/tokens`,
        headers: bffHeaders("acct-alice"),
        payload: { name: "visible" },
      });
      const { token, id } = MintTokenResponse.parse(mintRes.json());

      const listRes = await app.inject({
        method: "GET",
        url: `/tokens`,
        headers: bffAuthHeaders("acct-alice"),
      });
      expect(listRes.statusCode).toBe(200);
      const list = ListTokensResponse.parse(listRes.json());
      expect(list.tokens).toHaveLength(1);
      expect(list.tokens[0]!.id).toBe(id);
      expect(list.tokens[0]!.name).toBe("visible");
      const serialized = JSON.stringify(list);
      expect(serialized).not.toContain(token);
      expect(serialized).not.toContain(hashToken(token));

      // The owner revokes it.
      const revokeRes = await app.inject({
        method: "DELETE",
        url: `/tokens/${id}`,
        headers: bffAuthHeaders("acct-alice"),
      });
      expect(revokeRes.statusCode).toBe(200);

      // Now the list is empty (revoked tokens are excluded).
      const afterRes = await app.inject({
        method: "GET",
        url: `/tokens`,
        headers: bffAuthHeaders("acct-alice"),
      });
      expect(ListTokensResponse.parse(afterRes.json()).tokens).toHaveLength(0);
    });

    it("cross-account: B cannot revoke or list A's token", async () => {
      // Alice mints an account-scoped token.
      const aliceMint = await app.inject({
        method: "POST",
        url: `/tokens`,
        headers: bffHeaders("acct-alice"),
        payload: { name: "alice-token" },
      });
      const alice = MintTokenResponse.parse(aliceMint.json());

      // Bob (a DIFFERENT account) cannot revoke Alice's token — 404, no leak.
      const bobRevoke = await app.inject({
        method: "DELETE",
        url: `/tokens/${alice.id}`,
        headers: bffAuthHeaders("acct-bob"),
      });
      expect(bobRevoke.statusCode).toBe(404);

      // Bob's own token list does not include Alice's token.
      const bobList = await app.inject({
        method: "GET",
        url: `/tokens`,
        headers: bffAuthHeaders("acct-bob"),
      });
      const list = ListTokensResponse.parse(bobList.json());
      expect(list.tokens.some((t) => t.id === alice.id)).toBe(false);

      // Alice's token still authenticates (Bob's attempt revoked nothing).
      const stillLive = await pool.query(
        `SELECT 1 FROM api_tokens WHERE id = $1 AND revoked_at IS NULL`,
        [alice.id],
      );
      expect(stillLive.rows).toHaveLength(1);
    });

    it("rejects POST /tokens from a self-host TEAM_TOKEN (no accountId) with 401", async () => {
      await seedWorkspace(pool, ALLOWED_WS);
      const res = await app.inject({
        method: "POST",
        url: `/tokens`,
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          "content-type": "application/json",
        },
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });

    it("an account-scoped agent token can mint ANOTHER account-scoped token for its OWN account (INTENDED)", async () => {
      // Alice mints an account-scoped token via the browser/BFF path.
      const first = await app.inject({
        method: "POST",
        url: `/tokens`,
        headers: bffHeaders("acct-alice"),
        payload: { name: "seed" },
      });
      const seed = MintTokenResponse.parse(first.json());

      // That raw shp_ token — presented as a Bearer, NOT via the BFF — mints again.
      const second = await app.inject({
        method: "POST",
        url: `/tokens`,
        headers: {
          authorization: `Bearer ${seed.token}`,
          "content-type": "application/json",
        },
        payload: { name: "minted-by-agent" },
      });
      expect(second.statusCode).toBe(200);
      const minted = MintTokenResponse.parse(second.json());

      // The new token is account-scoped (NULL workspace) and owned by the SAME
      // account — not a cross-tenant escalation.
      const row = await pool.query<{
        workspace_id: string | null;
        account_id: string;
      }>(`SELECT workspace_id, account_id FROM api_tokens WHERE id = $1`, [
        minted.id,
      ]);
      expect(row.rows[0]!.workspace_id).toBeNull();
      expect(row.rows[0]!.account_id).toBe("acct-alice");
    });
  },
);
