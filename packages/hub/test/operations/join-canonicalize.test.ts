/**
 * Tests that `join` canonicalizes the repo at ingestion (packages/hub/src/
 * operations/join.ts). The hub owns the coordination key, so it must normalize
 * whatever a client reports — even an old client sending an `owner/repo` or
 * mixed-case spelling — onto the bare repo name. Kept in its own file (not
 * join.test.ts) to stay out of concurrent edits there.
 *
 * DB-dependent; gated on `dbAvailable` and skipped without a Postgres URL.
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
import { join } from "../../src/operations/join.js";
import type { Config } from "../../src/config.js";
import type { TenantContext } from "../../src/tenant.js";

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
    HUB_ADMIN_LABEL: "admin",
    ...overrides,
  };
}

describe.skipIf(!dbAvailable)("join — repo canonicalization at ingestion", () => {
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
  });

  afterEach(async () => {
    await truncateAll(pool);
    resetContext();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function sessionRepo(sessionId: string): Promise<string> {
    const { rows } = await pool.query<{ repo: string }>(
      "SELECT repo FROM sessions WHERE id = $1",
      [sessionId]
    );
    return rows[0]!.repo;
  }

  it.each([
    ["Acme/widgets", "widgets"],
    ["widgets", "widgets"],
    ["git@github.com:Acme/widgets.git", "widgets"],
    ["https://github.com/Acme/Widgets", "widgets"],
  ])("stores %j as %j on the session", async (input, expected) => {
    initContext({ pool, config: makeTestConfig() });
    const { sessionId } = await join({
      workspace: "test-ws",
      repo: input,
      branch: "main",
      human: "Alex Rivera",
      program: "claude",
    }, tenant);
    expect(await sessionRepo(sessionId)).toBe(expected);
  });

  it("converges owner-form and bare-form clients onto the same key", async () => {
    initContext({ pool, config: makeTestConfig() });
    const a = await join({
      workspace: "test-ws", repo: "Acme/widgets", branch: "main",
      human: "Alex", program: "claude",
    }, tenant);
    const b = await join({
      workspace: "test-ws", repo: "widgets", branch: "main",
      human: "Sam", program: "claude",
    }, tenant);
    expect(await sessionRepo(a.sessionId)).toBe(await sessionRepo(b.sessionId));
  });
});
