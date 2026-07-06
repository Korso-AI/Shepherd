-- Migration 006: index the dashboard history query's dominant case.
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY.
--
-- PERF: getWorkspaceLandscape's history query selects released ("done") OR
-- stale-unreleased ("dropped") work_items, ORDER BY COALESCE(released_at,
-- last_heartbeat_at) DESC, LIMIT 100. The COALESCE spans two tables so the sort
-- itself can't be fully index-driven, but the dominant + monotonically growing
-- branch is the released set (done tasks accumulate; dropped is a small live
-- subset). A partial index on released rows lets the planner walk done tasks in
-- released_at order instead of scanning every work_item in the workspace and
-- sorting. The existing work_items (workspace, repo, status, expires_at) index
-- only offered the `workspace` prefix for this predicate.
CREATE INDEX work_items_released_idx
  ON work_items (workspace, released_at DESC)
  WHERE released_at IS NOT NULL;
