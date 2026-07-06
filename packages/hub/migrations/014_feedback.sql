-- Migration 014: feedback capture for the limited-release "give feedback"
-- widget.
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY. Safe to apply to a database that already ran
-- 001-013.
--
-- WHY nullable workspace_id/account_id: submitFeedback accepts ANY resolved
-- tenant (self-host TEAM_TOKEN, an agent shp_ token, or a hosted browser call
-- with no route-derived workspace) rather than requiring one, so the row
-- captures whatever identity/workspace context happened to be present instead
-- of rejecting a submission that lacks it. ON DELETE SET NULL (rather than
-- CASCADE) so deleting a workspace never destroys feedback history.

CREATE TABLE feedback (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid        REFERENCES workspaces(id) ON DELETE SET NULL,
  account_id   text,
  type         text        NOT NULL CHECK (type IN ('bug', 'suggestion', 'other')),
  body         text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
