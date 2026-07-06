-- Migration 013: invites.max_uses becomes nullable.
--
-- WHY: the code/link invite's default cap (25 uses) is being replaced with
-- unlimited-until-revoked — an admin shares a link and it works until they
-- explicitly revoke it, rather than silently dying at use #26. NULL now means
-- "no cap"; incrementInviteUse's atomic guard (repo.ts) treats it as such.
-- Existing rows keep their concrete cap — this migration only relaxes the
-- constraint, it does not rewrite any data.
ALTER TABLE invites ALTER COLUMN max_uses DROP NOT NULL;
