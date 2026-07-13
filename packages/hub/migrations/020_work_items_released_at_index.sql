-- Migration 020: time-leading index for the work_items analytics queries.
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY. Safe to apply to a database that already ran
-- 001–019 — a single additive CREATE INDEX, no data change.
--
-- WHY: the analytics rollup (repo.ts getShepherdAnalytics) filters work_items
-- by released_at ALONE, cross-tenant — the claimsReleased period count, the
-- claims-released trend series, and the claim-duration percentiles. Migration
-- 017 added time-leading indexes for the other analytics tables with exactly
-- this rationale but skipped work_items; its existing indexes are
-- workspace-leading and cannot serve a time-only filter. Partial on
-- released_at IS NOT NULL because every one of those queries carries that
-- predicate, so active (unreleased) claims never bloat the index.
CREATE INDEX work_items_released_at_idx
  ON work_items (released_at)
  WHERE released_at IS NOT NULL;
