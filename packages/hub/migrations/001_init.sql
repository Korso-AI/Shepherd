-- Migration 001: initial schema
-- Note: on managed Postgres the default user must have the SUPERUSER or
-- CREATE EXTENSION privilege. gen_random_uuid() is provided by pgcrypto.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Bookkeeping table (IF NOT EXISTS so the migration runner can bootstrap
-- idempotently even before the advisory lock check completes on the first run)
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    text        PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Domain tables (NO IF NOT EXISTS — a genuine duplicate-object conflict should
-- remain loud; the advisory lock in migrate.ts guards concurrency)

CREATE TABLE agents (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace  text        NOT NULL,
  name       text        NOT NULL,
  human      text        NOT NULL,
  program    text        NOT NULL,
  model      text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace, name),
  UNIQUE (workspace, human, program, model)
);

CREATE TABLE sessions (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace         text        NOT NULL,
  agent_id          uuid        NOT NULL REFERENCES agents(id),
  repo              text        NOT NULL,
  branch            text        NOT NULL,
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE work_items (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace    text        NOT NULL,
  session_id   uuid        NOT NULL REFERENCES sessions(id),
  repo         text        NOT NULL,
  intent_text  text        NOT NULL,
  path_globs   text[]      NOT NULL,
  ttl_seconds  integer     NOT NULL,
  status       text        NOT NULL DEFAULT 'active', -- 'active' | 'released'
  expires_at   timestamptz NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  released_at  timestamptz
);

CREATE TABLE announcements (
  id                bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace         text        NOT NULL,
  repo              text        NOT NULL,
  from_session_id   uuid        NOT NULL REFERENCES sessions(id),
  target_agent_name text,                               -- null = broadcast
  body              text        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE announcement_deliveries (
  session_id      uuid        NOT NULL REFERENCES sessions(id),
  announcement_id bigint      NOT NULL REFERENCES announcements(id),
  delivered_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, announcement_id)
);

-- Indexes
CREATE INDEX ON work_items (workspace, repo, status, expires_at);
CREATE INDEX ON work_items (session_id, status);
CREATE INDEX ON sessions    (agent_id);
CREATE INDEX ON announcements (workspace, repo, id);
-- announcement_deliveries PK (session_id, announcement_id) is its own index
