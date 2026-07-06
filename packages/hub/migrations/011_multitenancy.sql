-- Migration 011: identity & multi-tenancy foundation.
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY. Safe to apply to a database that already ran
-- 001–010. Domain DDL uses bare CREATE (no IF NOT EXISTS) on purpose so a genuine
-- duplicate-object conflict stays loud; the runner records 011 in
-- schema_migrations so it only executes once.
--
-- WHAT: stands up the four new identity/tenancy tables (account_profiles,
-- workspaces, memberships, api_tokens, invites), then normalizes the five
-- coordination tables (agents, sessions, work_items, announcements,
-- change_records) off the free-text `workspace text` column onto a
-- `workspace_id uuid` FK into the new workspaces table, re-keying every
-- uniqueness/dedup index that named `workspace` onto `workspace_id`.
--
-- CLEAN CUTOVER: the live coordination data is ephemeral (agents re-join, claims
-- re-acquire, change records re-report on the next heartbeat). Rather than
-- backfill a workspace_id for every existing row (there is no workspaces table to
-- point at yet), we TRUNCATE the coordination tables so the NOT-NULL FK column can
-- be added with no backfill. The identity tables are brand new and start empty.

-- pgcrypto provides gen_random_uuid(); 001 already enables it. Re-asserting with
-- IF NOT EXISTS is harmless and idempotent (the one sanctioned IF NOT EXISTS —
-- extensions are infra, not domain objects).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- New identity / tenancy tables
-- ---------------------------------------------------------------------------

-- An account is an external identity (GitHub login today). account_id is the
-- stable external subject id; the profile columns are a refreshable snapshot of
-- display metadata and are all nullable (unknown until first seen).
CREATE TABLE account_profiles (
  account_id   text        PRIMARY KEY,
  display_name text,
  github_login text,
  email        text,
  avatar_url   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- A workspace is the tenancy boundary every coordination row now hangs off.
CREATE TABLE workspaces (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  slug       text        UNIQUE NOT NULL,
  name       text        NOT NULL,
  created_by text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Membership joins an account to a workspace with a role. Deleting a workspace
-- cascades its memberships away.
CREATE TABLE memberships (
  account_id   text        NOT NULL,
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role         text        NOT NULL CHECK (role IN ('admin', 'member')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, workspace_id)
);

-- A minted agent/API token, scoped to one workspace and owned by one account.
-- token_hash is the only stored form of the secret (the plaintext is shown once
-- at mint time). revoked_at NULL = active. NOTE: the FK intentionally omits
-- ON DELETE CASCADE so a workspace cannot be dropped while tokens reference it.
CREATE TABLE api_tokens (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   text        NOT NULL,
  workspace_id uuid        NOT NULL REFERENCES workspaces(id),
  token_hash   text        UNIQUE NOT NULL,
  name         text,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- A redeemable invite into a workspace at a fixed role. Deleting a workspace
-- cascades its invites away.
CREATE TABLE invites (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code         text        UNIQUE NOT NULL,
  created_by   text        NOT NULL,
  role_granted text        NOT NULL CHECK (role_granted IN ('admin', 'member')),
  expires_at   timestamptz,
  max_uses     integer     NOT NULL,
  use_count    integer     NOT NULL DEFAULT 0,
  revoked_at   timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Clean cutover of the coordination tables onto workspace_id
-- ---------------------------------------------------------------------------
--
-- RECONCILIATION NOTE (2026-06-30): this file must converge TWO live lineages
-- onto the same canonical workspaces shape, because the 011/012 version numbers
-- collide across a since-abandoned design:
--
--   * Fresh / dev DB — ran 001–010 only. Coordination tables carry a free-text
--     `workspace text` column and `*_workspace_*`-named indexes/constraints.
--   * Production — additionally ran an abandoned tenant_id design (recorded in
--     schema_migrations as 011_add_tenant_id / 012_add_sessions_tenant_index).
--     Every coordination table ALSO carries a `tenant_id text NOT NULL` column,
--     and its uniqueness/lookup objects are `*_tenant_workspace_*`-named.
--
-- The runner keys off the version STRING, so on prod `011_multitenancy` is still
-- unapplied and runs here. Rather than enumerate index/constraint names (which
-- differ between the two lineages), we drop the `tenant_id` and `workspace`
-- columns with CASCADE: Postgres then auto-drops exactly the indexes/constraints
-- that depend on each column, whatever they are named, in whichever lineage. The
-- IF EXISTS on the tenant_id drop is the one sanctioned conditional here — it is
-- a no-op on a fresh DB and the destructive reconciliation step on prod.

-- Drop all ephemeral coordination rows so the NOT-NULL workspace_id FK can be
-- added with no backfill (there is no workspace to point legacy rows at). CASCADE
-- covers announcement_deliveries (FK into announcements) and the session/work_item
-- FK chain; RESTART IDENTITY resets the announcements id sequence.
TRUNCATE TABLE
  announcement_deliveries,
  announcements,
  work_items,
  sessions,
  agents,
  change_records
  RESTART IDENTITY CASCADE;

-- Reconcile away the abandoned tenant_id lineage (prod only; no-op on a fresh
-- DB). DROP COLUMN ... CASCADE drops the column and every `*_tenant_*` index /
-- constraint that depends on it. All six coordination tables grew a tenant_id.
ALTER TABLE agents                  DROP COLUMN IF EXISTS tenant_id CASCADE;
ALTER TABLE sessions                DROP COLUMN IF EXISTS tenant_id CASCADE;
ALTER TABLE work_items              DROP COLUMN IF EXISTS tenant_id CASCADE;
ALTER TABLE announcements           DROP COLUMN IF EXISTS tenant_id CASCADE;
ALTER TABLE change_records          DROP COLUMN IF EXISTS tenant_id CASCADE;
ALTER TABLE announcement_deliveries DROP COLUMN IF EXISTS tenant_id CASCADE;

-- Re-key the five workspace-scoped tables onto workspace_id. Add the new FK
-- column first, then DROP the old free-text `workspace` column with CASCADE so
-- the remaining `*_workspace_*`-named indexes/constraints (the fresh-DB lineage,
-- and any tenant-lineage object that named workspace but not tenant_id) drop with
-- it. announcement_deliveries has no workspace column — it is keyed by
-- (session_id, announcement_id) — so it is intentionally absent here.
ALTER TABLE agents         ADD COLUMN workspace_id uuid NOT NULL REFERENCES workspaces(id);
ALTER TABLE agents         DROP COLUMN workspace CASCADE;

ALTER TABLE sessions       ADD COLUMN workspace_id uuid NOT NULL REFERENCES workspaces(id);
ALTER TABLE sessions       DROP COLUMN workspace CASCADE;

ALTER TABLE work_items     ADD COLUMN workspace_id uuid NOT NULL REFERENCES workspaces(id);
ALTER TABLE work_items     DROP COLUMN workspace CASCADE;

ALTER TABLE announcements  ADD COLUMN workspace_id uuid NOT NULL REFERENCES workspaces(id);
ALTER TABLE announcements  DROP COLUMN workspace CASCADE;

ALTER TABLE change_records ADD COLUMN workspace_id uuid NOT NULL REFERENCES workspaces(id);
ALTER TABLE change_records DROP COLUMN workspace CASCADE;

-- ---------------------------------------------------------------------------
-- Recreate the re-keyed uniqueness/dedup indexes onto workspace_id
-- ---------------------------------------------------------------------------

-- agents: identity is now (workspace_id, name). Recreate both the UNIQUE
-- constraint [001] and the text_pattern_ops prefix index [004] that backs the
-- `name LIKE handle || '-%'` ordinal lookup in `join`.
ALTER TABLE agents ADD CONSTRAINT agents_workspace_id_name_key UNIQUE (workspace_id, name);
CREATE INDEX agents_workspace_id_name_pattern_idx
  ON agents (workspace_id, name text_pattern_ops);

-- work_items: the active-claim filter [001] and the released-history partial
-- index [006].
CREATE INDEX work_items_workspace_id_repo_status_expires_at_idx
  ON work_items (workspace_id, repo, status, expires_at);
CREATE INDEX work_items_workspace_id_released_idx
  ON work_items (workspace_id, released_at DESC)
  WHERE released_at IS NOT NULL;

-- announcements: the workspace feed / delivery lookup [001].
CREATE INDEX announcements_workspace_id_repo_id_idx
  ON announcements (workspace_id, repo, id);

-- change_records: the two landscape lookups [003] and the per-commit dedup
-- partial unique index [005/009] (replaceChangeRecords upserts against this via
-- ON CONFLICT (workspace_id, repo, commit_sha) WHERE kind = 'committed').
CREATE INDEX change_records_workspace_id_repo_agent_id_idx
  ON change_records (workspace_id, repo, agent_id);
CREATE INDEX change_records_workspace_id_repo_updated_at_idx
  ON change_records (workspace_id, repo, updated_at);
CREATE UNIQUE INDEX change_records_committed_sha_key
  ON change_records (workspace_id, repo, commit_sha)
  WHERE kind = 'committed';
