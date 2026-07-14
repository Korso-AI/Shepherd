# shepherd

Shepherd coordinates multiple agents working in a shared workspace. It is built
from four components:

- **Hub** (`@shepherd/hub`, `packages/hub`) — a hosted service built on
  **Fastify + Postgres** that holds the authoritative coordination state
  (leases, locks, status).
- **MCP server** (`@korso/shepherd`, `packages/mcp-server`) — a thin **stdio**
  Model Context Protocol server that each agent runs locally and that forwards
  requests to the hub.
- **Shared contract** (`@shepherd/shared`, `packages/shared`) — the zod wire
  contract + identity canonicalization that the other packages build on.
- **Dashboard** (`@korso/shepherd-ui`, `packages/ui`) — a read/operate UI for the
  workspace, built as an auth-agnostic React app (Vite). It ships as two outputs:
  a component library for Korso and a self-host SPA the hub serves (see the UI
  section below).

Shepherd is designed to run in **two modes**, selected **per request** (not by a
build flag) by which credential the request carries:

- **Self-hosted** — a single trusted team runs its own hub and points its agents
  at it directly. Requests carry `TEAM_TOKEN` as a bearer credential; the hub
  maps them to the single workspace named by `ALLOWED_WORKSPACE`.
- **Korso-hosted** — Shepherd runs as a managed multi-workspace service. Browser
  requests arrive via the Korso BFF, which owns end-user auth and presents the
  `x-internal-token` shared secret (matched against the hub's
  `BFF_INTERNAL_TOKEN`) plus a trusted `x-account-id`; agents authenticate with
  minted `shp_…` API tokens. Accounts reach workspaces only through
  **membership** rows. Multi-tenancy is **implemented today**
  (workspaces + memberships + hashed API tokens, the per-request auth edge), as
  is the **packaged UI** (the React `@korso/shepherd-ui` dashboard described
  below); hosted-console embedding of the dashboard library is completed
  outside this repo.

## Connect your agent (any MCP client)

Shepherd is a standard stdio MCP server published to npm, so it works with **any**
MCP-capable agent — Claude Code, Codex, Pi, and others. The launch command and the
two required env vars (`HUB_URL`, plus `TEAM_TOKEN` for a self-host hub or
`SHEPHERD_TOKEN` for a hosted one) are identical everywhere; only the config
location differs per client. Set `PROGRAM` to your tool so you appear under
the right name in the presence feed.

> 📘 **Full walkthrough:** [`docs/shepherd-mcp-quickstart.md`](docs/shepherd-mcp-quickstart.md)
> — getting the token, per-client config, verifying it loaded, and gotchas. ~2 min.

**It's installed per client, not once.** `npx` caches the package machine-wide, but
each tool only launches servers listed in its own config — so add the entry to each
tool you use. The launch command is always `npx -y --package=@korso/shepherd shepherd-mcp`.

| Client          | Where to register it                                                                                                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Claude Code** | `claude mcp add shepherd -s user -e HUB_URL=… -e TEAM_TOKEN=… -- npx -y --package=@korso/shepherd shepherd-mcp` (or a project `.mcp.json`). **Not** `~/.claude/mcp.json` — it's silently ignored. |
| **Codex**       | `codex mcp add …`, or a `[mcp_servers.shepherd]` table (underscore!) in `~/.codex/config.toml` (TOML, not JSON).                                                                                  |
| **Pi**          | a JSON `mcpServers` block in `~/.pi/agent/mcp.json` (global) or `.pi/mcp.json` (project).                                                                                                         |
| **Cursor**      | a JSON `mcpServers` block in `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project); verify under Settings → MCP.                                                                          |
| **Any other**   | a stdio `mcpServers` entry — `command: npx`, `args: ["-y", "--package=@korso/shepherd", "shepherd-mcp"]`, plus the env vars.                                                                      |

## Monorepo layout

npm-workspaces TypeScript monorepo (ESM throughout):

```
packages/
  shared/      @shepherd/shared      — shared types/schemas (zod)
  hub/         @shepherd/hub         — Fastify + Postgres hub
  mcp-server/  @korso/shepherd       — stdio MCP server (published to npm)
  ui/          @korso/shepherd-ui    — auth-agnostic React dashboard (Vite)
```

Shared compiler config lives in `tsconfig.base.json`; the root `tsconfig.json`
references each package so `tsc -b` builds the whole graph.

## UI / dashboard

The packaged dashboard is `@korso/shepherd-ui` (`packages/ui/`), an
**auth-agnostic React app** built with **Vite**. "Auth-agnostic" means the UI
itself holds no notion of who the user is or how they authenticated — it renders
coordination state and issues operator actions, leaving authentication entirely
to the layer in front of it (the BFF when hosted, the bearer hook when
self-hosted). The single exception is the self-host entry, which owns the team
token (see "Auth ownership" below).

The package emits **two outputs** from one source tree (see `packages/ui/README.md`):

- **`dist/lib`** — a component library (`<Dashboard/>`, `createShepherdClient`,
  the React context) consumed by **Korso** when the dashboard is embedded in the
  hosted product. Auth lives in the BFF; the library is token-blind. (hosted product consumption happens outside this repo.)
- **`dist/selfhost`** — a self-contained SPA the **hub serves**. The hub serves
  it via a small hand-rolled asset route in `packages/hub/src/server.ts`
  (resolving `../../ui/dist/selfhost/` and preloading the hashed assets),
  exposing `GET /` (the `index.html` shell) and `GET /assets/*` (the hashed
  Vite-emitted JS/CSS); both are auth-exempt so the shell can prompt for the
  token, while the data endpoints stay gated. This bundle replaces the former
  hand-written `index.html` + `app.js` wallboard and ships inside the hub
  Docker image.

`npm run build` builds both outputs as part of the full graph (after `tsc -b`
compiles `@shepherd/shared`, which the lib bundles). The self-host SPA is also
built before `npm test`, since the hub's static-route tests serve it.

## Common commands

```
npm install        # install all workspaces
npm run build      # tsc -b across the project graph
npm test           # vitest run
npm run check      # lint + build + test — the same gate CI runs
npm run dev:hub    # run the hub in watch mode
npm run dev:mcp    # run the MCP server
npm run migrate    # run hub database migrations
```

Environment variables are documented in `.env.example`. The `dev:hub` /
`dev:mcp` / `migrate` scripts auto-load `.env` (via
`tsx --env-file-if-exists=.env`, which needs **Node >= 22.9** — on older Node,
export the vars in your shell instead). To run the hub locally you need its
three required self-host vars: `DATABASE_URL`, `TEAM_TOKEN`, and
`ALLOWED_WORKSPACE`.

## Running integration tests

The hub integration suite (`packages/hub/test/integration.spec.ts`) exercises
the full coordination scenarios — conflict detection, announcement delivery,
TTL expiry, staleness, and workspace isolation — against a real Postgres
instance. The suite skips automatically when no database URL is available, so
unit tests run on any machine.

**Prerequisites:** a local Postgres or a Docker container:

```
docker run --rm -p 5432:5432 -e POSTGRES_PASSWORD=test -e POSTGRES_DB=shepherd_test postgres:16
```

**Set the connection string** (pick whichever name suits):

```
export TEST_DATABASE_URL=postgres://postgres:test@localhost:5432/shepherd_test
# or:
export DATABASE_URL=postgres://postgres:test@localhost:5432/shepherd_test
```

**Run:**

```
npm test
# or target just the integration suite:
npx vitest run packages/hub/test/integration.spec.ts
```

Migrations run automatically at the start of each suite via `runTestMigrations`;
each test truncates all tables for isolation.

## Deployment modes — self-hosted vs hosted

Shepherd runs in two deployment modes from **one codebase**. The mode is chosen
**per request**, never by a build flag or a separate env switch: the auth edge
(`resolveTenant` in `packages/hub/src/tenant.ts`, wired into the `onRequest`
hook in `packages/hub/src/server.ts`) reduces every request to exactly **one**
credential and resolves it to a workspace scope, failing closed (401) on any
uncertainty. Resolution order (first match wins):

1. **`x-internal-token` — hosted, browser-via-BFF.** The shared secret is
   compared constant-time against the hub's `BFF_INTERNAL_TOKEN`; only after it
   verifies is the trusted `x-account-id` honoured, and the account reaches a
   workspace only through a live **membership** row (a non-member gets a
   generic 404). If `x-internal-token` is present but wrong — or the hub has no
   `BFF_INTERNAL_TOKEN` configured — the request is denied (401); it never
   falls back to the self-host path.
2. **`Authorization: Bearer shp_…` — hosted, agent/API token.** A minted token
   (stored only as a SHA-256 hash in `api_tokens`) resolves to its owning
   account and workspace, gated on the account's **live membership** — a
   revoked membership means the token no longer resolves.
3. **`Authorization: Bearer <TEAM_TOKEN>` — self-hosted.** A single trusted
   team runs its own hub; every client — each agent's MCP server, and the
   self-host dashboard SPA — carries `TEAM_TOKEN` straight to the hub, and the
   request resolves to the one workspace named by `ALLOWED_WORKSPACE` (seeded
   on boot). Any inbound `x-account-id` is **ignored** — a self-host client can
   never assert an account.

Config requires at least one mode to be **fully configured** before the hub
boots: `TEAM_TOKEN` + `ALLOWED_WORKSPACE` (self-host), or `BFF_INTERNAL_TOKEN`
alone (hosted). Both may be configured simultaneously.

## Auth ownership

Across both modes the principle is the same: **the auth layer owns
authentication, the hub authorizes on `sessionId`, and the UI is
auth-agnostic.** The auth layer is the **BFF when hosted** and the **bearer hook
when self-hosted**. The dashboard never authenticates a user itself; it renders
state and issues operator actions on top of whatever auth layer sits in front.

The **single exception** is self-hosted mode: with no BFF in front of it, the
hub itself enforces the `TEAM_TOKEN` gate before any data route runs. That gate
lives in the per-request tenant resolver (`resolveTenant` in
`packages/hub/src/tenant.ts`), called from the `onRequest` hook in
`packages/hub/src/server.ts`. The same resolver owns both modes and shares one
constant-time comparison (`timingSafeCompare`) across the self-host `TEAM_TOKEN`
check and the hosted `x-internal-token` check.

The token and session mechanics that back this today:

- **`TEAM_TOKEN` is a workspace-wide bearer credential** on the self-host path.
  Every self-host request carries it; the hub only checks that it matches
  (constant-time compare, never logged — `TEAM_TOKEN` is redacted from logs
  alongside `x-internal-token`). **Any holder of the token has full authority
  over the entire workspace.** There is no per-agent or per-human scoping at the
  token layer. (A future read-only `DASHBOARD_TOKEN` seam, so a wallboard viewer
  need not hold the write token, is deferred.)
- **Operations authorize on the `sessionId` in the request body, not on identity.**
  A `sessionId` is an unguessable v4 UUID returned by `join` and cached by each
  agent's MCP server. Anyone who holds the token _and_ learns another agent's
  `sessionId` can act as that agent — `done` its claims, `announce` as it
  (recorded under the victim's session), renew its leases, or read its pending
  announcements. For that reason the MCP server never echoes the `sessionId` back
  into agent-visible output.

**Operational guidance:** treat `TEAM_TOKEN` as a shared secret for the whole
team — generate a strong random value (e.g. `openssl rand -hex 32`) and never
deploy a guessable placeholder — rotate it via Secret Manager if a teammate
leaves, and do not paste
`sessionId`s into shared logs or transcripts. A per-session secret returned from
`join` and verified on later calls is a planned v2 hardening (see review P2-4).

## Multi-tenancy

**Tenancy is implemented, and the boundary is the workspace.** Migration `011`
stood up the identity/tenancy tables — `workspaces`, `memberships`,
`api_tokens`, `invites`, `account_profiles` — and re-keyed every coordination
table (`agents`, `sessions`, `work_items`, `announcements`, `change_records`)
onto a `NOT NULL workspace_id` FK into `workspaces`, with the uniqueness
constraints and hot composite indexes re-led by `workspace_id` (two workspaces
can each have an agent `alpha`, and the same `commit_sha` reported in two
workspaces does not collide). The data layer (`packages/hub/src/repo.ts`)
scopes **every** query by the resolved `workspace_id`, so a caller can never
read or mutate another workspace's rows. The mental model is **one account →
many workspaces via memberships; one workspace → many repos**.

**How a request gets its workspace** (`resolveTenant` in
`packages/hub/src/tenant.ts` — see "Deployment modes" above for the full
resolution order):

- **Hosted, browser** — the BFF's `x-internal-token` verifies against
  `BFF_INTERNAL_TOKEN`, then the trusted `x-account-id`'s **membership** in the
  route's workspace is checked; non-members get a generic 404. Trusted headers
  only ever reach SQL as parameterized values.
- **Hosted, agent** — a minted `shp_…` API token (stored only as a SHA-256
  hash; migration `015` additionally allows account-scoped tokens bound to no
  single workspace) resolves to its account and workspace, gated on live
  membership.
- **Self-hosted** — `TEAM_TOKEN` resolves to the single workspace named by
  `ALLOWED_WORKSPACE` (seeded on boot): full access, no per-account identity.

Migration `011` is a **clean cutover**, not a backfill: it TRUNCATEs the
(ephemeral) coordination tables so the `NOT NULL workspace_id` column needs no
legacy rows pointed anywhere — agents re-join and claims re-acquire on their
next heartbeat, so no durable data is lost.

- **Tenant isolation:** beneath the `repo.ts` `workspace_id` scoping, every table
  is protected by Postgres row-level security so a forgotten `WHERE` returns
  nothing instead of leaking across workspaces — see [`docs/rls.md`](docs/rls.md).

The operator-identity seam: `HUB_ADMIN_LABEL` stamps the sender on
announcements the operator sends from the self-host dashboard, and the hosted
`/admin/*` analytics surface additionally requires a BFF-signed operator
identity proof verified with `OPERATOR_IDENTITY_SECRET` (fail-closed when
unset).

## Workspace entitlements (optional limits)

The hub also carries an **optional** per-workspace limits primitive — caps on
seats, repos, and announcement retention — that is **inert unless the
deployment configures it**: a hub that never sets the
`ENTITLEMENTS_DEFAULT_LIMITS` env var has no limits of any kind, and self-host
`TEAM_TOKEN` requests are exempt even when it is set. Self-hosting is unlimited
by construction. See [`docs/entitlements.md`](docs/entitlements.md).

## Deploying the hub (GCP)

The hub runs on **GCP Cloud Run + Cloud SQL (Postgres 16)**. `min-instances=1`
keeps it always-on. HTTPS is terminated by Cloud Run automatically.

There are **two deploy postures**; pick one. Steps 1–2 (Cloud SQL, secrets) are
shared. The two differ only in **Step 3** (the Cloud Run deploy command and
which env/secrets it sets):

- **Self-host (unchanged).** GCP IAM unauthenticated access is enabled
  (`--allow-unauthenticated`) because the app enforces its own bearer token
  (`TEAM_TOKEN`). `BFF_INTERNAL_TOKEN` is **unset**, so the hub runs in the
  self-host floor with no hosted path. **Nothing new is required of the operator
  for hosted multi-tenancy.**
- **Korso-hosted.** GCP IAM is the front-line gate: deploy with
  `--no-allow-unauthenticated` and grant the BFF's invoker service account
  `roles/run.invoker`. Set `BFF_INTERNAL_TOKEN` (the BFF's shared secret); the
  app then uses it to select the hosted path per request. `TEAM_TOKEN` and
  `ALLOWED_WORKSPACE` are **not required** in this posture — `BFF_INTERNAL_TOKEN`
  alone satisfies config; set them too only if you also want the self-host path
  on the same hub.

**Migrations auto-apply on boot** in both postures — no operator action, no
separate migration job. (Migration `011` is a clean cutover that truncates the
ephemeral coordination tables; see "Multi-tenancy" above.)

The Dockerfile and app are portable — Fly.io, Railway, or Render are drop-in
alternatives if GCP is not preferred.

### Prerequisites

- `gcloud` CLI authenticated (`gcloud auth login && gcloud config set project <PROJECT>`)
- Cloud Run, Cloud SQL, and Secret Manager APIs enabled
- A project with billing enabled

### Step 1 — Create the Cloud SQL instance and database

```bash
# Create a Postgres 16 instance (db-f1-micro is free-tier eligible).
gcloud sql instances create shepherd-db \
  --database-version=POSTGRES_16 \
  --tier=db-f1-micro \
  --region=<region>

# Create the database inside the instance.
gcloud sql databases create shepherd --instance=shepherd-db

# Create a database user.
gcloud sql users create shepherd \
  --instance=shepherd-db \
  --password=<strong-password>

# Note the connection name for later steps:
gcloud sql instances describe shepherd-db --format='value(connectionName)'
# Example output: my-project:us-central1:shepherd-db
```

### Step 2 — Store secrets in Secret Manager

```bash
# Generate a strong team token.
openssl rand -hex 32

# Store the team token.
echo -n "<token-from-above>" | \
  gcloud secrets create your-team-token-secret --data-file=-

# Build the DATABASE_URL using the Cloud SQL Unix-socket form, then store it.
# Replace <conn-name> with the output from Step 1 (e.g. my-project:us-central1:shepherd-db).
echo -n "postgres://shepherd:<password>@/shepherd?host=/cloudsql/<conn-name>" | \
  gcloud secrets create your-database-url-secret --data-file=-

# HOSTED ONLY — store the BFF internal token (the BFF's shared secret). This is
# the same value the BFF sends as the x-internal-token header. Generate it with
# `openssl rand -hex 32`. NEVER commit it.
echo -n "<bff-internal-token>" | \
  gcloud secrets create your-bff-internal-token-secret --data-file=-
```

### Step 3 — Deploy to Cloud Run

Run from the **repo root** (build context must be the monorepo root). Pick the
command matching your posture.

**Self-host (unchanged).** `--allow-unauthenticated` is correct — GCP IAM is not
used for auth; the app enforces the bearer token. `BFF_INTERNAL_TOKEN` is left
unset, so there is no hosted path. Cloud Run issues an HTTPS endpoint
automatically.

```bash
gcloud run deploy shepherd-hub \
  --source . \
  --dockerfile packages/hub/Dockerfile \
  --region=<region> \
  --min-instances=1 \
  --add-cloudsql-instances=<conn-name> \
  --set-secrets=TEAM_TOKEN=your-team-token-secret:latest,DATABASE_URL=your-database-url-secret:latest \
  --set-env-vars=ALLOWED_WORKSPACE=<your-workspace>,TRUST_PROXY=true \
  --allow-unauthenticated \
  --port=8080
```

**Korso-hosted.** IAM is required (`--no-allow-unauthenticated`); the BFF's
invoker service account must hold `roles/run.invoker` on this service. The hub's
Cloud Run URL becomes the BFF's `SHEPHERD_API_BASE` and the OIDC token `aud`. Set
`BFF_INTERNAL_TOKEN` from Secret Manager (it selects the hosted path per
request). `TEAM_TOKEN` and `ALLOWED_WORKSPACE` are **not needed** in this
posture — `BFF_INTERNAL_TOKEN` alone satisfies config.

```bash
gcloud run deploy shepherd-hub \
  --source . \
  --dockerfile packages/hub/Dockerfile \
  --region=<region> \
  --min-instances=1 \
  --add-cloudsql-instances=<conn-name> \
  --set-secrets=DATABASE_URL=your-database-url-secret:latest,BFF_INTERNAL_TOKEN=your-bff-internal-token-secret:latest \
  --no-allow-unauthenticated \
  --port=8080

# Grant the BFF's invoker service account permission to call this service.
# <invoker-sa> is the frontend's SHEPHERD_INVOKER_SA_EMAIL (minted via WIF).
gcloud run services add-iam-policy-binding shepherd-hub \
  --region=<region> \
  --member=serviceAccount:<invoker-sa> \
  --role=roles/run.invoker
```

### Step 4 — Confirm deployment

```bash
# Fetch the service URL.
gcloud run services describe shepherd-hub --region=<region> \
  --format='value(status.url)'

# Health-check the hub. /health is exempt from app auth in both postures.
curl https://<service-url>/health
# Expected: {"status":"ok"} (or similar 200 response)
# On a Korso-hosted (IAM-gated) deploy, /health still requires a valid Cloud Run
# OIDC token to reach the container, e.g.:
#   curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
#     https://<service-url>/health
```

### Step 5 — Configure MCP servers on each machine (self-host)

This step applies to the **self-host** posture, where agents authenticate with
the shared `TEAM_TOKEN`. On a hosted deploy, agents never hold `TEAM_TOKEN` —
each user sets `SHEPHERD_TOKEN` to a minted `shp_…` token from the dashboard
instead (see [`docs/shepherd-mcp-quickstart.md`](docs/shepherd-mcp-quickstart.md)).

Set these in each team member's shell environment (or `.env`):

```
HUB_URL=https://<service-url>
TEAM_TOKEN=<same-token-stored-in-secret-manager>
WORKSPACE=<your-workspace>
```

### Notes

- **Migrations** run automatically on every container boot (idempotent via
  advisory lock in `migrate.ts`). No separate migration job is needed. Note
  that migration `011` (the workspace/tenancy cutover) **truncates the
  ephemeral coordination tables** rather than backfilling — agents re-join and
  claims re-acquire on their next heartbeat, so upgrading an existing self-host
  hub is still a zero-action redeploy with no durable data lost.
- **`CREATE EXTENSION pgcrypto`** runs without issue as the Cloud SQL default
  user; it is included in migration `001_init.sql`.
- **Cloud SQL connectivity**: the Unix-socket form
  (`?host=/cloudsql/<conn-name>`) is used when the instance is attached via
  `--add-cloudsql-instances`. For a public-IP connection (not recommended)
  use the standard `postgres://...@<public-ip>/shepherd` form with SSL.
- **Updating secrets**: use `gcloud secrets versions add <secret-name> --data-file=-`
  then redeploy or let Cloud Run pick up the new version on next container start.
- **Updating the service YAML**: `packages/hub/cloudrun-service.yaml` can be
  applied with `gcloud run services replace packages/hub/cloudrun-service.yaml`
  after substituting the placeholder values. The template sets `TRUST_PROXY=true`
  for Cloud Run's load balancer.

For Korso-hosted console/BFF integration notes, see
[`docs/hosted-integration.md`](docs/hosted-integration.md).

## License

Shepherd is licensed under the **GNU Affero General Public License v3.0 only**
(AGPL-3.0-only). See [`LICENSE`](LICENSE) for the full text.

In short: you are free to use, modify, and self-host Shepherd. If you run a
**modified** version as a network service, the AGPL requires you to make the
source of your modified version available to that service's users.

The AGPL applies to the code in this repository. If you need to use Shepherd
under different terms (for example, embedding it in a closed-source product), a
separate commercial license is available — contact [support@korsoai.com](mailto:support@korsoai.com).
