/**
 * Tests for packages/hub/src/operations/work.ts
 *
 * All DB-dependent tests are gated on `dbAvailable`.
 * When no Postgres is configured, the suite is skipped with a clear message.
 *
 * Test scenarios:
 *   - Happy (no conflict): single claim -> conflicts: [], workItemId returned
 *   - Happy (conflict): two sessions claim overlapping globs -> conflict reported
 *   - TTL clamp: ttlSeconds below MIN_TTL_SECONDS is clamped up
 *   - Expired claim: expired claim from other session is NOT in conflicts
 *   - Stale session: claim from stale session is NOT in conflicts
 *   - Concurrency (advisory lock): two overlapping work() calls run concurrently,
 *     second sees first in conflicts
 *   - Announcements: pending broadcast delivered exactly once
 *   - Unknown session: throws UnknownSessionError
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  runTestMigrations,
  truncateAll,
} from "../setup.js";
import { work } from "../../src/operations/work.js";
import { join } from "../../src/operations/join.js";
import { initContext, resetContext } from "../../src/context.js";
import type { Config } from "../../src/config.js";
import {
  createAgent,
  createSession,
  insertAnnouncement,
  addMembership,
} from "../../src/repo.js";
import { sync } from "../../src/operations/sync.js";
import { withTransaction } from "../../src/db.js";
import { UnknownSessionError } from "../../src/errors.js";
import { NO_ROUTE_WORKSPACE, type TenantContext } from "../../src/tenant.js";

// ---------------------------------------------------------------------------
// Test config
// ---------------------------------------------------------------------------

const TEST_CONFIG: Config = {
  DATABASE_URL: process.env["TEST_DATABASE_URL"] ?? process.env["DATABASE_URL"] ?? "",
  TEAM_TOKEN: "test-token",
  HUB_PORT: 8080,
  ALLOWED_WORKSPACE: "test-ws",
  DEFAULT_TTL_SECONDS: 1800,
  MIN_TTL_SECONDS: 30,
  STALE_AFTER_SECONDS: 120,
  CHANGE_RECORD_TTL_SECONDS: 604800,
  HUB_ADMIN_LABEL: "admin",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Seed an agent + session via direct repo calls (bypasses the op-layer guard so
 * tests can seed freely). Scoped to a workspace uuid (defaulting to the suite's
 * seeded workspace) — pass `workspaceId` to seed a cross-tenant row.
 */
async function seedSession(
  pool: pg.Pool,
  workspaceId: string,
  opts: {
    repo?: string;
    branch?: string;
    human?: string;
    program?: string;
    model?: string;
    agentName?: string;
  } = {},
): Promise<{ agentId: string; agentName: string; sessionId: string }> {
  const repo = opts.repo ?? "test-repo";
  const branch = opts.branch ?? "main";
  const human = opts.human ?? "alice";
  const program = opts.program ?? "my-prog";
  const model = opts.model ?? "claude-3";
  const agentName = opts.agentName ?? `agent-${Math.random().toString(36).slice(2, 8)}`;

  return withTransaction(pool, async (tx) => {
    const agent = await createAgent(tx, {
      workspaceId,
      name: agentName,
      human,
      program,
      model,
    });
    const session = await createSession(tx, {
      workspaceId,
      agentId: agent.id,
      repo,
      branch,
    });
    return { agentId: agent.id, agentName: agent.name, sessionId: session.id };
  });
}

// ---------------------------------------------------------------------------
// DB-gated suite
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)("work operation — DB-dependent", () => {
  let pool: pg.Pool;
  let workspaceId: string;
  let tenant: TenantContext;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester') ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      ["test-ws", "test-ws"]
    );
    workspaceId = rows[0]!.id;
    tenant = { workspaceId };
    initContext({ pool, config: TEST_CONFIG });
  });

  afterEach(async () => {
    await truncateAll(pool);
  });

  afterAll(async () => {
    resetContext();
    await pool.end();
  });

  // -------------------------------------------------------------------------
  // Happy path: no conflict
  // -------------------------------------------------------------------------
  it("happy (no conflict): returns workItemId and empty conflicts", async () => {
    const { sessionId } = await seedSession(pool, workspaceId);

    const result = await work({
      sessionId,
      intent: "Refactor auth module",
      pathGlobs: ["src/api/**"],
    }, tenant);

    expect(result.workItemId).toBeTruthy();
    expect(typeof result.workItemId).toBe("string");
    expect(result.landscape.conflicts).toHaveLength(0);
    expect(result.landscape.activeClaims).toHaveLength(0);
    expect(result.landscape.announcements).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Idempotency: a repeated work() for the same intent+globs reuses the claim
  // -------------------------------------------------------------------------
  it("idempotency: repeated work for same session+intent+globs reuses one claim", async () => {
    const { sessionId } = await seedSession(pool, workspaceId);

    const first = await work({
      sessionId,
      intent: "Refactor auth module",
      pathGlobs: ["src/api/**", "src/auth/**"],
    }, tenant);

    // Same intent, same globs in a DIFFERENT order (+ incidental dup/whitespace)
    // — must be treated as the same claim, not a new one.
    const second = await work({
      sessionId,
      intent: "Refactor auth module",
      pathGlobs: ["src/auth/** ", "src/api/**", "src/api/**"],
    }, tenant);

    expect(second.workItemId).toBe(first.workItemId);

    // Exactly ONE active claim row exists for the session — no pile-up.
    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM work_items
       WHERE session_id = $1 AND status = 'active'`,
      [sessionId],
    );
    expect(rows[0]!.count).toBe("1");
  });

  it("idempotency: a DIFFERENT intent or different globs still inserts a new claim", async () => {
    const { sessionId } = await seedSession(pool, workspaceId);

    const a = await work({ sessionId, intent: "Work A", pathGlobs: ["src/a/**"] }, tenant);
    // Different intent, same globs -> new claim.
    const b = await work({ sessionId, intent: "Work B", pathGlobs: ["src/a/**"] }, tenant);
    // Same intent as A, different globs -> new claim.
    const c = await work({ sessionId, intent: "Work A", pathGlobs: ["src/c/**"] }, tenant);

    expect(new Set([a.workItemId, b.workItemId, c.workItemId]).size).toBe(3);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM work_items
       WHERE session_id = $1 AND status = 'active'`,
      [sessionId],
    );
    expect(rows[0]!.count).toBe("3");
  });

  // -------------------------------------------------------------------------
  // Happy path: new claim is visible to subsequent listActiveClaims
  // -------------------------------------------------------------------------
  it("happy: claim is visible to others after work() completes", async () => {
    const { sessionId: sessionA } = await seedSession(pool, workspaceId, { agentName: "agent-a" });
    const { sessionId: sessionB } = await seedSession(pool, workspaceId, {
      agentName: "agent-b",
      human: "bob",
      program: "prog-b",
    });

    // A claims src/api/**
    await work({
      sessionId: sessionA,
      intent: "Build API",
      pathGlobs: ["src/api/**"],
    }, tenant);

    // B claims an unrelated path — should see A's claim in activeClaims but not conflicts
    const resultB = await work({
      sessionId: sessionB,
      intent: "Build UI",
      pathGlobs: ["src/ui/**"],
    }, tenant);

    expect(resultB.landscape.conflicts).toHaveLength(0);
    expect(resultB.landscape.activeClaims).toHaveLength(1);
    expect(resultB.landscape.activeClaims[0]!.pathGlobs).toContain("src/api/**");
  });

  // -------------------------------------------------------------------------
  // Happy path: conflict detected
  // -------------------------------------------------------------------------
  it("conflict: B's claim overlapping A's glob appears in B's conflicts", async () => {
    const { sessionId: sessionA, agentName: nameA } = await seedSession(pool, workspaceId, {
      agentName: "agent-a",
      human: "alice",
      program: "prog-a",
    });
    const { sessionId: sessionB } = await seedSession(pool, workspaceId, {
      agentName: "agent-b",
      human: "bob",
      program: "prog-b",
    });

    // A claims src/auth/**
    await work({
      sessionId: sessionA,
      intent: "Auth module",
      pathGlobs: ["src/auth/**"],
    }, tenant);

    // B claims overlapping path
    const resultB = await work({
      sessionId: sessionB,
      intent: "Login page",
      pathGlobs: ["src/auth/login.ts"],
    }, tenant);

    // B's claim still succeeds
    expect(resultB.workItemId).toBeTruthy();

    // B's conflicts contains A's claim
    expect(resultB.landscape.conflicts).toHaveLength(1);
    expect(resultB.landscape.conflicts[0]!.agentName).toBe(nameA);
    expect(resultB.landscape.conflicts[0]!.pathGlobs).toContain("src/auth/**");
  });

  // -------------------------------------------------------------------------
  // Edge: expired claim does not appear in conflicts
  // -------------------------------------------------------------------------
  it("edge: expired claim from another session is not in conflicts", async () => {
    const { sessionId: sessionA } = await seedSession(pool, workspaceId, {
      agentName: "agent-a",
      human: "alice",
      program: "prog-a",
    });
    const { sessionId: sessionB } = await seedSession(pool, workspaceId, {
      agentName: "agent-b",
      human: "bob",
      program: "prog-b",
    });

    // A claims with a very short TTL (will be clamped to MIN_TTL_SECONDS=30,
    // so we need to manually insert an already-expired claim)
    // We'll use direct SQL to insert an expired work item for session A.
    await pool.query(
      `INSERT INTO work_items (workspace_id, session_id, repo, intent_text, path_globs, ttl_seconds, expires_at)
       SELECT s.workspace_id, $1, s.repo, 'expired claim', ARRAY['src/auth/**'], 30,
              NOW() - INTERVAL '1 second'
       FROM sessions s WHERE s.id = $1`,
      [sessionA],
    );

    // B claims overlapping path — should see no conflicts since A's claim is expired
    const resultB = await work({
      sessionId: sessionB,
      intent: "Login page",
      pathGlobs: ["src/auth/login.ts"],
    }, tenant);

    expect(resultB.landscape.conflicts).toHaveLength(0);
    expect(resultB.landscape.activeClaims).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // #1: a stale session's claim DISAPPEARS (visibility requires a live session)
  // -------------------------------------------------------------------------
  it("#1: stale session claim drops out of conflicts and activeClaims", async () => {
    const { sessionId: sessionA } = await seedSession(pool, workspaceId, {
      agentName: "agent-a",
      human: "alice",
      program: "prog-a",
    });
    const { sessionId: sessionB } = await seedSession(pool, workspaceId, {
      agentName: "agent-b",
      human: "bob",
      program: "prog-b",
    });

    // A claims a path
    await work({
      sessionId: sessionA,
      intent: "Auth work",
      pathGlobs: ["src/auth/**"],
    }, tenant);

    // Manually make session A's heartbeat very old (well past STALE_AFTER=120s).
    // The 60s background heartbeat keeps a genuinely-live session fresh, so a
    // session this quiet is treated as dead — its claim must vanish even though
    // the claim's own TTL is far from expiry.
    await pool.query(
      `UPDATE sessions SET last_heartbeat_at = NOW() - INTERVAL '200 seconds' WHERE id = $1`,
      [sessionA],
    );

    // B claims overlapping path — A's claim is hidden, so B sees no conflict.
    const resultB = await work({
      sessionId: sessionB,
      intent: "Login page",
      pathGlobs: ["src/auth/login.ts"],
    }, tenant);

    expect(resultB.landscape.conflicts).toHaveLength(0);
    expect(resultB.landscape.activeClaims).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Edge: TTL clamping
  // -------------------------------------------------------------------------
  it("edge: ttlSeconds below MIN_TTL_SECONDS is clamped to MIN_TTL_SECONDS", async () => {
    const { sessionId } = await seedSession(pool, workspaceId);

    const before = new Date();
    const result = await work({
      sessionId,
      intent: "Short TTL test",
      pathGlobs: ["src/foo/**"],
      ttlSeconds: 5, // below MIN_TTL_SECONDS=30
    }, tenant);
    const after = new Date();

    expect(result.workItemId).toBeTruthy();

    // Verify the actual stored expires_at is ~30 seconds out (clamped), not 5
    const { rows } = await pool.query<{ expires_at: Date; ttl_seconds: number }>(
      "SELECT expires_at, ttl_seconds FROM work_items WHERE id = $1",
      [result.workItemId],
    );
    expect(rows[0]!.ttl_seconds).toBe(30);
    // expires_at should be ~30 seconds from call time (not 5)
    const expiresAt = rows[0]!.expires_at.getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before.getTime() + 29_000);
    expect(expiresAt).toBeLessThanOrEqual(after.getTime() + 31_000);
  });

  // -------------------------------------------------------------------------
  // Concurrency: advisory lock serialises overlapping claims
  // -------------------------------------------------------------------------
  it("concurrency (P1-1): advisory lock ensures at least one sees the other's claim", async () => {
    const { sessionId: sessionA } = await seedSession(pool, workspaceId, {
      agentName: "agent-a",
      human: "alice",
      program: "prog-a",
    });
    const { sessionId: sessionB } = await seedSession(pool, workspaceId, {
      agentName: "agent-b",
      human: "bob",
      program: "prog-b",
    });

    // Fire two overlapping work() calls concurrently
    const [resultA, resultB] = await Promise.all([
      work({
        sessionId: sessionA,
        intent: "Concurrent claim A",
        pathGlobs: ["src/shared/**"],
      }, tenant),
      work({
        sessionId: sessionB,
        intent: "Concurrent claim B",
        pathGlobs: ["src/shared/**"],
      }, tenant),
    ]);

    // Both succeed (claim always succeeds)
    expect(resultA.workItemId).toBeTruthy();
    expect(resultB.workItemId).toBeTruthy();

    // At least one must see the other's claim in conflicts (serialisation guarantee)
    const aConflicts = resultA.landscape.conflicts.length;
    const bConflicts = resultB.landscape.conflicts.length;
    expect(aConflicts + bConflicts).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // Integration: pending announcement delivered exactly once
  // -------------------------------------------------------------------------
  it("integration: pending broadcast delivered in landscape.announcements exactly once", async () => {
    const { sessionId: sessionA } = await seedSession(pool, workspaceId, {
      agentName: "agent-a",
      human: "alice",
      program: "prog-a",
    });
    const { sessionId: sessionB } = await seedSession(pool, workspaceId, {
      agentName: "agent-b",
      human: "bob",
      program: "prog-b",
    });

    // A creates a broadcast announcement
    await withTransaction(pool, async (tx) => {
      await insertAnnouncement(tx, {
        workspaceId,
        repo: "test-repo",
        fromSessionId: sessionA,
        targetAgentName: null, // broadcast
        body: "Hey everyone, heads up!",
      });
    });

    // First work() by B should receive the announcement
    const result1 = await work({
      sessionId: sessionB,
      intent: "First work",
      pathGlobs: ["src/ui/**"],
    }, tenant);

    expect(result1.landscape.announcements).toHaveLength(1);
    expect(result1.landscape.announcements[0]!.body).toBe("Hey everyone, heads up!");

    // Second work() by B should NOT redeliver the same announcement
    const result2 = await work({
      sessionId: sessionB,
      intent: "Second work",
      pathGlobs: ["src/other/**"],
    }, tenant);

    expect(result2.landscape.announcements).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Error: unknown session
  // -------------------------------------------------------------------------
  it("error: unknown sessionId throws UnknownSessionError", async () => {
    const fakeSessionId = "00000000-0000-0000-0000-000000000000";

    await expect(
      work({
        sessionId: fakeSessionId,
        intent: "ghost work",
        pathGlobs: ["src/**"],
      }, tenant),
    ).rejects.toThrow(UnknownSessionError);
  });

  // -------------------------------------------------------------------------
  // Change records (Tasks 3.2 / 3.3)
  // -------------------------------------------------------------------------

  it("changeReport: stored records are visible to an overlapping peer with presence enrichment", async () => {
    const { sessionId: sessionA } = await seedSession(pool, workspaceId, { agentName: "agent-a" });
    const { sessionId: sessionB } = await seedSession(pool, workspaceId, {
      agentName: "agent-b",
      human: "bob",
      program: "prog-b",
    });

    // A reports a committed + an uncommitted change on src/auth/**.
    await work({
      sessionId: sessionA,
      intent: "Auth work",
      pathGlobs: ["src/auth/**"],
      changeReport: {
        branch: "feat/auth",
        baseBranch: "main",
        head: "abc123",
        truncated: false,
        entries: [
          { kind: "committed", sha: "deadbeef", message: "commit auth", paths: ["src/auth/login.ts"] },
          { kind: "uncommitted", sha: null, message: null, paths: ["src/auth/wip.ts"] },
        ],
      },
    }, tenant);

    // B claims an overlapping glob -> should see BOTH of A's change records.
    const resultB = await work({
      sessionId: sessionB,
      intent: "Auth fix",
      pathGlobs: ["src/auth/**"],
    }, tenant);

    expect(resultB.landscape.changeRecords).toHaveLength(2);
    for (const rec of resultB.landscape.changeRecords) {
      expect(rec.agentName).toBe("agent-a");
      expect(rec.branch).toBe("feat/auth");
      expect(rec.authorIsLive).toBe(true);
      expect(typeof rec.authorLastActiveAt).toBe("string");
    }
    const committed = resultB.landscape.changeRecords.find((r) => r.kind === "committed");
    expect(committed!.commitSha).toBe("deadbeef");
    expect(committed!.message).toBe("commit auth");
    const uncommitted = resultB.landscape.changeRecords.find((r) => r.kind === "uncommitted");
    expect(uncommitted!.commitSha).toBeNull();
  });

  it("changeReport: committed records reflect the current reported set; uncommitted is wholesale-replaced", async () => {
    const { sessionId: sessionA } = await seedSession(pool, workspaceId, { agentName: "agent-a" });
    const { sessionId: sessionB } = await seedSession(pool, workspaceId, {
      agentName: "agent-b",
      human: "bob",
      program: "prog-b",
    });

    // A reports one committed (s1) + one uncommitted.
    await work({
      sessionId: sessionA,
      intent: "Auth work",
      pathGlobs: ["src/auth/**"],
      changeReport: {
        branch: "feat/auth",
        baseBranch: "main",
        head: "h1",
        truncated: false,
        entries: [
          { kind: "committed", sha: "s1", message: "m1", paths: ["src/auth/a.ts"] },
          { kind: "uncommitted", sha: null, message: null, paths: ["src/auth/b.ts"] },
        ],
      },
    }, tenant);

    let resultB = await work({
      sessionId: sessionB,
      intent: "Auth fix",
      pathGlobs: ["src/auth/**"],
    }, tenant);
    // B sees both A records (1 committed + 1 uncommitted).
    expect(resultB.landscape.changeRecords).toHaveLength(2);

    // A reports a NEW committed (s2) with NO uncommitted, on the SAME branch. The
    // uncommitted row is wholesale-replaced (cleared); s1 is no longer in A's
    // report (it was squashed/rebased away), so it is dropped — committed records
    // now reflect the agent's CURRENT unlanded set, not an ever-growing history.
    await work({
      sessionId: sessionA,
      intent: "Auth work",
      pathGlobs: ["src/auth/**"],
      changeReport: {
        branch: "feat/auth",
        baseBranch: "main",
        head: "h2",
        truncated: false,
        entries: [
          { kind: "committed", sha: "s2", message: "m2", paths: ["src/auth/a.ts"] },
        ],
      },
    }, tenant);

    resultB = await work({
      sessionId: sessionB,
      intent: "Auth fix",
      pathGlobs: ["src/auth/**"],
    }, tenant);
    expect(resultB.landscape.changeRecords).toHaveLength(1);
    expect(resultB.landscape.changeRecords[0]!.kind).toBe("committed");
    expect(resultB.landscape.changeRecords[0]!.commitSha).toBe("s2");

    // A reports a clean tree ([]) — nothing dirty AND nothing unlanded. Its
    // committed rows clear too, so B sees nothing from A.
    await work({
      sessionId: sessionA,
      intent: "Auth work",
      pathGlobs: ["src/auth/**"],
      changeReport: {
        branch: "feat/auth",
        baseBranch: "main",
        head: "h3",
        truncated: false,
        entries: [],
      },
    }, tenant);

    resultB = await work({
      sessionId: sessionB,
      intent: "Auth fix",
      pathGlobs: ["src/auth/**"],
    }, tenant);
    expect(resultB.landscape.changeRecords).toHaveLength(0);
  });

  it("changeReport: changeReport.branch different from join branch updates sessions.branch", async () => {
    const { sessionId: sessionA } = await seedSession(pool, workspaceId, {
      agentName: "agent-a",
      branch: "main",
    });

    await work({
      sessionId: sessionA,
      intent: "Auth work",
      pathGlobs: ["src/auth/**"],
      changeReport: {
        branch: "feat/new-branch",
        baseBranch: "main",
        head: "h1",
        truncated: false,
        entries: [
          { kind: "committed", sha: "s1", message: "m1", paths: ["src/auth/a.ts"] },
        ],
      },
    }, tenant);

    const { rows } = await pool.query<{ branch: string }>(
      "SELECT branch FROM sessions WHERE id = $1",
      [sessionA],
    );
    expect(rows[0]!.branch).toBe("feat/new-branch");
  });

  it("changeReport: non-overlapping records are excluded; own records never appear", async () => {
    const { sessionId: sessionA } = await seedSession(pool, workspaceId, { agentName: "agent-a" });
    const { sessionId: sessionB } = await seedSession(pool, workspaceId, {
      agentName: "agent-b",
      human: "bob",
      program: "prog-b",
    });

    // A reports a change on src/ui/**.
    await work({
      sessionId: sessionA,
      intent: "UI work",
      pathGlobs: ["src/ui/**"],
      changeReport: {
        branch: "feat/ui",
        baseBranch: "main",
        head: "h1",
        truncated: false,
        entries: [
          { kind: "committed", sha: "s1", message: "m1", paths: ["src/ui/page.ts"] },
        ],
      },
    }, tenant);

    // B claims a non-overlapping glob -> A's record is excluded.
    const resultB = await work({
      sessionId: sessionB,
      intent: "Auth work",
      pathGlobs: ["src/auth/**"],
      changeReport: {
        branch: "feat/auth",
        baseBranch: "main",
        head: "h2",
        truncated: false,
        entries: [
          { kind: "uncommitted", sha: null, message: null, paths: ["src/auth/x.ts"] },
        ],
      },
    }, tenant);

    // B sees no overlapping records, and never sees its OWN record.
    expect(resultB.landscape.changeRecords).toHaveLength(0);
  });

  it("changeReport: a stale author's record is still returned but authorIsLive===false", async () => {
    const { sessionId: sessionA } = await seedSession(pool, workspaceId, { agentName: "agent-a" });
    const { sessionId: sessionB } = await seedSession(pool, workspaceId, {
      agentName: "agent-b",
      human: "bob",
      program: "prog-b",
    });

    await work({
      sessionId: sessionA,
      intent: "Auth work",
      pathGlobs: ["src/auth/**"],
      changeReport: {
        branch: "feat/auth",
        baseBranch: "main",
        head: "h1",
        truncated: false,
        entries: [
          { kind: "committed", sha: "s1", message: "m1", paths: ["src/auth/a.ts"] },
        ],
      },
    }, tenant);

    // Backdate A's heartbeat past STALE_AFTER_SECONDS (=120).
    await pool.query(
      "UPDATE sessions SET last_heartbeat_at = NOW() - INTERVAL '200 seconds' WHERE id = $1",
      [sessionA],
    );

    const resultB = await work({
      sessionId: sessionB,
      intent: "Auth fix",
      pathGlobs: ["src/auth/**"],
    }, tenant);

    expect(resultB.landscape.changeRecords).toHaveLength(1);
    expect(resultB.landscape.changeRecords[0]!.authorIsLive).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Account-scoped credential (Task 2.2): work resolves the session via
  // resolveSession — an account-scoped token (no route workspace) that is a
  // LIVE member of the session's workspace works on the hot path; a session in
  // a workspace the account cannot see fail-closes to 404 with NO row written.
  // -------------------------------------------------------------------------

  it("account-scoped member: work succeeds and the claim is scoped to session.workspaceId", async () => {
    // acct-member is a live member of the suite workspace; its token carries no
    // route workspace (NO_ROUTE_WORKSPACE) — resolveSession reads the session and
    // authorizes membership against ITS workspace.
    await withTransaction(pool, (tx) =>
      addMembership(tx, { workspaceId, accountId: "acct-member", role: "member" }),
    );
    const { sessionId } = await seedSession(pool, workspaceId);
    const accountTenant: TenantContext = {
      workspaceId: NO_ROUTE_WORKSPACE,
      accountId: "acct-member",
      via: "agent",
    };

    const result = await work(
      { sessionId, intent: "account-scoped work", pathGlobs: ["src/api/**"] },
      accountTenant,
    );

    expect(result.workItemId).toBeTruthy();
    // The claim row is scoped to the SESSION's workspace, not any route input.
    const { rows } = await pool.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM work_items WHERE id = $1",
      [result.workItemId],
    );
    expect(rows[0]!.workspace_id).toBe(workspaceId);
  });

  it("account-scoped non-member: work on a session in a non-member workspace → 404, no row written", async () => {
    // A second workspace the calling account is NOT a member of. Its session is
    // real, but resolveSession must fail-closed to UnknownSessionError (404).
    const { rows: wsRows } = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester')
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      ["work-other-ws", "work-other-ws"],
    );
    const otherWs = wsRows[0]!.id;
    const { sessionId } = await seedSession(pool, otherWs);
    const accountTenant: TenantContext = {
      workspaceId: NO_ROUTE_WORKSPACE,
      accountId: "acct-outsider",
      via: "agent",
    };

    await expect(
      work(
        { sessionId, intent: "cross-tenant attempt", pathGlobs: ["src/**"] },
        accountTenant,
      ),
    ).rejects.toThrow(UnknownSessionError);

    // Nothing written in any workspace.
    const { rows } = await pool.query<{ count: string }>(
      "SELECT COUNT(*)::text AS count FROM work_items",
    );
    expect(rows[0]!.count).toBe("0");
  });

  it("back-compat: work with no changeReport leaves records untouched", async () => {
    const { sessionId: sessionA } = await seedSession(pool, workspaceId, { agentName: "agent-a" });
    const { sessionId: sessionB } = await seedSession(pool, workspaceId, {
      agentName: "agent-b",
      human: "bob",
      program: "prog-b",
    });

    // A reports a change.
    await work({
      sessionId: sessionA,
      intent: "Auth work",
      pathGlobs: ["src/auth/**"],
      changeReport: {
        branch: "feat/auth",
        baseBranch: "main",
        head: "h1",
        truncated: false,
        entries: [
          { kind: "committed", sha: "s1", message: "m1", paths: ["src/auth/a.ts"] },
        ],
      },
    }, tenant);

    // A calls work again with NO changeReport -> its records persist.
    await work({
      sessionId: sessionA,
      intent: "Auth work",
      pathGlobs: ["src/auth/**"],
    }, tenant);

    const resultB = await work({
      sessionId: sessionB,
      intent: "Auth fix",
      pathGlobs: ["src/auth/**"],
    }, tenant);
    expect(resultB.landscape.changeRecords).toHaveLength(1);
    expect(resultB.landscape.changeRecords[0]!.commitSha).toBe("s1");
  });
});

// ---------------------------------------------------------------------------
// Skipped message when no DB is available
// ---------------------------------------------------------------------------
describe.skipIf(dbAvailable)("work operation — DB not available", () => {
  it("skips because no database is configured", () => {
    console.log("[work.test] No TEST_DATABASE_URL or DATABASE_URL — DB tests skipped.");
  });
});
