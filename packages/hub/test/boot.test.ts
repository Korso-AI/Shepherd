/**
 * Self-host workspace seed-on-boot (Task 2.3).
 *
 * In self-host mode the hub must guarantee exactly one `workspaces` row whose
 * slug == ALLOWED_WORKSPACE so TEAM_TOKEN requests resolve to a real
 * workspace_id. These tests exercise the seed helper directly against the
 * disposable test database.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createTestPool, dbAvailable, runTestMigrations } from "./setup.js";
import { seedSelfHostWorkspace } from "../src/boot.js";
import { withContext } from "../src/scopedDb.js";

describe.skipIf(!dbAvailable)("seedSelfHostWorkspace", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
  });

  afterEach(async () => {
    // Clean up the seeded workspace so each case starts from a known state.
    await pool.query("DELETE FROM workspaces WHERE created_by = 'self-host'");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("seeds exactly one workspace row for the allowed slug", async () => {
    await withContext(pool, { kind: "maintenance" }, (db) =>
      seedSelfHostWorkspace(db, "default"),
    );

    const { rows } = await pool.query<{
      slug: string;
      name: string;
      created_by: string;
    }>("SELECT slug, name, created_by FROM workspaces WHERE slug = $1", [
      "default",
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slug: "default",
      name: "default",
      created_by: "self-host",
    });
  });

  it("is idempotent — calling it twice leaves a single row", async () => {
    await withContext(pool, { kind: "maintenance" }, (db) =>
      seedSelfHostWorkspace(db, "default"),
    );
    await withContext(pool, { kind: "maintenance" }, (db) =>
      seedSelfHostWorkspace(db, "default"),
    );

    const { rows } = await pool.query(
      "SELECT 1 FROM workspaces WHERE slug = $1",
      ["default"],
    );

    expect(rows).toHaveLength(1);
  });

  it("is a no-op when no allowed workspace is configured (hosted-only)", async () => {
    await withContext(pool, { kind: "maintenance" }, (db) =>
      seedSelfHostWorkspace(db, undefined),
    );

    const { rows } = await pool.query(
      "SELECT 1 FROM workspaces WHERE created_by = 'self-host'",
    );

    expect(rows).toHaveLength(0);
  });
});
