-- Migration 002: tighten constraints + add the staleness index.
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY. Safe to apply to a database that already ran 001.

-- work_items.status is only ever 'active' or 'released'; every query hard-codes
-- those two values. Constrain it so a typo'd write fails loudly instead of
-- silently making a claim invisible to listActiveClaims.
ALTER TABLE work_items
  ADD CONSTRAINT work_items_status_check
  CHECK (status IN ('active', 'released'));

-- The staleness filter (s.last_heartbeat_at > now - STALE_AFTER_SECONDS) is a
-- per-row post-join check in listActiveClaims. Index it so the planner can use
-- it as session counts grow.
CREATE INDEX sessions_last_heartbeat_at_idx
  ON sessions (last_heartbeat_at);
