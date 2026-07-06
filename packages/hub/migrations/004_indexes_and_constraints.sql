-- Migration 004: index + constraint hardening for the v2.1 identity / change
-- awareness work. Pure additive DDL, safe on a database that already ran 003.
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY.

-- PERF-4: `join` resolves the lowest free ordinal with a left-anchored prefix
-- match (`name LIKE handle || '-%'`) on EVERY join, plus once per retry. The
-- UNIQUE (workspace, name) b-tree only serves that prefix LIKE under C /
-- text_pattern_ops collation; under a default collation it falls back to a seq
-- scan. Add an explicit text_pattern_ops index so the hot-path prefix scan is
-- index-backed regardless of the database's collation.
CREATE INDEX agents_workspace_name_pattern_idx
  ON agents (workspace, name text_pattern_ops);

-- MIG-L1: the wire contract requires every change_records row to carry at least
-- one path glob (ChangeReportEntry.paths.min(1) inbound, ChangeRecord.paths.min(1)
-- outbound), but the column itself only said NOT NULL — an empty array `{}` would
-- satisfy that and then fail the outbound parse, dropping the whole landscape.
-- Enforce the ≥1 invariant at the DB level, mirroring the existing `kind` CHECK.
ALTER TABLE change_records
  ADD CONSTRAINT change_records_path_globs_nonempty
  CHECK (cardinality(path_globs) > 0);

-- MIG-M1: change_records are a wholesale per-agent snapshot (replaceChangeRecords
-- deletes-then-inserts by agent_id). The 003 FK defaulted to ON DELETE NO ACTION,
-- so any future agent-row GC would 23503-fail unless records were cleared first.
-- Agent rows are immortal today, but CASCADE matches the snapshot model and
-- future-proofs deletion. Recreate the FK with ON DELETE CASCADE.
ALTER TABLE change_records
  DROP CONSTRAINT IF EXISTS change_records_agent_id_fkey;
ALTER TABLE change_records
  ADD CONSTRAINT change_records_agent_id_fkey
  FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE;
