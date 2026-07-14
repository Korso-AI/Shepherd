/**
 * Migration runner for @shepherd/hub.
 *
 * Convention: migration filenames MUST be zero-padded numeric prefixes
 * (001_init.sql, 002_foo.sql, …) so that lexical sort == numeric order.
 * Never rename an existing migration file; add a new one instead.
 *
 * Concurrency: a session-level advisory lock (fixed bigint key below) is
 * acquired before any work starts.  Concurrent boots will queue behind the
 * first runner; by the time they acquire the lock all migrations will already
 * be recorded and they will exit with a no-op.
 *
 * ATOMICITY INVARIANT (enforced by convention — read before adding a migration):
 * Each migration file is executed inside ONE BEGIN/COMMIT (see runMigrations
 * below). For that all-or-nothing guarantee to hold, a migration file MUST NOT:
 *   - contain its own COMMIT / BEGIN (splits the file into multiple txns), or
 *   - use CREATE INDEX CONCURRENTLY (cannot run inside a transaction block).
 * Domain DDL uses bare CREATE (no IF NOT EXISTS) on purpose so a genuine
 * duplicate-object error stays loud — but that also means a half-applied file
 * would wedge the runner with 42P07 on the next boot. Keep every migration a
 * single atomic unit; if you need a concurrent index, ship it as its own file
 * applied by a separate, non-transactional path (not this runner).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import { createPool } from "./db.js";

// Arbitrary but stable advisory-lock key for migration serialisation.
const ADVISORY_LOCK_KEY = 7_142_857_142n; // fits in int64
// pg advisory lock functions take int4 pairs or a single int8 value.
// pg_advisory_lock(bigint) is the single-arg form.
const LOCK_KEY_STRING = ADVISORY_LOCK_KEY.toString();

/** Directory that contains the *.sql migration files. */
const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

/**
 * Read all *.sql files in the migrations directory, sorted lexically
 * (which equals numeric order given the zero-padded prefix convention).
 */
function readMigrationFiles(): { version: string; sql: string }[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // lexical == numeric because of zero-padded prefixes

  return files.map((f) => ({
    version: path.basename(f, ".sql"), // e.g. "001_init"
    sql: fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf-8"),
  }));
}

/**
 * Ensure the schema_migrations bookkeeping table exists.
 * Uses IF NOT EXISTS so it is safe to call before any migration has run.
 */
async function ensureBookkeepingTable(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Apply all pending migrations in order, wrapped in a session-level advisory
 * lock so concurrent boots serialise correctly.
 *
 * Each individual migration runs in its own transaction so a failure leaves
 * previously-applied migrations untouched.
 *
 * Idempotent: a second call with the same pool applies nothing.
 */
export async function runMigrations(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    // Acquire session-level advisory lock (blocks until available).
    await client.query(`SELECT pg_advisory_lock($1::bigint)`, [
      LOCK_KEY_STRING,
    ]);

    // Bootstrap bookkeeping table while still inside the lock.
    await ensureBookkeepingTable(client);

    // Find which versions have already been applied.
    const { rows } = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations",
    );
    const applied = new Set(rows.map((r) => r.version));

    const migrations = readMigrationFiles();

    for (const { version, sql } of migrations) {
      if (applied.has(version)) {
        continue; // already applied — skip
      }

      // Each migration in its own transaction.
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations (version) VALUES ($1)",
          [version],
        );
        await client.query("COMMIT");
        console.log(`[migrate] applied: ${version}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    // Always release the advisory lock (even on error) before returning the
    // client to the pool.  pg_advisory_unlock is safe to call even if the
    // lock was never acquired (it returns false rather than throwing).
    try {
      await client.query(`SELECT pg_advisory_unlock($1::bigint)`, [
        LOCK_KEY_STRING,
      ]);
    } catch {
      // ignore unlock errors — connection may already be broken
    }
    client.release();
  }
}

// ---------------------------------------------------------------------------
// CLI entry-point: `tsx packages/hub/src/migrate.ts`
// ---------------------------------------------------------------------------
const isMain =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const connString =
    process.env["MIGRATIONS_DATABASE_URL"] ?? process.env["DATABASE_URL"];
  if (!connString) {
    console.error("MIGRATIONS_DATABASE_URL or DATABASE_URL must be set");
    process.exit(1);
  }
  const pool = createPool(connString);
  runMigrations(pool)
    .then(() => {
      console.log("[migrate] done");
      return pool.end();
    })
    .catch((err) => {
      console.error("[migrate] failed:", err);
      process.exit(1);
    });
}
