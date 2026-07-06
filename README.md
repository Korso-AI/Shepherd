# shepherd

Shepherd coordinates multiple agents working in a shared workspace. It is built
from four components:

- **Hub** (`@shepherd/hub`, `packages/hub`) — a hosted service built on
  **Fastify + Postgres** that holds the authoritative coordination state
  (leases, locks, status).
- **MCP server** (`@korso/shepherd`, `packages/mcp-server`) — a thin **stdio**
  Model Context Protocol server that each agent runs locally and that forwards
  requests to the hub.
- **Dashboard** (`@korso/shepherd-ui`, `packages/ui`) — a read/operate UI for the
  workspace, built as an auth-agnostic React app (Vite). It ships as two outputs:
  a component library for Korso and a self-host SPA the hub serves (see the UI
  section below).

Shepherd is designed to run in **two modes**, selected **per request** (not by a
build flag) by whether the trusted `x-internal-token` header is present:

- **Self-hosted** — a single trusted team runs its own hub and points its agents
  at it directly. Requests carry `TEAM_TOKEN` as a bearer credential; the hub
  maps them to the fixed `self-hosted` tenant and enforces the
  `ALLOWED_WORKSPACE` guard.
- **Korso-hosted** — Shepherd runs as a managed Korso service behind the Korso
  BFF, which owns end-user auth and tenant identity. The BFF presents the
  `x-internal-token` shared secret plus a trusted `x-account-id` (a Firebase UID)
  that **becomes the tenant id**. Multi-tenancy is **implemented today** (the
  `tenant_id` dimension, the two-mode auth edge), as is the **packaged UI** (the
  React `@korso/shepherd-ui` dashboard described below); hosted-console embedding of
  the dashboard library is completed outside this repo.

## Connect your agent (any MCP client)

Shepherd is a standard stdio MCP server published to npm, so it works with **any**
MCP-capable agent — Claude Code, Codex, Pi, and others. The launch command and the
two required env vars (`HUB_URL`, `TEAM_TOKEN`) are identical everywhere; only the
config location differs per client. Set `PROGRAM` to your tool so you appear under
the right name in the presence feed.

> 📘 **Full walkthrough:** [`docs/shepherd-mcp-quickstart.md`](docs/shepherd-mcp-quickstart.md)
> — getting the token, per-client config, verifying it loaded, and gotchas. ~2 min.

**It's installed per client, not once.** `npx` caches the package machine-wide, but
each tool only launches servers listed in its own config — so add the entry to each
tool you use. The launch command is always `npx -y --package=@korso/shepherd shepherd-mcp`.

| Client | Where to register it |
|---|---|
| **Claude Code** | `claude mcp add shepherd -s user -e HUB_URL=… -e TEAM_TOKEN=… -- npx -y --package=@korso/shepherd shepherd-mcp` (or a project `.mcp.json`). **Not** `~/.claude/mcp.json` — it's silently ignored. |
| **Codex** | `codex mcp add …`, or a `[mcp_servers.shepherd]` table (underscore!) in `~/.codex/config.toml` (TOML, not JSON). |
| **Pi** | a JSON `mcpServers` block in `~/.pi/agent/mcp.json` (global) or `.pi/mcp.json` (project). |
| **Cursor** | a JSON `mcpServers` block in `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project); verify under Settings → MCP. |
| **Any other** | a stdio `mcpServers` entry — `command: npx`, `args: ["-y", "--package=@korso/shepherd", "shepherd-mcp"]`, plus the env vars. |

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
- **`dist/selfhost`** — a self-contained SPA the **hub serves**. The hub mounts
  it via `@fastify/static` (resolving `../../ui/dist/selfhost/`), exposing
  `GET /` (the `index.html` shell) and `GET /assets/*` (the hashed Vite-emitted
  JS/CSS); both are auth-exempt so the shell can prompt for the token, while the
  data endpoints stay gated. This bundle replaces the former hand-written
  `index.html` + `app.js` wallboard and ships inside the hub Docker image.

`npm run build` builds both outputs as part of the full graph (after `tsc -b`
compiles `@shepherd/shared`, which the lib bundles). The self-host SPA is also
built before `npm test`, since the hub's static-route tests serve it.

## Common commands

```
npm install        # install all workspaces
npm run build      # tsc -b across the project graph
npm test           # vitest run
npm run dev:hub    # run the hub in watch mode
npm run dev:mcp    # run the MCP server
npm run migrate    # run hub database migrations
```

Environment variables are documented in `.env.example`.

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
(`packages/hub/src/tenancy.ts`, wired into the `onRequest` hook in
`packages/hub/src/server.ts`) looks at whether a string `x-internal-token` header
is present and resolves the request to exactly one tenant, failing closed (401)
on any uncertainty.

- **Self-hosted.** A single trusted team runs its own hub. There is **no**
  `x-internal-token`. Every client — each agent's MCP server, and the self-host
  dashboard SPA — carries the `TEAM_TOKEN` as an `Authorization: Bearer`
  credential straight to the hub. The request maps to the fixed tenant id `self-hosted`, and
  the `ALLOWED_WORKSPACE` join-guard is **ENFORCED** (`join` rejects any other
  workspace with a 400). Any inbound `x-account-id` is **ignored** — a self-host
  client may never set the tenant. This path remains the self-host baseline.
- **Korso-hosted.** Requests flow through the **Korso BFF** rather than hitting
  the hub directly. The BFF presents a trusted `x-internal-token` (compared
  constant-time against the hub's `INTERNAL_API_TOKEN`) and a trusted
  `x-account-id` (a Firebase UID), which — only after the shared secret verifies
  — **becomes the tenant id** (`mode: "hosted"`). On this path the
  `ALLOWED_WORKSPACE` join-guard is **SKIPPED**: each tenant is isolated by
  `tenant_id` at the data layer, so the shared hub accepts whatever workspace the
  BFF presents. The `Authorization: Bearer` on this path is the Cloud Run **OIDC**
  token (validated by Cloud Run IAM, not by the app) — `TEAM_TOKEN` is **not**
  consulted. If `x-internal-token` is present but the hub has no
  `INTERNAL_API_TOKEN` configured, the request is denied (401) — it never falls
  back to the self-host path.

## Auth ownership

Across both modes the principle is the same: **the auth layer owns
authentication, the hub authorizes on `sessionId`, and the UI is
auth-agnostic.** The auth layer is the **BFF when hosted** and the **bearer hook
when self-hosted**. The dashboard never authenticates a user itself; it renders
state and issues operator actions on top of whatever auth layer sits in front.

The **single exception** is self-hosted mode: with no BFF in front of it, the
hub itself enforces the `TEAM_TOKEN` gate before any data route runs. That gate
lives in the per-request tenant resolver (`resolveRequestTenant` in
`packages/hub/src/tenancy.ts`), called from the `onRequest` hook in
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
  agent's MCP server. Anyone who holds the token *and* learns another agent's
  `sessionId` can act as that agent — `done` its claims, `announce` as it
  (recorded under the victim's session), renew its leases, or read its pending
  announcements. For that reason the MCP server never echoes the `sessionId` back
  into agent-visible output.

**Operational guidance:** treat `TEAM_TOKEN` as a shared secret for the whole
team, rotate it via Secret Manager if a teammate leaves, and do not paste
`sessionId`s into shared logs or transcripts. A per-session secret returned from
`join` and verified on later calls is a planned v2 hardening (see review P2-4).

## Multi-tenancy

**Tenancy is implemented.** Every coordination table carries a
`NOT NULL tenant_id`, and `tenant_id` sits **above** workspace in the partition
hierarchy: `tenant_id → workspace → repo`. The mental model is **one Korso
customer = one tenant = many workspaces/repos**. `workspace` and `repo` keep
exactly their previous meanings; `tenant_id` is a new outer boundary above them.
The data layer (`packages/hub/src/repo.ts`) scopes **every** query by the
resolved `tenant.tenantId`, so a caller can never read or mutate another tenant's
rows. The partition-defining constraints and the hot composite indexes are
re-led with `tenant_id` (see migration `011`), so per-tenant uniqueness holds
(two tenants can each have an agent `alpha` in workspace `acme`, and the same
`commit_sha` reported in two tenants does not collide) and per-tenant queries
stay index-backed.

**How a request gets its tenant id:**

- **Hosted** — the trusted `x-account-id` (a Firebase UID), honoured only after
  the `x-internal-token` shared secret verifies, becomes the `tenant_id`. The
  header is re-validated at the trust boundary (`AccountId`: 1..128 chars,
  `[A-Za-z0-9_-]`) and only ever reaches SQL as a parameterized value.
- **Self-hosted** — a fixed `tenant_id` of `"self-hosted"`
  (`DEFAULT_TENANT_ID` in `tenancy.ts`). Self-hosters run one tenant and need no
  tenant dimension; `ALLOWED_WORKSPACE` continues to pin them to one workspace.

`ALLOWED_WORKSPACE` is therefore **not** the tenancy boundary — `tenant_id` is.
For self-host it still pins the single tenant to one workspace (guard enforced);
for hosted it does not constrain the BFF-forwarded agent requests (the join guard
is skipped) and any placeholder value satisfies config. (The operator wallboard
endpoints still scope reads/writes by it, but the BFF forwards only the agent
endpoints.)

The operator-identity seam is unchanged: `HUB_ADMIN_LABEL` stamps the sender on
operator announcements today and is a documented placeholder for a future login
flow that will supply a real per-user identity and override it per request.

## Deploying the hub (GCP)

The hub runs on **GCP Cloud Run + Cloud SQL (Postgres 16)**. `min-instances=1`
keeps it always-on. HTTPS is terminated by Cloud Run automatically.

There are **two deploy postures**; pick one. Steps 1–2 (Cloud SQL, secrets) are
shared. The two differ only in **Step 3** (the Cloud Run deploy command and
which env/secrets it sets):

- **Self-host (unchanged).** GCP IAM unauthenticated access is enabled
  (`--allow-unauthenticated`) because the app enforces its own bearer token
  (`TEAM_TOKEN`). `INTERNAL_API_TOKEN` is **unset**, so the hub runs in the
  self-host floor with no hosted path. **Nothing new is required of the operator
  for hosted multi-tenancy.**
- **Korso-hosted.** GCP IAM is the front-line gate: deploy with
  `--no-allow-unauthenticated` and grant the BFF's invoker service account
  `roles/run.invoker`. Set `INTERNAL_API_TOKEN` (the BFF's shared secret); the
  app then uses it to select the hosted path per request. `TEAM_TOKEN` and
  `ALLOWED_WORKSPACE` are still **required by config** but are inert on hosted
  agent requests — set `TEAM_TOKEN` to an unused strong random value and
  `ALLOWED_WORKSPACE` to any placeholder.

**Migration `011` (the `tenant_id` column + backfill) auto-applies on boot** in
both postures and backfills every existing row to the `self-hosted` tenant — no
operator action, no separate migration job.

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

# HOSTED ONLY — store the internal API token (the BFF's shared secret). This is
# the same value the BFF sends as the x-internal-token header (the frontend's
# SHEPHERD_API_TOKEN). Generate it with `openssl rand -hex 32`. NEVER commit it.
echo -n "<internal-api-token>" | \
  gcloud secrets create your-internal-api-token-secret --data-file=-
```

### Step 3 — Deploy to Cloud Run

Run from the **repo root** (build context must be the monorepo root). Pick the
command matching your posture.

**Self-host (unchanged).** `--allow-unauthenticated` is correct — GCP IAM is not
used for auth; the app enforces the bearer token. `INTERNAL_API_TOKEN` is left
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
  --set-env-vars=ALLOWED_WORKSPACE=<your-workspace> \
  --allow-unauthenticated \
  --port=8080
```

**Korso-hosted.** IAM is required (`--no-allow-unauthenticated`); the BFF's
invoker service account must hold `roles/run.invoker` on this service. The hub's
Cloud Run URL becomes the BFF's `SHEPHERD_API_BASE` and the OIDC token `aud`. Set
`INTERNAL_API_TOKEN` from Secret Manager (it selects the hosted path per
request). `TEAM_TOKEN` and `ALLOWED_WORKSPACE` are still required by config but
inert on hosted agent requests — use an unused strong-random `TEAM_TOKEN` and a
placeholder `ALLOWED_WORKSPACE`.

```bash
gcloud run deploy shepherd-hub \
  --source . \
  --dockerfile packages/hub/Dockerfile \
  --region=<region> \
  --min-instances=1 \
  --add-cloudsql-instances=<conn-name> \
  --set-secrets=TEAM_TOKEN=your-team-token-secret:latest,DATABASE_URL=your-database-url-secret:latest,INTERNAL_API_TOKEN=your-internal-api-token-secret:latest \
  --set-env-vars=ALLOWED_WORKSPACE=placeholder \
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

This step applies to the **self-host** posture, where agents talk to the hub
directly. On a Korso-hosted deploy, agents go through the BFF instead and never
hold `TEAM_TOKEN` — there is nothing to configure here.

Set these in each founder's shell environment (or `.env`):

```
HUB_URL=https://<service-url>
TEAM_TOKEN=<same-token-stored-in-secret-manager>
WORKSPACE=<your-workspace>
```

### Notes

- **Migrations** run automatically on every container boot (idempotent via
  advisory lock in `migrate.ts`). No separate migration job is needed. This
  includes migration `011`, which adds `tenant_id` and **backfills every existing
  row to the `self-hosted` tenant** — so upgrading an existing self-host hub is a
  zero-action redeploy.
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
  after substituting the placeholder values.

### Hosted-console integration notes

The hub is hosted-ready; an upstream hosted console or BFF must honour these contract details:

- **`forwardToUpstream` is GET-only today, but every forwarded Shepherd endpoint
  is POST** (`/join`, `/work`, `/done`, …). the forwarder must
  pass the method **and** request body through (or add a write-capable variant).
  The hub keeps its POST endpoints.
- **The upstream-registry `pathPrefix` for Shepherd should be `""`.** The hub's
  routes are at **root** (`/work`, not `/api/work`). The registry's `pathPrefix`
  is a required per-upstream field with no global default, so the `shepherd`
  entry must set it to the empty string (otherwise paths get double-prefixed).
- **The OIDC token `aud` must equal the hub's Cloud Run URL.** With
  `audience: "base"`, the BFF mints the OIDC token with `aud = SHEPHERD_API_BASE`
  (the hub's own service URL), and the hosted hub's Cloud Run IAM check validates
  exactly that — so `SHEPHERD_API_BASE` must be the hub's own URL.

## License

Shepherd is licensed under the **GNU Affero General Public License v3.0 only**
(AGPL-3.0-only). See [`LICENSE`](LICENSE) for the full text.

In short: you are free to use, modify, and self-host Shepherd. If you run a
**modified** version as a network service, the AGPL requires you to make the
source of your modified version available to that service's users.

The AGPL applies to the code in this repository. If you need to use Shepherd
under different terms (for example, embedding it in a closed-source product), a
separate commercial license is available — contact Korso.
