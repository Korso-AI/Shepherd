/**
 * Tests for packages/hub/src/operations/announce.ts
 *
 * DB-dependent tests are gated on `dbAvailable` and skipped when no Postgres
 * connection string is configured.
 *
 * Scenarios:
 *   - Happy (broadcast): announce with no targetAgentName → NULL target;
 *     appears in every OTHER session's pending announcements.
 *   - Happy (targeted): announce targeting a specific agent name → appears
 *     only in that agent's sessions' pending, not others'.
 *   - Edge: the announcing session does NOT receive its own announcement back.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  runTestMigrations,
  truncateAll,
} from "../setup.js";
import { initContext, resetContext } from "../../src/context.js";
import { announce } from "../../src/operations/announce.js";
import { join } from "../../src/operations/join.js";
import {
  fetchPendingAnnouncements,
  getSession,
  getWorkspaceLandscape,
  addMembership,
  createAgent,
  createSession as createSessionRow,
} from "../../src/repo.js";
import { withContext } from "../../src/scopedDb.js";
import { UnknownSessionError } from "../../src/errors.js";
import type { Config } from "../../src/config.js";
import { NO_ROUTE_WORKSPACE, type TenantContext } from "../../src/tenant.js";

/** The suite's seeded workspace uuid + self-host tenant, set in beforeAll. */
let workspaceId: string;
let tenant: TenantContext;

// ---------------------------------------------------------------------------
// Shared test config factory
// ---------------------------------------------------------------------------

function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_URL: "postgres://localhost/test",
    TEAM_TOKEN: "test-token",
    HUB_PORT: 8080,
    ALLOWED_WORKSPACE: "test-ws",
    DEFAULT_TTL_SECONDS: 1800,
    MIN_TTL_SECONDS: 30,
    STALE_AFTER_SECONDS: 120,
    CHANGE_RECORD_TTL_SECONDS: 604800,
    HUB_ADMIN_LABEL: "admin",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Join helper: create a session in the test workspace. */
async function createSession(
  params: { human: string; program: string; model: string } = {
    human: "Alex",
    program: "claude",
    model: "claude-3-5-sonnet",
  },
): Promise<{ agentName: string; sessionId: string }> {
  return join(
    {
      workspace: "test-ws",
      repo: "org/repo",
      branch: "main",
      ...params,
    },
    tenant,
  );
}

// ---------------------------------------------------------------------------
// DB-gated suite
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "announce – DB tests" + (!dbAvailable ? " (SKIPPED: no DB configured)" : ""),
  () => {
    let pool: pg.Pool;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        ["test-ws", "test-ws"],
      );
      workspaceId = rows[0]!.id;
      tenant = { workspaceId };
      initContext({ pool, config: makeTestConfig() });
    });

    afterEach(async () => {
      await truncateAll(pool);
    });

    afterAll(async () => {
      resetContext();
      await pool.end();
    });

    // -----------------------------------------------------------------------
    // Happy path: broadcast
    // -----------------------------------------------------------------------

    it("broadcast: inserts announcement with NULL target_agent_name", async () => {
      const sender = await createSession({
        human: "Alex",
        program: "claude",
        model: "claude-3-5-sonnet",
      });

      const result = await announce(
        {
          sessionId: sender.sessionId,
          body: "Hello everyone!",
          // No targetAgentName → broadcast
        },
        tenant,
      );

      expect(result.ok).toBe(true);
      expect(typeof result.announcementId).toBe("number");
      expect(result.announcementId).toBeGreaterThan(0);

      // Verify the row has NULL target_agent_name in the DB.
      const { rows } = await pool.query<{ target_agent_name: string | null }>(
        `SELECT target_agent_name FROM announcements WHERE id = $1`,
        [result.announcementId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.target_agent_name).toBeNull();
    });

    it("broadcast: appears in every OTHER session's pending announcements", async () => {
      // Sender
      const sender = await createSession({
        human: "Alex",
        program: "claude",
        model: "claude-3-5-sonnet",
      });

      // Two other agents (different identities to force distinct agents)
      const receiver1 = await createSession({
        human: "Bob",
        program: "claude",
        model: "claude-3-5-sonnet",
      });
      const receiver2 = await createSession({
        human: "Carol",
        program: "claude",
        model: "claude-3-5-sonnet",
      });

      const result = await announce(
        {
          sessionId: sender.sessionId,
          body: "Broadcast message",
        },
        tenant,
      );

      const now = new Date();

      // Fetch pending for receiver1
      const r1Session = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => getSession(db, workspaceId, receiver1.sessionId),
      );
      const pending1 = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => fetchPendingAnnouncements(db, r1Session),
      );
      expect(pending1).toHaveLength(1);
      expect(pending1[0]!.id).toBe(result.announcementId);
      expect(pending1[0]!.body).toBe("Broadcast message");
      expect(pending1[0]!.targetAgentName).toBeNull();

      // Fetch pending for receiver2
      const r2Session = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => getSession(db, workspaceId, receiver2.sessionId),
      );
      const pending2 = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => fetchPendingAnnouncements(db, r2Session),
      );
      expect(pending2).toHaveLength(1);
      expect(pending2[0]!.id).toBe(result.announcementId);
    });

    // -----------------------------------------------------------------------
    // Happy path: targeted
    // -----------------------------------------------------------------------

    it("targeted: appears only in the named agent's sessions' pending, not others'", async () => {
      // Sender
      const sender = await createSession({
        human: "Alex",
        program: "claude",
        model: "claude-3-5-sonnet",
      });

      // Target agent (different identity)
      const target = await createSession({
        human: "Bob",
        program: "claude",
        model: "claude-3-5-sonnet",
      });

      // Bystander agent (should NOT receive the targeted announcement)
      const bystander = await createSession({
        human: "Carol",
        program: "claude",
        model: "claude-3-5-sonnet",
      });

      const result = await announce(
        {
          sessionId: sender.sessionId,
          body: "Only for Bob",
          targetAgentName: target.agentName,
        },
        tenant,
      );

      expect(result.ok).toBe(true);

      const now = new Date();

      // Target sees the announcement
      const targetSession = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => getSession(db, workspaceId, target.sessionId),
      );
      const targetPending = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => fetchPendingAnnouncements(db, targetSession),
      );
      expect(targetPending).toHaveLength(1);
      expect(targetPending[0]!.id).toBe(result.announcementId);
      expect(targetPending[0]!.targetAgentName).toBe(target.agentName);

      // Bystander does NOT see the announcement
      const bystanderSession = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => getSession(db, workspaceId, bystander.sessionId),
      );
      const bystanderPending = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => fetchPendingAnnouncements(db, bystanderSession),
      );
      expect(bystanderPending).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // Error path: a directed message to a name that is not a live agent in the
    // sender's repo is rejected (rather than silently going nowhere).
    // -----------------------------------------------------------------------

    it("targeted: rejects the bare handle (no ordinal) and lists the live agent names", async () => {
      const alex = await createSession({
        human: "Alex",
        program: "claude",
        model: "claude-3-5-sonnet",
      }); // -> alex-1
      const bob = await createSession({
        human: "Bob",
        program: "claude",
        model: "claude-3-5-sonnet",
      }); // -> bob-1

      // Alex addresses the bare handle "bob" — the real agent is "bob-1".
      const err = await announce(
        {
          sessionId: alex.sessionId,
          body: "hey bob",
          targetAgentName: "bob",
        },
        tenant,
      ).catch((e) => e as Error);

      expect(err).toBeInstanceOf(Error);
      // Names the offending target and points at the real, reachable name.
      expect(err.message).toMatch(/bob/);
      expect(err.message).toContain("bob-1");

      // Nothing was persisted — the transaction rolled back on the rejection.
      const { rows } = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM announcements`,
      );
      expect(rows[0]!.n).toBe("0");
      // The valid name still works (regression guard for the happy path).
      const ok = await announce(
        {
          sessionId: alex.sessionId,
          body: "hey bob",
          targetAgentName: bob.agentName,
        },
        tenant,
      );
      expect(ok.ok).toBe(true);
    });

    it("targeted: rejects a target with no session in the sender's repo", async () => {
      const alex = await createSession({
        human: "Alex",
        program: "claude",
        model: "claude-3-5-sonnet",
      });

      // No other agent exists; an entirely unknown name is rejected.
      await expect(
        announce(
          {
            sessionId: alex.sessionId,
            body: "anybody?",
            targetAgentName: "ghost-9",
          },
          tenant,
        ),
      ).rejects.toThrow(/ghost-9/);
    });

    // -----------------------------------------------------------------------
    // Edge: sender does NOT receive its own announcement
    // -----------------------------------------------------------------------

    it("sender does not receive its own broadcast announcement", async () => {
      const sender = await createSession({
        human: "Alex",
        program: "claude",
        model: "claude-3-5-sonnet",
      });

      await announce(
        {
          sessionId: sender.sessionId,
          body: "This is my own message",
        },
        tenant,
      );

      const now = new Date();

      // Sender's pending should be empty (from_session_id filter)
      const senderSession = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => getSession(db, workspaceId, sender.sessionId),
      );
      const senderPending = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => fetchPendingAnnouncements(db, senderSession),
      );
      expect(senderPending).toHaveLength(0);
    });

    it("sender does not receive its own targeted announcement even when targeting itself", async () => {
      const sender = await createSession({
        human: "Alex",
        program: "claude",
        model: "claude-3-5-sonnet",
      });

      await announce(
        {
          sessionId: sender.sessionId,
          body: "Targeting myself",
          targetAgentName: sender.agentName,
        },
        tenant,
      );

      const now = new Date();

      const senderSession = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => getSession(db, workspaceId, sender.sessionId),
      );
      const senderPending = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => fetchPendingAnnouncements(db, senderSession),
      );
      // from_session_id filter removes it
      expect(senderPending).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // #4: announce delivers the caller's OWN pending inbox (and marks it seen)
    // -----------------------------------------------------------------------

    it("#4: announce returns the caller's pending announcements and marks them delivered", async () => {
      const alex = await createSession({
        human: "Alex",
        program: "claude",
        model: "claude-3-5-sonnet",
      });
      const bob = await createSession({
        human: "Bob",
        program: "claude",
        model: "claude-3-5-sonnet",
      });

      // Bob broadcasts something for Alex to receive.
      const bobMsg = await announce(
        {
          sessionId: bob.sessionId,
          body: "heads up from bob",
        },
        tenant,
      );

      // Alex announces; the response carries Bob's message (delivered now),
      // and excludes Alex's own just-sent broadcast.
      const alexRes = await announce(
        {
          sessionId: alex.sessionId,
          body: "alex broadcasting",
        },
        tenant,
      );
      expect(alexRes.announcements).toHaveLength(1);
      expect(alexRes.announcements[0]!.id).toBe(bobMsg.announcementId);
      expect(alexRes.announcements[0]!.body).toBe("heads up from bob");

      // It was marked delivered: a second announce does not re-deliver it.
      const alexRes2 = await announce(
        {
          sessionId: alex.sessionId,
          body: "alex again",
        },
        tenant,
      );
      expect(alexRes2.announcements).toHaveLength(0);
    });

    // -----------------------------------------------------------------------
    // toAdmin: agent → operator reply channel (mirror of admin → agent DM)
    // -----------------------------------------------------------------------

    it("toAdmin: inserts announcement with to_admin=true and NULL target_agent_name", async () => {
      const sender = await createSession();

      const result = await announce(
        {
          sessionId: sender.sessionId,
          body: "deploy is green",
          toAdmin: true,
        },
        tenant,
      );

      expect(result.ok).toBe(true);

      const { rows } = await pool.query<{
        to_admin: boolean;
        target_agent_name: string | null;
      }>(
        `SELECT to_admin, target_agent_name FROM announcements WHERE id = $1`,
        [result.announcementId],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.to_admin).toBe(true);
      expect(rows[0]!.target_agent_name).toBeNull();
    });

    it("toAdmin: operator-directed reply is NOT delivered to other agents (leak guard)", async () => {
      const sender = await createSession({
        human: "Alex",
        program: "claude",
        model: "claude-3-5-sonnet",
      });
      const bystander = await createSession({
        human: "Bob",
        program: "claude",
        model: "claude-3-5-sonnet",
      });

      await announce(
        {
          sessionId: sender.sessionId,
          body: "for the operator only",
          toAdmin: true,
        },
        tenant,
      );

      const bystanderSession = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => getSession(db, workspaceId, bystander.sessionId),
      );
      const pending = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => fetchPendingAnnouncements(db, bystanderSession),
      );
      expect(pending).toHaveLength(0);
    });

    it("toAdmin: surfaces in the workspace landscape flagged toAdmin, fromAdmin=false", async () => {
      const sender = await createSession();

      await announce(
        {
          sessionId: sender.sessionId,
          body: "deploy is green",
          toAdmin: true,
        },
        tenant,
      );

      const now = new Date();
      const rows = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => getWorkspaceLandscape(db, workspaceId, now, 120),
      );
      const msg = rows.announcements.find((a) => a.body === "deploy is green");
      expect(msg).toBeDefined();
      expect(msg!.toAdmin).toBe(true);
      expect(msg!.fromAdmin).toBe(false);
      expect(msg!.fromAgentName).toBe(sender.agentName);
      expect(msg!.targetAgentName).toBeNull();
    });

    it("toAdmin and targetAgentName are mutually exclusive", async () => {
      const sender = await createSession();

      await expect(
        announce(
          {
            sessionId: sender.sessionId,
            body: "ambiguous",
            toAdmin: true,
            targetAgentName: "someone-1",
          },
          tenant,
        ),
      ).rejects.toThrow();
    });

    // -----------------------------------------------------------------------
    // Account-scoped credential (Task 2.2): announce resolves the session via
    // resolveSession — an account-scoped token (no route workspace) that is a
    // LIVE member of the session's workspace works; a session in a workspace the
    // account cannot see fail-closes to 404 with NO announcement written.
    // -----------------------------------------------------------------------

    it("account-scoped member: broadcast succeeds and is scoped to session.workspaceId", async () => {
      await withContext(pool, { kind: "workspace", workspaceId }, (db) =>
        addMembership(db, {
          workspaceId,
          accountId: "acct-member",
          role: "member",
        }),
      );
      const sender = await createSession();
      const accountTenant: TenantContext = {
        workspaceId: NO_ROUTE_WORKSPACE,
        accountId: "acct-member",
        via: "agent",
      };

      const result = await announce(
        { sessionId: sender.sessionId, body: "account-scoped broadcast" },
        accountTenant,
      );

      expect(result.ok).toBe(true);
      // The announcement row is scoped to the SESSION's workspace, not a route.
      const { rows } = await pool.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM announcements WHERE id = $1`,
        [result.announcementId],
      );
      expect(rows[0]!.workspace_id).toBe(workspaceId);
    });

    it("account-scoped non-member: announce on a session in a non-member workspace → 404, no announcement", async () => {
      // A second workspace the calling account is NOT a member of, with a real
      // session — resolveSession must fail-closed to UnknownSessionError (404).
      const { rows: wsRows } = await pool.query<{ id: string }>(
        `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester')
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        ["announce-other-ws", "announce-other-ws"],
      );
      const otherWs = wsRows[0]!.id;
      const otherSessionId = await withContext(
        pool,
        { kind: "workspace", workspaceId: otherWs },
        async (db) => {
          const agent = await createAgent(db, {
            workspaceId: otherWs,
            name: "outsider-agent",
            human: "outsider",
            program: "claude",
            model: null,
          });
          const session = await createSessionRow(db, {
            workspaceId: otherWs,
            agentId: agent.id,
            repo: "org/repo",
            branch: "main",
          });
          return session.id;
        },
      );
      const accountTenant: TenantContext = {
        workspaceId: NO_ROUTE_WORKSPACE,
        accountId: "acct-outsider",
        via: "agent",
      };

      await expect(
        announce(
          { sessionId: otherSessionId, body: "cross-tenant attempt" },
          accountTenant,
        ),
      ).rejects.toThrow(UnknownSessionError);

      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM announcements`,
      );
      expect(rows[0]!.n).toBe("0");
    });

    // -----------------------------------------------------------------------
    // Unified `target`: one name that resolves to a live agent, the operator
    // label (collective dashboard), or a specific workspace member.
    // -----------------------------------------------------------------------

    /** Seed a workspace member with a profile so `target` can resolve them. */
    async function addMember(
      accountId: string,
      profile: {
        displayName?: string;
        githubLogin?: string;
        email?: string;
      },
    ): Promise<void> {
      await withContext(pool, { kind: "workspace", workspaceId }, (db) =>
        addMembership(db, { workspaceId, accountId, role: "member" }),
      );
      await pool.query(
        `INSERT INTO account_profiles (account_id, display_name, github_login, email)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (account_id) DO UPDATE
           SET display_name = $2, github_login = $3, email = $4`,
        [
          accountId,
          profile.displayName ?? null,
          profile.githubLogin ?? null,
          profile.email ?? null,
        ],
      );
    }

    it("target: a live agent name resolves exactly like targetAgentName", async () => {
      const sender = await createSession({
        human: "Alex",
        program: "claude",
        model: "claude-3-5-sonnet",
      });
      const receiver = await createSession({
        human: "Bob",
        program: "claude",
        model: "claude-3-5-sonnet",
      });

      const result = await announce(
        {
          sessionId: sender.sessionId,
          body: "via unified target",
          target: receiver.agentName,
        },
        tenant,
      );

      const { rows } = await pool.query<{
        target_agent_name: string | null;
        to_admin: boolean;
        target_account_id: string | null;
      }>(
        `SELECT target_agent_name, to_admin, target_account_id
         FROM announcements WHERE id = $1`,
        [result.announcementId],
      );
      expect(rows[0]!.target_agent_name).toBe(receiver.agentName);
      expect(rows[0]!.to_admin).toBe(false);
      expect(rows[0]!.target_account_id).toBeNull();

      const receiverSession = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => getSession(db, workspaceId, receiver.sessionId),
      );
      const pending = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => fetchPendingAnnouncements(db, receiverSession),
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]!.body).toBe("via unified target");
    });

    it("target: the operator label ('admin', any case) addresses the dashboard collectively", async () => {
      const sender = await createSession();

      const result = await announce(
        {
          sessionId: sender.sessionId,
          body: "for whoever runs this",
          target: "Admin",
        },
        tenant,
      );

      const { rows } = await pool.query<{
        to_admin: boolean;
        target_agent_name: string | null;
        target_account_id: string | null;
        target_label: string | null;
      }>(
        `SELECT to_admin, target_agent_name, target_account_id, target_label
         FROM announcements WHERE id = $1`,
        [result.announcementId],
      );
      // Exactly the legacy toAdmin shape: collective, no specific member.
      expect(rows[0]!.to_admin).toBe(true);
      expect(rows[0]!.target_agent_name).toBeNull();
      expect(rows[0]!.target_account_id).toBeNull();
      expect(rows[0]!.target_label).toBeNull();
    });

    it("target: a member's display name (case-insensitive) → member-directed row + landscape name", async () => {
      await addMember("acct-alice", {
        displayName: "Alice Chen",
        githubLogin: "alicehub",
        email: "alice@example.com",
      });
      const sender = await createSession({
        human: "Alex",
        program: "claude",
        model: "claude-3-5-sonnet",
      });
      const bystander = await createSession({
        human: "Bob",
        program: "claude",
        model: "claude-3-5-sonnet",
      });

      const result = await announce(
        {
          sessionId: sender.sessionId,
          body: "review is ready for you",
          target: "alice chen",
        },
        tenant,
      );

      const { rows } = await pool.query<{
        to_admin: boolean;
        target_agent_name: string | null;
        target_account_id: string | null;
        target_label: string | null;
      }>(
        `SELECT to_admin, target_agent_name, target_account_id, target_label
         FROM announcements WHERE id = $1`,
        [result.announcementId],
      );
      expect(rows[0]!.to_admin).toBe(true); // keeps it out of agent delivery
      expect(rows[0]!.target_agent_name).toBeNull();
      expect(rows[0]!.target_account_id).toBe("acct-alice");
      expect(rows[0]!.target_label).toBe("Alice Chen");

      // Leak guard: a member-directed message reaches NO agent.
      const bystanderSession = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => getSession(db, workspaceId, bystander.sessionId),
      );
      const pending = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => fetchPendingAnnouncements(db, bystanderSession),
      );
      expect(pending).toHaveLength(0);

      // The dashboard feed shows WHO it's for.
      const landscape = await withContext(
        pool,
        { kind: "workspace", workspaceId },
        (db) => getWorkspaceLandscape(db, workspaceId, new Date(), 120),
      );
      const msg = landscape.announcements.find(
        (a) => a.body === "review is ready for you",
      );
      expect(msg).toBeDefined();
      expect(msg!.toAdmin).toBe(true);
      expect(msg!.targetMemberName).toBe("Alice Chen");
    });

    it("target: matches a member by GitHub login and by email too", async () => {
      await addMember("acct-alice", {
        displayName: "Alice Chen",
        githubLogin: "alicehub",
        email: "alice@example.com",
      });
      const sender = await createSession();

      for (const target of ["alicehub", "ALICE@example.com"]) {
        const result = await announce(
          { sessionId: sender.sessionId, body: `hi via ${target}`, target },
          tenant,
        );
        const { rows } = await pool.query<{ target_account_id: string | null }>(
          `SELECT target_account_id FROM announcements WHERE id = $1`,
          [result.announcementId],
        );
        expect(rows[0]!.target_account_id).toBe("acct-alice");
      }
    });

    it("target: a live agent shadows a member with the same name (agent wins)", async () => {
      const sender = await createSession({
        human: "Alex",
        program: "claude",
        model: "claude-3-5-sonnet",
      });
      const agent = await createSession({
        human: "Bob",
        program: "claude",
        model: "claude-3-5-sonnet",
      });
      await addMember("acct-shadow", { displayName: agent.agentName });

      const result = await announce(
        {
          sessionId: sender.sessionId,
          body: "who gets this?",
          target: agent.agentName,
        },
        tenant,
      );

      const { rows } = await pool.query<{
        target_agent_name: string | null;
        to_admin: boolean;
      }>(
        `SELECT target_agent_name, to_admin FROM announcements WHERE id = $1`,
        [result.announcementId],
      );
      expect(rows[0]!.target_agent_name).toBe(agent.agentName);
      expect(rows[0]!.to_admin).toBe(false);
    });

    it("target: no live agent, no member → 400 listing BOTH sets, nothing persisted", async () => {
      await addMember("acct-alice", { displayName: "Alice Chen" });
      const sender = await createSession({
        human: "Alex",
        program: "claude",
        model: "claude-3-5-sonnet",
      });
      const other = await createSession({
        human: "Bob",
        program: "claude",
        model: "claude-3-5-sonnet",
      });

      const err = await announce(
        {
          sessionId: sender.sessionId,
          body: "hello?",
          target: "nobody-in-particular",
        },
        tenant,
      ).catch((e) => e as Error);

      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toContain("nobody-in-particular");
      expect((err as Error).message).toContain(other.agentName); // live agents listed
      expect((err as Error).message).toContain("Alice Chen"); // members listed

      const { rows } = await pool.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM announcements`,
      );
      expect(rows[0]!.n).toBe("0");
    });

    it("target: an ambiguous member name → 400 asking to disambiguate", async () => {
      await addMember("acct-a1", {
        displayName: "Alice",
        githubLogin: "alice-one",
      });
      await addMember("acct-a2", {
        displayName: "Alice",
        githubLogin: "alice-two",
      });
      const sender = await createSession();

      await expect(
        announce(
          {
            sessionId: sender.sessionId,
            body: "which alice?",
            target: "alice",
          },
          tenant,
        ),
      ).rejects.toThrow(/2 workspace members/);

      // The unique identifier still works.
      const ok = await announce(
        {
          sessionId: sender.sessionId,
          body: "that alice",
          target: "alice-two",
        },
        tenant,
      );
      const { rows } = await pool.query<{ target_account_id: string | null }>(
        `SELECT target_account_id FROM announcements WHERE id = $1`,
        [ok.announcementId],
      );
      expect(rows[0]!.target_account_id).toBe("acct-a2");
    });

    it("target: cannot be combined with the legacy fields", async () => {
      const sender = await createSession();

      await expect(
        announce(
          {
            sessionId: sender.sessionId,
            body: "ambiguous",
            target: "someone",
            targetAgentName: "someone-1",
          },
          tenant,
        ),
      ).rejects.toThrow(/target replaces/);

      await expect(
        announce(
          {
            sessionId: sender.sessionId,
            body: "ambiguous",
            target: "someone",
            toAdmin: true,
          },
          tenant,
        ),
      ).rejects.toThrow(/target replaces/);
    });
  },
);
