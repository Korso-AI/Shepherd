/**
 * Entry-point for the @shepherd/hub HTTP server.
 *
 * Boot sequence:
 *   1. Parse and validate config from process.env.
 *   2. Run pending migrations on the owner connection (MIGRATIONS_DATABASE_URL
 *      when set, else DATABASE_URL), then close that pool.
 *   3. Create the request-serving Postgres pool (DATABASE_URL).
 *   4. Initialise the shared context (makes getContext() work in operations).
 *   5. Seed the self-host workspace through a maintenance-context ScopedDb
 *      (no-op in hosted-only mode).
 *   6. Build the Fastify app and start listening.
 */

import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { initContext } from "./context.js";
import { runMigrations } from "./migrate.js";
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

  const pool = createPool(config.DATABASE_URL); // request-serving pool, as today

  initContext({ pool, config });

  await withContext(pool, { kind: "maintenance" }, (db) =>
    seedSelfHostWorkspace(db, config.ALLOWED_WORKSPACE),
  );

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
