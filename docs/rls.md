# Row-level security

Every row the hub serves is scoped to the request's workspace or account by
Postgres **row-level security** (RLS), not by the application's `WHERE` clauses
alone. This is defense in depth: `packages/hub/src/repo.ts` already filters
every query by the resolved `workspace_id`, and RLS is the floor underneath it.
A query that forgets its scope returns **nothing** instead of leaking another
workspace's rows, and a write that forgets its scope touches **nothing**
instead of corrupting a neighbour.

> **Honest scope.** RLS hardens against constrained SQL injection and
> application bugs — a mistake in a `WHERE` clause, an operation that skipped
> the context door, an injection that can only append to an existing query. It
> is **not** a wall against an attacker who already has arbitrary SQL on the app
> connection: the context is carried in session GUCs the connection can set for
> itself, so full SQL can forge any context. The remaining win of the two-role
> model (below) is structural: the app role can read and write rows but
> **cannot** `ALTER`/`DROP` the policies, change table ownership, or install a
> schema backdoor. Isolation of tenants from each other is enforced; isolation
> from a fully-compromised app connection is not the claim.

## How it works

Request-serving code reaches the database through exactly one door,
`withContext` / `ScopedDb` in
[`packages/hub/src/scopedDb.ts`](../packages/hub/src/scopedDb.ts). The door is
compile-enforced: repository functions accept only the branded `ScopedDb`
handle, and `withContext` is the only thing that mints one. A query that skipped
context-setting is therefore a **type error**, not a latent cross-tenant bug.

`withContext` opens a transaction and sets four transaction-local GUCs that the
policies read back through SQL helper functions:

| GUC                | Helper               | Meaning                                        |
| ------------------ | -------------------- | ---------------------------------------------- |
| `app.context`      | `app_context()`      | which context kind is in force                 |
| `app.workspace_id` | `app_workspace_id()` | the workspace the request is pinned/focused on |
| `app.account_id`   | `app_account_id()`   | the acting account                             |
| `app.invite_code`  | `app_invite_code()`  | the exact invite code being redeemed           |

The GUCs are set `is_local = true`, so they vanish at `COMMIT`/`ROLLBACK` and can
never leak across pooled connections.

**Failure is loud where it must be and closed everywhere else.**
`app_context()` **raises** when `app.context` is unset, so a query that runs
outside `withContext` errors immediately instead of silently returning zero
rows. The id helpers instead return `NULL` when unset, and `col = NULL` is never
true, so any id comparison in a policy **fails closed** to zero rows rather than
opening up.

### The six contexts

`withContext` takes one of six context kinds. Each maps to a set of policy arms;
the module header in `scopedDb.ts` is the authoritative description.

- **workspace** — a resolved request pinned to one workspace. The common case:
  agents and browser sessions acting inside their workspace.
- **account** — the account surface (list/create workspaces, tokens, invite
  redemption, account deletion). An account context may additionally **focus**
  one workspace after validating a capability — an invite code, or the caller's
  own membership — to unlock that workspace's membership and entitlement reads
  **without** granting full workspace powers. Invite reads and updates in
  account context are further pinned to the exact invite code being redeemed
  (`app.invite_code`), so redeeming one invite never exposes another.
- **auth** — `resolveTenant`'s pre-tenant lookups, which run before a workspace
  is known (the chicken-and-egg of resolving who you are), plus one sanctioned
  post-auth use: `createWorkspace`'s global slug-uniqueness probe (an account
  context would hide other tenants' slugs and break suffixing).
- **internal** — the `/internal/*` entitlements surface, reached only by the
  trusted embedding service call.
- **operator** — the read-only `/admin/*` cross-tenant analytics surface.
- **maintenance** — boot-time self-host seeding.

## Self-hosting

**Upgrading requires no action.** Migration `021` applies automatically on boot
like every other migration, and the policies are declared `FORCE ROW LEVEL
SECURITY`, so they bind **even on the table owner**. A single-connection
deployment — the default self-host posture, where `DATABASE_URL` is the owner —
keeps working unchanged: the same connection runs migrations and serves
requests, and `withContext` sets the context on every request either way.

### Optional hardening: the two-role model

For a deployment that wants the app connection to be structurally unable to
touch the policies, split the owner from the request path:

1. Create a login user for the request path.
2. `GRANT <database>_app TO <user>`. Migration `021` creates a group role whose
   name is derived from your database name — a database named `shepherd` yields
   the role `shepherd_app` — and grants it exactly the table privileges the
   request path needs. The user inherits those privileges through the group.
3. Point `DATABASE_URL` at that login user.
4. Set `MIGRATIONS_DATABASE_URL` to the **owner** URL, so migrations still run
   as the owner while requests run as the restricted user.

> **Never run the request path as a Postgres superuser.** Superusers (and roles
> with `BYPASSRLS`) bypass RLS entirely, which silently defeats every policy in
> this document.

The group role is **per-database by design**: the name is derived from the
database, and its grants are scoped to that database's tables. Hosting several
Shepherd databases on one cluster grants nothing across them — `shepherd_app`
in one database has no reach into another.

One privilege the app role keeps: it may `SELECT` (but not write)
`schema_migrations`. Boot verifies that the **serving** database carries every
migration before the hub starts listening — a mistyped `MIGRATIONS_DATABASE_URL`
that migrates one database and serves another is caught here rather than
surfacing as a missing column mid-request. Only the migration runner (the owner)
can write that table.

## Adding a table

A new migration that introduces a workspace- or account-keyed table must wire it
into the model, or tenants will not be isolated on it. The steps:

1. `GRANT SELECT, INSERT, UPDATE, DELETE ON <table> TO <database>_app;` — the app
   role has no privileges on a table until you grant them.
2. `ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;`
3. `ALTER TABLE <table> FORCE ROW LEVEL SECURITY;` — without `FORCE`, the owner
   (the single-connection self-host default) bypasses the policies.
4. `CREATE POLICY` per context arm the table needs. A workspace-keyed table
   usually needs the workspace `FOR ALL` arm (`app_context() = 'workspace' AND
workspace_id = app_workspace_id()`, in both `USING` and `WITH CHECK`) plus an
   operator read arm so `/admin/*` analytics can see across tenants.

> **This is checked in CI.** `packages/hub/test/rls.coverage.test.ts` inspects
> the live schema and fails if any table is missing a step — RLS not enabled,
> not forced, the grant absent, or a required policy arm missing — and prints the
> exact remediation SQL to paste into your migration.
