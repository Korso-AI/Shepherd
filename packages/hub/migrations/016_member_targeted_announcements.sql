-- Migration 016: let an agent address an announcement to a SPECIFIC workspace
-- member (a dashboard user), generalising migration 010's single-operator
-- to_admin flag — its comment anticipated exactly this: "Today the operator is
-- a singleton; this is the single-operator degenerate case of future
-- per-operator targeting."
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY. Safe to apply to a database that already ran
-- 001–015.
--
-- WHY: workspaces now hold multiple accounts, so "reply to the operator"
-- (to_admin) can no longer identify WHO a message is for. A member-directed
-- message keeps to_admin = true (so the existing agent-delivery exclusion
-- keeps it out of every agent's inbox) and additionally records:
--
--   target_account_id — the member's account id (text, matching memberships/
--                       account_profiles convention; no FK — profiles are a
--                       best-effort snapshot table).
--   target_label      — a render-ready snapshot of the member's display name
--                       at send time (the from_label pattern), so the feed
--                       shows "→ alice" without a join and survives profile
--                       changes or member removal.
--
-- Legacy rows (and legacy toAdmin sends) have both NULL: "to the operators,
-- whoever they are" — rendered as the old "→ admin".

ALTER TABLE announcements ADD COLUMN target_account_id text;
ALTER TABLE announcements ADD COLUMN target_label text;
