-- Migration 015: account-scoped API tokens.
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY. Safe to apply to a database that already ran
-- 001-014.
--
-- WHAT: drop the NOT NULL on api_tokens.workspace_id so a token can be
-- ACCOUNT-scoped (workspace_id IS NULL) rather than locked to one workspace. A
-- NULL FK is valid and unconstrained, which is exactly the "not bound to any
-- workspace" semantic; existing non-null rows keep behaving as workspace-locked
-- tokens. The workspaces(id) FK and the token_hash UNIQUE constraint are
-- unchanged (a NULL foreign key simply skips the reference check).

ALTER TABLE api_tokens ALTER COLUMN workspace_id DROP NOT NULL;
