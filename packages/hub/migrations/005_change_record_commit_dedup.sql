-- Migration 005: deduplicate committed change records by commit identity.
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY. Safe to apply to a database that already ran
-- 001–004.
--
-- Model change (#6): a `committed` change record is now a per-COMMIT fact keyed
-- by (workspace, repo, branch, commit_sha), deduplicated across every agent that
-- reports it — not a per-agent snapshot row. The first agent to report a commit
-- owns the row (its agent_id / agent_name); later reporters only refresh
-- updated_at via UPSERT. `uncommitted` records stay per-agent (no sha, inherently
-- one ephemeral row per agent), so the dedup is scoped to committed rows only.

-- Step 1: collapse any pre-existing duplicate committed rows so the unique index
-- below can be created. Keep the EARLIEST row per (workspace, repo, branch,
-- commit_sha) — lowest updated_at, tie-broken by id — matching the
-- first-reporter-owns-it rule. Only touches committed rows with a non-null sha;
-- uncommitted rows (null sha) are left entirely alone.
DELETE FROM change_records dup
USING change_records keep
WHERE dup.kind = 'committed'
  AND keep.kind = 'committed'
  AND dup.commit_sha IS NOT NULL
  AND keep.commit_sha IS NOT NULL
  AND dup.workspace = keep.workspace
  AND dup.repo = keep.repo
  AND dup.branch = keep.branch
  AND dup.commit_sha = keep.commit_sha
  AND (
    dup.updated_at > keep.updated_at
    OR (dup.updated_at = keep.updated_at AND dup.id > keep.id)
  );

-- Step 2: enforce cross-reporter dedup going forward. A PARTIAL unique index so
-- it constrains committed rows only; uncommitted rows (null sha) are unaffected
-- and may freely coexist. replaceChangeRecords upserts against this index via
-- `ON CONFLICT (workspace, repo, branch, commit_sha) WHERE kind = 'committed'`.
CREATE UNIQUE INDEX change_records_committed_sha_key
  ON change_records (workspace, repo, branch, commit_sha)
  WHERE kind = 'committed';
