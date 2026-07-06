import pg from "pg";

/**
 * Create a pg.Pool from a connection string.
 * Pass a custom connString to point at a throwaway test DB without touching
 * process.env (used by test/setup.ts).
 */
export function createPool(connString?: string): pg.Pool {
  const connectionString = connString ?? process.env["DATABASE_URL"];
  if (!connectionString) {
    throw new Error(
      "No database connection string provided and DATABASE_URL is not set."
    );
  }
  return new pg.Pool({
    connectionString,
    // Cap concurrent server connections. Keep this aligned with the Postgres
    // connection budget DIVIDED BY the number of hub replicas.
    max: Number(process.env["PG_POOL_MAX"] ?? 10),
    // Reap idle clients so we don't pin the whole pool during quiet periods.
    idleTimeoutMillis: 30_000,
    // Fail fast instead of hanging forever when no client is available — a
    // bounded wait surfaces pool pressure as an error rather than a deadlock.
    connectionTimeoutMillis: 5_000,
  });
}

/**
 * Run `fn` inside a single transaction (READ COMMITTED — Postgres' default;
 * the BEGIN here does NOT raise the isolation level). Operations that need
 * stronger guarantees (e.g. `work`'s check-then-claim) rely on an explicit
 * pg_advisory_xact_lock for serialisation, not on the isolation level.
 *
 * Rolls back automatically on any thrown error; always releases the client.
 */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
