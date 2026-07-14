-- Migration 021: row-level security — make the Phase 1 context GUCs ENFORCED.
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY. Safe to apply after 001-020. Domain DDL uses
-- bare CREATE (no IF NOT EXISTS) so a genuine duplicate-object conflict stays
-- loud; the runner records 021 so it only executes once.
--
-- WHAT: Phase 1 (scopedDb.ts) routes every request-serving query through
-- `withContext`, which opens a transaction and sets three transaction-local
-- GUCs — `app.context`, `app.workspace_id`, `app.account_id` (plus a fourth,
-- `app.invite_code`, added by this task). Until now those GUCs were INERT. This
-- migration installs the `app_context()` / `app_workspace_id()` / `app_account_id()`
-- / `app_invite_code()` SQL helpers that read them, then ENABLEs + FORCEs RLS on
-- every application table with per-context policies, turning the GUCs into the
-- actual tenant-isolation wall.
--
-- PER-DATABASE APP ROLE: policies are FORCEd (they bind even to the table
-- owner), so a two-role deployment serves requests as a NOLOGIN role named
-- `<database>_app` (derived from current_database() so a shared cluster gets one
-- role per database, no cross-database grant bleed). The role is created here
-- and granted exactly the DML the hub needs — never BYPASSRLS, never LOGIN. When
-- the connecting user lacks CREATEROLE, role creation is skipped with a WARNING
-- and the hub keeps serving on its single connection: FORCE RLS still binds a
-- non-superuser owner (the policies are LIVE for it); only a superuser or
-- BYPASSRLS connection leaves them inert. If the skip fired, the role and its
-- grants must be provisioned manually before the two-role upgrade — docs/rls.md
-- carries the exact SQL.
--
-- SUPERUSER BYPASS: a SUPERUSER (and any BYPASSRLS role) ignores RLS entirely,
-- even with FORCE. The disposable test pool connects as `postgres` (superuser),
-- so the coverage meta-test (test/rls.coverage.test.ts) audits the catalog
-- shape — enabled/forced/policies/grants — rather than probing enforcement;
-- the as-the-app-role isolation suite (Task 8/9) proves enforcement.
--
-- CONTEXTS (the DbContext union in scopedDb.ts; every kind maps to policy arms):
--   workspace   — a resolved request pinned to one workspace.
--   account     — account-surface routes; may FOCUS one workspace after proving
--                 a capability (an invite code, the caller's own membership).
--   auth        — resolveTenant's pre-tenant lookups + createWorkspace's global
--                 slug probe.
--   internal    — the /internal/* entitlements surface (BFF service call).
--   operator    — /admin/* read-only cross-tenant analytics.
--   maintenance — boot-time self-host seeding.
--
-- LOUD FAILURE: `app_context()` RAISEs when `app.context` is unset — a query
-- that reached a policied table WITHOUT going through withContext is a bug, and
-- we want it to explode, not silently return zero rows. The id helpers instead
-- NULLIF empty→NULL, and `col = NULL` is never true, so an id-less (or
-- wrong-context) query fails CLOSED to zero rows rather than leaking.

-- ---------------------------------------------------------------------------
-- The per-database app role
-- ---------------------------------------------------------------------------

DO $do$
DECLARE
  app_role text := current_database() || '_app';
  unsafe   text;
  members  text;
BEGIN
  -- Postgres truncates identifiers at 63 BYTES (not characters). A multibyte
  -- database name can pass a character-count check, then CREATE ROLE silently
  -- truncates the name and the exact pg_roles lookup in the grant block below
  -- misses it — the migration would commit with NO grants. Measure in bytes.
  IF octet_length(app_role) > 63 THEN
    RAISE EXCEPTION 'database name "%" is too long to derive the app role name ("%" exceeds 63 bytes)',
      current_database(), app_role;
  END IF;
  BEGIN
    EXECUTE format('CREATE ROLE %I NOLOGIN', app_role);
  EXCEPTION
    WHEN duplicate_object THEN
      -- Roles are CLUSTER-level, so a role by this name can pre-exist this
      -- database: a recreated same-name database, a dump restored next to its
      -- old role — or a squatter on a shared cluster. The grant block below
      -- hands this role all app DML, so refuse any pre-existing role whose
      -- attributes exceed what this migration would have created.
      SELECT concat_ws(', ',
               CASE WHEN rolcanlogin   THEN 'LOGIN'      END,
               CASE WHEN rolsuper      THEN 'SUPERUSER'  END,
               CASE WHEN rolbypassrls  THEN 'BYPASSRLS'  END,
               CASE WHEN rolcreaterole THEN 'CREATEROLE' END,
               CASE WHEN rolcreatedb   THEN 'CREATEDB'   END)
        INTO unsafe
      FROM pg_roles WHERE rolname = app_role;
      IF unsafe <> '' THEN
        RAISE EXCEPTION 'pre-existing role "%" has unsafe attributes (%) — drop or strip it before applying this migration',
          app_role, unsafe;
      END IF;
      -- Existing memberships can be legitimate (a two-role deployment's login
      -- user, the test harness login) but deserve an audit line: everyone in
      -- this group is about to inherit the app grants.
      SELECT string_agg(m.rolname, ', ') INTO members
      FROM pg_auth_members am
      JOIN pg_roles g ON g.oid = am.roleid
      JOIN pg_roles m ON m.oid = am.member
      WHERE g.rolname = app_role;
      IF members IS NOT NULL THEN
        RAISE WARNING 'role "%" already existed with members: % — they inherit the app grants',
          app_role, members;
      END IF;
    WHEN insufficient_privilege THEN
      RAISE WARNING '% role not created (insufficient privilege) — single-role mode; docs/rls.md has the SQL to provision it later', app_role;
  END;
END
$do$;

-- ---------------------------------------------------------------------------
-- Context helper functions (read the transaction-local GUCs)
-- ---------------------------------------------------------------------------

CREATE FUNCTION app_context() RETURNS text
LANGUAGE plpgsql STABLE AS $$
DECLARE v text := NULLIF(current_setting('app.context', true), '');
BEGIN
  IF v IS NULL THEN
    RAISE EXCEPTION 'app.context is not set — run queries through withContext() (src/scopedDb.ts)';
  END IF;
  RETURN v;
END $$;

CREATE FUNCTION app_workspace_id() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid
$$;

CREATE FUNCTION app_account_id() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.account_id', true), '')
$$;

-- The invite code capability GUC (Task 7 amendment 3). invites carry an `email`
-- column (018), so an unscoped account-context SELECT would make invitee emails
-- enumerable. The account-context invite arms below match on code = this GUC;
-- unset → NULL → `code = NULL` never true → fail closed. scopedDb.ts sets it on
-- EVERY re-scope so a widening can never inherit a stale code.
CREATE FUNCTION app_invite_code() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.invite_code', true), '')
$$;

-- ---------------------------------------------------------------------------
-- Grants to the app role (guarded: only when the role exists)
-- ---------------------------------------------------------------------------

DO $do$
DECLARE
  app_role text := current_database() || '_app';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = app_role) THEN
    EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', app_role);
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION app_context(), app_workspace_id(), app_account_id(), app_invite_code() TO %I',
      app_role);
    -- Least-privilege DML: each table gets ONLY the verbs the serving code
    -- issues (repo.ts is the ground truth; rls.coverage.test.ts pins this map
    -- both ways — a missing verb breaks the app-role suite, an extra verb
    -- fails the catalog audit). RLS is the row-level wall; these grants are an
    -- independent verb-level wall, so a future over-broad policy has the
    -- smallest possible blast radius. Deliberately NOT granted:
    --   invites DELETE       — workspace deletion rides the FK cascade, which
    --                          runs as the table owner;
    --   feedback UPDATE/DELETE — the workspace detach is the FK's ON DELETE
    --                          SET NULL; src never updates/deletes feedback;
    --   agents / announcements / announcement_deliveries UPDATE — insert-and-
    --                          delete lifecycles, never updated in place.
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON
         sessions, work_items, change_records, workspaces, memberships,
         api_tokens, account_profiles, workspace_entitlements
       TO %I', app_role);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON invites TO %I', app_role);
    EXECUTE format(
      'GRANT SELECT, INSERT, DELETE ON agents, announcements, announcement_deliveries TO %I',
      app_role);
    EXECUTE format('GRANT SELECT, INSERT ON feedback TO %I', app_role);
    -- schema_migrations: SELECT ONLY (amendment 1). Boot's assertMigrationsCurrent
    -- (migrate.ts) reads `SELECT version FROM schema_migrations` on the SERVING
    -- pool, so the app role needs to read it in two-role deployments — but the
    -- migration RUNNER (owner connection) is the sole writer, so NEVER grant
    -- INSERT/UPDATE/DELETE, and RLS stays OFF on it.
    EXECUTE format('GRANT SELECT ON schema_migrations TO %I', app_role);
    EXECUTE format('GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO %I', app_role);
  END IF;
END
$do$;

-- PostgreSQL 15 removed PUBLIC's default CREATE on the public schema, but a
-- database upgraded or restored from an older cluster KEEPS the old ACL — under
-- which any role (the app role included) could create persistent objects in
-- public, undoing the two-role guarantee that the request path cannot install
-- a schema backdoor. No-op on fresh PG15+ databases. The owner keeps CREATE
-- through schema ownership; only the blanket PUBLIC grant goes.
DO $do$
BEGIN
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE WARNING 'could not REVOKE CREATE ON SCHEMA public FROM PUBLIC (not the schema owner) — run it manually as the owner';
END
$do$;

-- ===== Coordination tables =====
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
CREATE POLICY agents_workspace ON agents FOR ALL
  USING (app_context() = 'workspace' AND workspace_id = app_workspace_id())
  WITH CHECK (app_context() = 'workspace' AND workspace_id = app_workspace_id());
CREATE POLICY agents_account_read ON agents FOR SELECT
  USING (app_context() = 'account' AND EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.workspace_id = agents.workspace_id AND m.account_id = app_account_id()));
CREATE POLICY agents_operator_read ON agents FOR SELECT
  USING (app_context() = 'operator');

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_workspace ON sessions FOR ALL
  USING (app_context() = 'workspace' AND workspace_id = app_workspace_id())
  WITH CHECK (app_context() = 'workspace' AND workspace_id = app_workspace_id());
CREATE POLICY sessions_account_read ON sessions FOR SELECT
  USING (app_context() = 'account' AND EXISTS (
    SELECT 1 FROM memberships m
    WHERE m.workspace_id = sessions.workspace_id AND m.account_id = app_account_id()));
CREATE POLICY sessions_internal_read ON sessions FOR SELECT
  USING (app_context() = 'internal' AND workspace_id = app_workspace_id());
CREATE POLICY sessions_operator_read ON sessions FOR SELECT
  USING (app_context() = 'operator');

ALTER TABLE work_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE work_items FORCE ROW LEVEL SECURITY;
CREATE POLICY work_items_workspace ON work_items FOR ALL
  USING (app_context() = 'workspace' AND workspace_id = app_workspace_id())
  WITH CHECK (app_context() = 'workspace' AND workspace_id = app_workspace_id());
CREATE POLICY work_items_operator_read ON work_items FOR SELECT
  USING (app_context() = 'operator');

ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcements FORCE ROW LEVEL SECURITY;
CREATE POLICY announcements_workspace ON announcements FOR ALL
  USING (app_context() = 'workspace' AND workspace_id = app_workspace_id())
  WITH CHECK (app_context() = 'workspace' AND workspace_id = app_workspace_id());
CREATE POLICY announcements_operator_read ON announcements FOR SELECT
  USING (app_context() = 'operator');

ALTER TABLE change_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_records FORCE ROW LEVEL SECURITY;
CREATE POLICY change_records_workspace ON change_records FOR ALL
  USING (app_context() = 'workspace' AND workspace_id = app_workspace_id())
  WITH CHECK (app_context() = 'workspace' AND workspace_id = app_workspace_id());
CREATE POLICY change_records_operator_read ON change_records FOR SELECT
  USING (app_context() = 'operator');

ALTER TABLE announcement_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE announcement_deliveries FORCE ROW LEVEL SECURITY;
-- BOTH ends of a delivery must be in-context: the session arm alone would let a
-- caller link its own session to ANOTHER workspace's announcement — heartbeat's
-- ackAnnouncementIds is client-supplied and announcement ids are sequential, so
-- a forged ack could corrupt a neighbour's delivery ledger (and, via the FK,
-- block its retention prune). The FK cannot be the wall here: referential
-- checks run as the table owner and bypass RLS.
CREATE POLICY announcement_deliveries_workspace ON announcement_deliveries FOR ALL
  USING (app_context() = 'workspace'
    AND EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_id AND s.workspace_id = app_workspace_id())
    AND EXISTS (
      SELECT 1 FROM announcements a
      WHERE a.id = announcement_id AND a.workspace_id = app_workspace_id()))
  WITH CHECK (app_context() = 'workspace'
    AND EXISTS (
      SELECT 1 FROM sessions s
      WHERE s.id = session_id AND s.workspace_id = app_workspace_id())
    AND EXISTS (
      SELECT 1 FROM announcements a
      WHERE a.id = announcement_id AND a.workspace_id = app_workspace_id()));
CREATE POLICY announcement_deliveries_operator_read ON announcement_deliveries FOR SELECT
  USING (app_context() = 'operator');

-- ===== workspace_entitlements =====
ALTER TABLE workspace_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY workspace_entitlements_internal ON workspace_entitlements FOR ALL
  USING (app_context() = 'internal' AND workspace_id = app_workspace_id())
  WITH CHECK (app_context() = 'internal' AND workspace_id = app_workspace_id());
CREATE POLICY workspace_entitlements_workspace_read ON workspace_entitlements FOR SELECT
  USING (app_context() = 'workspace' AND workspace_id = app_workspace_id());
CREATE POLICY workspace_entitlements_account_read ON workspace_entitlements FOR SELECT
  USING (app_context() = 'account' AND workspace_id = app_workspace_id());
CREATE POLICY workspace_entitlements_operator_read ON workspace_entitlements FOR SELECT
  USING (app_context() = 'operator');

-- ===== Tenancy tables =====
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY workspaces_workspace ON workspaces FOR ALL
  USING (app_context() = 'workspace' AND id = app_workspace_id())
  WITH CHECK (app_context() = 'workspace' AND id = app_workspace_id());
CREATE POLICY workspaces_account_read ON workspaces FOR SELECT
  USING (app_context() = 'account' AND (
    id = app_workspace_id()
    OR created_by = app_account_id()
    OR EXISTS (SELECT 1 FROM memberships m
               WHERE m.workspace_id = workspaces.id AND m.account_id = app_account_id())));
CREATE POLICY workspaces_account_insert ON workspaces FOR INSERT
  WITH CHECK (app_context() = 'account' AND created_by = app_account_id());
CREATE POLICY workspaces_auth_read ON workspaces FOR SELECT
  USING (app_context() = 'auth');
CREATE POLICY workspaces_internal_read ON workspaces FOR SELECT
  USING (app_context() = 'internal' AND id = app_workspace_id());
CREATE POLICY workspaces_maintenance ON workspaces FOR ALL
  USING (app_context() = 'maintenance')
  WITH CHECK (app_context() = 'maintenance');
CREATE POLICY workspaces_operator_read ON workspaces FOR SELECT
  USING (app_context() = 'operator');

ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_workspace ON memberships FOR ALL
  USING (app_context() = 'workspace' AND workspace_id = app_workspace_id())
  WITH CHECK (app_context() = 'workspace' AND workspace_id = app_workspace_id());
CREATE POLICY memberships_account_read ON memberships FOR SELECT
  USING (app_context() = 'account' AND (
    account_id = app_account_id() OR workspace_id = app_workspace_id()));
CREATE POLICY memberships_account_insert ON memberships FOR INSERT
  WITH CHECK (app_context() = 'account'
    AND account_id = app_account_id() AND workspace_id = app_workspace_id());
CREATE POLICY memberships_account_update ON memberships FOR UPDATE
  USING (app_context() = 'account'
    AND account_id = app_account_id() AND workspace_id = app_workspace_id())
  WITH CHECK (app_context() = 'account'
    AND account_id = app_account_id() AND workspace_id = app_workspace_id());
CREATE POLICY memberships_account_delete ON memberships FOR DELETE
  USING (app_context() = 'account' AND account_id = app_account_id());
CREATE POLICY memberships_internal_read ON memberships FOR SELECT
  USING (app_context() = 'internal' AND workspace_id = app_workspace_id());
CREATE POLICY memberships_auth_read ON memberships FOR SELECT
  USING (app_context() = 'auth' AND account_id = app_account_id());
CREATE POLICY memberships_operator_read ON memberships FOR SELECT
  USING (app_context() = 'operator');

ALTER TABLE api_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_tokens FORCE ROW LEVEL SECURITY;
-- SELECT stays UNSCOPED: the hash lookup (findApiTokenByHash) happens BEFORE the
-- caller's identity is known, so there is no account to scope by yet.
CREATE POLICY api_tokens_auth ON api_tokens FOR SELECT
  USING (app_context() = 'auth');
-- The last-used touch runs AFTER setDbContext widened the auth context with the
-- token row's account (tenant.ts), so scope it (amendment 2a): an auth-context
-- UPDATE may only touch the caller's own token rows.
CREATE POLICY api_tokens_auth_touch ON api_tokens FOR UPDATE
  USING (app_context() = 'auth' AND account_id = app_account_id())
  WITH CHECK (app_context() = 'auth' AND account_id = app_account_id());
CREATE POLICY api_tokens_workspace ON api_tokens FOR ALL
  USING (app_context() = 'workspace' AND workspace_id = app_workspace_id())
  WITH CHECK (app_context() = 'workspace' AND workspace_id = app_workspace_id());
CREATE POLICY api_tokens_account ON api_tokens FOR ALL
  USING (app_context() = 'account' AND account_id = app_account_id())
  WITH CHECK (app_context() = 'account' AND account_id = app_account_id());
-- Operator context DOES read api_tokens: the /admin analytics rollup
-- (getShepherdAnalytics, repo.ts) counts live vs revoked tokens cluster-wide, a
-- cross-tenant aggregate with no single workspace/account to scope by — so this
-- operator SELECT arm is load-bearing. The only production operator reads are
-- count(*) aggregates; RLS cannot scope by column, so the token-hash exposure
-- this row-level grant technically permits is theoretical (no operator query
-- selects the hash).
CREATE POLICY api_tokens_operator_read ON api_tokens FOR SELECT
  USING (app_context() = 'operator');

ALTER TABLE invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites FORCE ROW LEVEL SECURITY;
CREATE POLICY invites_workspace ON invites FOR ALL
  USING (app_context() = 'workspace' AND workspace_id = app_workspace_id())
  WITH CHECK (app_context() = 'workspace' AND workspace_id = app_workspace_id());
-- Account-context invite access is CODE-SCOPED (amendment 3): a redeemer proves
-- possession of a specific code, never enumerates. invites carry an `email`
-- (018) — an unscoped account SELECT would leak invitee addresses. GUC unset →
-- app_invite_code() NULL → `code = NULL` never true → fail closed.
CREATE POLICY invites_account_read ON invites FOR SELECT
  USING (app_context() = 'account' AND code = app_invite_code());
CREATE POLICY invites_account_use ON invites FOR UPDATE
  USING (app_context() = 'account' AND code = app_invite_code())
  WITH CHECK (app_context() = 'account' AND code = app_invite_code());
CREATE POLICY invites_operator_read ON invites FOR SELECT
  USING (app_context() = 'operator');

ALTER TABLE account_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_profiles FORCE ROW LEVEL SECURITY;
-- auth-context profile access is SCOPED to the caller's account (amendment 2b):
-- the only auth-context profile use is upsertAccountProfile, which always runs
-- with the accountId in context. An unscoped FOR ALL would let the pre-tenant
-- auth context read/write any account's profile row.
CREATE POLICY account_profiles_auth ON account_profiles FOR ALL
  USING (app_context() = 'auth' AND account_id = app_account_id())
  WITH CHECK (app_context() = 'auth' AND account_id = app_account_id());
CREATE POLICY account_profiles_account ON account_profiles FOR ALL
  USING (app_context() = 'account' AND account_id = app_account_id())
  WITH CHECK (app_context() = 'account' AND account_id = app_account_id());
-- A workspace context may read a profile only when it is the caller's OWN
-- account, or the profile's account is a CURRENT member of the caller's
-- workspace (roster display: listMembers, landscape human names). An unscoped
-- `app_context() = 'workspace'` would expose every account's email to any
-- workspace credential. A former member who has left the workspace no longer
-- passes the EXISTS — their name intentionally falls back to the raw id in any
-- lingering reference, rather than leaking their profile cross-tenant.
CREATE POLICY account_profiles_workspace_read ON account_profiles FOR SELECT
  USING (app_context() = 'workspace'
    AND (account_id = app_account_id()
      OR EXISTS (
        SELECT 1 FROM memberships m
        WHERE m.account_id = account_profiles.account_id
          AND m.workspace_id = app_workspace_id())));
CREATE POLICY account_profiles_operator_read ON account_profiles FOR SELECT
  USING (app_context() = 'operator');

ALTER TABLE feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY feedback_workspace_insert ON feedback FOR INSERT
  WITH CHECK (app_context() = 'workspace'
    AND (workspace_id = app_workspace_id() OR workspace_id IS NULL));
CREATE POLICY feedback_account_insert ON feedback FOR INSERT
  WITH CHECK (app_context() = 'account' AND workspace_id IS NULL);
-- No UPDATE policy on feedback is DELIBERATE: the only workspace_id mutation is
-- the workspace→NULL detach on workspace deletion, which is the FK's ON DELETE
-- SET NULL (migration 014). FK referential actions bypass RLS, so no UPDATE arm
-- is needed; src never issues an `UPDATE feedback`.
-- submitFeedback inserts with RETURNING id, and Postgres evaluates the SELECT
-- policies against an INSERT's RETURNING output — so the SUBMITTING context must
-- be able to read the row it just wrote, or the insert fails with an RLS
-- violation. These arms exist for that INSERT...RETURNING back-read, NOT for any
-- user-facing feedback browse (there is none), so each is EXACTLY the shape its
-- insert arm can produce and nothing wider. In particular the workspace arm's
-- account disjunct is pinned to workspace-less rows: a bare
-- `OR account_id = app_account_id()` would let workspace A read the same
-- account's feedback submitted in workspace B.
CREATE POLICY feedback_workspace_read ON feedback FOR SELECT
  USING (app_context() = 'workspace'
    AND (workspace_id = app_workspace_id()
      OR (workspace_id IS NULL AND account_id = app_account_id())));
CREATE POLICY feedback_account_read ON feedback FOR SELECT
  USING (app_context() = 'account'
    AND workspace_id IS NULL AND account_id = app_account_id());
CREATE POLICY feedback_operator_read ON feedback FOR SELECT
  USING (app_context() = 'operator');

-- ===== Prune-path indexes (amendment 4) =====
-- The announcement prune runs inside `work`'s advisory-lock window, so these
-- back its delete scans: deliveries by announcement, announcements by workspace
-- + age. The announcements index carries `id` as its last column because the
-- prune reads `ORDER BY created_at, id LIMIT n` (repo.ts pruneAnnouncements):
-- the index provides that order within the workspace, so the scan STOPS after
-- n rows instead of top-N-sorting the whole expired backlog on every pass.
--
-- Plain (non-CONCURRENT) CREATE INDEX — this file is one transaction. NOTE: the
-- ENABLE/FORCE statements above hold ACCESS EXCLUSIVE locks on EVERY app table
-- until this transaction commits, and these two builds run at its end, each
-- scanning its whole table — so a large pre-existing announcements OR
-- announcement_deliveries table stretches the all-table lock window. A
-- deployment with big tables should pre-build BOTH exact index names with
-- CREATE INDEX CONCURRENTLY (outside this transaction) before applying 021;
-- IF NOT EXISTS then makes these no-ops. The explicit names + IF NOT EXISTS
-- deliberately deviate from this file's bare-DDL convention: an UNNAMED create
-- can never no-op (Postgres would auto-suffix a duplicate and build it under
-- the lock anyway).
CREATE INDEX IF NOT EXISTS announcement_deliveries_announcement_id_idx
  ON announcement_deliveries (announcement_id);
CREATE INDEX IF NOT EXISTS announcements_workspace_id_created_at_id_idx
  ON announcements (workspace_id, created_at, id);
