/**
 * Tests for the member management endpoints (Task 3.6 + ownership):
 *   GET    /workspaces/:id/members                      — list members (any member).
 *   DELETE /workspaces/:id/members/:accountId           — remove a member.
 *   PATCH  /workspaces/:id/members/:accountId/role      — owner promotes/demotes.
 *   POST   /workspaces/:id/transfer-ownership           — owner hands off ownership.
 *   POST   /workspaces/:id/leave                         — caller removes themselves.
 *
 * Ownership is derived from workspaces.created_by (there is no "owner" role): the
 * owner may change roles / transfer / remove admins and can never be removed;
 * plain admins may only remove members. seedWorkspace(createdBy) sets the owner.
 *
 * All three are `/workspaces/:id/*` routes, so resolveTenant has ALREADY validated
 * the browser-via-BFF caller is a MEMBER of `:id` (a non-member is rejected 404 in
 * the onRequest hook) and set `tenant.role`. So:
 *   - list   gates on membership only (no requireAdmin — members see the roster).
 *   - remove requires admin (403 otherwise), 404s an unknown target, refuses to
 *     remove the LAST admin (409), and — on success — revokes that member's
 *     api_tokens IN THIS workspace (their tokens in OTHER workspaces are untouched).
 *   - leave  removes the caller's own membership + revokes their own tokens, but
 *     refuses if the caller is the last admin (409).
 *
 * Setup mirrors invites.test.ts / tokens.test.ts: a real pool, the onRequest hook
 * hits the DB, and we seed workspaces + memberships + account_profiles + tokens by
 * hand. truncateAll + truncateTenancy reset between tests; the rate limiter is reset
 * in afterEach.
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
import { ListMembersResponse } from "@shepherd/shared";

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

/**
 * BFF headers for a BODYLESS request (GET / DELETE). Fastify rejects an empty
 * body when content-type is application/json, so we omit it here.
 */
function bffAuthHeaders(accountId: string, extra: Record<string, string> = {}) {
  return {
    "x-internal-token": INTERNAL_TOKEN,
    "x-account-id": accountId,
    ...extra,
  };
}

/**
 * Seed a workspace by slug (idempotent); returns its uuid. `createdBy` sets the
 * OWNER account (workspaces.created_by) — defaults to 'tester' (no seeded account
 * is the owner), but owner-gated tests pass the caller's account id so they own it.
 */
async function seedWorkspace(
  pool: pg.Pool,
  slug: string,
  createdBy = "tester",
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, $3)
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name, created_by = EXCLUDED.created_by RETURNING id`,
    [slug, slug, createdBy],
  );
  return rows[0]!.id;
}

/** The current role of (accountId, workspaceId), or null when not a member. */
async function roleOf(
  pool: pg.Pool,
  accountId: string,
  workspaceId: string,
): Promise<"admin" | "member" | null> {
  const { rows } = await pool.query<{ role: "admin" | "member" }>(
    `SELECT role FROM memberships WHERE account_id = $1 AND workspace_id = $2`,
    [accountId, workspaceId],
  );
  return rows[0]?.role ?? null;
}

/** The owner account (workspaces.created_by) of a workspace. */
async function ownerOf(pool: pg.Pool, workspaceId: string): Promise<string> {
  const { rows } = await pool.query<{ created_by: string }>(
    `SELECT created_by FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  return rows[0]!.created_by;
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

/** Seed an account_profiles snapshot (idempotent). */
async function seedProfile(
  pool: pg.Pool,
  accountId: string,
  fields: {
    displayName?: string | null;
    githubLogin?: string | null;
    email?: string | null;
    avatarUrl?: string | null;
  } = {},
): Promise<void> {
  await pool.query(
    `INSERT INTO account_profiles (account_id, display_name, github_login, email, avatar_url)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (account_id) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           github_login = EXCLUDED.github_login,
           email        = EXCLUDED.email,
           avatar_url   = EXCLUDED.avatar_url`,
    [
      accountId,
      fields.displayName ?? null,
      fields.githubLogin ?? null,
      fields.email ?? null,
      fields.avatarUrl ?? null,
    ],
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

/** Whether a token id is currently revoked (revoked_at set). */
async function isRevoked(pool: pg.Pool, tokenId: string): Promise<boolean> {
  const { rows } = await pool.query<{ revoked_at: Date | null }>(
    `SELECT revoked_at FROM api_tokens WHERE id = $1`,
    [tokenId],
  );
  return rows[0]!.revoked_at !== null;
}

/** Whether (accountId, workspaceId) currently has a membership row. */
async function isMember(
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
  "Member endpoints (DB-gated)" + (!dbAvailable ? " (SKIPPED: no DB)" : ""),
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

    // --- GET /workspaces/:id/members ----------------------------------------

    it("lists all members with profile fields + role", async () => {
      const wsId = await seedWorkspace(pool, "list-ws");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      await seedMembership(pool, "acct-bob", wsId, "member");
      // bob is not the caller, so his seeded profile survives the request (the BFF
      // hook only refreshes the CALLER's profile from the request headers).
      await seedProfile(pool, "acct-bob", {
        displayName: "Bob Member",
        githubLogin: "bob",
        email: "bob@example.com",
        avatarUrl: "https://example.com/b.png",
      });

      // The caller's own profile is refreshed from the BFF headers on this request.
      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${wsId}/members`,
        headers: bffAuthHeaders("acct-admin", {
          "x-display-name": "Alice Admin",
          "x-github-login": "alice",
          "x-avatar-url": "https://example.com/a.png",
        }),
      });
      expect(res.statusCode).toBe(200);
      const body = ListMembersResponse.parse(res.json());

      expect(body.members).toHaveLength(2);
      const alice = body.members.find((m) => m.accountId === "acct-admin")!;
      expect(alice.role).toBe("admin");
      expect(alice.displayName).toBe("Alice Admin");
      expect(alice.githubLogin).toBe("alice");
      expect(alice.avatarUrl).toBe("https://example.com/a.png");
      const bob = body.members.find((m) => m.accountId === "acct-bob")!;
      expect(bob.role).toBe("member");
      expect(bob.displayName).toBe("Bob Member");
      expect(bob.githubLogin).toBe("bob");
      expect(bob.email).toBe("bob@example.com");
      expect(bob.avatarUrl).toBe("https://example.com/b.png");
    });

    it("a member (non-admin) may list the roster", async () => {
      const wsId = await seedWorkspace(pool, "list-as-member");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      await seedMembership(pool, "acct-member", wsId, "member");

      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${wsId}/members`,
        headers: bffAuthHeaders("acct-member"),
      });
      expect(res.statusCode).toBe(200);
      const body = ListMembersResponse.parse(res.json());
      expect(body.members).toHaveLength(2);
    });

    it("list is workspace-scoped: members of another workspace do not appear", async () => {
      const wsA = await seedWorkspace(pool, "scope-a");
      const wsB = await seedWorkspace(pool, "scope-b");
      await seedMembership(pool, "acct-admin", wsA, "admin");
      await seedMembership(pool, "acct-other", wsB, "member");

      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${wsA}/members`,
        headers: bffAuthHeaders("acct-admin"),
      });
      const body = ListMembersResponse.parse(res.json());
      expect(body.members.map((m) => m.accountId)).toEqual(["acct-admin"]);
    });

    // --- DELETE /workspaces/:id/members/:accountId --------------------------

    it("admin removes a member; membership gone AND that member's tokens in THIS workspace are revoked, but tokens in OTHER workspaces are untouched", async () => {
      const wsId = await seedWorkspace(pool, "remove-ws");
      const otherWs = await seedWorkspace(pool, "remove-other");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      await seedMembership(pool, "acct-victim", wsId, "member");
      await seedMembership(pool, "acct-victim", otherWs, "member");

      const tokThis = await seedToken(pool, "acct-victim", wsId, "shp_this");
      const tokOther = await seedToken(
        pool,
        "acct-victim",
        otherWs,
        "shp_other",
      );

      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}/members/acct-victim`,
        headers: bffAuthHeaders("acct-admin"),
      });
      expect(res.statusCode).toBe(200);

      expect(await isMember(pool, "acct-victim", wsId)).toBe(false);
      expect(await isRevoked(pool, tokThis)).toBe(true);
      // The token in the OTHER workspace is untouched.
      expect(await isRevoked(pool, tokOther)).toBe(false);
      // And the membership in the OTHER workspace is untouched.
      expect(await isMember(pool, "acct-victim", otherWs)).toBe(true);
    });

    it("the OWNER removing themselves is rejected (409) — owner can't be removed", async () => {
      // The lone admin here is ALSO the owner; the owner can never be removed, so
      // this is a 409 (they must transfer ownership first), with no side effects.
      const wsId = await seedWorkspace(pool, "last-admin", "acct-admin");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      await seedMembership(pool, "acct-member", wsId, "member");
      const tok = await seedToken(pool, "acct-admin", wsId, "shp_admin");

      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}/members/acct-admin`,
        headers: bffAuthHeaders("acct-admin"),
      });
      expect(res.statusCode).toBe(409);

      // No side effects: still a member, token NOT revoked.
      expect(await isMember(pool, "acct-admin", wsId)).toBe(true);
      expect(await isRevoked(pool, tok)).toBe(false);
    });

    it("the OWNER removes another admin (2+ admins) → allowed", async () => {
      // Removing an admin is owner-only; acct-admin-1 owns the workspace.
      const wsId = await seedWorkspace(pool, "two-admins", "acct-admin-1");
      await seedMembership(pool, "acct-admin-1", wsId, "admin");
      await seedMembership(pool, "acct-admin-2", wsId, "admin");

      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}/members/acct-admin-2`,
        headers: bffAuthHeaders("acct-admin-1"),
      });
      expect(res.statusCode).toBe(200);
      expect(await isMember(pool, "acct-admin-2", wsId)).toBe(false);
      expect(await isMember(pool, "acct-admin-1", wsId)).toBe(true);
    });

    it("a NON-owner admin cannot remove another admin → 403, no side effects", async () => {
      // created_by = 'tester' (no seeded account owns it), so acct-admin-1 is a
      // plain admin — removing a fellow admin is owner-only.
      const wsId = await seedWorkspace(pool, "nonowner-remove-admin");
      await seedMembership(pool, "acct-admin-1", wsId, "admin");
      await seedMembership(pool, "acct-admin-2", wsId, "admin");

      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}/members/acct-admin-2`,
        headers: bffAuthHeaders("acct-admin-1"),
      });
      expect(res.statusCode).toBe(403);
      expect(await isMember(pool, "acct-admin-2", wsId)).toBe(true);
    });

    it("the OWNER cannot be removed even by another admin → 409", async () => {
      const wsId = await seedWorkspace(pool, "protect-owner", "acct-owner");
      await seedMembership(pool, "acct-owner", wsId, "admin");
      await seedMembership(pool, "acct-admin-2", wsId, "admin");

      // acct-admin-2 is an admin but not the owner; even so, the owner is protected
      // (the owner-cannot-be-removed guard is a 409, checked before other gates).
      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}/members/acct-owner`,
        headers: bffAuthHeaders("acct-admin-2"),
      });
      expect(res.statusCode).toBe(409);
      expect(await isMember(pool, "acct-owner", wsId)).toBe(true);
    });

    it("removing an accountId that is not a member of this workspace → 404", async () => {
      const wsId = await seedWorkspace(pool, "remove-stranger");
      await seedMembership(pool, "acct-admin", wsId, "admin");

      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}/members/acct-stranger`,
        headers: bffAuthHeaders("acct-admin"),
      });
      expect(res.statusCode).toBe(404);
    });

    it("a non-admin member cannot remove another member → 403, no side effects", async () => {
      const wsId = await seedWorkspace(pool, "member-remove");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      await seedMembership(pool, "acct-member", wsId, "member");
      await seedMembership(pool, "acct-target", wsId, "member");

      const res = await app.inject({
        method: "DELETE",
        url: `/workspaces/${wsId}/members/acct-target`,
        headers: bffAuthHeaders("acct-member"),
      });
      expect(res.statusCode).toBe(403);
      expect(await isMember(pool, "acct-target", wsId)).toBe(true);
    });

    // --- POST /workspaces/:id/leave -----------------------------------------

    it("a non-last member leaves: own membership gone + own tokens revoked", async () => {
      const wsId = await seedWorkspace(pool, "leave-ws");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      await seedMembership(pool, "acct-leaver", wsId, "member");
      const tok = await seedToken(pool, "acct-leaver", wsId, "shp_leaver");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/leave`,
        headers: bffHeaders("acct-leaver"),
        payload: {},
      });
      expect(res.statusCode).toBe(200);

      expect(await isMember(pool, "acct-leaver", wsId)).toBe(false);
      expect(await isRevoked(pool, tok)).toBe(true);
      // The admin is untouched.
      expect(await isMember(pool, "acct-admin", wsId)).toBe(true);
    });

    it("the LAST admin cannot leave → 409 with NO side effects", async () => {
      const wsId = await seedWorkspace(pool, "last-admin-leave");
      await seedMembership(pool, "acct-admin", wsId, "admin");
      await seedMembership(pool, "acct-member", wsId, "member");
      const tok = await seedToken(pool, "acct-admin", wsId, "shp_lonely");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/leave`,
        headers: bffHeaders("acct-admin"),
        payload: {},
      });
      expect(res.statusCode).toBe(409);

      expect(await isMember(pool, "acct-admin", wsId)).toBe(true);
      expect(await isRevoked(pool, tok)).toBe(false);
    });

    it("an admin leaves while another admin exists → allowed", async () => {
      const wsId = await seedWorkspace(pool, "admin-leave-ok");
      await seedMembership(pool, "acct-admin-1", wsId, "admin");
      await seedMembership(pool, "acct-admin-2", wsId, "admin");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/leave`,
        headers: bffHeaders("acct-admin-1"),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(await isMember(pool, "acct-admin-1", wsId)).toBe(false);
      expect(await isMember(pool, "acct-admin-2", wsId)).toBe(true);
    });

    // --- isOwner in the roster ----------------------------------------------

    it("lists the owner with isOwner true and everyone else false", async () => {
      const wsId = await seedWorkspace(pool, "owner-roster", "acct-owner");
      await seedMembership(pool, "acct-owner", wsId, "admin");
      await seedMembership(pool, "acct-bob", wsId, "member");

      const res = await app.inject({
        method: "GET",
        url: `/workspaces/${wsId}/members`,
        headers: bffAuthHeaders("acct-bob"),
      });
      expect(res.statusCode).toBe(200);
      const body = ListMembersResponse.parse(res.json());
      expect(
        body.members.find((m) => m.accountId === "acct-owner")!.isOwner,
      ).toBe(true);
      expect(
        body.members.find((m) => m.accountId === "acct-bob")!.isOwner,
      ).toBe(false);
    });

    // --- PATCH /workspaces/:id/members/:accountId/role (owner-only) ----------

    it("the owner promotes a member to admin", async () => {
      const wsId = await seedWorkspace(pool, "promote-ws", "acct-owner");
      await seedMembership(pool, "acct-owner", wsId, "admin");
      await seedMembership(pool, "acct-member", wsId, "member");

      const res = await app.inject({
        method: "PATCH",
        url: `/workspaces/${wsId}/members/acct-member/role`,
        headers: bffHeaders("acct-owner"),
        payload: { role: "admin" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, role: "admin" });
      expect(await roleOf(pool, "acct-member", wsId)).toBe("admin");
    });

    it("the owner demotes an admin to member", async () => {
      const wsId = await seedWorkspace(pool, "demote-ws", "acct-owner");
      await seedMembership(pool, "acct-owner", wsId, "admin");
      await seedMembership(pool, "acct-admin-2", wsId, "admin");

      const res = await app.inject({
        method: "PATCH",
        url: `/workspaces/${wsId}/members/acct-admin-2/role`,
        headers: bffHeaders("acct-owner"),
        payload: { role: "member" },
      });
      expect(res.statusCode).toBe(200);
      expect(await roleOf(pool, "acct-admin-2", wsId)).toBe("member");
    });

    it("a NON-owner admin cannot change roles → 403, no change", async () => {
      const wsId = await seedWorkspace(pool, "nonowner-role"); // created_by 'tester'
      await seedMembership(pool, "acct-admin", wsId, "admin");
      await seedMembership(pool, "acct-member", wsId, "member");

      const res = await app.inject({
        method: "PATCH",
        url: `/workspaces/${wsId}/members/acct-member/role`,
        headers: bffHeaders("acct-admin"),
        payload: { role: "admin" },
      });
      expect(res.statusCode).toBe(403);
      expect(await roleOf(pool, "acct-member", wsId)).toBe("member");
    });

    it("the owner cannot change their OWN role → 409", async () => {
      const wsId = await seedWorkspace(pool, "owner-self-role", "acct-owner");
      await seedMembership(pool, "acct-owner", wsId, "admin");

      const res = await app.inject({
        method: "PATCH",
        url: `/workspaces/${wsId}/members/acct-owner/role`,
        headers: bffHeaders("acct-owner"),
        payload: { role: "member" },
      });
      expect(res.statusCode).toBe(409);
      expect(await roleOf(pool, "acct-owner", wsId)).toBe("admin");
    });

    it("changing the role of a non-member → 404", async () => {
      const wsId = await seedWorkspace(pool, "role-stranger", "acct-owner");
      await seedMembership(pool, "acct-owner", wsId, "admin");

      const res = await app.inject({
        method: "PATCH",
        url: `/workspaces/${wsId}/members/acct-stranger/role`,
        headers: bffHeaders("acct-owner"),
        payload: { role: "admin" },
      });
      expect(res.statusCode).toBe(404);
    });

    // --- POST /workspaces/:id/transfer-ownership (owner-only) ----------------

    it("the owner transfers ownership: created_by moves and the target becomes admin", async () => {
      const wsId = await seedWorkspace(pool, "transfer-ws", "acct-owner");
      await seedMembership(pool, "acct-owner", wsId, "admin");
      await seedMembership(pool, "acct-next", wsId, "member");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/transfer-ownership`,
        headers: bffHeaders("acct-owner"),
        payload: { accountId: "acct-next" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
      expect(await ownerOf(pool, wsId)).toBe("acct-next");
      // The new owner is promoted to admin; the former owner stays an admin.
      expect(await roleOf(pool, "acct-next", wsId)).toBe("admin");
      expect(await roleOf(pool, "acct-owner", wsId)).toBe("admin");
    });

    it("a NON-owner cannot transfer ownership → 403, no change", async () => {
      const wsId = await seedWorkspace(
        pool,
        "transfer-forbidden",
        "acct-owner",
      );
      await seedMembership(pool, "acct-owner", wsId, "admin");
      await seedMembership(pool, "acct-admin-2", wsId, "admin");
      await seedMembership(pool, "acct-member", wsId, "member");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/transfer-ownership`,
        headers: bffHeaders("acct-admin-2"),
        payload: { accountId: "acct-member" },
      });
      expect(res.statusCode).toBe(403);
      expect(await ownerOf(pool, wsId)).toBe("acct-owner");
    });

    it("transferring ownership to a non-member → 404", async () => {
      const wsId = await seedWorkspace(pool, "transfer-stranger", "acct-owner");
      await seedMembership(pool, "acct-owner", wsId, "admin");

      const res = await app.inject({
        method: "POST",
        url: `/workspaces/${wsId}/transfer-ownership`,
        headers: bffHeaders("acct-owner"),
        payload: { accountId: "acct-stranger" },
      });
      expect(res.statusCode).toBe(404);
      expect(await ownerOf(pool, wsId)).toBe("acct-owner");
    });
  },
);
