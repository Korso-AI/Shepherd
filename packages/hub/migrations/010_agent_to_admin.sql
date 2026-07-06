-- Migration 010: let an agent address an announcement to the human operator
-- (the dashboard), the mirror of the admin → agent DM added in 008.
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY. Safe to apply to a database that already ran
-- 001–009.
--
-- WHY: an agent reply to the operator is "not a broadcast and not aimed at any
-- agent". The existing per-agent delivery query treats a NULL target_agent_name
-- as a broadcast to everyone, so we cannot represent "for the operator only" by
-- target_agent_name alone. `to_admin` is a dedicated operator-namespace marker:
-- delivery to agents excludes it, while the dashboard's workspace feed shows it
-- (rendered as "<agent> → admin"). Today the operator is a singleton; this is
-- the single-operator degenerate case of future per-operator targeting.

ALTER TABLE announcements ADD COLUMN to_admin boolean NOT NULL DEFAULT false;
