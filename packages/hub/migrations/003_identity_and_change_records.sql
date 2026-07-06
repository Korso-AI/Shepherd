-- Migration 003: per-session identities + durable change awareness.
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY. Safe to apply to a database that already ran
-- 001 and 002.
--
-- Identity model change: an agent is now keyed by (workspace, name) alone — the
-- old (workspace, human, program, model) identity tuple is dropped, and model
-- becomes optional (it may be unknown when an agent first joins).

-- Drop the auto-generated UNIQUE (workspace, human, program, model) constraint
-- from 001_init. IF EXISTS guards against a divergent auto-generated name.
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_workspace_human_program_model_key;

-- model is now optional. The UNIQUE (workspace, name) constraint
-- (agents_workspace_name_key) stays INTACT — do not drop it.
ALTER TABLE agents ALTER COLUMN model DROP NOT NULL;

-- Durable record of what each agent has changed, so teammates retain awareness
-- of committed/uncommitted work across sessions.
CREATE TABLE change_records (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace  text        NOT NULL,
  repo       text        NOT NULL,
  agent_id   uuid        NOT NULL REFERENCES agents(id),
  agent_name text        NOT NULL,
  branch     text        NOT NULL,
  kind       text        NOT NULL CHECK (kind IN ('committed', 'uncommitted')),
  commit_sha text,
  message    text,
  path_globs text[]      NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX ON change_records (workspace, repo, agent_id);
CREATE INDEX ON change_records (workspace, repo, updated_at);
