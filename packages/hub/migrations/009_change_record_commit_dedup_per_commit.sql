-- Migration 009: make committed change-record dedup PER-COMMIT (drop `branch`).
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY. Safe to apply to a database that already ran
-- 001–008.
--
-- WHY: migration 005 keyed committed dedup on (workspace, repo, branch,
-- commit_sha), but a committed record is meant to be a per-COMMIT fact (its
-- docstring in repo.ts says so). Including `branch` meant the SAME commit reported
-- under two branch labels (e.g. once on `feat/x`, again on `main` after a merge)
-- produced TWO rows for one commit, and "first-reporter-owns" was tracked per
-- branch. Viewer-side resolution (isAncestor) is branch-agnostic, so the dupes
-- were harmless to readers, but the stored model contradicted its own contract.
-- This drops `branch` from the key so dedup is truly per-commit. `branch` stays a
-- column for display; it just no longer participates in identity.

-- Step 1: collapse committed rows that would now collide on (workspace, repo,
-- commit_sha) — i.e. the same commit recorded under different branches. Keep the
-- EARLIEST row per key (lowest updated_at, tie-broken by id), matching 005's
-- first-reporter-owns-it rule. Only committed rows with a non-null sha are
-- constrained; uncommitted rows (null sha) cannot collide and are left alone.
DELETE FROM change_records dup
USING change_records keep
WHERE dup.kind = 'committed'
  AND keep.kind = 'committed'
  AND dup.commit_sha IS NOT NULL
  AND keep.commit_sha IS NOT NULL
  AND dup.workspace = keep.workspace
  AND dup.repo = keep.repo
  AND dup.commit_sha = keep.commit_sha
  AND (
    dup.updated_at > keep.updated_at
    OR (dup.updated_at = keep.updated_at AND dup.id > keep.id)
  );

-- Step 2: swap the partial unique index for the per-commit one. replaceChangeRecords
-- upserts against this via `ON CONFLICT (workspace, repo, commit_sha) WHERE kind =
-- 'committed'`.
DROP INDEX change_records_committed_sha_key;

CREATE UNIQUE INDEX change_records_committed_sha_key
  ON change_records (workspace, repo, commit_sha)
  WHERE kind = 'committed';
