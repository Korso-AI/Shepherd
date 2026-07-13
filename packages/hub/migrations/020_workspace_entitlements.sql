-- Migration 020: per-workspace entitlements — a neutral caps primitive.
--
-- One optional row per workspace holding numeric limits the hub enforces:
--   * seats_limit      — max members a workspace may have
--   * repos_limit      — max distinct repos a workspace may register
--   * retention_days   — how long announcement history is kept
-- A NULL cap means unlimited for that dimension. No row at all means the
-- deployment's configured defaults apply (ENTITLEMENTS_DEFAULT_LIMITS; when a
-- deployment never sets it, enforcement is disabled entirely). `expires_at`
-- lets a temporary grant self-revert: past the timestamp the row is ignored
-- and the deployment defaults apply again, without any writer having to
-- clean it up.
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no
-- COMMIT, no CREATE INDEX CONCURRENTLY. Safe to apply after 001-019.

CREATE TABLE workspace_entitlements (
  workspace_id   uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  seats_limit    integer CHECK (seats_limit > 0),
  repos_limit    integer CHECK (repos_limit > 0),
  retention_days integer CHECK (retention_days > 0),
  expires_at     timestamptz,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
