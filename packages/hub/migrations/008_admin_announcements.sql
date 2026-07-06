-- Migration 008: allow announcements sent by the human operator (admin) from
-- the dashboard, which have no agent session behind them.
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY. Safe to apply to a database that already ran
-- 001–007.
--
-- WHY: every announcement until now referenced a real agent session via a
-- NOT NULL `from_session_id`. The operator watching the wallboard has no
-- session, so admin messages carry a NULL session, a `from_admin` flag, and a
-- `from_label` snapshot of the sender identity (the configured admin label
-- today; a real per-user identity once login lands). Agent messages are
-- unchanged: `from_session_id` set, `from_admin = false`, `from_label = NULL`.

ALTER TABLE announcements ALTER COLUMN from_session_id DROP NOT NULL;
ALTER TABLE announcements ADD COLUMN from_admin boolean NOT NULL DEFAULT false;
ALTER TABLE announcements ADD COLUMN from_label text;
