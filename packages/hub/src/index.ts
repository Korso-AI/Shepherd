/**
 * Entry-point for the @shepherd/hub HTTP server.
 *
 * Boot sequence:
 *   1. Parse and validate config from process.env.
 *   2. Create the Postgres pool.
 *   3. Initialise the shared context (makes getContext() work in operations).
 *   4. Run pending migrations.
 *   5. Seed the self-host workspace (no-op in hosted-only mode).
 *   6. Build the Fastify app and start listening.
 */

import { loadConfig } from "./config.js";
import { createPool } from "./db.js";
import { initContext } from "./context.js";
import { runMigrations } from "./migrate.js";
import { seedSelfHostWorkspace } from "./boot.js";
import { buildServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config.DATABASE_URL);

  initContext({ pool, config });

  await runMigrations(pool);

  await seedSelfHostWorkspace(pool, config.ALLOWED_WORKSPACE);

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
