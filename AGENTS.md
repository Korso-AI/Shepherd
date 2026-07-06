# AGENTS.md — shepherd

**`shepherd` is a multi-agent coordination service** — it lets a fleet of
agents working in a shared workspace stay out of each other's way (leases, locks, status, announcements).
This repo is the **hub + the MCP client + the dashboard** for that coordination state.

It is built from four packages:

- **Hub** (`@shepherd/hub`, `packages/hub`) — a hosted **Fastify + Postgres** service holding the
  authoritative coordination state. The **sole writer/reader of the database** (`pg`).
- **MCP server** (`@korso/shepherd`, `packages/mcp-server`) — a thin **stdio** Model Context Protocol
  server each agent runs locally; forwards to the hub. **This is the one published-to-npm surface.**
- **Shared** (`@shepherd/shared`, `packages/shared`) — the **zod wire contract** + identity
  canonicalization; the leaf package every other one builds on.
- **Dashboard** (`@korso/shepherd-ui`, `packages/ui`) — an **auth-agnostic** React app; renders
  coordination state and issues operator actions, holding no notion of who the user is.

> **This is the canonical agent context for the repo** — shared across all agent tools. If a `CLAUDE.md`
> exists it imports this (`@AGENTS.md`); do not fork a second copy. Operational detail (deploy, env,
> connect-your-agent) lives in [`README.md`](README.md); **this file is the engineering charter** (code
> style, boundaries, the minimalism discipline, the auth invariants, Definition of Done) — read it first.

> **Status:** live. The hub, the MCP server, and the `@shepherd/shared` contract are real code; **hosted multi-tenancy is implemented** (a `NOT NULL tenant_id` on every coordination table, the two-mode
> per-request auth edge, per-tenant query scoping). `packages/ui/` now exists (React + Vite) — the
> README's "forthcoming" note is stale. The two deployment modes (self-hosted `TEAM_TOKEN`; Korso-hosted
> behind an upstream BFF via `x-internal-token` + trusted `x-account-id`) are described in
> [`README.md`](README.md) and live in `packages/hub/src/tenancy.ts`.

## Repository layout

An **npm-workspaces** TypeScript monorepo (ESM throughout). Shared compiler config is `tsconfig.base.json`;
the root `tsconfig.json` references each package so `tsc -b` builds the whole graph.

```
packages/
  shared/      @shepherd/shared    — zod wire contract + identity canonicalization (the leaf)
  hub/         @shepherd/hub       — Fastify + Postgres hub; the only DB writer/reader
  mcp-server/  @korso/shepherd     — stdio MCP server (published to npm); thin client over the hub
  ui/          @korso/shepherd-ui  — auth-agnostic React dashboard (Vite)
```

## Architecture & module boundaries

The dependency arrows are load-bearing — keep them true (today by review; a `dependency-cruiser`
`boundaries` check is the [intended gate](#the-one-command)):

- **`@shepherd/shared` is the leaf.** It holds the **single source of truth for the wire shape** — the zod
  schemas in `src/contract.ts`, re-exported with their inferred `…T` types from `src/index.ts`. The hub,
  the MCP client, and the UI all import the contract from here. **Never redefine a wire schema** in a
  consumer; add or change it in `shared` so both ends of the wire move together (this is shepherd's analogue
  of a generated-client contract). `shared` imports nothing from the other packages.
- **The hub is the sole database tier.** Only `@shepherd/hub` imports `pg`; the data layer is
  `packages/hub/src/repo.ts` and **every query is scoped by the resolved `tenant.tenantId`**. No other
  package touches Postgres; no SQL lives outside `repo.ts`.
- **The MCP server is a thin client and the npm boundary.** `@korso/shepherd` forwards agent tool calls to
  the hub over HTTP; it holds **no coordination logic of its own** beyond local caching / context
  resolution. Because it is published, its tool surface + bin entries (`shepherd-mcp`,
  `shepherd-inbox-hook`) are a **public contract** — treat changes to them like a release, not a refactor.
- **The UI is auth-agnostic.** `@korso/shepherd-ui` renders state and issues operator actions; it holds
  **no auth/identity** and never decides who the user is — that belongs to the layer in front (the BFF when
  hosted, the bearer hook when self-hosted). It talks only to read/operate endpoints.

## The one command

```
npm run check
```

The intended gate, fail-fast and **identical to CI** so "passes locally" means "passes CI":

```
npm ci                       # frozen install from the committed package-lock.json
format:check  →  lint  →  typecheck (tsc -b --noEmit / tsc --noEmit)  →  test  →  build  →  boundaries
```

- `format:check` — Prettier in check mode (no writes).
- `lint` — ESLint (flat config), max-warnings 0.
- `typecheck` — strict, no-emit across the project graph.
- `test` — Vitest. The hub **integration** suite needs a real Postgres and **skips cleanly** without one
  (`TEST_DATABASE_URL`/`DATABASE_URL`); unit tests run on any machine. See [`README.md`](README.md).
- `build` — `tsc -b` for the graph; `tsup` for the published `mcp-server`; Vite for `ui`.
- `boundaries` — `dependency-cruiser` enforces [the import rules above](#architecture--module-boundaries).

> **Current gating status.** Today only `build`, `test`, and the `dev`/`migrate`
> scripts exist; there is **no `check` aggregate, no lint, no format, no no-emit typecheck, no boundaries
> check, and no aggregate CI verification script** (only `publish-mcp.yml`). Several dev dependencies also float on
> `"latest"` (root + `ui`). The section above is the **target**; wiring `npm run check` + pinning those
> deps is the first thing to do, because **a rule that isn't a failing check does not exist**.

## Environment & tooling

- **npm workspaces** manage the graph and lockfile (`package-lock.json`, committed; CI uses `npm ci`).
- **Pin dependencies — they must earn their place.** Replace floating `"latest"` ranges with real,
  audited versions; a *new* dep must clear `npm audit` and beat the stdlib/Fastify/existing-dep rungs of
  the [minimalism ladder](#minimalism--the-lazy-senior-dev-discipline).
- **TypeScript** in `strict` mode (NodeNext, ES2022, `composite`); type errors are build failures. Build
  the graph with `tsc -b`.
- **Vitest** for unit + integration; **Testing Library** for the UI.
- **Fastify 5** (hub) / **`@modelcontextprotocol/sdk`** (MCP server) / **Vite + React** (UI) / **`pg`** for
  Postgres / **`pino`** for hub logging.
- Target **Node 22 LTS** for development; the published `mcp-server` keeps a wider `engines` floor (`>=18`)
  so any agent host can run it.

## Code style

- Prefer simple, explicit, readable code over clever code. Boring over clever; deletion over addition.
- **No `any`.** Use `unknown` at boundaries and narrow. The one sanctioned place an external/untyped value
  becomes typed is a **zod boundary parser** — never a raw cast that launders `unknown` into a domain type.
- **Validate every external payload at the boundary with zod** (agent requests, HTTP bodies, headers, env).
  Parse, don't assume. The wire `…T` types describe the *contract*; the zod `.parse`/`.safeParse` proves the
  *payload*. `AccountId` in `tenancy.ts` is the model: a bounded, charset-checked parser at the trust edge.
- **Secrets are server-side only.** Read them from `process.env` in the hub; never ship a secret to the UI
  bundle. `TEAM_TOKEN` / `INTERNAL_API_TOKEN` / `DATABASE_URL` are hub config, never client-visible.
- **TSDoc** on exported functions, types, and modules; the auth/tenancy modules already model this. Comments
  explain *why*, not *what*.
- Keep functions small and single-purpose; prefer pure functions (`resolveRequestTenant` is pure by design).
  Caps (target — to be wired into the `lint` rule): file soft 300 / hard 500 lines; function soft 50 /
  hard 75; cyclomatic complexity ≤ 10.
- **Descriptive names**; single-letter names only in tight loops. Explicit named exports; avoid default
  exports except where a framework requires them.
- Prefer Node's standard library and Fastify built-ins before reaching for a dependency.

## Minimalism — the lazy-senior-dev discipline

> The best code is the code you never wrote. This repo is predominantly agent-written, and the
> characteristic failure mode here is *over-building*: speculative abstractions, a helper reinvented, a
> dependency for a one-liner, flexibility no caller needs. Before writing code, climb this ladder and stop
> at the first rung that works:
>
> 1. **YAGNI** — does this need to exist at all, and is it in scope for the current phase?
> 2. **Reuse** — does `@shepherd/shared` (the zod contract, `generateName`, `canonicalizeRepo`) or an
>    existing hub module already do it?
> 3. **Platform / stdlib** — does Node (`node:crypto`, `node:http`), Fastify, or `pg` already cover it?
> 4. **Existing dependency** — does a package already in `package-lock.json` solve it? A *new* dep must
>    clear `npm audit` and earn its place — prefer the platform.
> 5. **Smallest correct change** — the shortest working diff wins, *once you understand the problem.*
>
> Deletion over addition. Boring over clever. Fix root causes, not symptoms — **one guard in the tenant
> resolver beats a check in every route handler.**

**Not lazy about — never "minimized away."** Minimalism governs how much *code* you write, never how much
*correctness* you keep. The carve-outs are exactly this repo's non-negotiables, and they all live in the
auth/tenancy edge (see [Correctness & safety](#correctness--safety)): the zod boundary parse on every wire
payload; **constant-time** token comparison (`timingSafeCompare` — never `===` on a secret); **fail-closed**
tenant resolution; **`tenant_id` scoping on every query**; never echoing a `sessionId` back to the agent;
never leaking internal errors downstream; and the full **test discipline** on those paths. A "minimal smoke
test" is never a substitute — never shrink a test to shrink a diff.

Mark deliberate shortcuts: `// TODO(operational hardening): <ceiling> — <upgrade path>`, so the next agent sees the boundary
instead of treating the shortcut as load-bearing (e.g. the deferred per-session secret and read-only
`DASHBOARD_TOKEN` seams noted in the README).

## Correctness & safety

Shepherd's dangerous code is the **two-mode auth edge** (`packages/hub/src/tenancy.ts`) and the
**tenant-scoped data layer** (`packages/hub/src/repo.ts`). The safety properties are bound to *that code*,
not to a label — they hold no matter which route, mode, or tenant is in play:

- **Fail closed.** `resolveRequestTenant` denies (`401`) on every uncertain path and **never** falls back
  from the hosted path to the self-host path. Missing/invalid identity → 401; a hosted request to a hub with
  no `INTERNAL_API_TOKEN` configured → 401. A partial auth config is a hard error, not a fallback.
- **Two credentials, never conflated.** The mode is chosen per request by whether a string `x-internal-token`
  is present. Hosted: the shared secret is verified, *then* the trusted `x-account-id` becomes the tenant id;
  the `Authorization: Bearer` is the Cloud Run OIDC token (not `TEAM_TOKEN`). Self-host: `TEAM_TOKEN` bearer
  only, and any inbound `x-account-id` is **ignored**. A client can never supply or override the tenant id.
- **Constant-time secret comparison.** All token checks go through `timingSafeCompare` (SHA-256 → fixed-width
  `timingSafeEqual`), one implementation shared by both modes so they can't drift. Never compare a secret
  with `===`/`startsWith` past the `Bearer ` prefix strip.
- **`tenant_id` is the tenancy boundary, not `ALLOWED_WORKSPACE`.** Every query in `repo.ts` is scoped by the
  resolved `tenant.tenantId`; a caller can never read or mutate another tenant's rows. Trusted headers reach
  SQL only as parameterized values, re-validated at the boundary (`AccountId`).
- **`sessionId` is a capability — don't leak it.** Operations authorize on the `sessionId` in the request
  body, not on identity; the MCP server never echoes a `sessionId` back into agent-visible output.
- **Never leak internals downstream.** Map `HubError`s to status codes and return generic messages; log
  detail server-side only. Never copy arbitrary upstream/internal headers back to a caller.
- **Never hardcode secrets.** Read `TEAM_TOKEN` / `INTERNAL_API_TOKEN` / `DATABASE_URL` from the environment;
  `.env*` is gitignored. Secrets are never logged (`TEAM_TOKEN` and `x-internal-token` are redacted).

## Testing

- Use **Vitest**. Write tests **alongside** new code, not after. Cover the important paths and edge cases;
  favor fast, deterministic tests. The hub integration suite runs against a real Postgres and truncates
  tables per test for isolation; it skips cleanly when no database URL is set.
- **The auth/tenancy edge carries a higher bar — tie the safety to the dangerous code, not to a slice.**
  `tenancy.ts` and the `tenant_id` scoping in `repo.ts` are shepherd's "money modules." They get explicit
  happy-path **and** failure-path tests: forged/absent `x-internal-token`, hosted request with no
  `INTERNAL_API_TOKEN` configured, missing/malformed/array `x-account-id` rejected, self-host `x-account-id`
  ignored, and cross-tenant read/write isolation. Never let coverage here regress. (These already exist in
  `test/tenancy.test.ts` and `test/operations/tenant-isolation.test.ts` — keep them green and growing.)
- **Test behavior, not implementation.** Assert on responses, persisted rows, raised errors — not on internal
  calls or snapshot noise. Coverage is a **floor, not a target**: never add a test whose only purpose is to
  execute a line.
- **Never edit, weaken, delete, or `skip`/`xfail` a test to turn a red build green.** A failing test is a
  finding — fix the code under test. The only sanctioned reason to change an assertion is that it is genuinely
  *stale* (the behavior it pinned was intentionally changed); say so explicitly in the commit/PR.
- Tests must be **independent and runnable in any order**.

## Definition of Done

`npm run check` green (once wired: format, lint, typecheck, test, build, boundaries); new external boundaries
have a zod parser + tests; new exported/published API carries TSDoc; **no `any`**; no secret reachable from
the UI bundle; no hardcoded secrets; wire schema changes live in `@shepherd/shared` (both ends move together)
and, if the MCP tool surface changed, it is treated as a release; every `repo.ts` query stays `tenant_id`-
scoped and the auth edge stays fail-closed with failure-path tests; the coverage on the auth/tenancy paths is
unchanged or raised; and the diff is the **smallest correct change** — climbed the
[minimalism ladder](#minimalism--the-lazy-senior-dev-discipline), with no speculative abstraction, reinvented
helper, or unjustified/floating new dependency.

## Working style

- **Ask before major structural decisions.** Follow the
  [minimalism ladder](#minimalism--the-lazy-senior-dev-discipline) — prefer deleting code over adding it.
  Optimize for readability/maintainability first; performance only where measured.
- Commit **small, logical changes** with clear messages. Keep the working tree clean (no committed build
  output under `dist/`).
- Respect the package boundaries: `@shepherd/shared` is the leaf and the wire contract; the hub owns the DB;
  the MCP server stays a thin published client; the UI stays auth-agnostic. "While I'm here" cross-package
  edits are how the boundaries (and the size caps) rot — keep the diff inside the boundary it belongs to.
