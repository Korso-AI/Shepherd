-- Migration 017: indexes for the operator analytics rollup (/admin/analytics).
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY. Safe to apply to a database that already ran
-- 001–016 — every statement is a plain additive CREATE INDEX, no data change.
--
-- WHY: the analytics rollup (repo.ts getShepherdAnalytics) is the first surface
-- to filter these tables by time alone, cross-tenant. Without indexes each of
-- these queries degrades into a full-table scan that grows with the TOTAL row
-- count across every tenant.

-- change_records: the 7d/30d engagement rollups filter on updated_at ALONE (no
-- kind predicate) and count DISTINCT workspace_id, and the commits trend groups
-- by day over updated_at. A plain updated_at-leading index serves both; adding
-- workspace_id as the second column lets the DISTINCT count run index-only.
-- (The existing (workspace_id, repo, updated_at) index from 004 is
-- workspace-leading and cannot serve a time-only filter.)
CREATE INDEX change_records_updated_at_workspace_id_idx
  ON change_records (updated_at, workspace_id);

-- Daily "new X" trend series: each groups its table by day over created_at,
-- filtered to the trend window.
CREATE INDEX account_profiles_created_at_idx
  ON account_profiles (created_at);

CREATE INDEX workspaces_created_at_idx
  ON workspaces (created_at);

CREATE INDEX sessions_created_at_idx
  ON sessions (created_at);
