-- Migration 019: optional client context for feedback rows (feedback widget
-- v2). The widget silently attaches route / appVersion / userAgent / viewport;
-- older clients send nothing, so the column is nullable.
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no
-- COMMIT, no CREATE INDEX CONCURRENTLY. Safe to apply after 001-018.

ALTER TABLE feedback ADD COLUMN context jsonb;
