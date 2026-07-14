/**
 * resolveSession — membership-gated session scope (Task 2.1).
 *
 * This is the per-request tenancy gate the six coordination operations will
 * route through (Task 2.2): given a tenant and a body `sessionId`, it returns
 * the authorized session for BOTH credential kinds, or throws
 * UnknownSessionError (→ 404). The suite's focus is the CROSS-TENANT ISOLATION
 * invariant — the property AGENTS.md forbids regressing — proven directly at the
 * helper (below the HTTP layer that isolation.test.ts covers):
 *
 *   - Account-scoped MEMBER: resolves the session in its own workspace.
 *   - Account-scoped NON-member: a session in a workspace the account cannot see
 *     throws the SAME error as an unknown session — NO existence disclosure.
 *   - Legacy/self-host (concrete workspaceId): a session in ANOTHER workspace
 *     404s via getSession's workspace_id predicate — today's gate, unchanged.
 *   - Unknown session id (either kind) → 404.
 *
 * DB-gated: skips entirely when no TEST_DATABASE_URL/DATABASE_URL is set.
 */

import { describe, it, expect, beforeAll, afterEach, afterAll } from "vitest";
import pg from "pg";

import {
  dbAvailable,
  createTestPool,
  createAppPool,
  runTestMigrations,
  truncateAll,
  truncateTenancy,
} from "../setup.js";
import {
  createWorkspace,
  addMembership,
  createAgent,
  createSession,
} from "../../src/repo.js";
import { withContext } from "../../src/scopedDb.js";
import { resolveSession } from "../../src/sessionScope.js";
import { NO_ROUTE_WORKSPACE, contextForTenant } from "../../src/tenant.js";
import type { TenantContext } from "../../src/tenant.js";
import { UnknownSessionError } from "../../src/errors.js";

const UNKNOWN_ID = "00000000-0000-0000-0000-000000000000";

describe.skipIf(!dbAvailable)(
  "resolveSession (session scope, Task 2.1)",
  () => {
    // Owner pool: fixture seeding (mintSession, createWorkspace, addMembership)
    // and truncates. Restricted app-role pool: the resolveSession-under-test.
    let pool: pg.Pool;
    let appPool: pg.Pool;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      appPool = createAppPool();
    });

    afterEach(async () => {
      await truncateAll(pool);
      await truncateTenancy(pool);
    });

    afterAll(async () => {
      await appPool.end();
      await pool.end();
    });

    /** Mint an agent + session in `workspaceId`; returns the session id. */
    async function mintSession(
      workspaceId: string,
      human: string,
    ): Promise<string> {
      return withContext(
        pool,
        { kind: "workspace", workspaceId },
        async (tx) => {
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
        },
      );
    }

    /** Run resolveSession inside a transaction (its real call context). */
    async function resolve(
      tenant: TenantContext,
      sessionId: string,
    ): Promise<Awaited<ReturnType<typeof resolveSession>>> {
      return withContext(appPool, contextForTenant(tenant), (tx) =>
        resolveSession(tx, tenant, sessionId),
      );
    }

    const accountTenant = (accountId: string): TenantContext => ({
      workspaceId: NO_ROUTE_WORKSPACE,
      accountId,
      via: "agent",
    });

    it("account-scoped MEMBER resolves a session in its workspace", async () => {
      const w = await withContext(
        pool,
        { kind: "account", accountId: "acct-a" },
        (db) =>
          createWorkspace(db, {
            slug: "w",
            name: "W",
            createdBy: "acct-a",
          }),
      );
      await withContext(
        pool,
        { kind: "account", accountId: "acct-a", workspaceId: w.id },
        (db) =>
          addMembership(db, {
            workspaceId: w.id,
            accountId: "acct-a",
            role: "member",
          }),
      );
      const sessionId = await mintSession(w.id, "alice");

      const session = await resolve(accountTenant("acct-a"), sessionId);
      expect(session.id).toBe(sessionId);
      expect(session.workspaceId).toBe(w.id);
      expect(session.agentName).toBe("agent-alice");
    });

    it("adoption re-points the LIVE transaction to the session's workspace triple", async () => {
      const w = await withContext(
        pool,
        { kind: "account", accountId: "acct-a" },
        (db) =>
          createWorkspace(db, { slug: "w", name: "W", createdBy: "acct-a" }),
      );
      await withContext(
        pool,
        { kind: "account", accountId: "acct-a", workspaceId: w.id },
        (db) =>
          addMembership(db, {
            workspaceId: w.id,
            accountId: "acct-a",
            role: "member",
          }),
      );
      const sessionId = await mintSession(w.id, "alice");
      const tenant = accountTenant("acct-a");

      // Probe the GUCs ON THE SAME TRANSACTION resolveSession ran in: the
      // operation's writes execute right here, so THIS triple — not the
      // primitive's unit-tested mapping — is what the Phase 2 policies will
      // see. Pins that adoption lands the SESSION's workspace id plus the
      // caller's account (a stale/swapped variable would pass every
      // behavioral test today, GUCs being inert, and surface only as Phase 2
      // zero-row no-ops).
      await withContext(appPool, contextForTenant(tenant), async (tx) => {
        await resolveSession(tx, tenant, sessionId);
        const { rows } = await tx.query(
          `SELECT current_setting('app.context') AS ctx,
                  current_setting('app.workspace_id') AS ws,
                  current_setting('app.account_id') AS acct`,
        );
        expect(rows[0]).toEqual({ ctx: "workspace", ws: w.id, acct: "acct-a" });
      });
    });

    it("account-scoped NON-member → 404, SAME error as unknown (no existence disclosure)", async () => {
      // acct-a is a member of W but NOT of X; the session lives in X.
      const w = await withContext(
        pool,
        { kind: "account", accountId: "acct-a" },
        (db) =>
          createWorkspace(db, {
            slug: "w",
            name: "W",
            createdBy: "acct-a",
          }),
      );
      await withContext(
        pool,
        { kind: "account", accountId: "acct-a", workspaceId: w.id },
        (db) =>
          addMembership(db, {
            workspaceId: w.id,
            accountId: "acct-a",
            role: "member",
          }),
      );
      const x = await withContext(
        pool,
        { kind: "account", accountId: "acct-b" },
        (db) =>
          createWorkspace(db, {
            slug: "x",
            name: "X",
            createdBy: "acct-b",
          }),
      );
      await withContext(
        pool,
        { kind: "account", accountId: "acct-b", workspaceId: x.id },
        (db) =>
          addMembership(db, {
            workspaceId: x.id,
            accountId: "acct-b",
            role: "admin",
          }),
      );
      const sessionIdX = await mintSession(x.id, "bob");

      // The non-member attempt must throw UnknownSessionError...
      await expect(
        resolve(accountTenant("acct-a"), sessionIdX),
      ).rejects.toBeInstanceOf(UnknownSessionError);

      // ...and it must be INDISTINGUISHABLE from an unknown session id: same error
      // type AND same message (which names only the supplied id, never the ws it
      // lives in). This is the no-existence-disclosure property.
      const nonMemberErr = await resolve(
        accountTenant("acct-a"),
        sessionIdX,
      ).catch((e) => e);
      const unknownErr = await resolve(
        accountTenant("acct-a"),
        UNKNOWN_ID,
      ).catch((e) => e);
      expect(nonMemberErr).toBeInstanceOf(UnknownSessionError);
      expect(unknownErr).toBeInstanceOf(UnknownSessionError);
      expect(nonMemberErr.message).toBe(`Session not found: ${sessionIdX}`);
      expect(unknownErr.message).toBe(`Session not found: ${UNKNOWN_ID}`);
    });

    it("legacy/self-host (concrete workspaceId): a session in ANOTHER workspace → 404", async () => {
      // Credential resolved to workspace W; the session lives in X. getSession's
      // workspace_id predicate is the existing cross-tenant gate — unchanged.
      const w = await withContext(
        pool,
        { kind: "account", accountId: "acct-a" },
        (db) =>
          createWorkspace(db, {
            slug: "w",
            name: "W",
            createdBy: "acct-a",
          }),
      );
      const x = await withContext(
        pool,
        { kind: "account", accountId: "acct-b" },
        (db) =>
          createWorkspace(db, {
            slug: "x",
            name: "X",
            createdBy: "acct-b",
          }),
      );
      const sessionIdX = await mintSession(x.id, "bob");

      const teamTenant: TenantContext = { workspaceId: w.id, via: "team" };
      await expect(resolve(teamTenant, sessionIdX)).rejects.toBeInstanceOf(
        UnknownSessionError,
      );
    });

    it("legacy/self-host: resolves a session in its OWN workspace", async () => {
      const w = await withContext(
        pool,
        { kind: "account", accountId: "acct-a" },
        (db) =>
          createWorkspace(db, {
            slug: "w",
            name: "W",
            createdBy: "acct-a",
          }),
      );
      const sessionId = await mintSession(w.id, "alice");

      const teamTenant: TenantContext = { workspaceId: w.id, via: "team" };
      const session = await resolve(teamTenant, sessionId);
      expect(session.id).toBe(sessionId);
      expect(session.workspaceId).toBe(w.id);
    });

    it("unknown session id → 404 for BOTH credential kinds", async () => {
      const w = await withContext(
        pool,
        { kind: "account", accountId: "acct-a" },
        (db) =>
          createWorkspace(db, {
            slug: "w",
            name: "W",
            createdBy: "acct-a",
          }),
      );
      await withContext(
        pool,
        { kind: "account", accountId: "acct-a", workspaceId: w.id },
        (db) =>
          addMembership(db, {
            workspaceId: w.id,
            accountId: "acct-a",
            role: "member",
          }),
      );

      await expect(
        resolve(accountTenant("acct-a"), UNKNOWN_ID),
      ).rejects.toBeInstanceOf(UnknownSessionError);
      const teamTenant: TenantContext = { workspaceId: w.id, via: "team" };
      await expect(resolve(teamTenant, UNKNOWN_ID)).rejects.toBeInstanceOf(
        UnknownSessionError,
      );
    });
  },
);
