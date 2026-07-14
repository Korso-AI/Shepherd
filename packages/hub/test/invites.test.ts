/**
 * Tests for the invite create/revoke/redeem endpoints (Task 3.5):
 *   POST /workspaces/:id/invites             — admin mints a redeemable invite code.
 *   POST /workspaces/:id/invites/:code/revoke — admin revokes one (workspace-scoped).
 *   POST /invites/:code/redeem               — a SIGNED-IN account joins via the code.
 *
 * The two `/workspaces/:id/*` routes ride resolveTenant's membership + role check
 * (admin-only via requireAdmin). The redeem route is NOT under `/workspaces/:id`, so
 * resolveTenant does no route-membership check — the operation pins the trust itself:
 * it accepts ONLY the browser-via-BFF account path (accountId set AND workspaceId is
 * the NO_ROUTE_WORKSPACE sentinel ""), and rejects an agent `shp_` token (concrete
 * workspaceId), a forged x-account-id (no/invalid internal token → 401 before the
 * handler), and a self-host TEAM_TOKEN (no accountId).
 *
 * Tenancy setup mirrors tokens.test.ts: a real pool, the onRequest hook hits the DB,
 * and we seed workspaces + memberships + account_profiles by hand. truncateAll +
 * truncateTenancy reset between tests; the rate limiter AND the redeem throttle are
 * reset in afterEach.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  vi,
} from "vitest";
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
import { __resetRedeemThrottle } from "../src/operations/invites.js";
import type { Config } from "../src/config.js";
import type { FastifyInstance } from "fastify";
import {
  InviteResponse,
  RedeemInviteResponse,
  ListEmailInvitesResponse,
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

/** Read an invite's raw row (use_count, revoked_at, …) directly for assertions. */
async function readInvite(
  pool: pg.Pool,
  code: string,
): Promise<{
  workspace_id: string;
  role_granted: string;
  use_count: number;
  max_uses: number;
  expires_at: Date | null;
  revoked_at: Date | null;
} | null> {
  const { rows } = await pool.query(
    `SELECT workspace_id, role_granted, use_count, max_uses, expires_at, revoked_at
     FROM invites WHERE code = $1`,
    [code],
  );
  return rows[0] ?? null;
}

/**
 * Seed an ACCOUNT-scoped agent token (workspace_id NULL) directly and return its
 * plaintext. Such a token resolves via the agent path with the NO_ROUTE_WORKSPACE
 * sentinel workspaceId — the exact shape the OLD sentinel-based redeem guard
 * mistook for a trusted browser session. Seeded by SQL because the account-scoped
 * mint endpoint lands in a later task; the redeem guard must reject it regardless.
 */
async function seedAccountScopedToken(
  pool: pg.Pool,
  accountId: string,
  plaintext = "shp_account_scoped_redeem",
): Promise<string> {
  await pool.query(
    `INSERT INTO api_tokens (account_id, workspace_id, token_hash, name)
     VALUES ($1, NULL, $2, 'account-scoped-test')`,
    [accountId, hashToken(plaintext)],
  );
  return plaintext;
}

/** Mint an agent `shp_` token for (accountId, workspaceId) via the mint endpoint. */
async function mintAgentToken(
  app: FastifyInstance,
  workspaceId: string,
  accountId: string,
): Promise<string> {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${workspaceId}/tokens`,
    headers: bffHeaders(accountId),
    payload: {},
  });
  return res.json().token as string;
}

// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Invite endpoints (DB-gated)" + (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    let pool: pg.Pool;
    let appPool: pg.Pool;
    let app: FastifyInstance;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      // The server handlers run as the restricted app-role login so the invite
      // create/revoke/redeem paths exercise migration 021's RLS policies (admin
      // membership check, workspace-scoped revoke, account-context redeem).
      appPool = createAppPool();
      initContext({ pool: appPool, config: makeTestConfig() });
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
      await appPool.end();
      await pool.end();
    });

    // --- POST /workspaces/:id/invites (create) ------------------------------

    it("admin creates an invite with defaults (7d expiry, unlimited uses, member role) and a high-entropy code", async () => {
      const wsId = await seedWorkspace(pool, "alpha");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      const before = Date.now();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/invites`,
        headers: bffHeaders("acct-admin"),
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const invite = InviteResponse.parse(res.json());

      // Defaults: unlimited uses until revoked, member role, 7d expiry.
      expect(invite.maxUses).toBeNull();
      expect(invite.useCount).toBe(0);

      // Code is url-safe base62 (no + / = or other punctuation) carrying 128-bit
      // entropy. base62 of 16 random bytes is typically 21–22 chars, but the
      // length is a magnitude artifact: when the high byte(s) happen to be zero
      // the encoded BigInt is shorter (this does NOT reduce entropy). Assert a
      // safe non-flaky range rather than a hard ≥21 floor (which flakes ~1/256
      // on a leading zero byte).
      expect(invite.code).toMatch(/^[0-9A-Za-z]+$/);
      expect(invite.code.length).toBeGreaterThanOrEqual(16);
      expect(invite.code.length).toBeLessThanOrEqual(22);

      // Expiry defaults to ~7 days out (allow a wide window for clock/test drift).
      expect(invite.expiresAt).not.toBeNull();
      const expiresMs = new Date(invite.expiresAt!).getTime();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      expect(expiresMs).toBeGreaterThan(before + sevenDays - 60_000);
      expect(expiresMs).toBeLessThan(before + sevenDays + 60_000);

      // Persisted with role member.
      const row = await readInvite(pool, invite.code);
      expect(row!.role_granted).toBe("member");
      expect(row!.workspace_id).toBe(wsId);
    });

    it("honors expiresInDays / maxUses overrides; a stray role is ignored (member-only, P2.7)", async () => {
      const wsId = await seedWorkspace(pool, "overrides");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      const before = Date.now();
      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/invites`,
        headers: bffHeaders("acct-admin"),
        // `role` is no longer a request field — it is stripped, not honored, so
        // the invite is still minted at the `member` role.
        payload: { role: "admin", expiresInDays: 30, maxUses: 3 },
      });
      expect(res.statusCode).toBe(200);
      const invite = InviteResponse.parse(res.json());
      expect(invite.maxUses).toBe(3);

      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      const expiresMs = new Date(invite.expiresAt!).getTime();
      expect(expiresMs).toBeGreaterThan(before + thirtyDays - 60_000);
      expect(expiresMs).toBeLessThan(before + thirtyDays + 60_000);

      const row = await readInvite(pool, invite.code);
      expect(row!.role_granted).toBe("member");
    });

    it("two invites in the same workspace get DISTINCT codes", async () => {
      const wsId = await seedWorkspace(pool, "distinct");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      const a = InviteResponse.parse(
        (
          await app.inject({
            method: "POST",
            url: `/workspaces/${wsId}/invites`,
            headers: bffHeaders("acct-admin"),
            payload: {},
          })
        ).json(),
      );
      const b = InviteResponse.parse(
        (
          await app.inject({
            method: "POST",
            url: `/workspaces/${wsId}/invites`,
            headers: bffHeaders("acct-admin"),
            payload: {},
          })
        ).json(),
      );
      expect(a.code).not.toBe(b.code);
    });

    it("a non-admin (member) cannot create an invite → 403", async () => {
      const wsId = await seedWorkspace(pool, "member-create");
      await seedMembership(pool, "acct-member", wsId, "member");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/invites`,
        headers: bffHeaders("acct-member"),
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });

    // --- POST /workspaces/:id/invites/:code/revoke --------------------------

    it("admin revokes an invite; a revoked code can no longer be redeemed", async () => {
      const wsId = await seedWorkspace(pool, "revoke-ws");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      const created = InviteResponse.parse(
        (
          await app.inject({
            method: "POST",
            url: `/workspaces/${wsId}/invites`,
            headers: bffHeaders("acct-admin"),
            payload: {},
          })
        ).json(),
      );

      const revoke = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/invites/${created.code}/revoke`,
        headers: bffHeaders("acct-admin"),
        payload: {},
      });
      expect(revoke.statusCode).toBe(200);

      // The invite is now revoked in the DB.
      const row = await readInvite(pool, created.code);
      expect(row!.revoked_at).not.toBeNull();

      // A redeem of the revoked code is rejected (no membership added).
      const redeem = await app.inject({
        method: "POST",
        url: `/invites/${created.code}/redeem`,
        headers: bffHeaders("acct-newcomer"),
        payload: {},
      });
      expect(redeem.statusCode).toBe(410);
    });

    it("a non-admin (member) cannot revoke an invite → 403", async () => {
      const wsId = await seedWorkspace(pool, "member-revoke");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      await seedMembership(pool, "acct-member", wsId, "member");

      const created = InviteResponse.parse(
        (
          await app.inject({
            method: "POST",
            url: `/workspaces/${wsId}/invites`,
            headers: bffHeaders("acct-admin"),
            payload: {},
          })
        ).json(),
      );

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/invites/${created.code}/revoke`,
        headers: bffHeaders("acct-member"),
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });

    it("revoke is workspace-scoped: admin of A cannot revoke B's invite (404), and B's code still redeems", async () => {
      const wsA = await seedWorkspace(pool, "rev-a");
      const wsB = await seedWorkspace(pool, "rev-b");
      await seedMembership(pool, "acct-a-admin", wsA, "admin");
      await seedMembership(pool, "acct-b-admin", wsB, "admin");

      // B's admin creates an invite into B.
      const inviteB = InviteResponse.parse(
        (
          await app.inject({
            method: "POST",
            url: `/workspaces/${wsB}/invites`,
            headers: bffHeaders("acct-b-admin"),
            payload: {},
          })
        ).json(),
      );

      // A's admin tries to revoke B's code SCOPED TO A's workspace → 404
      // (must not be able to revoke another workspace's invite by guessing it).
      const cross = await app.inject({
        method: "POST",
        url: `/workspaces/${wsA}/invites/${inviteB.code}/revoke`,
        headers: bffHeaders("acct-a-admin"),
        payload: {},
      });
      expect(cross.statusCode).toBe(404);

      // B's invite is untouched: it still redeems.
      const redeem = await app.inject({
        method: "POST",
        url: `/invites/${inviteB.code}/redeem`,
        headers: bffHeaders("acct-joiner"),
        payload: {},
      });
      expect(redeem.statusCode).toBe(200);
      const body = RedeemInviteResponse.parse(redeem.json());
      expect(body.workspace.id).toBe(wsB);
    });

    it("revoking an unknown code → 404", async () => {
      const wsId = await seedWorkspace(pool, "unknown-revoke");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/invites/nonexistent-code/revoke`,
        headers: bffHeaders("acct-admin"),
        payload: {},
      });
      expect(res.statusCode).toBe(404);
    });

    // --- POST /invites/:code/redeem (happy path) ----------------------------

    it("redeem adds a membership with the granted role and increments use_count", async () => {
      const wsId = await seedWorkspace(pool, "redeem-ws");

      // Seed an ADMIN-role invite directly. The create API mints `member` invites
      // only now (P2.7), but the redeem path must still honor whatever role_granted
      // the invite row carries — so we exercise it with an admin invite.
      const code = "redeemadmininvite01";
      await pool.query(
        `INSERT INTO invites (workspace_id, code, created_by, role_granted, max_uses, expires_at)
         VALUES ($1, $2, 'acct-admin', 'admin', 25, now() + interval '7 days')`,
        [wsId, code],
      );

      const redeem = await app.inject({
        method: "POST",
        url: `/invites/${code}/redeem`,
        headers: bffHeaders("acct-newcomer"),
        payload: {},
      });
      expect(redeem.statusCode).toBe(200);
      const body = RedeemInviteResponse.parse(redeem.json());
      expect(body.workspace.id).toBe(wsId);
      expect(body.workspace.role).toBe("admin");

      // Membership now exists at the granted role.
      const mem = await pool.query<{ role: string }>(
        `SELECT role FROM memberships WHERE account_id = $1 AND workspace_id = $2`,
        ["acct-newcomer", wsId],
      );
      expect(mem.rows).toHaveLength(1);
      expect(mem.rows[0]!.role).toBe("admin");

      // use_count advanced by exactly one.
      const row = await readInvite(pool, code);
      expect(row!.use_count).toBe(1);
    });

    it("redeem tolerates a bodyless POST that still carries content-type: application/json", async () => {
      // The console BFF forwards the browser's bodyless redeem POST with an
      // EMPTY body but a fabricated `content-type: application/json`. Fastify's
      // default JSON parser rejects that (FST_ERR_CTP_EMPTY_JSON_BODY -> 400)
      // before the handler runs — the exact bug class that already turned a
      // last-admin leave into a 500 and the invite-link join into an opaque
      // "HTTP 400: upstream_error". The hub must treat an empty JSON body as
      // "no body" on every route instead of dying in body parsing.
      const wsId = await seedWorkspace(pool, "redeem-empty-body-ws");

      const code = "redeememptybody01";
      await pool.query(
        `INSERT INTO invites (workspace_id, code, created_by, role_granted, max_uses, expires_at)
         VALUES ($1, $2, 'acct-admin', 'member', 25, now() + interval '7 days')`,
        [wsId, code],
      );

      const redeem = await app.inject({
        method: "POST",
        url: `/invites/${code}/redeem`,
        // bffHeaders sets content-type: application/json; deliberately NO payload.
        headers: bffHeaders("acct-empty-body"),
      });
      expect(redeem.statusCode).toBe(200);
      const body = RedeemInviteResponse.parse(redeem.json());
      expect(body.workspace.id).toBe(wsId);

      const mem = await pool.query(
        `SELECT role FROM memberships WHERE account_id = $1 AND workspace_id = $2`,
        ["acct-empty-body", wsId],
      );
      expect(mem.rows).toHaveLength(1);
    });

    // --- Invite ↔ last-admin-guard interaction (Task 3.5 × 3.6) -------------

    it("redeeming an ADMIN-role invite lifts the last-admin guard: the prior sole admin can then leave", async () => {
      // Precondition: a workspace with exactly ONE admin (admin1) and no other.
      const wsId = await seedWorkspace(pool, "last-admin-interaction");
      await seedMembership(pool, "acct-admin1", wsId, "admin");

      const countAdmins = async () => {
        const { rows } = await pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM memberships WHERE workspace_id = $1 AND role = 'admin'`,
          [wsId],
        );
        return Number(rows[0]!.n);
      };
      expect(await countAdmins()).toBe(1);

      // The last-admin guard blocks admin1 from leaving while they're the sole admin.
      const blocked = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/leave`,
        headers: bffHeaders("acct-admin1"),
        payload: {},
      });
      expect(blocked.statusCode).toBe(409); // ConflictError: last admin

      // An ADMIN-role invite exists (seeded directly — the create API mints only
      // `member` invites now, P2.7); a second account redeems it to become admin.
      const code = "lastadminliftinvite01";
      await pool.query(
        `INSERT INTO invites (workspace_id, code, created_by, role_granted, max_uses, expires_at)
         VALUES ($1, $2, 'acct-admin1', 'admin', 25, now() + interval '7 days')`,
        [wsId, code],
      );
      const redeem = await app.inject({
        method: "POST",
        url: `/invites/${code}/redeem`,
        headers: bffHeaders("acct-admin2"),
        payload: {},
      });
      expect(redeem.statusCode).toBe(200);
      const redeemed = RedeemInviteResponse.parse(redeem.json());
      expect(redeemed.workspace.role).toBe("admin");

      // The grant raised the admin count — the guard precondition no longer holds.
      expect(await countAdmins()).toBe(2);

      // admin1 can NOW leave: the workspace still retains an admin (admin2).
      const left = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/leave`,
        headers: bffHeaders("acct-admin1"),
        payload: {},
      });
      expect(left.statusCode).toBe(200);

      // admin1's membership is gone; admin2 remains the surviving admin.
      const a1 = await pool.query(
        `SELECT 1 FROM memberships WHERE account_id = $1 AND workspace_id = $2`,
        ["acct-admin1", wsId],
      );
      expect(a1.rows).toHaveLength(0);
      expect(await countAdmins()).toBe(1);
    });

    it("redeem by an EXISTING member is a no-op success and does NOT burn a use", async () => {
      const wsId = await seedWorkspace(pool, "already-member");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      await seedMembership(pool, "acct-member", wsId, "member");

      const created = InviteResponse.parse(
        (
          await app.inject({
            method: "POST",
            url: `/workspaces/${wsId}/invites`,
            headers: bffHeaders("acct-admin"),
            payload: {},
          })
        ).json(),
      );

      const redeem = await app.inject({
        method: "POST",
        url: `/invites/${created.code}/redeem`,
        headers: bffHeaders("acct-member"),
        payload: {},
      });
      expect(redeem.statusCode).toBe(200);
      const body = RedeemInviteResponse.parse(redeem.json());
      expect(body.workspace.id).toBe(wsId);
      // Role unchanged — already-member redeem does NOT re-grant/promote.
      expect(body.workspace.role).toBe("member");

      // No use was burned.
      const row = await readInvite(pool, created.code);
      expect(row!.use_count).toBe(0);
    });

    it("redeem of an EXPIRED invite is rejected (410) and does NOT advance use_count", async () => {
      const wsId = await seedWorkspace(pool, "expired-ws");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      // Insert an already-expired invite directly (expires_at in the past).
      await pool.query(
        `INSERT INTO invites (workspace_id, code, created_by, role_granted, max_uses, expires_at)
         VALUES ($1, 'EXPIRED-CODE', 'acct-admin', 'member', 25, now() - interval '1 hour')`,
        [wsId],
      );

      const redeem = await app.inject({
        method: "POST",
        url: `/invites/EXPIRED-CODE/redeem`,
        headers: bffHeaders("acct-late"),
        payload: {},
      });
      expect(redeem.statusCode).toBe(410);

      // No membership, no use burned.
      const mem = await pool.query(
        `SELECT 1 FROM memberships WHERE account_id = $1 AND workspace_id = $2`,
        ["acct-late", wsId],
      );
      expect(mem.rows).toHaveLength(0);
      const row = await readInvite(pool, "EXPIRED-CODE");
      expect(row!.use_count).toBe(0);
    });

    it("redeem of an EXHAUSTED invite (use_count == max_uses) is rejected (410)", async () => {
      const wsId = await seedWorkspace(pool, "exhausted-ws");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      // max_uses 1, already used once.
      await pool.query(
        `INSERT INTO invites (workspace_id, code, created_by, role_granted, max_uses, use_count)
         VALUES ($1, 'EXHAUSTED', 'acct-admin', 'member', 1, 1)`,
        [wsId],
      );

      const redeem = await app.inject({
        method: "POST",
        url: `/invites/EXHAUSTED/redeem`,
        headers: bffHeaders("acct-toolate"),
        payload: {},
      });
      expect(redeem.statusCode).toBe(410);

      const row = await readInvite(pool, "EXHAUSTED");
      expect(row!.use_count).toBe(1);
    });

    it("redeem of a revoked code is rejected (410)", async () => {
      const wsId = await seedWorkspace(pool, "revoked-redeem");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      await pool.query(
        `INSERT INTO invites (workspace_id, code, created_by, role_granted, max_uses, revoked_at)
         VALUES ($1, 'REVOKED-CODE', 'acct-admin', 'member', 25, now())`,
        [wsId],
      );

      const redeem = await app.inject({
        method: "POST",
        url: `/invites/REVOKED-CODE/redeem`,
        headers: bffHeaders("acct-x"),
        payload: {},
      });
      expect(redeem.statusCode).toBe(410);
    });

    it("redeem of an unknown code is rejected (410)", async () => {
      const redeem = await app.inject({
        method: "POST",
        url: `/invites/totally-unknown/redeem`,
        headers: bffHeaders("acct-x"),
        payload: {},
      });
      expect(redeem.statusCode).toBe(410);
    });

    // --- Redeem auth pinning (security-critical) ----------------------------

    it("redeem with a FORGED x-account-id (no internal token) → 401, no membership", async () => {
      const wsId = await seedWorkspace(pool, "forged-ws");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      const created = InviteResponse.parse(
        (
          await app.inject({
            method: "POST",
            url: `/workspaces/${wsId}/invites`,
            headers: bffHeaders("acct-admin"),
            payload: {},
          })
        ).json(),
      );

      // A raw client asserts an account WITHOUT the BFF internal token.
      const redeem = await app.inject({
        method: "POST",
        url: `/invites/${created.code}/redeem`,
        headers: {
          "x-account-id": "acct-attacker",
          "content-type": "application/json",
        },
        payload: {},
      });
      expect(redeem.statusCode).toBe(401);

      // No membership was created for the forged account.
      const mem = await pool.query(
        `SELECT 1 FROM memberships WHERE account_id = $1 AND workspace_id = $2`,
        ["acct-attacker", wsId],
      );
      expect(mem.rows).toHaveLength(0);
    });

    it("redeem with an AGENT shp_ token is rejected (no self-join to NEW workspaces)", async () => {
      const wsHome = await seedWorkspace(pool, "agent-home");
      const wsTarget = await seedWorkspace(pool, "agent-target");
      await seedMembership(pool, "acct-agent", wsHome, "member");
      await seedMembership(pool, "acct-target-admin", wsTarget, "admin");

      // An invite into the TARGET workspace (which the agent is NOT a member of).
      const created = InviteResponse.parse(
        (
          await app.inject({
            method: "POST",
            url: `/workspaces/${wsTarget}/invites`,
            headers: bffHeaders("acct-target-admin"),
            payload: {},
          })
        ).json(),
      );

      // The agent's shp_ token is scoped to wsHome. It must NOT be able to redeem.
      const token = await mintAgentToken(app, wsHome, "acct-agent");
      const redeem = await app.inject({
        method: "POST",
        url: `/invites/${created.code}/redeem`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {},
      });
      expect([401, 403]).toContain(redeem.statusCode);

      // The agent's account did NOT self-join the target workspace.
      const mem = await pool.query(
        `SELECT 1 FROM memberships WHERE account_id = $1 AND workspace_id = $2`,
        ["acct-agent", wsTarget],
      );
      expect(mem.rows).toHaveLength(0);
      // And the use was not burned.
      const row = await readInvite(pool, created.code);
      expect(row!.use_count).toBe(0);
    });

    it("redeem with an ACCOUNT-scoped token (workspace_id NULL) is rejected (no self-join to NEW workspaces)", async () => {
      // Regression for the credential-kind discriminator (plan 1.2): an
      // account-scoped token resolves to {workspaceId: "", accountId} — the SAME
      // shape a browser session has on a non-:id route. The redeem guard must key
      // on `tenant.via`, NOT the workspace sentinel; otherwise this token would
      // pass and self-join arbitrary workspaces via any code it holds — a durable
      // membership row that survives token revocation.
      const wsTarget = await seedWorkspace(pool, "acct-scoped-target");
      await seedMembership(pool, "acct-target-admin", wsTarget, "admin");

      const created = InviteResponse.parse(
        (
          await app.inject({
            method: "POST",
            url: `/workspaces/${wsTarget}/invites`,
            headers: bffHeaders("acct-target-admin"),
            payload: {},
          })
        ).json(),
      );

      const token = await seedAccountScopedToken(pool, "acct-scoped-agent");
      const redeem = await app.inject({
        method: "POST",
        url: `/invites/${created.code}/redeem`,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        payload: {},
      });
      expect([401, 403]).toContain(redeem.statusCode);

      // The account did NOT self-join the target workspace, and no use was burned.
      const mem = await pool.query(
        `SELECT 1 FROM memberships WHERE account_id = $1 AND workspace_id = $2`,
        ["acct-scoped-agent", wsTarget],
      );
      expect(mem.rows).toHaveLength(0);
      const row = await readInvite(pool, created.code);
      expect(row!.use_count).toBe(0);
    });

    it("redeem with a self-host TEAM_TOKEN (no account) is rejected", async () => {
      const wsId = await seedWorkspace(pool, ALLOWED_WS);
      await pool.query(
        `INSERT INTO invites (workspace_id, code, created_by, role_granted, max_uses)
         VALUES ($1, 'TEAM-CODE', 'seed', 'member', 25)`,
        [wsId],
      );

      const redeem = await app.inject({
        method: "POST",
        url: `/invites/TEAM-CODE/redeem`,
        headers: {
          authorization: `Bearer ${TEST_TOKEN}`,
          "content-type": "application/json",
        },
        payload: {},
      });
      expect([401, 403]).toContain(redeem.statusCode);

      const row = await readInvite(pool, "TEAM-CODE");
      expect(row!.use_count).toBe(0);
    });

    // --- Redeem throttle (anti-enumeration) ---------------------------------

    it("throttles repeated invalid-code redeems from one account, but a valid redeem from a DIFFERENT account still works", async () => {
      const wsId = await seedWorkspace(pool, "throttle-ws");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      const created = InviteResponse.parse(
        (
          await app.inject({
            method: "POST",
            url: `/workspaces/${wsId}/invites`,
            headers: bffHeaders("acct-admin"),
            payload: {},
          })
        ).json(),
      );

      // The attacker enumerates invalid codes from one account until throttled.
      let throttled = false;
      for (let i = 0; i < 30; i++) {
        const res = await app.inject({
          method: "POST",
          url: `/invites/guess-${i}/redeem`,
          headers: bffHeaders("acct-attacker"),
          payload: {},
        });
        if (res.statusCode === 429) {
          throttled = true;
          break;
        }
        // Until throttled, an unknown code reads as 410.
        expect(res.statusCode).toBe(410);
      }
      expect(throttled).toBe(true);

      // A DIFFERENT account redeeming a VALID code is unaffected by the
      // attacker's failures.
      const ok = await app.inject({
        method: "POST",
        url: `/invites/${created.code}/redeem`,
        headers: bffHeaders("acct-victim"),
        payload: {},
      });
      expect(ok.statusCode).toBe(200);
    });

    // --- POST /workspaces/:id/invites/email ---------------------------------

    it("email invite → 501 when RESEND_API_KEY/INVITE_EMAIL_FROM/PUBLIC_WEB_URL are not configured", async () => {
      const wsId = await seedWorkspace(pool, "email-unconfigured");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/invites/email`,
        headers: bffHeaders("acct-admin"),
        payload: { email: "newcomer@example.com" },
      });
      expect(res.statusCode).toBe(501);
    });

    it("a non-admin (member) cannot send an email invite → 403", async () => {
      const wsId = await seedWorkspace(pool, "email-member");
      await seedMembership(pool, "acct-member", wsId, "member");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/invites/email`,
        headers: bffHeaders("acct-member"),
        payload: { email: "newcomer@example.com" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("email invite with a malformed address → 400 (before hitting Resend)", async () => {
      const wsId = await seedWorkspace(pool, "email-malformed");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/invites/email`,
        headers: bffHeaders("acct-admin"),
        payload: { email: "not-an-email" },
      });
      expect(res.statusCode).toBe(400);
    });
  },
);

// ---------------------------------------------------------------------------
// Email invites — configured deployment (RESEND_API_KEY/INVITE_EMAIL_FROM/
// PUBLIC_WEB_URL all set). Runs against its own app/pool so it can carry a
// different Config than the suite above, which deliberately leaves email
// unconfigured to exercise the 501 path.
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Invite by email — configured deployment (DB-gated)" +
    (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    let pool: pg.Pool;
    let appPool: pg.Pool;
    let app: FastifyInstance;
    let fetchSpy: ReturnType<typeof vi.spyOn>;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      // Server handlers run as the restricted app-role login so the email-invite
      // paths exercise migration 021's RLS policies.
      appPool = createAppPool();
      initContext({
        pool: appPool,
        config: makeTestConfig({
          RESEND_API_KEY: "test-resend-key",
          INVITE_EMAIL_FROM: "invites@example.com",
          PUBLIC_WEB_URL: "https://app.example.com",
        }),
      });
      app = buildServer();
      await app.ready();
    });

    afterEach(async () => {
      __resetRateLimiter();
      __resetRedeemThrottle();
      await truncateAll(pool);
      await truncateTenancy(pool);
      fetchSpy?.mockRestore();
    });

    afterAll(async () => {
      await app.close();
      resetContext();
      await appPool.end();
      await pool.end();
    });

    it("admin sends an email invite: mints a one-time-use code and calls Resend with the join link", async () => {
      const wsId = await seedWorkspace(pool, "email-configured");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ id: "resend-id" }), { status: 200 }),
        );

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/invites/email`,
        headers: bffHeaders("acct-admin"),
        payload: { email: "newcomer@example.com" },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.email).toBe("newcomer@example.com");
      expect(typeof body.sentAt).toBe("string");

      // Resend was called once, with the join link pointing at PUBLIC_WEB_URL.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0]!;
      expect(url).toBe("https://api.resend.com/emails");
      const requestBody = JSON.parse((init as RequestInit).body as string);
      expect(requestBody.to).toBe("newcomer@example.com");
      expect(requestBody.from).toBe("invites@example.com");
      expect(requestBody.html).toContain(
        "https://app.example.com/shepherd/join/",
      );

      // The minted invite is one-time-use (maxUses fixed at 1, not the
      // unlimited code/link default).
      const { rows } = await pool.query<{
        max_uses: number;
        use_count: number;
      }>(`SELECT max_uses, use_count FROM invites WHERE workspace_id = $1`, [
        wsId,
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.max_uses).toBe(1);
      expect(rows[0]!.use_count).toBe(0);
    });

    it("an email invite's join link expires after one redemption (one-time use)", async () => {
      const wsId = await seedWorkspace(pool, "email-onetime");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ id: "resend-id" }), { status: 200 }),
        );

      const send = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/invites/email`,
        headers: bffHeaders("acct-admin"),
        payload: { email: "newcomer@example.com" },
      });
      expect(send.statusCode).toBe(200);

      const { rows } = await pool.query<{ code: string }>(
        `SELECT code FROM invites WHERE workspace_id = $1`,
        [wsId],
      );
      const code = rows[0]!.code;

      const firstRedeem = await app.inject({
        method: "POST",
        url: `/invites/${code}/redeem`,
        headers: bffHeaders("acct-newcomer"),
        payload: {},
      });
      expect(firstRedeem.statusCode).toBe(200);

      const secondRedeem = await app.inject({
        method: "POST",
        url: `/invites/${code}/redeem`,
        headers: bffHeaders("acct-second"),
        payload: {},
      });
      expect(secondRedeem.statusCode).toBe(410);
    });

    it("surfaces a 500 when Resend's API call fails (no silent success)", async () => {
      const wsId = await seedWorkspace(pool, "email-resend-failure");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response("rate limited", {
          status: 429,
          statusText: "Too Many Requests",
        }),
      );

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/invites/email`,
        headers: bffHeaders("acct-admin"),
        payload: { email: "newcomer@example.com" },
      });
      expect(res.statusCode).toBe(500);
    });

    // --- GET /workspaces/:id/invites/email (pending list) -------------------

    it("lists a sent email invite as pending, then drops it after redemption", async () => {
      const wsId = await seedWorkspace(pool, "email-pending");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(
          new Response(JSON.stringify({ id: "resend-id" }), { status: 200 }),
        );

      const send = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/invites/email`,
        headers: bffHeaders("acct-admin"),
        payload: { email: "newcomer@example.com" },
      });
      expect(send.statusCode).toBe(200);

      const pending = await app.inject({
        method: "GET",
        url: `/workspaces/${wsId}/invites/email`,
        headers: bffHeaders("acct-admin"),
      });
      expect(pending.statusCode).toBe(200);
      const list = ListEmailInvitesResponse.parse(pending.json());
      expect(list.invites).toHaveLength(1);
      expect(list.invites[0]!.email).toBe("newcomer@example.com");
      // Status-only surface: the invite CODE must not leak into the list.
      expect(JSON.stringify(pending.json())).not.toContain(
        (
          await pool.query<{ code: string }>(
            `SELECT code FROM invites WHERE workspace_id = $1`,
            [wsId],
          )
        ).rows[0]!.code,
      );

      // Redeem the one-time link — the entry disappears from the pending list.
      const { rows } = await pool.query<{ code: string }>(
        `SELECT code FROM invites WHERE workspace_id = $1`,
        [wsId],
      );
      const redeem = await app.inject({
        method: "POST",
        url: `/invites/${rows[0]!.code}/redeem`,
        headers: bffHeaders("acct-newcomer"),
        payload: {},
      });
      expect(redeem.statusCode).toBe(200);

      const after = await app.inject({
        method: "GET",
        url: `/workspaces/${wsId}/invites/email`,
        headers: bffHeaders("acct-admin"),
      });
      expect(ListEmailInvitesResponse.parse(after.json()).invites).toHaveLength(
        0,
      );
    });

    it("pending list excludes revoked and expired email invites, and code invites entirely", async () => {
      const wsId = await seedWorkspace(pool, "email-pending-filter");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      // Seed directly: one live, one revoked, one expired email invite, plus a
      // plain code invite (email NULL) that must never appear here.
      await pool.query(
        `INSERT INTO invites (workspace_id, code, created_by, role_granted, max_uses, expires_at, revoked_at, email)
         VALUES
           ($1, 'live-code',    'tester', 'member', 1, now() + interval '7 days', NULL,  'live@example.com'),
           ($1, 'revoked-code', 'tester', 'member', 1, now() + interval '7 days', now(), 'revoked@example.com'),
           ($1, 'expired-code', 'tester', 'member', 1, now() - interval '1 day',  NULL,  'expired@example.com'),
           ($1, 'plain-code',   'tester', 'member', 1, now() + interval '7 days', NULL,  NULL)`,
        [wsId],
      );

      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${wsId}/invites/email`,
        headers: bffHeaders("acct-admin"),
      });
      expect(res.statusCode).toBe(200);
      const list = ListEmailInvitesResponse.parse(res.json());
      expect(list.invites.map((i) => i.email)).toEqual(["live@example.com"]);
    });

    it("a non-admin (member) cannot list pending email invites → 403", async () => {
      const wsId = await seedWorkspace(pool, "email-pending-member");
      await seedMembership(pool, "acct-member", wsId, "member");

      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${wsId}/invites/email`,
        headers: bffHeaders("acct-member"),
      });
      expect(res.statusCode).toBe(403);
    });
  },
);
