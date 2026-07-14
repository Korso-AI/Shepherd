/**
 * Entry-point for the @shepherd/hub HTTP server.
 *
 * Boot sequence:
 *   1. Parse and validate config from process.env.
 *   2. Run pending migrations on the owner connection (MIGRATIONS_DATABASE_URL
 *      when set, else DATABASE_URL), then close that pool AND scrub the owner
 *      credential from the process.
 *   3. Create the request-serving Postgres pool (DATABASE_URL) and verify it
 *      sees the full migration set (fail closed on a split-database boot).
 *   4. Initialise the shared context (makes getContext() work in operations).
 *   5. Self-host mode only: seed the team workspace through a
 *      maintenance-context ScopedDb.
 *   6. Build the Fastify app and start listening.
 */

import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { initContext } from "./context.js";
import { runMigrations, assertMigrationsCurrent } from "./migrate.js";
import { seedSelfHostWorkspace } from "./boot.js";
import { withContext } from "./scopedDb.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();

  // Migrations run on the owner connection when configured (two-role
  // deployments); otherwise on the same DATABASE_URL as today. Closed
  // immediately so the elevated connection is not held during request serving.
  const migrationPool = createPool(
    config.MIGRATIONS_DATABASE_URL ?? config.DATABASE_URL,
  );
  await runMigrations(migrationPool);
  await migrationPool.end();
  // Scrub the owner credential now that migrations are done: request-serving
  // code (and anything it loads) must not be able to re-mint an owner
  // connection from env or the retained Config. This is the in-process
  // approximation of the stronger posture — running migrations in a one-shot
  // job that alone receives the owner secret — which stays the recommended
  // hosted setup.
  delete config.MIGRATIONS_DATABASE_URL;
  delete process.env["MIGRATIONS_DATABASE_URL"];

  const pool = createPool(config.DATABASE_URL); // request-serving pool, as today

  // Fail closed if the serving database is not the one the migrations just
  // landed on (a mistyped MIGRATIONS_DATABASE_URL would otherwise migrate one
  // database and serve another): the serving pool must see every migration.
  await assertMigrationsCurrent(pool);

  initContext({ pool, config });

  // Self-host mode only: hosted deployments (no ALLOWED_WORKSPACE) skip the
  // maintenance transaction entirely instead of opening one for a no-op.
  const allowedWorkspace = config.ALLOWED_WORKSPACE;
  if (allowedWorkspace !== undefined) {
    await withContext(pool, { kind: "maintenance" }, (db) =>
      seedSelfHostWorkspace(db, allowedWorkspace),
    );
  }

  // Thread the trust-proxy decision from config (default false — fail-safe).
  // Enable TRUST_PROXY only when a trusted reverse proxy fronts the hub; see the
  // trustProxy comment in server.ts for why it must not be on by default.
  const app = buildServer({ trustProxy: config.TRUST_PROXY });

  await app.listen({ port: config.HUB_PORT, host: "0.0.0.0" });
  app.log.info(`Hub listening on port ${config.HUB_PORT}`);
}

main().catch((err: unknown) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
