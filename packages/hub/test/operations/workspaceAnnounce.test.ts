/**
 * Tests for packages/hub/src/operations/workspaceAnnounce.ts
 *
 * The operator-sent (admin) announcement path: no session, scoped to
 * ALLOWED_WORKSPACE, stamped with HUB_ADMIN_LABEL and from_admin=true.
 *
 * DB-gated (skipped without a Postgres connection string). Scenarios:
 *   - broadcast to a specific repo → one admin row, delivered to that repo's agents
 *   - broadcast with no repo → fans out to every repo agents have connected from
 *   - DM → resolves the target's repo; only the target receives it
 *   - unknown agent → ValidationError (→ 400)
 *   - admin rows survive the "exclude my own sends" filter (NULL from_session_id)
 *   - the sender label flows through to delivery + the landscape feed
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
import { workspaceAnnounce } from "../../src/operations/workspaceAnnounce.js";
import { workspaceLandscape } from "../../src/operations/workspaceLandscape.js";
import { join } from "../../src/operations/join.js";
import { fetchPendingAnnouncements, getSession } from "../../src/repo.js";
import { withTransaction } from "../../src/db.js";
import { ValidationError } from "../../src/errors.js";
import type { Config } from "../../src/config.js";
import type { TenantContext } from "../../src/tenant.js";

const ADMIN_LABEL = "admin@example.test";

/** The suite's seeded workspace uuid + self-host tenant, set in beforeAll. */
let workspaceId: string;
let tenant: TenantContext;

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
    HUB_ADMIN_LABEL: ADMIN_LABEL,
    ...overrides,
  };
}

/** Join a session in the test workspace, defaulting repo to org/repo. */
async function createSession(
  params: { human: string; program?: string; model?: string; repo?: string }
): Promise<{ agentName: string; sessionId: string }> {
  return join(
    {
      workspace: "test-ws",
      repo: params.repo ?? "org/repo",
      branch: "main",
      human: params.human,
      program: params.program ?? "claude",
      model: params.model ?? "claude-3-5-sonnet",
    },
    tenant
  );
}

async function pendingFor(pool: pg.Pool, sessionId: string) {
  const session = await getSession(pool, workspaceId, sessionId);
  return withTransaction(pool, (tx) => fetchPendingAnnouncements(tx, session));
}

describe.skipIf(!dbAvailable)(
  "workspaceAnnounce – DB tests" +
    (!dbAvailable ? " (SKIPPED: no DB configured)" : ""),
  () => {
    let pool: pg.Pool;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        ["test-ws", "test-ws"]
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

    it("broadcast to a specific repo: one admin row delivered to that repo's agents", async () => {
      // Join with a non-canonical repo spelling; `join` canonicalizes the
      // session to the bare name ("repo"), and the operation canonicalizes the
      // broadcast repo the same way, so they converge.
      const receiver = await createSession({ human: "Bob", repo: "org/repo" });

      const res = await workspaceAnnounce({
        body: "Standup in 5 minutes",
        repo: "org/repo",
      }, tenant);

      expect(res.ok).toBe(true);
      expect(res.announcementIds).toHaveLength(1);

      // Stored as an admin row with the configured label, NULL session, and the
      // canonicalized repo bucket.
      const { rows } = await pool.query<{
        from_admin: boolean;
        from_label: string | null;
        from_session_id: string | null;
        target_agent_name: string | null;
        repo: string;
      }>(
        `SELECT from_admin, from_label, from_session_id, target_agent_name, repo
         FROM announcements WHERE id = $1`,
        [res.announcementIds[0]]
      );
      expect(rows[0]!.from_admin).toBe(true);
      expect(rows[0]!.from_label).toBe(ADMIN_LABEL);
      expect(rows[0]!.from_session_id).toBeNull();
      expect(rows[0]!.target_agent_name).toBeNull();
      expect(rows[0]!.repo).toBe("repo");

      // The agent receives it, attributed to the admin label.
      const pending = await pendingFor(pool, receiver.sessionId);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.body).toBe("Standup in 5 minutes");
      expect(pending[0]!.fromAgentName).toBe(ADMIN_LABEL);
      expect(pending[0]!.fromHuman).toBe(ADMIN_LABEL);
      expect(pending[0]!.targetAgentName).toBeNull();
    });

    it("broadcast with no repo: fans out to every repo agents have connected from", async () => {
      const inA = await createSession({ human: "Bob", repo: "repo-a" });
      const inB = await createSession({ human: "Carol", repo: "repo-b" });

      const res = await workspaceAnnounce({ body: "Workspace-wide notice" }, tenant);

      // One row per distinct session repo (repo-a, repo-b).
      expect(res.announcementIds).toHaveLength(2);

      const pendingA = await pendingFor(pool, inA.sessionId);
      const pendingB = await pendingFor(pool, inB.sessionId);
      expect(pendingA).toHaveLength(1);
      expect(pendingA[0]!.body).toBe("Workspace-wide notice");
      expect(pendingB).toHaveLength(1);
      expect(pendingB[0]!.body).toBe("Workspace-wide notice");
    });

    it("DM: resolves the target's repo; only the target receives it", async () => {
      const target = await createSession({ human: "Bob", repo: "repo-a" });
      const bystander = await createSession({ human: "Carol", repo: "repo-a" });

      const res = await workspaceAnnounce({
        body: "ping just for you",
        targetAgentName: target.agentName,
      }, tenant);
      expect(res.announcementIds).toHaveLength(1);

      const targetPending = await pendingFor(pool, target.sessionId);
      expect(targetPending).toHaveLength(1);
      expect(targetPending[0]!.targetAgentName).toBe(target.agentName);
      expect(targetPending[0]!.fromAgentName).toBe(ADMIN_LABEL);

      const bystanderPending = await pendingFor(pool, bystander.sessionId);
      expect(bystanderPending).toHaveLength(0);
    });

    it("DM to an unknown agent throws ValidationError (→ 400)", async () => {
      await expect(
        workspaceAnnounce({ body: "hi", targetAgentName: "NoSuchAgent" }, tenant)
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("admin broadcast appears in the landscape feed with fromAdmin=true", async () => {
      await createSession({ human: "Bob", repo: "org/repo" });
      await workspaceAnnounce({ body: "feed me", repo: "org/repo" }, tenant);

      const landscape = await workspaceLandscape(tenant);
      const mine = landscape.announcements.find((a) => a.body === "feed me");
      expect(mine).toBeDefined();
      expect(mine!.fromAdmin).toBe(true);
      expect(mine!.fromAgentName).toBe(ADMIN_LABEL);
      expect(mine!.repo).toBe("repo"); // canonicalized
    });

    // -----------------------------------------------------------------------
    // Sender identity: an account-bearing caller is labelled with THEIR
    // profile name (so agents know which member spoke and can reply by name);
    // profile-less accounts and self-host TEAM_TOKEN keep HUB_ADMIN_LABEL.
    // -----------------------------------------------------------------------

    it("account caller with a profile: message is labelled with the member's name", async () => {
      await pool.query(
        `INSERT INTO account_profiles (account_id, display_name, github_login, email)
         VALUES ('acct-alice', 'Alice Chen', 'alicehub', 'alice@example.com')`
      );
      const accountTenant: TenantContext = {
        workspaceId,
        accountId: "acct-alice",
        role: "admin",
        via: "browser",
      };
      const receiver = await createSession({ human: "Bob", repo: "org/repo" });

      await workspaceAnnounce(
        { body: "hi from alice", repo: "org/repo" },
        accountTenant
      );

      const pending = await pendingFor(pool, receiver.sessionId);
      expect(pending).toHaveLength(1);
      expect(pending[0]!.fromAgentName).toBe("Alice Chen");
      expect(pending[0]!.fromHuman).toBe("Alice Chen");

      const landscape = await workspaceLandscape(tenant);
      const mine = landscape.announcements.find((a) => a.body === "hi from alice");
      expect(mine!.fromAgentName).toBe("Alice Chen");
      expect(mine!.fromAdmin).toBe(true);
    });

    it("account caller with NO profile: falls back to HUB_ADMIN_LABEL", async () => {
      const accountTenant: TenantContext = {
        workspaceId,
        accountId: "acct-ghost",
        role: "admin",
        via: "browser",
      };
      const receiver = await createSession({ human: "Bob", repo: "org/repo" });

      await workspaceAnnounce(
        { body: "anonymous admin", repo: "org/repo" },
        accountTenant
      );

      const pending = await pendingFor(pool, receiver.sessionId);
      expect(pending[0]!.fromAgentName).toBe(ADMIN_LABEL);
    });
  }
);
