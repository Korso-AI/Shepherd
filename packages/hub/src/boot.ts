/**
 * Boot-time setup that runs once after the pool + config are ready and
 * migrations have applied, before the server starts handling requests.
 */

import type { ScopedDb } from "./scopedDb.js";

/**
 * In self-host mode, guarantee exactly one `workspaces` row whose slug matches
 * ALLOWED_WORKSPACE so TEAM_TOKEN requests resolve to a real workspace_id.
 *
 * Runs on a maintenance-context {@link ScopedDb} (see index.ts) so the write
 * passes through the one database door with its RLS context set.
 *
 * The upsert is idempotent (`ON CONFLICT (slug) DO NOTHING`), so repeated boots
 * leave a single row untouched. When `allowedWorkspace` is undefined the hub is
 * a hosted-only deployment with no implicit team workspace — this is a no-op.
 */
export async function seedSelfHostWorkspace(
  db: ScopedDb,
  allowedWorkspace: string | undefined,
): Promise<void> {
  if (allowedWorkspace === undefined) {
    return;
  }

  await db.query(
    `INSERT INTO workspaces (slug, name, created_by)
     VALUES ($1, $1, 'self-host')
     ON CONFLICT (slug) DO NOTHING`,
    [allowedWorkspace],
  );
}
