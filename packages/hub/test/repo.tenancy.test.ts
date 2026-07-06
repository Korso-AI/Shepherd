/**
 * Tenancy CRUD data-access suite (Task 3.1).
 *
 * Exercises the workspace / membership / api_token / invite functions added to
 * repo.ts, with a hard focus on the cross-tenant scoping invariants: every
 * mutating/reading function that is workspace-scoped must refuse to touch
 * another tenant's rows. Also covers the atomic invite-use guard, the
 * last-admin count, and ON CONFLICT idempotency.
 *
 * DB-gated: skips entirely when no TEST_DATABASE_URL/DATABASE_URL is set.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import pg from "pg";

import {
  dbAvailable,
  createTestPool,
  runTestMigrations,
  truncateAll,
  truncateTenancy,
} from "./setup.js";

import {
  createWorkspace,
  addMembership,
  listWorkspacesForAccount,
  countWorkspacesCreatedBy,
  insertApiToken,
  findApiTokenByHash,
  listApiTokens,
  revokeApiToken,
  revokeOwnApiToken,
  revokeApiTokensForMember,
  createInvite,
  findInviteByCode,
  incrementInviteUse,
  revokeInvite,
  revokeInviteByCode,
  listMembers,
  removeMembership,
  countAdmins,
  setRole,
  slugifyWorkspaceName,
  createAgent,
  createSession,
  getSessionById,
} from "../src/repo.js";

import { hashToken } from "../src/tenant.js";
import { withTransaction } from "../src/db.js";

describe.skipIf(!dbAvailable)("repo tenancy CRUD (Task 3.1)", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
  });

  // Truncate AFTER each test (the established convention — see tenant.test.ts):
  // coordination tables first (FK children of workspaces), then the tenancy
  // tables this suite owns. Truncating in `afterEach` rather than `beforeEach`
  // avoids racing a just-finished test's pooled connection, which can deadlock
  // a TRUNCATE (ACCESS EXCLUSIVE) against an in-flight statement.
  afterEach(async () => {
    await truncateAll(pool);
    await truncateTenancy(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  // -------------------------------------------------------------------------
  // Workspace + membership
  // -------------------------------------------------------------------------

  describe("createWorkspace / addMembership / listWorkspacesForAccount", () => {
    it("creates a workspace and returns its row", async () => {
      const ws = await createWorkspace(pool, {
        slug: "acme",
        name: "Acme",
        createdBy: "acct-1",
      });
      expect(ws.id).toMatch(/[0-9a-f-]{36}/);
      expect(ws.slug).toBe("acme");
      expect(ws.name).toBe("Acme");
      expect(ws.createdBy).toBe("acct-1");
    });

    it("lists only the workspaces the account is a member of, with its role", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      const b = await createWorkspace(pool, { slug: "b", name: "B", createdBy: "acct-2" });
      // acct-1 is admin of A, member of B; acct-2 admin of B only.
      await addMembership(pool, { workspaceId: a.id, accountId: "acct-1", role: "admin" });
      await addMembership(pool, { workspaceId: b.id, accountId: "acct-2", role: "admin" });
      await addMembership(pool, { workspaceId: b.id, accountId: "acct-1", role: "member" });

      const mine = await listWorkspacesForAccount(pool, "acct-1");
      const bySlug = Object.fromEntries(mine.map((w) => [w.slug, w]));
      expect(Object.keys(bySlug).sort()).toEqual(["a", "b"]);
      expect(bySlug["a"]!.role).toBe("admin");
      expect(bySlug["b"]!.role).toBe("member");
      // isOwner is derived from created_by: acct-1 created "a" (owner) but only
      // joined "b" (not owner).
      expect(bySlug["a"]!.isOwner).toBe(true);
      expect(bySlug["b"]!.isOwner).toBe(false);
      // The WorkspaceSummary shape (id/slug/name/role).
      expect(bySlug["a"]).toMatchObject({ id: a.id, slug: "a", name: "A", role: "admin" });
    });

    it("addMembership is idempotent on (workspace_id, account_id) — re-add updates role", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      await addMembership(pool, { workspaceId: a.id, accountId: "acct-1", role: "member" });
      // Re-adding the same pair must not throw on the unique/PK constraint.
      await addMembership(pool, { workspaceId: a.id, accountId: "acct-1", role: "admin" });
      const mine = await listWorkspacesForAccount(pool, "acct-1");
      expect(mine).toHaveLength(1);
      expect(mine[0]!.role).toBe("admin");
    });

    it("countWorkspacesCreatedBy counts only workspaces this account created", async () => {
      await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      await createWorkspace(pool, { slug: "b", name: "B", createdBy: "acct-1" });
      await createWorkspace(pool, { slug: "c", name: "C", createdBy: "acct-2" });
      expect(await countWorkspacesCreatedBy(pool, "acct-1")).toBe(2);
      expect(await countWorkspacesCreatedBy(pool, "acct-2")).toBe(1);
      expect(await countWorkspacesCreatedBy(pool, "nobody")).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // API tokens
  // -------------------------------------------------------------------------

  describe("api tokens", () => {
    it("inserts a token storing only its hash, and lists it WITHOUT the hash", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      const hash = hashToken("shp_secret");
      const summary = await insertApiToken(pool, {
        workspaceId: a.id,
        accountId: "acct-1",
        tokenHash: hash,
        name: "ci",
      });
      expect(summary.id).toMatch(/[0-9a-f-]{36}/);
      expect(summary.name).toBe("ci");
      expect(summary.revokedAt).toBeNull();

      const listed = await listApiTokens(pool, a.id);
      expect(listed).toHaveLength(1);
      // The listing surface must never carry the hash or plaintext.
      expect(JSON.stringify(listed[0])).not.toContain(hash);
      expect(listed[0]).toMatchObject({ id: summary.id, name: "ci", revokedAt: null });
      // ISO-string timestamps.
      expect(typeof listed[0]!.createdAt).toBe("string");
    });

    it("persists an ACCOUNT-SCOPED (workspace_id NULL) token and reads it back as workspace_id: null", async () => {
      // An account-scoped token is not bound to any workspace (migration 015
      // dropped the NOT NULL on api_tokens.workspace_id). It must insert cleanly
      // and round-trip through findApiTokenByHash with a null workspace_id.
      const hash = hashToken("shp_account_scoped");
      const summary = await insertApiToken(pool, {
        workspaceId: null,
        accountId: "acct-1",
        tokenHash: hash,
        name: "account-scoped",
      });
      expect(summary.id).toMatch(/[0-9a-f-]{36}/);
      expect(summary.revokedAt).toBeNull();

      const found = await findApiTokenByHash(pool, hash);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(summary.id);
      expect(found!.account_id).toBe("acct-1");
      expect(found!.workspace_id).toBeNull();
    });

    it("still persists a WORKSPACE-LOCKED token and reads back the concrete workspace_id (legacy path)", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      const hash = hashToken("shp_workspace_locked");
      const summary = await insertApiToken(pool, {
        workspaceId: a.id,
        accountId: "acct-1",
        tokenHash: hash,
        name: "workspace-locked",
      });

      const found = await findApiTokenByHash(pool, hash);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(summary.id);
      expect(found!.account_id).toBe("acct-1");
      expect(found!.workspace_id).toBe(a.id);
    });

    it("listApiTokens is scoped to the workspace (no cross-tenant leak)", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      const b = await createWorkspace(pool, { slug: "b", name: "B", createdBy: "acct-2" });
      await insertApiToken(pool, { workspaceId: a.id, accountId: "acct-1", tokenHash: hashToken("t-a"), name: "a" });
      await insertApiToken(pool, { workspaceId: b.id, accountId: "acct-2", tokenHash: hashToken("t-b"), name: "b" });
      const listedA = await listApiTokens(pool, a.id);
      expect(listedA).toHaveLength(1);
      expect(listedA[0]!.name).toBe("a");
    });

    it("revokeApiToken is workspace-scoped: cannot revoke another tenant's token", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      const b = await createWorkspace(pool, { slug: "b", name: "B", createdBy: "acct-2" });
      const tokB = await insertApiToken(pool, { workspaceId: b.id, accountId: "acct-2", tokenHash: hashToken("t-b"), name: "b" });

      // Workspace A tries to revoke B's token → no row affected, token stays live.
      const revokedCross = await revokeApiToken(pool, a.id, tokB.id);
      expect(revokedCross).toBe(false);
      const stillLive = await listApiTokens(pool, b.id);
      expect(stillLive[0]!.revokedAt).toBeNull();

      // The owning workspace can revoke it.
      const revokedOwn = await revokeApiToken(pool, b.id, tokB.id);
      expect(revokedOwn).toBe(true);
      // listApiTokens hides revoked tokens (P3.3), so the revoked token drops out
      // of the active listing; confirm via a direct read that revoked_at was set.
      const afterRevoke = await listApiTokens(pool, b.id);
      expect(afterRevoke).toHaveLength(0);
      const { rows } = await pool.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM api_tokens WHERE id = $1`,
        [tokB.id]
      );
      expect(rows[0]!.revoked_at).not.toBeNull();
    });

    it("revokeOwnApiToken is account-scoped: a member cannot revoke another member's token in the SAME workspace", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      // Two members of the SAME workspace, each with a token.
      const tokAlice = await insertApiToken(pool, { workspaceId: a.id, accountId: "acct-alice", tokenHash: hashToken("t-alice"), name: "alice" });
      const tokBob = await insertApiToken(pool, { workspaceId: a.id, accountId: "acct-bob", tokenHash: hashToken("t-bob"), name: "bob" });

      // Alice tries to revoke Bob's token → account_id guard rejects (no row).
      const cross = await revokeOwnApiToken(pool, "acct-alice", tokBob.id);
      expect(cross).toBe(false);
      const byName1 = Object.fromEntries((await listApiTokens(pool, a.id)).map((t) => [t.name, t]));
      expect(byName1["bob"]!.revokedAt).toBeNull();

      // Alice CAN revoke her own token.
      const own = await revokeOwnApiToken(pool, "acct-alice", tokAlice.id);
      expect(own).toBe(true);
      // Revoked tokens drop out of the active listing (P3.3): alice's is gone, bob's remains.
      const byName2 = Object.fromEntries((await listApiTokens(pool, a.id)).map((t) => [t.name, t]));
      expect(byName2["alice"]).toBeUndefined();
      expect(byName2["bob"]).toBeDefined();
      const aliceRow = await pool.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM api_tokens WHERE id = $1`,
        [tokAlice.id]
      );
      expect(aliceRow.rows[0]!.revoked_at).not.toBeNull();

      // Idempotent: a second revoke of the already-revoked token affects no row.
      const again = await revokeOwnApiToken(pool, "acct-alice", tokAlice.id);
      expect(again).toBe(false);
    });

    it("revokeOwnApiToken revokes an ACCOUNT-scoped (workspace_id NULL) token by account ownership", async () => {
      // An account-scoped token (migration 015) is not locked to any workspace, so
      // ownership must key on account_id alone — a workspace predicate would make it
      // unrevocable. Confirm the owner can revoke it and a different account cannot.
      const tok = await insertApiToken(pool, {
        workspaceId: null,
        accountId: "acct-alice",
        tokenHash: hashToken("acct-scoped"),
        name: "account-wide",
      });

      const byOther = await revokeOwnApiToken(pool, "acct-bob", tok.id);
      expect(byOther).toBe(false);

      const byOwner = await revokeOwnApiToken(pool, "acct-alice", tok.id);
      expect(byOwner).toBe(true);

      const { rows } = await pool.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM api_tokens WHERE id = $1`,
        [tok.id]
      );
      expect(rows[0]!.revoked_at).not.toBeNull();
    });

    it("revokeApiTokensForMember revokes that member's live tokens in the workspace and returns the count", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      await insertApiToken(pool, { workspaceId: a.id, accountId: "acct-1", tokenHash: hashToken("t1"), name: "t1" });
      await insertApiToken(pool, { workspaceId: a.id, accountId: "acct-1", tokenHash: hashToken("t2"), name: "t2" });
      await insertApiToken(pool, { workspaceId: a.id, accountId: "acct-2", tokenHash: hashToken("t3"), name: "t3" });

      const count = await revokeApiTokensForMember(pool, a.id, "acct-1");
      expect(count).toBe(2);
      // Revoked tokens (t1, t2) drop out of the active listing (P3.3); t3 (acct-2) stays.
      const listed = await listApiTokens(pool, a.id);
      const byName = Object.fromEntries(listed.map((t) => [t.name, t]));
      expect(byName["t1"]).toBeUndefined();
      expect(byName["t2"]).toBeUndefined();
      expect(byName["t3"]).toBeDefined();
      expect(byName["t3"]!.revokedAt).toBeNull();
      // Confirm t1/t2 were actually revoked (not merely hidden).
      const { rows } = await pool.query<{ revoked_at: Date | null }>(
        `SELECT revoked_at FROM api_tokens WHERE workspace_id = $1 AND account_id = 'acct-1'`,
        [a.id]
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Invites
  // -------------------------------------------------------------------------

  describe("invites", () => {
    it("creates an invite and finds it by code", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      const inv = await createInvite(pool, {
        workspaceId: a.id,
        code: "CODE-1",
        createdBy: "acct-1",
        roleGranted: "member",
        maxUses: 3,
        expiresAt: null,
      });
      expect(inv.code).toBe("CODE-1");
      expect(inv.roleGranted).toBe("member");
      expect(inv.maxUses).toBe(3);
      expect(inv.useCount).toBe(0);

      const found = await findInviteByCode(pool, "CODE-1");
      expect(found).not.toBeNull();
      expect(found!.workspaceId).toBe(a.id);
      expect(await findInviteByCode(pool, "nope")).toBeNull();
    });

    it("incrementInviteUse refuses once max_uses is reached (atomic guard)", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      const inv = await createInvite(pool, {
        workspaceId: a.id,
        code: "CODE-2",
        createdBy: "acct-1",
        roleGranted: "member",
        maxUses: 2,
        expiresAt: null,
      });

      const first = await incrementInviteUse(pool, inv.code);
      expect(first).not.toBeNull();
      expect(first!.useCount).toBe(1);

      const second = await incrementInviteUse(pool, inv.code);
      expect(second).not.toBeNull();
      expect(second!.useCount).toBe(2);

      // Third must fail (max reached) — returns null, count unchanged.
      const third = await incrementInviteUse(pool, inv.code);
      expect(third).toBeNull();
      const after = await findInviteByCode(pool, inv.code);
      expect(after!.useCount).toBe(2);
    });

    it("incrementInviteUse refuses an EXPIRED invite atomically (use_count unchanged)", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      // expires_at in the past — the atomic guard must refuse the claim.
      const inv = await createInvite(pool, {
        workspaceId: a.id,
        code: "CODE-EXP",
        createdBy: "acct-1",
        roleGranted: "member",
        maxUses: 5,
        expiresAt: new Date(Date.now() - 60_000),
      });
      expect(inv.expiresAt).not.toBeNull();

      const claim = await incrementInviteUse(pool, inv.code);
      expect(claim).toBeNull();
      // use_count must not have advanced.
      const { rows } = await pool.query<{ use_count: number }>(
        `SELECT use_count FROM invites WHERE code = $1`,
        [inv.code]
      );
      expect(rows[0]!.use_count).toBe(0);
    });

    it("incrementInviteUse claims a not-yet-expired invite (expires_at in the future)", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      const inv = await createInvite(pool, {
        workspaceId: a.id,
        code: "CODE-FUT",
        createdBy: "acct-1",
        roleGranted: "member",
        maxUses: 5,
        expiresAt: new Date(Date.now() + 60 * 60_000),
      });
      const claim = await incrementInviteUse(pool, inv.code);
      expect(claim).not.toBeNull();
      expect(claim!.useCount).toBe(1);
    });

    it("revokeInvite is workspace-scoped: cannot revoke another tenant's invite", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      const b = await createWorkspace(pool, { slug: "b", name: "B", createdBy: "acct-2" });
      const invB = await createInvite(pool, {
        workspaceId: b.id,
        code: "CODE-B",
        createdBy: "acct-2",
        roleGranted: "member",
        maxUses: 5,
        expiresAt: null,
      });

      const cross = await revokeInvite(pool, a.id, invB.id);
      expect(cross).toBe(false);

      const own = await revokeInvite(pool, b.id, invB.id);
      expect(own).toBe(true);
    });

    it("revokeInviteByCode is workspace-scoped: another tenant's code matches zero rows", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      const b = await createWorkspace(pool, { slug: "b", name: "B", createdBy: "acct-2" });
      await createInvite(pool, {
        workspaceId: b.id,
        code: "BYCODE-B",
        createdBy: "acct-2",
        roleGranted: "member",
        maxUses: 5,
        expiresAt: null,
      });

      // A's workspace cannot revoke B's code.
      expect(await revokeInviteByCode(pool, a.id, "BYCODE-B")).toBe(false);
      // The code is still live in B.
      expect(await findInviteByCode(pool, "BYCODE-B")).not.toBeNull();

      // B's workspace revokes it; a second call is idempotent (zero rows → false).
      expect(await revokeInviteByCode(pool, b.id, "BYCODE-B")).toBe(true);
      expect(await revokeInviteByCode(pool, b.id, "BYCODE-B")).toBe(false);
      expect(await findInviteByCode(pool, "BYCODE-B")).toBeNull();
    });

    it("a revoked invite is treated as not found by findInviteByCode", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      const inv = await createInvite(pool, {
        workspaceId: a.id,
        code: "CODE-R",
        createdBy: "acct-1",
        roleGranted: "member",
        maxUses: 5,
        expiresAt: null,
      });
      await revokeInvite(pool, a.id, inv.id);
      expect(await findInviteByCode(pool, "CODE-R")).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Members + role guards
  // -------------------------------------------------------------------------

  describe("members + role guards", () => {
    beforeEach(async () => {
      // account_profiles for display join.
      await pool.query(
        `INSERT INTO account_profiles (account_id, display_name, github_login, avatar_url)
         VALUES ('acct-1', 'Alice', 'alice', 'http://a/avatar.png'),
                ('acct-2', 'Bob', 'bob', NULL)
         ON CONFLICT (account_id) DO NOTHING`
      );
    });

    it("listMembers joins account_profiles for display identity and is workspace-scoped", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      const b = await createWorkspace(pool, { slug: "b", name: "B", createdBy: "acct-2" });
      await addMembership(pool, { workspaceId: a.id, accountId: "acct-1", role: "admin" });
      await addMembership(pool, { workspaceId: a.id, accountId: "acct-2", role: "member" });
      await addMembership(pool, { workspaceId: b.id, accountId: "acct-2", role: "admin" });

      const members = await listMembers(pool, a.id);
      expect(members).toHaveLength(2);
      const byAcct = Object.fromEntries(members.map((m) => [m.accountId, m]));
      expect(byAcct["acct-1"]).toMatchObject({
        displayName: "Alice",
        githubLogin: "alice",
        avatarUrl: "http://a/avatar.png",
        role: "admin",
      });
      expect(byAcct["acct-2"]!.role).toBe("member");
    });

    it("countAdmins counts admins in the workspace only", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      const b = await createWorkspace(pool, { slug: "b", name: "B", createdBy: "acct-2" });
      await addMembership(pool, { workspaceId: a.id, accountId: "acct-1", role: "admin" });
      await addMembership(pool, { workspaceId: a.id, accountId: "acct-2", role: "member" });
      await addMembership(pool, { workspaceId: b.id, accountId: "acct-2", role: "admin" });
      expect(await countAdmins(pool, a.id)).toBe(1);
      expect(await countAdmins(pool, b.id)).toBe(1);
    });

    it("setRole promotes/demotes within the workspace (scoped)", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      await addMembership(pool, { workspaceId: a.id, accountId: "acct-2", role: "member" });
      await setRole(pool, a.id, "acct-2", "admin");
      expect(await countAdmins(pool, a.id)).toBe(1);
      const found = (await listMembers(pool, a.id)).find((m) => m.accountId === "acct-2");
      expect(found!.role).toBe("admin");
    });

    it("removeMembership is workspace-scoped: cannot remove from another tenant", async () => {
      const a = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      const b = await createWorkspace(pool, { slug: "b", name: "B", createdBy: "acct-2" });
      await addMembership(pool, { workspaceId: b.id, accountId: "acct-2", role: "admin" });

      // Workspace A tries to remove acct-2 (a B member) → no row affected.
      const cross = await removeMembership(pool, a.id, "acct-2");
      expect(cross).toBe(false);
      expect(await countAdmins(pool, b.id)).toBe(1);

      const own = await removeMembership(pool, b.id, "acct-2");
      expect(own).toBe(true);
      expect(await countAdmins(pool, b.id)).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // getSessionById (Task 2.1) — the UNSCOPED session lookup
  //
  // Unlike getSession (workspace-scoped, throws), getSessionById looks a session
  // up by id ALONE and returns null when absent. It underpins resolveSession's
  // account-scoped path, where the workspace is not yet known and is READ from
  // the session before membership is checked. These tests pin the two properties
  // the caller relies on: it finds a session regardless of workspace, and it
  // returns null (never throws) for an unknown id.
  // -------------------------------------------------------------------------

  describe("getSessionById", () => {
    /** Mint an agent + session in `workspaceId`; returns the session id. */
    async function mintSession(workspaceId: string, human: string): Promise<string> {
      return withTransaction(pool, async (tx) => {
        const agent = await createAgent(tx, {
          workspaceId,
          name: `agent-${human}`,
          human,
          program: "claude",
          model: null,
        });
        const session = await createSession(tx, {
          workspaceId,
          agentId: agent.id,
          repo: "org/repo",
          branch: "main",
        });
        return session.id;
      });
    }

    it("returns the session (with agent join) by id alone, ignoring workspace", async () => {
      const ws = await createWorkspace(pool, { slug: "a", name: "A", createdBy: "acct-1" });
      const sessionId = await mintSession(ws.id, "alice");

      const session = await getSessionById(pool, sessionId);
      expect(session).not.toBeNull();
      expect(session!.id).toBe(sessionId);
      expect(session!.workspaceId).toBe(ws.id);
      expect(session!.agentName).toBe("agent-alice");
      expect(session!.human).toBe("alice");
      expect(session!.repo).toBe("org/repo");
      expect(session!.branch).toBe("main");
    });

    it("returns null for an unknown session id (never throws)", async () => {
      const missing = "00000000-0000-0000-0000-000000000000";
      expect(await getSessionById(pool, missing)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Slug helper
  // -------------------------------------------------------------------------

  describe("slugifyWorkspaceName", () => {
    it("lowercases and kebab-cases the name", () => {
      expect(slugifyWorkspaceName("Acme Corp")).toBe("acme-corp");
      expect(slugifyWorkspaceName("  Hello   World!! ")).toBe("hello-world");
      expect(slugifyWorkspaceName("Foo_Bar.Baz")).toBe("foo-bar-baz");
    });
  });
});
