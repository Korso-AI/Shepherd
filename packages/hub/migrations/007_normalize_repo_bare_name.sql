-- Migration 007: normalize every stored `repo` to the bare repo name.
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY. Safe to apply to a database that already ran
-- 001–006.
--
-- WHY: the coordination key is the value the client reports for `repo`, matched
-- by EXACT string. The MCP client's detection diverged: a clone WITH an origin
-- remote reported `owner/repo` (and, before lowercasing landed, with original
-- case — e.g. `Acme/widgets`), while a clone WITHOUT an origin fell back to the
-- toplevel directory basename (`widgets`). Those never reconciled, so the same
-- repo split into multiple buckets on the dashboard and — worse — agents in the
-- different spellings were invisible to each other for conflict detection.
--
-- canonicalizeRepo (gitContext.ts) now reduces every source to the bare,
-- lowercased trailing segment so all spellings converge going forward. This
-- migration applies the SAME reduction to data already on the hub. The transform
-- mirrors the code: strip everything up to and including the last '/', drop a
-- trailing '.git', then lowercase. Idempotent — a row already in bare form is
-- left byte-for-byte unchanged (the WHERE guards skip no-op updates).
--
-- Tradeoff (documented on canonicalizeRepo): two distinct repos sharing a short
-- name under different owners collapse onto one key. For a coordination boundary
-- that is the safe error direction — a false merge is visible and self-
-- correcting; the false split it replaces silently hid teammates.

-- A SQL mirror of canonicalizeRepo's reduction, as an expression we reuse below.
--   regexp_replace(repo, '^.*/', '')  -> drop owner / nested groups (last segment)
--   regexp_replace(...,  '\.git$', '') -> drop a trailing .git, if any
--   lower(...)                         -> case-fold
-- (Stored detection output normally has no .git, but we strip it defensively so
-- any legacy raw-URL remnant still converges.)

-- Step 1: change_records first. Normalizing repo can make two committed rows
-- collide on the partial unique index change_records_committed_sha_key
-- (workspace, repo, branch, commit_sha) WHERE kind='committed' — e.g. the same
-- commit reported once under `Acme/widgets` and once under `widgets`. Collapse
-- those duplicates BEFORE the update, keeping the earliest row per post-
-- normalization key (lowest updated_at, tie-broken by id), matching 005's
-- first-reporter-owns-it rule. Only committed rows with a non-null sha are
-- constrained; uncommitted rows (null sha) cannot collide and are left alone.
DELETE FROM change_records dup
USING change_records keep
WHERE dup.kind = 'committed'
  AND keep.kind = 'committed'
  AND dup.commit_sha IS NOT NULL
  AND keep.commit_sha IS NOT NULL
  AND dup.workspace = keep.workspace
  AND dup.branch = keep.branch
  AND dup.commit_sha = keep.commit_sha
  AND lower(regexp_replace(regexp_replace(dup.repo,  '^.*/', ''), '\.git$', ''))
    = lower(regexp_replace(regexp_replace(keep.repo, '^.*/', ''), '\.git$', ''))
  AND (
    dup.updated_at > keep.updated_at
    OR (dup.updated_at = keep.updated_at AND dup.id > keep.id)
  );

UPDATE change_records
SET repo = lower(regexp_replace(regexp_replace(repo, '^.*/', ''), '\.git$', ''))
WHERE repo <> lower(regexp_replace(regexp_replace(repo, '^.*/', ''), '\.git$', ''));

-- Step 2: the remaining tables have no uniqueness on repo, so a plain rewrite.
UPDATE sessions
SET repo = lower(regexp_replace(regexp_replace(repo, '^.*/', ''), '\.git$', ''))
WHERE repo <> lower(regexp_replace(regexp_replace(repo, '^.*/', ''), '\.git$', ''));

UPDATE work_items
SET repo = lower(regexp_replace(regexp_replace(repo, '^.*/', ''), '\.git$', ''))
WHERE repo <> lower(regexp_replace(regexp_replace(repo, '^.*/', ''), '\.git$', ''));

UPDATE announcements
SET repo = lower(regexp_replace(regexp_replace(repo, '^.*/', ''), '\.git$', ''))
WHERE repo <> lower(regexp_replace(regexp_replace(repo, '^.*/', ''), '\.git$', ''));
