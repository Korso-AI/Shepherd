-- Migration 012: additive tenancy indexes (review findings P2.1–P2.3).
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY. Safe to apply to a database that already ran
-- 001–011 — every statement is a plain additive CREATE INDEX, no data change.
--
-- WHY: migration 011 re-keyed the coordination tables onto workspace_id and
-- recreated the indexes it had dropped on agents/work_items/announcements/
-- change_records — but it added NO index for three workspace-scoped access paths.
-- Each query below otherwise degrades into a scan that grows with the TOTAL
-- cross-tenant row count, not the tenant's own.

-- sessions (P2.1): liveAgentNamesInRepo (repo.ts — fires on every directed
-- announce) and listWorkspaceRepos (admin broadcast) filter sessions by
-- (workspace_id, repo) and by liveness (last_heartbeat_at). The only existing
-- sessions indexes are (agent_id) [001] and (last_heartbeat_at) [002]; neither
-- serves a workspace-scoped lookup. This composite covers the filter and the
-- liveness range in one.
CREATE INDEX sessions_workspace_id_repo_last_heartbeat_at_idx
  ON sessions (workspace_id, repo, last_heartbeat_at);

-- memberships (P2.2): the PK is (account_id, workspace_id), which cannot serve a
-- workspace-leading lookup. listMembers (the member roster) and countAdmins (the
-- last-admin guard) both filter `WHERE workspace_id = $1` alone and otherwise
-- scan the whole table. findMembership (account-leading) is already covered by
-- the PK.
CREATE INDEX memberships_workspace_id_idx
  ON memberships (workspace_id);

-- api_tokens (P2.3): only token_hash is indexed (UNIQUE — the auth hot path is
-- fine). listApiTokens (Config-tab load) and revokeApiTokensForMember (runs on
-- every member removal) filter on (workspace_id, account_id) and otherwise scan.
CREATE INDEX api_tokens_workspace_id_account_id_idx
  ON api_tokens (workspace_id, account_id);
