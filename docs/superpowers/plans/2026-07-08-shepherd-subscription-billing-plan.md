# Shepherd Subscription Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Korso-hosted Shepherd workspaces a Stripe-billed subscription product (Free / Pro $15/mo flat / Enterprise custom) with per-plan seat, repo, and retention limits enforced in the hub — while self-hosted deployments stay fully unlimited and unmetered.

**Architecture:** Plan state lives on the `workspaces` table (migration `020`); a small pure module (`packages/hub/src/plan.ts`) defines the limits table and the `effectivePlan()` fallback rules. Enforcement is three surgical checks in the hub's existing transaction paths (seat check in `redeemInvite`, repo check in `join`, retention prune next to the existing `pruneChangeRecords` call sites), all of which no-op unless the deployment has billing enabled (`STRIPE_SECRET_KEY` set) — self-host never sets it. The hub owns all Stripe interaction: trial-start/Checkout/Portal endpoints under `/workspaces/:id/billing/*` (admin-only; the 14-day trial is app-side and creates NO Stripe objects — no card) and a signature-verified, auth-exempt `/stripe/webhook` route that flips plan state. The UI gets a Billing section in the existing ConfigPanel; the platform BFF only proxies.

**Spec:** `docs/superpowers/specs/2026-07-08-shepherd-subscription-billing-design.md` (approved). Do not relitigate plan/pricing decisions.

**Tech Stack:** TypeScript (ESM), Fastify 5, Postgres (`pg`), Zod 3 (`@shepherd/shared` wire contract), `stripe` Node SDK (new dependency, hub only), React (`@korso/shepherd-ui`), Vitest (DB-gated integration suite via `packages/hub/test/setup.ts`).

## Global Constraints

- Prices/limits (copied from spec, exact): Free = $0, **2 seats, 3 repos, 7-day retention**; Pro = **$15/mo flat**, **20 seats**, unlimited repos, **90-day retention**, admin analytics, **14-day trial — app-side, NO credit card required** (human decision 2026-07-08, supersedes the Stripe-side trial); Enterprise = custom, unlimited everything, **no self-serve Checkout at launch**.
- **Billing entity = the workspace.** One Stripe customer + subscription per workspace. No org layer. Flat pricing — never per seat, never per agent.
- **Agents are NEVER a plan lever.** No agent counts anywhere in this plan (anti-abuse rate limiting is separate, out of scope).
- **Hosted-only enforcement.** Every limit check must no-op when billing is not enabled on the deployment (`STRIPE_SECRET_KEY` unset) AND when the request resolved via self-host `TEAM_TOKEN` (`tenant.via === "team"`). Self-host is fully unlimited/unmetered.
- **Downgrade, never lock out.** Grace period on payment failure, then revert to Free *limits*. Never delete data (beyond normal retention pruning), never hard-lock.
- Migration `020` is next. **Atomic-migration invariant** (see `packages/hub/src/migrate.ts` header and `migrations/011_multitenancy.sql`): one implicit transaction per file — no `COMMIT`/`BEGIN`, no `CREATE INDEX CONCURRENTLY`, bare `CREATE`/`ALTER` (no `IF NOT EXISTS`) for domain DDL.
- The verification gate for every task is `npm run check` (root: `tsc -b` + UI build + `vitest run`). DB-gated suites need `TEST_DATABASE_URL` (see `packages/hub/test/setup.ts`; local convention: Postgres on `:5433`).
- Security posture: never echo internal auth detail (see `AUTH_MESSAGES` in `packages/hub/src/server.ts`); the webhook route must be auth-exempt but signature-verified and must fail closed on any verification failure.
- Match surrounding code style: heavily-commented modules, `repo.ts` owns ALL SQL, operations own domain logic, `server.ts` routes are thin parse-and-dispatch.

## Resolved open questions (from the spec's "Open questions" section)

These are the concrete decisions this plan implements. **Flag to the human for confirmation** — see the "Decisions to confirm" list at the end.

1. **Columns (migration `020_workspace_plans.sql`)** — six new `workspaces` columns: `plan text NOT NULL DEFAULT 'free'` (CHECK `free|pro|enterprise`), `plan_status text NOT NULL DEFAULT 'none'` (CHECK `none|trialing|active|past_due|canceled`), `stripe_customer_id text` (partial unique index), `stripe_subscription_id text`, `current_period_end timestamptz`, `grace_until timestamptz`.
2. **Retention cleanup = lazy prune at coordination-write time**, throttled to once per workspace per hour in-memory. Rationale: the hub already prunes `change_records` lazily inside the `work`/`sync`/`heartbeat` transactions (`pruneChangeRecords`, `repo.ts:2257`) — same pattern, zero new infra (no cron on Cloud Run, no boot sweep that misses long-lived instances), and it lands inside an existing transaction. This also finally bounds the announcements ledger (known review finding P2-2, noted at `repo.ts:1686-1691`). `change_records` need no plan-level prune: the existing `CHANGE_RECORD_TTL_SECONDS` default (3 days) is already stricter than both the 7- and 90-day windows.
3. **Limit-hit error shape = HTTP 402 + `code: "plan_limit"` body**, defined in the shared zod contract (`PlanLimitErrorBody`): `{ error, code: "plan_limit", limit: "seats"|"repos", plan, current, max }`. A new `PlanLimitError` hub error class maps to it in the server error handler. 402 is unused by any existing hub surface, so clients can key upgrade UI off the status alone.
4. **Trial = APP-SIDE, NO credit card** (human decision — "no credit card needed" is the adoption lever). An admin calls `POST /workspaces/:id/billing/trial`; the hub flips the workspace to `plan='pro'`, `plan_status='trialing'`, `current_period_end = now + 14 days` — **no Stripe customer, subscription, or card is created at trial start**. The existing `current_period_end` column is dual-used as the trial-end timestamp while trialing (no new column). `effectivePlan()` treats `trialing` as `pro` only while `now < current_period_end`; an expired trial reverts to FREE LIMITS (same downgrade-never-lock-out rule — no data deleted). Converting to paid Pro goes through Stripe Checkout (card entered THEN). **One trial per workspace — concrete guard:** the trial endpoint refuses (409) unless `plan = 'free' AND plan_status = 'none' AND stripe_customer_id IS NULL AND stripe_subscription_id IS NULL` (an expired trial leaves `plan_status='trialing'`, a lapsed subscription leaves `stripe_customer_id` set, so both are caught; accepted edge: an abandoned checkout creates a customer id and thereby blocks a later trial).
5. **Enterprise limits = DB flag set administratively** (documented SQL runbook: `UPDATE workspaces SET plan='enterprise', plan_status='active' WHERE slug=...`). No admin write endpoint at launch — Enterprise is sales-led and rare; the operator `/admin/*` surface stays read-only.
6. **Where checks slot in:** seats → inside `redeemInvite`'s existing transaction (`packages/hub/src/operations/invites.ts:384`, the only place a membership is added besides workspace creation); repos → inside `join`'s transaction (`packages/hub/src/operations/join.ts:187`, the single repo-ingestion point — `work` inherits the session's repo, so gating join gates everything); retention → next to the three `pruneChangeRecords` call sites (`operations/work.ts:101`, `operations/sync.ts:67`, `operations/heartbeat.ts:81`). All checks call a shared guard that returns immediately when `!billingEnabled(config) || tenant.via === "team"`.
7. **Spec deviation — `/admin/*` analytics is NOT plan-gated.** The existing `/admin/analytics` (`server.ts:644`, `requireOperator` in `tenant.ts:156`) is the **cross-tenant Korso-internal operator surface** — gating product-wide operator data on one workspace's plan is incoherent, and workspace admins can't reach it anyway. Instead, the Pro "admin analytics" entitlement is exposed as `entitlements.analytics` in the new `GET /workspaces/:id/billing` response, so the hosted console gates its per-workspace analytics UI on it; a hub-side `requirePlanFeature` helper ships in `plan.ts` for whatever workspace-scoped analytics endpoint lands later. **Confirm this reading with the human.**
8. **Grace period = 14 days** (`BILLING_GRACE_DAYS` config, default 14), set on `invoice.payment_failed`, cleared when the subscription goes `active` again.

## File structure

```
packages/hub/migrations/020_workspace_plans.sql        create — plan columns on workspaces
packages/hub/src/plan.ts                               create — PLAN_LIMITS, effectivePlan, guards
packages/hub/src/retention.ts                          create — throttled per-workspace retention prune
packages/hub/src/billing/stripe.ts                     create — Stripe client wrapper (injectable for tests)
packages/hub/src/billing/webhook.ts                    create — event verification + plan-state transitions
packages/hub/src/operations/billing.ts                 create — trial/checkout/portal/status operations
packages/hub/src/repo.ts                               modify — plan-row reads/writes, pruneAnnouncements
packages/hub/src/errors.ts                             modify — PlanLimitError
packages/hub/src/config.ts                             modify — STRIPE_* env vars + superRefine
packages/hub/src/server.ts                             modify — billing routes, webhook route + auth exemption, 402 mapping
packages/hub/src/operations/invites.ts                 modify — seat check in redeemInvite
packages/hub/src/operations/join.ts                    modify — repo check
packages/hub/src/operations/{work,sync,heartbeat}.ts   modify — retention prune call
packages/hub/package.json                              modify — add "stripe"
packages/shared/src/contract.ts                        modify — Plan, PlanStatus, PlanLimitErrorBody, billing request/response schemas
packages/ui/src/client.ts                              modify — getBilling / startCheckout / openBillingPortal
packages/ui/src/config/Billing.tsx                     create — Billing section (admin actions, member read-only)
packages/ui/src/config/Billing.test.tsx                create
packages/ui/src/config/ConfigPanel.tsx                 modify — add Billing section
packages/hub/test/plan.test.ts                         create — pure-unit effectivePlan/limits
packages/hub/test/planLimits.test.ts                   create — DB-gated seat/repo enforcement
packages/hub/test/retention.test.ts                    create — DB-gated announcement pruning
packages/hub/test/billing.test.ts                      create — DB-gated trial/checkout/portal/status endpoints (fake Stripe)
packages/hub/test/stripeWebhook.test.ts                create — DB-gated webhook signature + transitions
docs/billing-runbook.md                                create — Stripe setup, env vars, Enterprise runbook
```

Phases are ordered hub/data → enforcement → Stripe → UI → docs. Each phase leaves `npm run check` green and is independently shippable (enforcement ships dark until `STRIPE_SECRET_KEY` is set on the hosted deployment).

---

## Phase 1 — Plan state (schema + model, no behavior change)

### Task 1: Migration 020 — plan columns on `workspaces`

**Files:**
- Create: `packages/hub/migrations/020_workspace_plans.sql`
- Test: `packages/hub/test/migrate.test.ts` already asserts all migrations apply; a new DB-gated assertion goes in `packages/hub/test/plan.test.ts` (created here, extended in Task 2)

**Interfaces:**
- Produces: `workspaces.plan`, `workspaces.plan_status`, `workspaces.stripe_customer_id`, `workspaces.stripe_subscription_id`, `workspaces.current_period_end`, `workspaces.grace_until` — every later task reads/writes these exact column names.

- [ ] **Step 1: Write the failing test**

Create `packages/hub/test/plan.test.ts`:

```typescript
/**
 * Tests for workspace plan state (migration 020) and the plan model (plan.ts).
 * The migration assertions are DB-gated; effectivePlan tests (Task 2) are pure.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { dbAvailable, createTestPool, runTestMigrations } from "./setup.js";

describe.skipIf(!dbAvailable)(
  "migration 020: workspace plan columns" + (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    let pool: pg.Pool;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
    });
    afterAll(async () => pool.end());

    it("defaults a new workspace to free / none with no Stripe linkage", async () => {
      const { rows } = await pool.query(
        `INSERT INTO workspaces (slug, name, created_by)
         VALUES ('plan-test-ws', 'Plan Test', 'tester')
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
         RETURNING plan, plan_status, stripe_customer_id,
                   stripe_subscription_id, current_period_end, grace_until`
      );
      expect(rows[0]).toEqual({
        plan: "free",
        plan_status: "none",
        stripe_customer_id: null,
        stripe_subscription_id: null,
        current_period_end: null,
        grace_until: null,
      });
    });

    it("rejects an unknown plan value (CHECK constraint)", async () => {
      await expect(
        pool.query(`UPDATE workspaces SET plan = 'platinum' WHERE slug = 'plan-test-ws'`)
      ).rejects.toThrow(/check constraint/i);
    });

    it("rejects a duplicate stripe_customer_id (partial unique index)", async () => {
      await pool.query(
        `UPDATE workspaces SET stripe_customer_id = 'cus_dupe' WHERE slug = 'plan-test-ws'`
      );
      await expect(
        pool.query(
          `INSERT INTO workspaces (slug, name, created_by, stripe_customer_id)
           VALUES ('plan-test-ws-2', 'Plan Test 2', 'tester', 'cus_dupe')`
        )
      ).rejects.toThrow(/duplicate key/i);
      // cleanup so reruns stay idempotent
      await pool.query(
        `DELETE FROM workspaces WHERE slug IN ('plan-test-ws', 'plan-test-ws-2')`
      );
    });
  }
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/hub/test/plan.test.ts`
Expected: FAIL — `column "plan" ... does not exist` (with `TEST_DATABASE_URL` set; without a DB the suite skips, which is NOT a pass for this task — run it against the test Postgres).

- [ ] **Step 3: Write the migration**

Create `packages/hub/migrations/020_workspace_plans.sql`:

```sql
-- Migration 020: workspace plan / billing state.
-- Design: docs/superpowers/specs/2026-07-08-shepherd-subscription-billing-design.md
--
-- Atomic, single-transaction file (see the invariant in migrate.ts): no COMMIT,
-- no CREATE INDEX CONCURRENTLY. Bare ALTER/CREATE so duplicates stay loud.
--
-- The workspace is the billing entity: each hosted workspace carries its own
-- plan and Stripe customer/subscription. Every existing and future workspace
-- defaults to the free plan with no Stripe linkage — including self-host
-- workspaces, whose hubs never enable billing (no STRIPE_SECRET_KEY), so these
-- columns are inert there.
--
--   plan          — the SUBSCRIBED tier ('free' | 'pro' | 'enterprise').
--                   Stripe webhooks set 'pro'; 'enterprise' is set
--                   administratively (sales-led; see docs/billing-runbook.md).
--   plan_status   — the subscription lifecycle ('none' | 'trialing' | 'active'
--                   | 'past_due' | 'canceled'). 'trialing' is set APP-SIDE by
--                   the no-card trial endpoint (no Stripe objects exist yet);
--                   the other paid states are mapped from Stripe statuses.
--                   The EFFECTIVE plan (what limits apply) is derived in code:
--                   see effectivePlan() in packages/hub/src/plan.ts — trialing
--                   keeps pro limits only until current_period_end; past_due
--                   inside the grace window keeps the paid limits; past_due
--                   beyond it and canceled revert to Free limits. Data is
--                   never deleted and the workspace is never locked.
--   grace_until   — end of the past-due grace window (set on
--                   invoice.payment_failed, cleared when payment recovers).
--   current_period_end — DUAL USE: while plan_status='trialing' (app-side,
--                   card-less trial) this is the TRIAL END; once a Stripe
--                   subscription exists it is the paid-through timestamp.

ALTER TABLE workspaces
  ADD COLUMN plan                   text        NOT NULL DEFAULT 'free'
             CHECK (plan IN ('free', 'pro', 'enterprise')),
  ADD COLUMN plan_status            text        NOT NULL DEFAULT 'none'
             CHECK (plan_status IN ('none', 'trialing', 'active', 'past_due', 'canceled')),
  ADD COLUMN stripe_customer_id     text,
  ADD COLUMN stripe_subscription_id text,
  ADD COLUMN current_period_end     timestamptz,
  ADD COLUMN grace_until            timestamptz;

-- Webhooks resolve a workspace by its Stripe customer; enforce the 1:1 mapping
-- and make the lookup indexed. Partial so the (many) NULL rows don't collide.
CREATE UNIQUE INDEX workspaces_stripe_customer_id_key
  ON workspaces (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/hub/test/plan.test.ts`
Expected: PASS (3 tests). Also run `npx vitest run packages/hub/test/migrate.test.ts` — still PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/hub/migrations/020_workspace_plans.sql packages/hub/test/plan.test.ts
git commit -m "feat(hub): migration 020 — workspace plan/billing columns"
```

### Task 2: Plan model — `plan.ts` + repo helpers

**Files:**
- Create: `packages/hub/src/plan.ts`
- Modify: `packages/hub/src/repo.ts` (append a "Billing / plan state" section)
- Modify: `packages/shared/src/contract.ts` (Plan/PlanStatus enums only — the rest of the contract lands in Task 3)
- Test: `packages/hub/test/plan.test.ts` (extend)

**Interfaces:**
- Consumes: migration 020 columns (Task 1); `Queryable` type in `repo.ts:34`.
- Produces (used by Tasks 4-9):
  - `@shepherd/shared`: `Plan = z.enum(["free","pro","enterprise"])`, `PlanStatus = z.enum(["none","trialing","active","past_due","canceled"])`, inferred `PlanT`, `PlanStatusT`.
  - `plan.ts`: `PLAN_LIMITS: Record<PlanT, PlanLimits>` where `PlanLimits = { seats: number|null; repos: number|null; retentionDays: number|null; analytics: boolean }` (null = unlimited); `effectivePlan(row: WorkspacePlanRow, now?: Date): PlanT`; `billingEnabled(config: Config): boolean`.
  - `repo.ts`: `WorkspacePlanRow` interface `{ plan: PlanT; plan_status: PlanStatusT; stripe_customer_id: string|null; stripe_subscription_id: string|null; current_period_end: Date|null; grace_until: Date|null }`; `getWorkspacePlanRow(db: Queryable, workspaceId: string): Promise<WorkspacePlanRow | null>`; `setStripeCustomerId(db, workspaceId, customerId): Promise<void>`; `findWorkspaceIdByStripeCustomerId(db, customerId): Promise<string | null>`; `applyPlanState(db, workspaceId, patch: { plan: PlanT; planStatus: PlanStatusT; stripeSubscriptionId?: string|null; currentPeriodEnd?: Date|null; graceUntil?: Date|null }): Promise<void>`.

- [ ] **Step 1: Write the failing tests** (append to `packages/hub/test/plan.test.ts` — these are pure, NOT DB-gated)

```typescript
import { PLAN_LIMITS, effectivePlan, billingEnabled } from "../src/plan.js";
import type { WorkspacePlanRow } from "../src/repo.js";

function row(overrides: Partial<WorkspacePlanRow> = {}): WorkspacePlanRow {
  return {
    plan: "free",
    plan_status: "none",
    stripe_customer_id: null,
    stripe_subscription_id: null,
    current_period_end: null,
    grace_until: null,
    ...overrides,
  };
}

describe("PLAN_LIMITS", () => {
  it("encodes the spec's limits exactly", () => {
    expect(PLAN_LIMITS.free).toEqual({ seats: 2, repos: 3, retentionDays: 7, analytics: false });
    expect(PLAN_LIMITS.pro).toEqual({ seats: 20, repos: null, retentionDays: 90, analytics: true });
    expect(PLAN_LIMITS.enterprise).toEqual({ seats: null, repos: null, retentionDays: null, analytics: true });
  });
});

describe("effectivePlan", () => {
  const now = new Date("2026-07-08T12:00:00Z");

  it("free stays free", () => {
    expect(effectivePlan(row(), now)).toBe("free");
  });
  it("pro active keeps pro limits", () => {
    expect(effectivePlan(row({ plan: "pro", plan_status: "active" }), now)).toBe("pro");
  });
  it("trialing keeps pro limits only until current_period_end (the trial end)", () => {
    const live = row({ plan: "pro", plan_status: "trialing", current_period_end: new Date("2026-07-15T00:00:00Z") });
    const expired = row({ plan: "pro", plan_status: "trialing", current_period_end: new Date("2026-07-01T00:00:00Z") });
    const missingEnd = row({ plan: "pro", plan_status: "trialing", current_period_end: null });
    expect(effectivePlan(live, now)).toBe("pro");
    expect(effectivePlan(expired, now)).toBe("free"); // expired trial → FREE LIMITS, no lock-out
    expect(effectivePlan(missingEnd, now)).toBe("free"); // fail toward free
  });
  it("past_due keeps pro inside the grace window, reverts to free after", () => {
    const inGrace = row({ plan: "pro", plan_status: "past_due", grace_until: new Date("2026-07-20T00:00:00Z") });
    const pastGrace = row({ plan: "pro", plan_status: "past_due", grace_until: new Date("2026-07-01T00:00:00Z") });
    const noGrace = row({ plan: "pro", plan_status: "past_due", grace_until: null });
    expect(effectivePlan(inGrace, now)).toBe("pro");
    expect(effectivePlan(pastGrace, now)).toBe("free");
    expect(effectivePlan(noGrace, now)).toBe("free");
  });
  it("canceled reverts to free limits (data untouched — this is limits only)", () => {
    expect(effectivePlan(row({ plan: "pro", plan_status: "canceled" }), now)).toBe("free");
  });
  it("enterprise is administratively set and ignores plan_status", () => {
    expect(effectivePlan(row({ plan: "enterprise", plan_status: "none" }), now)).toBe("enterprise");
  });
});

describe("billingEnabled", () => {
  it("keys strictly off STRIPE_SECRET_KEY", () => {
    const base = { DATABASE_URL: "x" } as never;
    expect(billingEnabled(base)).toBe(false);
    expect(billingEnabled({ ...(base as object), STRIPE_SECRET_KEY: "sk_test_x" } as never)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/hub/test/plan.test.ts`
Expected: FAIL — `Cannot find module '../src/plan.js'`.

- [ ] **Step 3: Add the shared enums** (in `packages/shared/src/contract.ts`, near the `Role` enum at line 405)

```typescript
// ---------------------------------------------------------------------------
// Billing plans (hosted workspaces only — self-host is unlimited/unmetered).
// The workspace is the billing entity; plan state lives on the workspaces
// table and these enums are its wire vocabulary. See the design doc:
// docs/superpowers/specs/2026-07-08-shepherd-subscription-billing-design.md
// ---------------------------------------------------------------------------

/** The subscribed tier. 'enterprise' is set administratively (sales-led). */
export const Plan = z.enum(["free", "pro", "enterprise"]);

/**
 * The subscription lifecycle, mapped from Stripe. The EFFECTIVE plan (which
 * limits apply) is derived hub-side: past_due keeps paid limits inside the
 * grace window; canceled / lapsed past_due revert to Free LIMITS (never a
 * lock-out, never deletion).
 */
export const PlanStatus = z.enum(["none", "trialing", "active", "past_due", "canceled"]);
```

And the inferred types alongside the file's existing `export type ...T` block:

```typescript
export type PlanT = z.infer<typeof Plan>;
export type PlanStatusT = z.infer<typeof PlanStatus>;
```

(Match how the file exports its other inferred types — follow the existing `RoleT` pattern, and re-export from `packages/shared/src/index.ts` if the barrel enumerates names rather than `export *`.)

- [ ] **Step 4: Create `packages/hub/src/plan.ts`**

```typescript
/**
 * Plan model for @shepherd/hub — the single source of truth for what each
 * billing tier allows and which tier a workspace EFFECTIVELY has right now.
 *
 * Design: docs/superpowers/specs/2026-07-08-shepherd-subscription-billing-design.md
 *
 * HOSTED-ONLY: every consumer must first check `billingEnabled(config)` (and
 * skip `tenant.via === "team"` requests). A self-host deployment never sets
 * STRIPE_SECRET_KEY, so all limits are inert there by construction.
 *
 * Agents are NEVER a plan lever — nothing in this module counts agents.
 */

import type { PlanT } from "@shepherd/shared";
import type { Config } from "./config.js";
import type { WorkspacePlanRow } from "./repo.js";

/** What a tier allows. `null` = unlimited. */
export interface PlanLimits {
  /** Max human memberships in the workspace. */
  seats: number | null;
  /** Max DISTINCT repos coordinated in the workspace. */
  repos: number | null;
  /** Announcement history retention window, in days. */
  retentionDays: number | null;
  /** Whether the workspace-admin analytics surface is entitled. */
  analytics: boolean;
}

/** The plan table, verbatim from the approved design (do not tweak casually). */
export const PLAN_LIMITS: Record<PlanT, PlanLimits> = {
  free: { seats: 2, repos: 3, retentionDays: 7, analytics: false },
  pro: { seats: 20, repos: null, retentionDays: 90, analytics: true },
  enterprise: { seats: null, repos: null, retentionDays: null, analytics: true },
};

/** Whether this deployment bills at all. Self-host never sets the key. */
export function billingEnabled(config: Config): boolean {
  return config.STRIPE_SECRET_KEY !== undefined;
}

/**
 * The tier whose LIMITS currently apply to a workspace — the downgrade-never-
 * lock-out rule as one pure function:
 *  - free       → free.
 *  - enterprise → enterprise regardless of plan_status (set administratively,
 *                 no Stripe subscription drives it).
 *  - pro        → pro while active; trialing (the app-side, no-card trial)
 *                 keeps pro only until current_period_end — the trial-end
 *                 timestamp — and fails toward free when it is missing or
 *                 past; past_due keeps pro until grace_until lapses (a
 *                 missing grace_until fails toward free); canceled (and any
 *                 other state) reverts to FREE LIMITS.
 * Reverting means limits only: data is never deleted here and nothing locks.
 */
export function effectivePlan(row: WorkspacePlanRow, now: Date = new Date()): PlanT {
  if (row.plan === "free") return "free";
  if (row.plan === "enterprise") return "enterprise";
  switch (row.plan_status) {
    case "active":
      return row.plan;
    case "trialing":
      // App-side trial: current_period_end holds the trial end (dual use —
      // see migration 020). An expired or end-less trial is Free limits.
      return row.current_period_end !== null && row.current_period_end > now ? row.plan : "free";
    case "past_due":
      return row.grace_until !== null && row.grace_until > now ? row.plan : "free";
    default:
      return "free";
  }
}
```

- [ ] **Step 5: Append the repo helpers** (new section at the end of `packages/hub/src/repo.ts`, before the analytics section, importing `PlanT`/`PlanStatusT` from `@shepherd/shared`)

```typescript
// ---------------------------------------------------------------------------
// Billing / plan state (migration 020)
//
// Plan state lives on the workspaces row. Reads/writes here; the meaning of
// the fields (effective plan, grace window) lives in plan.ts.
// ---------------------------------------------------------------------------

/** The plan/billing slice of a workspaces row. */
export interface WorkspacePlanRow {
  plan: PlanT;
  plan_status: PlanStatusT;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: Date | null;
  grace_until: Date | null;
}

/** The plan/billing columns of one workspace, or null when it doesn't exist. */
export async function getWorkspacePlanRow(
  db: Queryable,
  workspaceId: string
): Promise<WorkspacePlanRow | null> {
  const { rows } = await db.query<WorkspacePlanRow>(
    `SELECT plan, plan_status, stripe_customer_id, stripe_subscription_id,
            current_period_end, grace_until
     FROM   workspaces
     WHERE  id = $1`,
    [workspaceId]
  );
  return rows[0] ?? null;
}

/**
 * Record the workspace's Stripe customer id (created lazily at first
 * checkout). The partial unique index enforces the 1:1 mapping.
 */
export async function setStripeCustomerId(
  db: Queryable,
  workspaceId: string,
  customerId: string
): Promise<void> {
  await db.query(
    `UPDATE workspaces SET stripe_customer_id = $2 WHERE id = $1`,
    [workspaceId, customerId]
  );
}

/** Webhook lookup: which workspace a Stripe customer belongs to, or null. */
export async function findWorkspaceIdByStripeCustomerId(
  db: Queryable,
  customerId: string
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM workspaces WHERE stripe_customer_id = $1`,
    [customerId]
  );
  return rows[0]?.id ?? null;
}

/**
 * Apply a plan-state transition (webhook or admin action). plan/planStatus are
 * always written; the optional fields are written only when the caller passes
 * them (undefined = leave as-is; null = clear), so partial webhook knowledge
 * never clobbers fields it didn't carry.
 */
export async function applyPlanState(
  db: Queryable,
  workspaceId: string,
  patch: {
    plan: PlanT;
    planStatus: PlanStatusT;
    stripeSubscriptionId?: string | null;
    currentPeriodEnd?: Date | null;
    graceUntil?: Date | null;
  }
): Promise<void> {
  await db.query(
    `UPDATE workspaces SET
       plan        = $2,
       plan_status = $3,
       stripe_subscription_id = CASE WHEN $4 THEN $5 ELSE stripe_subscription_id END,
       current_period_end     = CASE WHEN $6 THEN $7::timestamptz ELSE current_period_end END,
       grace_until            = CASE WHEN $8 THEN $9::timestamptz ELSE grace_until END
     WHERE id = $1`,
    [
      workspaceId,
      patch.plan,
      patch.planStatus,
      patch.stripeSubscriptionId !== undefined,
      patch.stripeSubscriptionId ?? null,
      patch.currentPeriodEnd !== undefined,
      patch.currentPeriodEnd ?? null,
      patch.graceUntil !== undefined,
      patch.graceUntil ?? null,
    ]
  );
}
```

Note: `config.ts` gains `STRIPE_SECRET_KEY` as an optional string in this task so `billingEnabled` type-checks (the full config block with superRefine lands in Task 7):

```typescript
  // Billing (hosted deployments only; self-host never sets these — Task 7 adds
  // the remaining STRIPE_* vars and the completeness superRefine).
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
```

- [ ] **Step 6: Add a DB-gated round-trip test for the repo helpers** (append inside the existing DB-gated describe in `plan.test.ts`)

```typescript
    it("round-trips plan state through the repo helpers", async () => {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO workspaces (slug, name, created_by)
         VALUES ('plan-repo-ws', 'Plan Repo', 'tester') RETURNING id`
      );
      const wsId = rows[0]!.id;
      const { getWorkspacePlanRow, setStripeCustomerId, findWorkspaceIdByStripeCustomerId, applyPlanState } =
        await import("../src/repo.js");

      await setStripeCustomerId(pool, wsId, "cus_roundtrip");
      expect(await findWorkspaceIdByStripeCustomerId(pool, "cus_roundtrip")).toBe(wsId);

      const periodEnd = new Date("2026-08-08T00:00:00Z");
      await applyPlanState(pool, wsId, {
        plan: "pro",
        planStatus: "trialing",
        stripeSubscriptionId: "sub_1",
        currentPeriodEnd: periodEnd,
      });
      let row = await getWorkspacePlanRow(pool, wsId);
      expect(row).toMatchObject({
        plan: "pro",
        plan_status: "trialing",
        stripe_customer_id: "cus_roundtrip",
        stripe_subscription_id: "sub_1",
      });
      expect(row!.current_period_end!.toISOString()).toBe(periodEnd.toISOString());
      expect(row!.grace_until).toBeNull();

      // Omitted fields are preserved (undefined = leave as-is).
      await applyPlanState(pool, wsId, { plan: "pro", planStatus: "active" });
      row = await getWorkspacePlanRow(pool, wsId);
      expect(row!.stripe_subscription_id).toBe("sub_1");

      await pool.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    });
```

- [ ] **Step 7: Run tests, then the full gate**

Run: `npx vitest run packages/hub/test/plan.test.ts` — Expected: PASS.
Run: `npm run check` — Expected: build + full suite green.

- [ ] **Step 8: Commit**

```bash
git add packages/hub/src/plan.ts packages/hub/src/repo.ts packages/hub/src/config.ts \
        packages/shared/src/contract.ts packages/shared/src/index.ts packages/hub/test/plan.test.ts
git commit -m "feat(hub): plan model — PLAN_LIMITS, effectivePlan, plan-state repo helpers"
```

---

## Phase 2 — Wire contract + error shape

### Task 3: Shared billing contract + `PlanLimitError` (402)

**Files:**
- Modify: `packages/shared/src/contract.ts` (after the Plan/PlanStatus block from Task 2)
- Modify: `packages/hub/src/errors.ts`
- Modify: `packages/hub/src/server.ts` (error handler branch)
- Test: `packages/hub/test/plan.test.ts` (extend, pure unit for the error class) and `packages/hub/test/server.test.ts` conventions are NOT touched — the 402 mapping is exercised end-to-end in Task 4's tests.

**Interfaces:**
- Produces:
  - `@shepherd/shared`: `PlanLimitErrorBody` (below) + `PlanLimitErrorBodyT`; `BillingStatusResponse` + `BillingStatusResponseT` (includes `trialAvailable`); `StartTrialResponse { plan, planStatus, trialEndsAt }` + `StartTrialResponseT`; `CreateCheckoutSessionRequest` `{ interval: "month"|"year" (default "month") }` + `CheckoutSessionResponse { url: string }`; `PortalSessionResponse { url: string }`.
  - `hub/errors.ts`: `class PlanLimitError extends HubError { status: 402; limit: "seats"|"repos"; plan: PlanT; current: number; max: number }` with constructor `new PlanLimitError(limit, plan, current, max)` that composes its own user-facing message.
  - `server.ts` error handler: `PlanLimitError` → HTTP 402 with a body that parses as `PlanLimitErrorBody`.

- [ ] **Step 1: Add the contract schemas** (append to `packages/shared/src/contract.ts` after PlanStatus)

```typescript
// ---------------------------------------------------------------------------
// Plan-limit error body (HTTP 402) — what the hub returns when a plan limit
// blocks an action, so clients can render a precise upgrade prompt. `error`
// stays the human-readable line every other hub error carries; `code` is the
// machine key clients switch on.
// ---------------------------------------------------------------------------
export const PlanLimitErrorBody = z.object({
  error: z.string(),
  code: z.literal("plan_limit"),
  limit: z.enum(["seats", "repos"]),
  plan: Plan,
  current: z.number().int(),
  max: z.number().int(),
});

// ---------------------------------------------------------------------------
// getBilling(workspaceId) -> BillingStatusResponse   (GET /workspaces/:id/billing)
//
// Readable by ANY member (non-admins see plan status read-only in the UI);
// the mutating billing endpoints below are admin-only. On a deployment with
// billing disabled (self-host) this returns billingEnabled:false with
// unlimited usage maxima so the UI can hide the panel.
// ---------------------------------------------------------------------------
export const BillingStatusResponse = z.object({
  billingEnabled: z.boolean(),
  plan: Plan,
  planStatus: PlanStatus,
  /** The tier whose LIMITS currently apply (grace/downgrade fallback applied). */
  effectivePlan: Plan,
  currentPeriodEnd: IsoTimestamp.nullable(),
  graceUntil: IsoTimestamp.nullable(),
  seats: z.object({ used: z.number().int(), max: z.number().int().nullable() }),
  repos: z.object({ used: z.number().int(), max: z.number().int().nullable() }),
  retentionDays: z.number().int().nullable(),
  entitlements: z.object({ analytics: z.boolean() }),
  /**
   * Whether this workspace may start the 14-day, NO-CARD app-side trial —
   * true only for a never-trialed, never-subscribed free workspace (the
   * one-trial-per-workspace guard, computed hub-side). Drives the UI's
   * "Start free trial — no credit card" button.
   */
  trialAvailable: z.boolean(),
});

// ---------------------------------------------------------------------------
// startTrial(workspaceId) -> StartTrialResponse
//   (POST /workspaces/:id/billing/trial — admin-only. Starts the 14-day
//    APP-SIDE trial: plan='pro', plan_status='trialing', current_period_end =
//    trial end. NO Stripe customer/subscription/card is created — converting
//    to paid Pro goes through Checkout later. 409 when the workspace has ever
//    trialed or subscribed.)
// ---------------------------------------------------------------------------
export const StartTrialResponse = z.object({
  plan: Plan,
  planStatus: PlanStatus,
  /** When the trial reverts to Free LIMITS (stored in current_period_end). */
  trialEndsAt: IsoTimestamp,
});

// ---------------------------------------------------------------------------
// startCheckout(workspaceId, { interval }) -> { url }
//   (POST /workspaces/:id/billing/checkout — admin-only, Pro upgrades and
//    trial→paid conversions; card is entered HERE (the trial itself is
//    card-less). Enterprise is sales-led with no self-serve Checkout at launch.)
// openBillingPortal(workspaceId) -> { url }
//   (POST /workspaces/:id/billing/portal — admin-only.)
// ---------------------------------------------------------------------------
export const CreateCheckoutSessionRequest = z.object({
  interval: z.enum(["month", "year"]).default("month"),
});
export const CheckoutSessionResponse = z.object({ url: z.string() });
export const PortalSessionResponse = z.object({ url: z.string() });
```

Add the inferred `...T` type exports next to the others: `PlanLimitErrorBodyT`, `BillingStatusResponseT`, `StartTrialResponseT`, `CreateCheckoutSessionRequestT`, `CheckoutSessionResponseT`, `PortalSessionResponseT`.

- [ ] **Step 2: Write the failing unit test** (append to `plan.test.ts`, pure)

```typescript
import { PlanLimitError } from "../src/errors.js";
import { PlanLimitErrorBody } from "@shepherd/shared";

describe("PlanLimitError", () => {
  it("carries a 402 status and serializes to the shared body shape", () => {
    const err = new PlanLimitError("seats", "free", 2, 2);
    expect(err.status).toBe(402);
    const body = {
      error: err.message,
      code: "plan_limit" as const,
      limit: err.limit,
      plan: err.plan,
      current: err.current,
      max: err.max,
    };
    expect(() => PlanLimitErrorBody.parse(body)).not.toThrow();
    expect(err.message).toMatch(/seat limit/i);
    expect(err.message).toMatch(/upgrade/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run packages/hub/test/plan.test.ts`
Expected: FAIL — `PlanLimitError` is not exported.

- [ ] **Step 4: Add the error class** (append to `packages/hub/src/errors.ts`)

```typescript
/**
 * Thrown when a PLAN LIMIT blocks a well-formed, authorized action on a
 * hosted workspace (seat cap on invite redemption, repo cap on join). Maps to
 * HTTP 402 Payment Required with the shared `PlanLimitErrorBody` shape so the
 * UI can render a precise upgrade prompt.
 *
 * Like ConflictError, the message is user-facing actionable guidance and is
 * echoed verbatim — the caller is already an authenticated member of this
 * workspace, so there is no existence-leak concern. NEVER thrown on a
 * self-host (TEAM_TOKEN) path or a billing-disabled deployment: the guards in
 * plan.ts no-op there (self-host is unlimited by design).
 */
export class PlanLimitError extends HubError {
  readonly status = 402 as const;
  readonly limit: "seats" | "repos";
  readonly plan: "free" | "pro" | "enterprise";
  readonly current: number;
  readonly max: number;

  constructor(
    limit: "seats" | "repos",
    plan: "free" | "pro" | "enterprise",
    current: number,
    max: number
  ) {
    const noun = limit === "seats" ? "seat" : "repo";
    super(
      `This workspace has reached its ${noun} limit (${current}/${max} on the ${plan} plan). ` +
        `Upgrade the workspace plan to add more.`
    );
    this.limit = limit;
    this.plan = plan;
    this.current = current;
    this.max = max;
  }
}
```

- [ ] **Step 5: Map it in the error handler** (in `packages/hub/src/server.ts`, add to the imports from `./errors.js` and insert a branch in `setErrorHandler` between the `ConflictError` and `NotConfiguredError` branches)

```typescript
    // Domain: a plan limit blocked the action (hosted workspaces only) → 402
    // with the machine-readable shared PlanLimitErrorBody, so the UI/MCP client
    // can render an upgrade prompt. Message is user-facing (like ConflictError).
    if (err instanceof PlanLimitError) {
      return reply.status(err.status).send({
        error: err.message,
        code: "plan_limit",
        limit: err.limit,
        plan: err.plan,
        current: err.current,
        max: err.max,
      });
    }
```

- [ ] **Step 6: Run tests + gate**

Run: `npx vitest run packages/hub/test/plan.test.ts` — PASS.
Run: `npm run check` — green.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/contract.ts packages/shared/src/index.ts \
        packages/hub/src/errors.ts packages/hub/src/server.ts packages/hub/test/plan.test.ts
git commit -m "feat: shared billing contract + PlanLimitError (402 plan_limit body)"
```

---

## Phase 3 — Limit enforcement (ships dark until billing is enabled)

### Task 4: Seat limit on invite redemption

**Files:**
- Modify: `packages/hub/src/plan.ts` (add the guard)
- Modify: `packages/hub/src/operations/invites.ts` (`redeemInvite`, inside the transaction at line ~384)
- Test: Create `packages/hub/test/planLimits.test.ts`

**Interfaces:**
- Consumes: `PLAN_LIMITS`, `effectivePlan`, `billingEnabled` (Task 2); `getWorkspacePlanRow`, `countMembers` (`repo.ts:898`, signature `(db, workspaceId) => Promise<number>` — verify and adapt if it differs); `PlanLimitError` (Task 3); `TenantContext` (`tenant.ts:51`).
- Produces: `assertSeatAvailable(tx: Queryable, config: Config, tenant: TenantContext, workspaceId: string): Promise<void>` in `plan.ts` — throws `PlanLimitError("seats", ...)` when adding one more membership would exceed the effective plan's seat cap; returns silently otherwise.

- [ ] **Step 1: Write the failing test.** Create `packages/hub/test/planLimits.test.ts`, mirroring the harness of `packages/hub/test/invites.test.ts` / `workspaces.test.ts` (real pool, `initContext`, `buildServer`, `bffHeaders`, `truncateTenancy` between tests, `__resetRateLimiter`). Test config MUST include `STRIPE_SECRET_KEY: "sk_test_fake"` (billing enabled) plus dummies for the other STRIPE_ fields once Task 7 makes them co-required.

```typescript
/**
 * Plan-limit enforcement (seats + repos) — DB-gated. Billing is ENABLED in
 * this suite's config (STRIPE_SECRET_KEY set); the self-host/team-token and
 * billing-disabled no-op paths are asserted explicitly.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import pg from "pg";
import type { FastifyInstance } from "fastify";
import { dbAvailable, createTestPool, runTestMigrations, truncateAll, truncateTenancy } from "./setup.js";
import { initContext, resetContext } from "../src/context.js";
import { buildServer } from "../src/server.js";
import { __resetRateLimiter } from "../src/tenant.js";
// ... makeTestConfig / bffHeaders / seedWorkspace helpers copied from workspaces.test.ts,
//     with makeTestConfig extended: STRIPE_SECRET_KEY: "sk_test_fake",
//     STRIPE_WEBHOOK_SECRET: "whsec_fake", STRIPE_PRICE_PRO_MONTHLY: "price_fake",
//     PUBLIC_WEB_URL: "https://app.test".

describe.skipIf(!dbAvailable)("seat limit (free = 2 seats)", () => {
  // beforeAll: pool + migrations; beforeEach: initContext(makeTestConfig(), pool),
  // app = buildServer(); afterEach: truncateTenancy + truncateAll + resetContext
  // + __resetRateLimiter; afterAll: pool.end().

  async function seedFreeWorkspaceWithInvite(pool: pg.Pool) {
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO workspaces (slug, name, created_by) VALUES ('seat-ws', 'Seat WS', 'acct-owner') RETURNING id`
    );
    const wsId = rows[0]!.id;
    await pool.query(
      `INSERT INTO memberships (account_id, workspace_id, role) VALUES ('acct-owner', $1, 'admin')`,
      [wsId]
    );
    await pool.query(
      `INSERT INTO invites (workspace_id, code, created_by, role_granted, max_uses)
       VALUES ($1, 'seatcode', 'acct-owner', 'member', 10)`,
      [wsId]
    );
    return wsId;
  }

  it("admits the 2nd member on free, blocks the 3rd with a 402 plan_limit body", async () => {
    const wsId = await seedFreeWorkspaceWithInvite(pool);

    const second = await app.inject({
      method: "POST",
      url: "/invites/seatcode/redeem",
      headers: bffHeaders("acct-2"),
    });
    expect(second.statusCode).toBe(200);

    const third = await app.inject({
      method: "POST",
      url: "/invites/seatcode/redeem",
      headers: bffHeaders("acct-3"),
    });
    expect(third.statusCode).toBe(402);
    const body = third.json();
    expect(body).toMatchObject({
      code: "plan_limit",
      limit: "seats",
      plan: "free",
      current: 2,
      max: 2,
    });

    // The blocked redeem burned nothing: membership count unchanged.
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM memberships WHERE workspace_id = $1`,
      [wsId]
    );
    expect(rows[0].n).toBe(2);
  });

  it("a pro workspace admits up to 20 members (3rd join succeeds)", async () => {
    const wsId = await seedFreeWorkspaceWithInvite(pool);
    await pool.query(
      `UPDATE workspaces SET plan = 'pro', plan_status = 'active' WHERE id = $1`,
      [wsId]
    );
    await app.inject({ method: "POST", url: "/invites/seatcode/redeem", headers: bffHeaders("acct-2") });
    const third = await app.inject({
      method: "POST",
      url: "/invites/seatcode/redeem",
      headers: bffHeaders("acct-3"),
    });
    expect(third.statusCode).toBe(200);
  });

  it("with billing disabled (no STRIPE_SECRET_KEY) the free cap does not apply", async () => {
    // Re-init context with a config that has NO STRIPE_SECRET_KEY, rebuild app,
    // seed the same fixture, redeem three accounts — all 200.
  });
});
```

(Write the third test in full — same shape as the first with the alternate config and three 200 assertions.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/hub/test/planLimits.test.ts`
Expected: the "blocks the 3rd" test FAILS (gets 200, expected 402) — enforcement doesn't exist yet.

- [ ] **Step 3: Add the guard to `plan.ts`**

```typescript
import type { Queryable } from "./repo.js"; // export the Queryable type alias from repo.ts (it is module-private today — a one-line `export type` change)
import { getWorkspacePlanRow, countMembers } from "./repo.js";
import { PlanLimitError } from "./errors.js";
import type { TenantContext } from "./tenant.js";

/**
 * Block adding one more MEMBERSHIP when the workspace's effective plan is at
 * its seat cap. Call INSIDE the same transaction that inserts the membership
 * so the count and the insert are atomic under redeemInvite's flow.
 *
 * No-ops (returns silently) when:
 *  - this deployment doesn't bill (self-host: no STRIPE_SECRET_KEY), or
 *  - the request resolved via the self-host TEAM_TOKEN, or
 *  - the effective plan is unlimited (enterprise).
 */
export async function assertSeatAvailable(
  tx: Queryable,
  config: Config,
  tenant: TenantContext,
  workspaceId: string
): Promise<void> {
  if (!billingEnabled(config) || tenant.via === "team") return;
  const row = await getWorkspacePlanRow(tx, workspaceId);
  if (row === null) return; // workspace existence is the caller's concern
  const plan = effectivePlan(row);
  const max = PLAN_LIMITS[plan].seats;
  if (max === null) return;
  const used = await countMembers(tx, workspaceId);
  if (used >= max) {
    throw new PlanLimitError("seats", plan, used, max);
  }
}
```

- [ ] **Step 4: Wire it into `redeemInvite`** (`packages/hub/src/operations/invites.ts`, inside the `withTransaction` block at step 6, BEFORE `incrementInviteUse` so a blocked redeem burns no use)

```typescript
  await withTransaction(pool, async (tx) => {
    // Plan gate (hosted only): a membership is about to be added — enforce the
    // effective plan's seat cap atomically with the insert. Throws
    // PlanLimitError (402) without burning an invite use. Self-host and
    // billing-disabled deployments no-op inside the guard.
    await assertSeatAvailable(tx, getContext().config, tenant, workspaceId);

    const claimed = await incrementInviteUse(tx, code);
    // ... existing code unchanged
```

(Import `assertSeatAvailable` from `../plan.js`. Note the existing `.catch` only records redeem-failure throttling for `InviteError` — `PlanLimitError` propagates untouched to the 402 mapping, which is correct: the code was valid.)

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/hub/test/planLimits.test.ts` — PASS.
Run: `npx vitest run packages/hub/test/invites.test.ts` — still PASS (billing disabled in that suite's config → guard no-ops).

- [ ] **Step 6: Commit**

```bash
git add packages/hub/src/plan.ts packages/hub/src/repo.ts \
        packages/hub/src/operations/invites.ts packages/hub/test/planLimits.test.ts
git commit -m "feat(hub): enforce plan seat limit on invite redemption (402 plan_limit)"
```

### Task 5: Repo limit on join

**Files:**
- Modify: `packages/hub/src/plan.ts` (add `assertRepoAllowed`)
- Modify: `packages/hub/src/operations/join.ts` (inside the transaction, before `createSession` at line ~273)
- Test: `packages/hub/test/planLimits.test.ts` (extend)

**Interfaces:**
- Consumes: `listWorkspaceRepos` (`repo.ts:1659`, `(db, workspaceId) => Promise<string[]>` over DISTINCT session repos); `canonicalizeRepo` from `@shepherd/shared`; everything from Task 4.
- Produces: `assertRepoAllowed(tx: Queryable, config: Config, tenant: TenantContext, workspaceId: string, repo: string): Promise<void>` — no-op if `repo` (already canonicalized) is among the workspace's existing repos; throws `PlanLimitError("repos", ...)` when it's NEW and the distinct-repo count is at the cap.

- [ ] **Step 1: Write the failing test** (append to `planLimits.test.ts`; join needs an agent credential — mint an `shp_` token like `tokens.test.ts` does, or use the BFF path? `/join` is called with an agent token in production. Seed an api_tokens row by hand exactly as `workspaces.test.ts` seeds them: insert `api_tokens (account_id, workspace_id, token_hash)` with `hashToken("shp_test_x")` from `../src/tenant.js`, plus the membership for that account.)

```typescript
describe.skipIf(!dbAvailable)("repo limit (free = 3 repos)", () => {
  async function joinRepo(app: FastifyInstance, repo: string, token: string, slug: string) {
    return app.inject({
      method: "POST",
      url: "/join",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      payload: { workspace: slug, human: "tester", program: "test", repo, branch: "main" },
    });
  }

  it("admits 3 distinct repos on free, blocks the 4th; re-joining an existing repo always passes", async () => {
    // seed workspace 'repo-ws' + membership acct-1 + workspace-scoped token shp_test_repo
    for (const repo of ["repo-a", "repo-b", "repo-c"]) {
      const res = await joinRepo(app, repo, "shp_test_repo", "repo-ws");
      expect(res.statusCode).toBe(200);
    }
    const fourth = await joinRepo(app, "repo-d", "shp_test_repo", "repo-ws");
    expect(fourth.statusCode).toBe(402);
    expect(fourth.json()).toMatchObject({ code: "plan_limit", limit: "repos", plan: "free", current: 3, max: 3 });

    // An EXISTING repo is never blocked — the cap gates new repos only.
    const rejoin = await joinRepo(app, "repo-a", "shp_test_repo", "repo-ws");
    expect(rejoin.statusCode).toBe(200);
  });

  it("pro workspaces have unlimited repos (4th join succeeds)", async () => {
    // same fixture with plan='pro', plan_status='active' → 4 joins, all 200
  });

  it("self-host TEAM_TOKEN joins are never repo-limited even with billing enabled", async () => {
    // join 4 distinct repos via the TEAM_TOKEN bearer against ALLOWED_WORKSPACE — all 200
  });
});
```

(Write all three tests in full following the first's structure.)

- [ ] **Step 2: Run to verify the new tests fail** — the 4th join returns 200 today.

- [ ] **Step 3: Add `assertRepoAllowed` to `plan.ts`**

```typescript
import { listWorkspaceRepos } from "./repo.js";

/**
 * Block a join that would introduce a NEW distinct repo beyond the effective
 * plan's repo cap. `repo` must already be canonicalized (join canonicalizes at
 * its single ingestion point). Joining an EXISTING repo always passes — the
 * cap gates growth, it never breaks a workspace that is already over it
 * (e.g. after a downgrade: existing repos keep working, new ones are blocked).
 *
 * RACE NOTE: two concurrent joins introducing two different new repos could
 * both pass the count. join.ts closes this by taking the workspace-level
 * advisory xact lock before calling this guard when the repo is new; the
 * limit is a segmentation lever, so even that residual strictness is about
 * correctness of the error message, not cost.
 *
 * Same no-op conditions as assertSeatAvailable (billing disabled / team path /
 * unlimited plan).
 */
export async function assertRepoAllowed(
  tx: Queryable,
  config: Config,
  tenant: TenantContext,
  workspaceId: string,
  repo: string
): Promise<void> {
  if (!billingEnabled(config) || tenant.via === "team") return;
  const row = await getWorkspacePlanRow(tx, workspaceId);
  if (row === null) return;
  const plan = effectivePlan(row);
  const max = PLAN_LIMITS[plan].repos;
  if (max === null) return;
  const repos = await listWorkspaceRepos(tx, workspaceId);
  if (repos.includes(repo)) return;
  if (repos.length >= max) {
    throw new PlanLimitError("repos", plan, repos.length, max);
  }
}
```

- [ ] **Step 4: Wire it into `join`** (`packages/hub/src/operations/join.ts`). Hoist the canonicalization that is currently inline in the `createSession` call into a const at the top of the `withTransaction` callback, and gate before session creation:

```typescript
  // Canonicalize ONCE at the single repo-ingestion point (see the comment on
  // createSession below) so the plan gate and the session row agree.
  const repo = canonicalizeRepo(input.repo);

  return withTransaction(pool, async (tx) => {
    // Plan gate (hosted only): a NEW distinct repo may be entering this
    // workspace. Serialize the check-then-create against concurrent joins with
    // the workspace-level advisory xact lock (auto-released at COMMIT/ROLLBACK)
    // so two racing new repos can't both slip under the cap.
    await tx.query("SELECT pg_advisory_xact_lock(hashtext($1))", [workspaceId]);
    await assertRepoAllowed(tx, config, tenant, workspaceId, repo);

    let agent: AgentRow | null = null;
    // ... existing agent-allocation loop unchanged ...

    const session = await createSession(tx, {
      workspaceId,
      agentId: agent.id,
      repo, // canonicalized above
      branch: input.branch,
    });
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/hub/test/planLimits.test.ts packages/hub/test/operations/join.test.ts packages/hub/test/operations/join-canonicalize.test.ts`
Expected: all PASS (existing join suites run with billing disabled → guard no-ops).

- [ ] **Step 6: Full gate + commit**

Run: `npm run check` — green.

```bash
git add packages/hub/src/plan.ts packages/hub/src/operations/join.ts packages/hub/test/planLimits.test.ts
git commit -m "feat(hub): enforce plan repo limit at join (402 plan_limit, existing repos exempt)"
```

---

## Phase 4 — Retention

### Task 6: Plan-window announcement retention (lazy, throttled prune)

**Files:**
- Create: `packages/hub/src/retention.ts`
- Modify: `packages/hub/src/repo.ts` (add `pruneAnnouncements`)
- Modify: `packages/hub/src/operations/work.ts:101`, `packages/hub/src/operations/sync.ts:67`, `packages/hub/src/operations/heartbeat.ts:81` (call `maybePruneRetention` right after the existing `pruneChangeRecords` call)
- Test: Create `packages/hub/test/retention.test.ts`

**Interfaces:**
- Consumes: `PLAN_LIMITS[plan].retentionDays`, `effectivePlan`, `billingEnabled`, `getWorkspacePlanRow`.
- Produces:
  - `repo.ts`: `pruneAnnouncements(tx: pg.PoolClient, workspaceId: string, retentionSeconds: number, now: Date): Promise<void>` — deletes announcements older than the window AND their delivery rows (the `announcement_deliveries.announcement_id` FK has no CASCADE — `001_init.sql:64` — so deliveries go first, same transaction).
  - `retention.ts`: `maybePruneRetention(tx: pg.PoolClient, config: Config, workspaceId: string, now: Date): Promise<void>` (throttled to once/hour/workspace, in-memory) and `__resetRetentionThrottle(): void` for tests.

**Design notes recorded for the implementer:**
- Chosen over cron/boot-sweep: matches the existing lazy `pruneChangeRecords` pattern at the exact same call sites, needs no scheduler on Cloud Run, runs inside an already-open transaction, and bounds the P2-2 announcements ledger as a side benefit.
- `change_records` are NOT plan-pruned: the global `CHANGE_RECORD_TTL_SECONDS` (3-day default) is already stricter than every plan window. Document this in the module header.
- Billing-disabled deployments (self-host) never prune (unlimited retention). Enterprise (`retentionDays: null`) never prunes.
- The in-memory throttle mirrors the `throttleWrite` maps in `tenant.ts:461` (single-instance, resets on restart — a skipped prune lands on a later call; a restarted process prunes at most once per workspace immediately, which is harmless).

- [ ] **Step 1: Write the failing test.** Create `packages/hub/test/retention.test.ts` (DB-gated; harness as in Task 4 with billing ENABLED config). Seed a workspace + agent + session by direct SQL (mirror how `operations/announce.test.ts` seeds coordination rows), insert announcements with `created_at` backdated 10 days and 1 day, insert a delivery row for the old one, then call the operation-level entry point:

```typescript
import { maybePruneRetention, __resetRetentionThrottle } from "../src/retention.js";
import { withTransaction } from "../src/db.js";

it("prunes announcements (and their deliveries) older than the free 7-day window", async () => {
  // fixture: free workspace wsId; announcements: idOld (created_at now-10d, one
  // delivery row), idNew (now-1d).
  await withTransaction(pool, async (tx) => {
    await maybePruneRetention(tx, makeTestConfig({ STRIPE_SECRET_KEY: "sk_test_fake", /* … */ }), wsId, new Date());
  });
  const { rows } = await pool.query(`SELECT id FROM announcements WHERE workspace_id = $1`, [wsId]);
  expect(rows.map((r) => Number(r.id))).toEqual([idNew]);
  const del = await pool.query(`SELECT count(*)::int AS n FROM announcement_deliveries WHERE announcement_id = $1`, [idOld]);
  expect(del.rows[0].n).toBe(0);
});

it("keeps 10-day-old announcements on pro (90-day window)", async () => { /* plan='pro', status='active' → both rows survive */ });
it("never prunes when billing is disabled (self-host = unlimited)", async () => { /* config without STRIPE_SECRET_KEY → both rows survive */ });
it("throttles: a second call within the hour does not re-query", async () => {
  // call once, insert another over-age row, call again with the same `now` —
  // the new over-age row survives (throttled); after __resetRetentionThrottle()
  // a third call removes it.
});
```

(Write each in full with the shared fixture helper. Remember `beforeEach`/`afterEach`: `__resetRetentionThrottle()` alongside `__resetRateLimiter()`.)

- [ ] **Step 2: Run to verify failure** — module `../src/retention.js` does not exist.

- [ ] **Step 3: Add `pruneAnnouncements` to `repo.ts`** (next to `pruneChangeRecords`, `repo.ts:2257`)

```typescript
/**
 * Delete this workspace's announcements older than `retentionSeconds`, and
 * their delivery ledger rows. Deliveries go first in the SAME transaction —
 * announcement_deliveries.announcement_id has no ON DELETE CASCADE (001) —
 * so the FK never blocks the parent delete. Plan-window retention (plan.ts)
 * drives the cutoff; unlimited plans simply never call this.
 */
export async function pruneAnnouncements(
  tx: pg.PoolClient,
  workspaceId: string,
  retentionSeconds: number,
  now: Date
): Promise<void> {
  await tx.query(
    `DELETE FROM announcement_deliveries d
     USING announcements a
     WHERE d.announcement_id = a.id
       AND a.workspace_id = $1
       AND a.created_at < $2::timestamptz - ($3 * interval '1 second')`,
    [workspaceId, now, retentionSeconds]
  );
  await tx.query(
    `DELETE FROM announcements
     WHERE workspace_id = $1
       AND created_at < $2::timestamptz - ($3 * interval '1 second')`,
    [workspaceId, now, retentionSeconds]
  );
}
```

- [ ] **Step 4: Create `packages/hub/src/retention.ts`**

```typescript
/**
 * Plan-window retention for @shepherd/hub — trims announcement history to the
 * workspace's effective plan window (free 7d / pro 90d / enterprise unlimited).
 *
 * LAZY + THROTTLED by design: runs inside the hot coordination transactions
 * (work/sync/heartbeat), right where pruneChangeRecords already runs, at most
 * once per workspace per PRUNE_INTERVAL_MS — no scheduler, no boot sweep.
 * (change_records need no plan prune: the global CHANGE_RECORD_TTL_SECONDS
 * default of 3 days is stricter than every plan window.)
 *
 * HOSTED-ONLY: a deployment without billing (self-host) never prunes —
 * self-host retention is unlimited per the design. Data is deleted ONLY by
 * this retention window; downgrades/non-payment never delete anything else.
 *
 * The throttle map mirrors tenant.ts's hot-path write throttles: in-memory,
 * single-instance, resets on restart (a skipped prune lands on a later call).
 */

import type pg from "pg";
import type { Config } from "./config.js";
import { PLAN_LIMITS, effectivePlan, billingEnabled } from "./plan.js";
import { getWorkspacePlanRow, pruneAnnouncements } from "./repo.js";

/** Minimum gap between retention prunes for the same workspace. */
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const lastPrune = new Map<string, number>();

/** Trim this workspace's announcement history to its plan window (throttled). */
export async function maybePruneRetention(
  tx: pg.PoolClient,
  config: Config,
  workspaceId: string,
  now: Date
): Promise<void> {
  if (!billingEnabled(config)) return;
  const last = lastPrune.get(workspaceId);
  if (last !== undefined && now.getTime() - last < PRUNE_INTERVAL_MS) return;
  lastPrune.set(workspaceId, now.getTime());

  const row = await getWorkspacePlanRow(tx, workspaceId);
  if (row === null) return;
  const retentionDays = PLAN_LIMITS[effectivePlan(row, now)].retentionDays;
  if (retentionDays === null) return; // enterprise: unlimited
  await pruneAnnouncements(tx, workspaceId, retentionDays * 86_400, now);
}

/** Test-only: clear the per-workspace prune throttle. */
export function __resetRetentionThrottle(): void {
  lastPrune.clear();
}
```

- [ ] **Step 5: Call it from the three coordination paths.** In each of `operations/work.ts` (after line 107), `operations/sync.ts` (after its `pruneChangeRecords`), `operations/heartbeat.ts` (after its `pruneChangeRecords`):

```typescript
    // Plan-window retention (hosted only; throttled per workspace) — trims
    // announcement history alongside the change-record prune above.
    await maybePruneRetention(tx, config, session.workspaceId, now);
```

(Each file already has `config` and `now` in scope at that point; add the import `import { maybePruneRetention } from "../retention.js";`.)

- [ ] **Step 6: Run tests**

Run: `npx vitest run packages/hub/test/retention.test.ts packages/hub/test/operations/work.test.ts packages/hub/test/operations/sync.test.ts packages/hub/test/operations/heartbeat.test.ts`
Expected: PASS (existing suites unaffected — billing disabled there).

- [ ] **Step 7: Full gate + commit**

```bash
git add packages/hub/src/retention.ts packages/hub/src/repo.ts \
        packages/hub/src/operations/work.ts packages/hub/src/operations/sync.ts \
        packages/hub/src/operations/heartbeat.ts packages/hub/test/retention.test.ts
git commit -m "feat(hub): plan-window announcement retention (lazy throttled prune)"
```

---

## Phase 5 — Stripe integration

### Task 7: Stripe config + client wrapper + `GET /workspaces/:id/billing`

**Files:**
- Modify: `packages/hub/package.json` (add `"stripe": "^18"` to dependencies), run `npm install`
- Modify: `packages/hub/src/config.ts` (remaining STRIPE_ vars + superRefine)
- Create: `packages/hub/src/billing/stripe.ts`
- Create: `packages/hub/src/operations/billing.ts` (`getBillingStatus` only in this task)
- Modify: `packages/hub/src/server.ts` (route)
- Test: Create `packages/hub/test/billing.test.ts`; extend `packages/hub/test/config.test.ts`

**Interfaces:**
- Consumes: `BillingStatusResponse` contract (Task 3); `getWorkspacePlanRow`, `countMembers`, `listWorkspaceRepos`; `PLAN_LIMITS`, `effectivePlan`, `billingEnabled`; `requireWorkspaceId` (`tenant.ts:93`).
- Produces:
  - `config.ts`: `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_MONTHLY`, `STRIPE_PRICE_PRO_ANNUAL` (all optional strings), `BILLING_GRACE_DAYS` (int, default 14); superRefine: `STRIPE_SECRET_KEY` set ⇒ `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_MONTHLY`, and `PUBLIC_WEB_URL` required.
  - `billing/stripe.ts`: `getStripe(config: Config): Stripe` (throws `NotConfiguredError` when billing disabled; caches the client) and `__setStripeForTests(fake: unknown): void` (also clears the cache; pass `null` to restore).
  - `plan.ts`: `trialEligible(row: WorkspacePlanRow): boolean` — the one-trial-per-workspace guard, shared by `getBillingStatus` (as `trialAvailable`) and Task 8's `startTrial`.
  - `operations/billing.ts`: `getBillingStatus(tenant: TenantContext): Promise<BillingStatusResponseT>`.
  - Route: `GET /workspaces/:id/billing` — any member (`:id` membership already validated by `resolveTenant`).

- [ ] **Step 1: Config tests first** (append to `packages/hub/test/config.test.ts`, following its existing style):

```typescript
it("requires webhook secret, pro price, and PUBLIC_WEB_URL once STRIPE_SECRET_KEY is set", () => {
  expect(() =>
    loadConfig({ DATABASE_URL: "x", TEAM_TOKEN: "t", ALLOWED_WORKSPACE: "w", STRIPE_SECRET_KEY: "sk" })
  ).toThrow(/STRIPE_SECRET_KEY is set but/);
});

it("accepts a fully-configured billing deployment", () => {
  const cfg = loadConfig({
    DATABASE_URL: "x", BFF_INTERNAL_TOKEN: "b",
    STRIPE_SECRET_KEY: "sk", STRIPE_WEBHOOK_SECRET: "wh",
    STRIPE_PRICE_PRO_MONTHLY: "price_m", PUBLIC_WEB_URL: "https://app.example",
  });
  expect(cfg.BILLING_GRACE_DAYS).toBe(14);
});
```

- [ ] **Step 2: Run to verify failure**, then extend `config.ts`:

```typescript
  // ---------------------------------------------------------------------------
  // Billing (Stripe) — hosted deployments only. STRIPE_SECRET_KEY being set is
  // THE billing-enabled switch (plan.ts billingEnabled); self-host operators
  // simply never set it and every plan limit is inert. When it IS set, the
  // webhook secret, the Pro monthly price, and PUBLIC_WEB_URL (Checkout/Portal
  // redirect base) become required — see the superRefine below. The annual
  // price is optional (the checkout endpoint 501s for interval=year without it).
  STRIPE_SECRET_KEY: z.string().min(1).optional(),        // (already added in Task 2)
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_PRICE_PRO_MONTHLY: z.string().min(1).optional(),
  STRIPE_PRICE_PRO_ANNUAL: z.string().min(1).optional(),
  // Days of past-due grace before a workspace reverts to Free limits.
  BILLING_GRACE_DAYS: z.coerce.number().int().positive().default(14),
```

And in the existing `superRefine`:

```typescript
  if (
    cfg.STRIPE_SECRET_KEY &&
    (!cfg.STRIPE_WEBHOOK_SECRET || !cfg.STRIPE_PRICE_PRO_MONTHLY || !cfg.PUBLIC_WEB_URL)
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["STRIPE_SECRET_KEY"],
      message:
        "STRIPE_SECRET_KEY is set but STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_PRO_MONTHLY, and/or PUBLIC_WEB_URL is missing — all are required once billing is enabled",
    });
  }
```

Run the config tests — PASS. **Note:** every test config object built via `makeTestConfig` gains the new defaulted field implicitly? No — `Config` is a plain type; add `BILLING_GRACE_DAYS: 14` to the `makeTestConfig` helpers you touched in Tasks 4/6 if `tsc` complains.

- [ ] **Step 3: Install the SDK**

Run: `npm install stripe@^18 -w @shepherd/hub`
Expected: `stripe` appears in `packages/hub/package.json` dependencies and the root lockfile.

- [ ] **Step 4: Create `packages/hub/src/billing/stripe.ts`**

```typescript
/**
 * Stripe client access for @shepherd/hub — the ONLY module that constructs
 * the SDK client. Injectable for tests (__setStripeForTests) so the DB-gated
 * billing suites never talk to Stripe.
 */

import Stripe from "stripe";
import type { Config } from "../config.js";
import { NotConfiguredError } from "../errors.js";

let override: Stripe | null = null;
let cached: Stripe | null = null;

/** The Stripe client, or NotConfiguredError (501) when billing is disabled. */
export function getStripe(config: Config): Stripe {
  if (override !== null) return override;
  if (config.STRIPE_SECRET_KEY === undefined) {
    throw new NotConfiguredError("Billing is not enabled on this deployment");
  }
  cached ??= new Stripe(config.STRIPE_SECRET_KEY);
  return cached;
}

/** Test-only: substitute a fake client (pass null to restore the real one). */
export function __setStripeForTests(fake: unknown): void {
  override = fake as Stripe | null;
  cached = null;
}
```

- [ ] **Step 5: Write the failing endpoint test.** Create `packages/hub/test/billing.test.ts` (DB-gated; billing-enabled `makeTestConfig` as in Task 4):

```typescript
it("GET /workspaces/:id/billing reports plan, usage, limits, entitlements", async () => {
  // seed: workspace 'bill-ws' (free), members acct-1 (admin) + acct-2, two
  // sessions with distinct repos (seed agents+sessions by direct SQL as in
  // the announce test fixtures).
  const res = await app.inject({
    method: "GET",
    url: `/workspaces/${wsId}/billing`,
    headers: bffHeaders("acct-2"), // NON-admin member: read allowed
  });
  expect(res.statusCode).toBe(200);
  const body = BillingStatusResponse.parse(res.json());
  expect(body).toMatchObject({
    billingEnabled: true,
    plan: "free",
    planStatus: "none",
    effectivePlan: "free",
    seats: { used: 2, max: 2 },
    repos: { used: 2, max: 3 },
    retentionDays: 7,
    entitlements: { analytics: false },
    trialAvailable: true, // never trialed, never subscribed → eligible
  });
});

it("reports trialAvailable:false once the workspace has trialed or has Stripe linkage", async () => {
  // Case A: plan_status='trialing' (even expired) → false.
  // Case B: plan='free', plan_status='none', stripe_customer_id='cus_x' → false.
});

it("reports billingEnabled:false with null maxima when billing is disabled", async () => {
  // re-init context without STRIPE_SECRET_KEY → seats.max/repos.max/retentionDays null,
  // entitlements.analytics true (nothing is gated on a non-billing deployment),
  // trialAvailable false (there is nothing to trial).
});
```

- [ ] **Step 6: Implement `getBillingStatus`** in `packages/hub/src/operations/billing.ts`, plus the shared eligibility guard in `plan.ts`:

Add to `packages/hub/src/plan.ts`:

```typescript
/**
 * One trial per workspace, EVER — the no-card trial's abuse guard. Eligible
 * only when the workspace has never trialed and never touched Stripe:
 * an expired trial leaves plan_status='trialing' behind, and a lapsed/canceled
 * subscription leaves stripe_customer_id set (webhooks keep it on deletion),
 * so both histories are caught. Accepted edge: a customer created by an
 * ABANDONED checkout also blocks a later trial (documented in the plan's
 * decisions-to-confirm).
 */
export function trialEligible(row: WorkspacePlanRow): boolean {
  return (
    row.plan === "free" &&
    row.plan_status === "none" &&
    row.stripe_customer_id === null &&
    row.stripe_subscription_id === null
  );
}
```

Then the operation:

```typescript
/**
 * Billing operations: plan status (this task); trial start, Checkout +
 * Portal sessions (Task 8). The hub owns ALL Stripe interaction — the
 * platform BFF only proxies these routes, and the UI's billing panel renders
 * their output. The 14-day trial is APP-SIDE and card-less: it touches only
 * the workspaces plan columns, never Stripe.
 */

import type { BillingStatusResponseT } from "@shepherd/shared";
import { getContext } from "../context.js";
import { requireWorkspaceId, type TenantContext } from "../tenant.js";
import { PLAN_LIMITS, effectivePlan, billingEnabled, trialEligible } from "../plan.js";
import { getWorkspacePlanRow, countMembers, listWorkspaceRepos } from "../repo.js";
import { AuthError } from "../errors.js";

/**
 * Current plan + usage for the tenant's workspace. Any member may read (the
 * UI shows non-admins a read-only panel); mutating endpoints are admin-only.
 * On a billing-disabled deployment everything reports unlimited so the UI
 * hides the panel.
 */
export async function getBillingStatus(tenant: TenantContext): Promise<BillingStatusResponseT> {
  const { pool, config } = getContext();
  const workspaceId = requireWorkspaceId(tenant);

  const row = await getWorkspacePlanRow(pool, workspaceId);
  if (row === null) throw new AuthError(404, "workspace not found");
  const enabled = billingEnabled(config);
  const seatsUsed = await countMembers(pool, workspaceId);
  const reposUsed = (await listWorkspaceRepos(pool, workspaceId)).length;

  if (!enabled) {
    return {
      billingEnabled: false,
      plan: row.plan,
      planStatus: row.plan_status,
      effectivePlan: row.plan,
      currentPeriodEnd: null,
      graceUntil: null,
      seats: { used: seatsUsed, max: null },
      repos: { used: reposUsed, max: null },
      retentionDays: null,
      entitlements: { analytics: true },
      trialAvailable: false,
    };
  }

  const effective = effectivePlan(row);
  const limits = PLAN_LIMITS[effective];
  return {
    billingEnabled: true,
    plan: row.plan,
    planStatus: row.plan_status,
    effectivePlan: effective,
    currentPeriodEnd: row.current_period_end?.toISOString() ?? null,
    graceUntil: row.grace_until?.toISOString() ?? null,
    seats: { used: seatsUsed, max: limits.seats },
    repos: { used: reposUsed, max: limits.repos },
    retentionDays: limits.retentionDays,
    entitlements: { analytics: limits.analytics },
    // One trial per workspace, ever (see trialEligible in plan.ts — the same
    // guard startTrial enforces, so the UI button and the endpoint agree).
    trialAvailable: trialEligible(row),
  };
}
```

Route in `server.ts` (next to the other `/workspaces/:id/*` GETs):

```typescript
  // Billing status — readable by ANY member of `:id` (resolveTenant validated
  // membership); the checkout/portal POSTs below are admin-gated in the ops.
  app.get("/workspaces/:id/billing", async (request, _reply) => {
    return getBillingStatus(request.tenant);
  });
```

- [ ] **Step 7: Run tests + full gate + commit**

```bash
git add packages/hub/package.json package-lock.json packages/hub/src/config.ts \
        packages/hub/src/billing/stripe.ts packages/hub/src/operations/billing.ts \
        packages/hub/src/server.ts packages/hub/test/billing.test.ts packages/hub/test/config.test.ts
git commit -m "feat(hub): stripe config + GET /workspaces/:id/billing status endpoint"
```

### Task 8: Trial, Checkout + Customer Portal endpoints (admin-only)

**Files:**
- Modify: `packages/hub/src/operations/billing.ts`
- Modify: `packages/hub/src/server.ts`
- Test: `packages/hub/test/billing.test.ts` (extend, with a fake Stripe via `__setStripeForTests`)

**Interfaces:**
- Consumes: `getStripe`/`__setStripeForTests` (Task 7); `requireAdmin` (`tenant.ts:127`); `trialEligible` (Task 7); `setStripeCustomerId`, `applyPlanState`; contract schemas from Task 3 (incl. `StartTrialResponse`); `ConflictError`, `NotConfiguredError`.
- Produces:
  - `startTrial(tenant: TenantContext): Promise<StartTrialResponseT>` — the APP-SIDE, no-card trial (touches only the plan columns; NO Stripe call).
  - `createCheckoutSession(input: CreateCheckoutSessionRequestT, tenant: TenantContext): Promise<CheckoutSessionResponseT>` — a straight PAID subscription (card entered here; the trial already happened app-side).
  - `createPortalSession(tenant: TenantContext): Promise<PortalSessionResponseT>`
  - Routes: `POST /workspaces/:id/billing/trial`, `POST /workspaces/:id/billing/checkout`, `POST /workspaces/:id/billing/portal`.

**Behavior contract (write tests for each):**
1. Non-admin member → 403. Self-host TEAM_TOKEN → 401 (`requireAccountId`) — billing is a hosted/account surface. (Applies to all three endpoints.)
2. Billing disabled → 501 (`NotConfiguredError`; `startTrial` checks `billingEnabled(config)` itself since it never calls `getStripe`).
3. **Trial:** eligible workspace (`trialEligible` — `plan='free' AND plan_status='none' AND stripe_customer_id IS NULL AND stripe_subscription_id IS NULL`) → sets `plan='pro'`, `plan_status='trialing'`, `current_period_end = now + 14 days` (the trial end — dual use, see migration 020) via `applyPlanState`; creates NOTHING in Stripe; returns `{ plan, planStatus, trialEndsAt }`. Ineligible (ever trialed — even expired — or any Stripe linkage) → 409 `ConflictError("This workspace has already used its free trial — upgrade to Pro to continue.")`.
4. **Checkout** is refused with 409 only when a PAID subscription already exists (`plan_status` in `active|past_due`) or plan is `enterprise` — a `trialing` workspace (live OR expired trial) MUST be allowed through: Checkout is the trial→paid conversion path. Message: `ConflictError("This workspace already has an active subscription — use Manage billing instead.")`.
5. Checkout mechanics: creates a Stripe customer (`metadata: { workspaceId }`) if the workspace has none, persists it via `setStripeCustomerId`, creates a subscription-mode Checkout session with the monthly price (or annual when `interval: "year"`; 501 if `STRIPE_PRICE_PRO_ANNUAL` unset), `subscription_data: { metadata: { workspaceId } }` (NO `trial_period_days` — the trial is app-side and already consumed; NO `payment_method_collection` override — subscription mode collects the card by default, which is exactly the "card enters at conversion" rule), success/cancel URLs on `PUBLIC_WEB_URL` (`?billing=success` / `?billing=canceled`). Returns `{ url: session.url }`.
6. Portal: requires an existing `stripe_customer_id` (409 if none — nothing to manage; note an app-side trial creates no customer, so a trialing-only workspace gets the 409 and the UI never offers Portal for it), returns `{ url }` from `stripe.billingPortal.sessions.create({ customer, return_url: PUBLIC_WEB_URL })`.

- [ ] **Step 1: Write the failing tests** (extend `billing.test.ts`; fake Stripe):

```typescript
function fakeStripe() {
  const calls: Record<string, unknown[]> = { customers: [], checkout: [], portal: [] };
  return {
    calls,
    customers: {
      create: async (params: unknown) => { calls.customers.push(params); return { id: "cus_new" }; },
    },
    checkout: {
      sessions: {
        create: async (params: unknown) => { calls.checkout.push(params); return { url: "https://checkout.stripe.test/s" }; },
      },
    },
    billingPortal: {
      sessions: {
        create: async (params: unknown) => { calls.portal.push(params); return { url: "https://portal.stripe.test/p" }; },
      },
    },
  };
}
// beforeEach: __setStripeForTests(fakeStripe-instance); afterEach: __setStripeForTests(null).

it("admin starts the no-card trial: pro/trialing, 14-day end, and NO Stripe calls", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${wsId}/billing/trial`,
    headers: bffHeaders("acct-1"),
  });
  expect(res.statusCode).toBe(200);
  const body = StartTrialResponse.parse(res.json());
  expect(body).toMatchObject({ plan: "pro", planStatus: "trialing" });
  const endsAt = new Date(body.trialEndsAt).getTime();
  expect(endsAt).toBeGreaterThan(Date.now() + 13 * 86_400_000);
  expect(endsAt).toBeLessThan(Date.now() + 15 * 86_400_000);
  // The adoption lever: NO card, NO Stripe objects at trial start.
  expect(fake.calls.customers).toHaveLength(0);
  expect(fake.calls.checkout).toHaveLength(0);
  const { rows } = await pool.query(
    `SELECT plan, plan_status, stripe_customer_id, stripe_subscription_id FROM workspaces WHERE id = $1`,
    [wsId]
  );
  expect(rows[0]).toMatchObject({
    plan: "pro",
    plan_status: "trialing",
    stripe_customer_id: null,
    stripe_subscription_id: null,
  });
});

it("refuses a second trial with 409 — even after the first expired, and after any Stripe linkage", async () => {
  // Case A: plan='pro', plan_status='trialing', current_period_end in the past → 409.
  // Case B: plan='free', plan_status='none', stripe_customer_id='cus_x' → 409.
  // Case C: non-admin member → 403.
});

it("admin checkout creates customer + a straight PAID subscription session (no trial config)", async () => {
  const res = await app.inject({
    method: "POST",
    url: `/workspaces/${wsId}/billing/checkout`,
    headers: bffHeaders("acct-1"),
    payload: {},
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ url: "https://checkout.stripe.test/s" });
  expect(fake.calls.customers[0]).toMatchObject({ metadata: { workspaceId: wsId } });
  expect(fake.calls.checkout[0]).toMatchObject({
    mode: "subscription",
    customer: "cus_new",
    line_items: [{ price: "price_fake", quantity: 1 }],
    subscription_data: { metadata: { workspaceId: wsId } },
  });
  // The app-side trial replaced Stripe's: assert the session carries NO trial.
  expect((fake.calls.checkout[0] as { subscription_data: Record<string, unknown> }).subscription_data)
    .not.toHaveProperty("trial_period_days");
  const { rows } = await pool.query(`SELECT stripe_customer_id FROM workspaces WHERE id = $1`, [wsId]);
  expect(rows[0].stripe_customer_id).toBe("cus_new");
});

it("checkout is ALLOWED while (or after) trialing — it is the trial→paid conversion path", async () => {
  // seed plan='pro', plan_status='trialing', current_period_end now+7d → checkout 200
});
it("rejects a non-admin with 403 and an already-paid subscription with 409", async () => { /* member → 403; plan_status='active' → 409 */ });
it("portal returns the portal url for a customer-linked workspace, 409 without one (incl. trial-only workspaces)", async () => { /* ... */ });
```

- [ ] **Step 2: Run to verify failure** (404 route not found), then implement in `operations/billing.ts`:

```typescript
import type {
  CreateCheckoutSessionRequestT,
  CheckoutSessionResponseT,
  PortalSessionResponseT,
  StartTrialResponseT,
} from "@shepherd/shared";
import { requireAccountId, requireAdmin } from "../tenant.js";
import { getStripe } from "../billing/stripe.js";
import { setStripeCustomerId, applyPlanState } from "../repo.js";
import { ConflictError, NotConfiguredError } from "../errors.js";
// (billingEnabled + trialEligible are already imported from ../plan.js in
//  Task 7's getBillingStatus — this file shares those imports.)

/** Length of the app-side, no-card Pro trial (design §Plans: 14 days). */
const TRIAL_DAYS = 14;

/**
 * Start the 14-day Pro trial — APP-SIDE and CARD-LESS (the advertised
 * "no credit card needed" adoption lever): flips the plan columns only, and
 * creates NO Stripe customer/subscription. current_period_end dual-uses as
 * the trial end (migration 020); effectivePlan reverts an expired trial to
 * FREE LIMITS on its own — nothing is scheduled and nothing is deleted.
 * Converting to paid goes through createCheckoutSession (card entered there).
 *
 * ADMIN-ONLY, hosted-only, and ONE trial per workspace ever — trialEligible
 * (plan.ts) is the guard, shared with getBillingStatus's trialAvailable so
 * the UI button and this endpoint can never disagree.
 */
export async function startTrial(tenant: TenantContext): Promise<StartTrialResponseT> {
  const { pool, config } = getContext();
  requireAccountId(tenant);
  requireAdmin(tenant);
  const workspaceId = requireWorkspaceId(tenant);
  if (!billingEnabled(config)) {
    throw new NotConfiguredError("Billing is not enabled on this deployment");
  }

  const row = await getWorkspacePlanRow(pool, workspaceId);
  if (row === null) throw new AuthError(404, "workspace not found");
  if (!trialEligible(row)) {
    throw new ConflictError(
      "This workspace has already used its free trial — upgrade to Pro to continue."
    );
  }

  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86_400_000);
  await applyPlanState(pool, workspaceId, {
    plan: "pro",
    planStatus: "trialing",
    currentPeriodEnd: trialEndsAt, // dual use: the trial end
  });
  return { plan: "pro", planStatus: "trialing", trialEndsAt: trialEndsAt.toISOString() };
}

/**
 * Start a Pro upgrade: create (or reuse) the workspace's Stripe customer and
 * mint a subscription-mode Checkout session. ADMIN-ONLY, hosted-only.
 * Enterprise has no self-serve checkout at launch (sales-led).
 *
 * This is a straight PAID subscription — the card enters HERE. There is no
 * Stripe-side trial: the 14-day trial is app-side (startTrial above), so a
 * `trialing` workspace (live or expired) is explicitly ALLOWED through —
 * this endpoint IS the trial→paid conversion path. Only an existing paid
 * subscription (active/past_due) or an enterprise plan refuses.
 */
export async function createCheckoutSession(
  input: CreateCheckoutSessionRequestT,
  tenant: TenantContext
): Promise<CheckoutSessionResponseT> {
  const { pool, config } = getContext();
  requireAccountId(tenant);
  requireAdmin(tenant);
  const workspaceId = requireWorkspaceId(tenant);
  const stripe = getStripe(config); // 501 when billing disabled

  const row = await getWorkspacePlanRow(pool, workspaceId);
  if (row === null) throw new AuthError(404, "workspace not found");
  if (row.plan === "enterprise" || ["active", "past_due"].includes(row.plan_status)) {
    throw new ConflictError(
      "This workspace already has an active subscription — use Manage billing instead."
    );
  }

  const price =
    input.interval === "year" ? config.STRIPE_PRICE_PRO_ANNUAL : config.STRIPE_PRICE_PRO_MONTHLY;
  if (price === undefined) {
    throw new NotConfiguredError("Annual billing is not configured on this deployment");
  }

  let customerId = row.stripe_customer_id;
  if (customerId === null) {
    const customer = await stripe.customers.create({ metadata: { workspaceId } });
    customerId = customer.id;
    await setStripeCustomerId(pool, workspaceId, customerId);
  }

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customerId,
    line_items: [{ price, quantity: 1 }],
    // NO trial_period_days (the trial is app-side, already consumed) and NO
    // payment_method_collection override — subscription mode collects the
    // card by default, which is exactly the "card enters at conversion" rule.
    subscription_data: { metadata: { workspaceId } },
    success_url: `${config.PUBLIC_WEB_URL}/?billing=success`,
    cancel_url: `${config.PUBLIC_WEB_URL}/?billing=canceled`,
    metadata: { workspaceId },
  });
  if (session.url == null) throw new Error("Stripe returned a session without a url");
  return { url: session.url };
}

/** Open the Stripe Customer Portal (manage/cancel). ADMIN-ONLY, hosted-only. */
export async function createPortalSession(tenant: TenantContext): Promise<PortalSessionResponseT> {
  const { pool, config } = getContext();
  requireAccountId(tenant);
  requireAdmin(tenant);
  const workspaceId = requireWorkspaceId(tenant);
  const stripe = getStripe(config);

  const row = await getWorkspacePlanRow(pool, workspaceId);
  if (row === null) throw new AuthError(404, "workspace not found");
  if (row.stripe_customer_id === null) {
    throw new ConflictError("This workspace has no billing account yet — upgrade first.");
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: row.stripe_customer_id,
    return_url: config.PUBLIC_WEB_URL!,
  });
  return { url: session.url };
}
```

Routes in `server.ts`:

```typescript
  // Billing actions: start the no-card app-side trial, start a Pro upgrade
  // (Stripe Checkout — also the trial→paid conversion), open the Customer
  // Portal. All are :id routes (membership validated in the hook) and
  // ADMIN-gated in the ops; requireAccountId additionally rejects the
  // self-host TEAM_TOKEN (billing is a hosted/account surface).
  app.post("/workspaces/:id/billing/trial", async (request, _reply) => {
    return startTrial(request.tenant);
  });

  app.post("/workspaces/:id/billing/checkout", async (request, _reply) => {
    const parsed = CreateCheckoutSessionRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw parsed.error;
    }
    return createCheckoutSession(parsed.data, request.tenant);
  });

  app.post("/workspaces/:id/billing/portal", async (request, _reply) => {
    return createPortalSession(request.tenant);
  });
```

- [ ] **Step 3: Run tests + full gate + commit**

```bash
git add packages/hub/src/operations/billing.ts packages/hub/src/server.ts packages/hub/test/billing.test.ts
git commit -m "feat(hub): no-card app-side trial + Stripe Checkout/Portal endpoints (admin-only)"
```

### Task 9: Webhook route — auth-exempt, signature-verified, plan transitions

**Files:**
- Create: `packages/hub/src/billing/webhook.ts`
- Modify: `packages/hub/src/server.ts` (auth-hook exemption + encapsulated raw-body route)
- Test: Create `packages/hub/test/stripeWebhook.test.ts`

**Interfaces:**
- Consumes: `getStripe` (`stripe.webhooks.constructEvent` — pure HMAC verification, no network; the REAL client is used in tests with the fake webhook secret via `stripe.webhooks.generateTestHeaderString`), `findWorkspaceIdByStripeCustomerId`, `applyPlanState`, `setStripeCustomerId`, `getWorkspacePlanRow`.
- Produces: `handleStripeWebhook(rawBody: Buffer, signatureHeader: string | undefined): Promise<{ received: true }>` — throws `AuthError(401, ...)` on a missing/invalid signature (mapped to the generic 401 reply; never reveal why), applies state transitions for the four relevant events, and silently acks everything else.

**Transition table (implement exactly; each webhook lookup resolves the workspace by `event.data.object.metadata.workspaceId` first, falling back to `findWorkspaceIdByStripeCustomerId` — metadata makes ordering with `checkout.session.completed` irrelevant):**

| Event | Effect |
|---|---|
| `checkout.session.completed` | link ids: `setStripeCustomerId` (if changed) + `applyPlanState(plan:'pro', planStatus:'active', stripeSubscriptionId: session.subscription)` — optimistic unlock; the subscription events refine status/period. This is also how an app-side trial converts to paid: `trialing` → `active`, and the stale trial-end in `current_period_end` is refreshed by the subscription events (harmless meanwhile — `active` ignores it). |
| `customer.subscription.created` / `customer.subscription.updated` | map Stripe status → `planStatus` (`trialing→trialing` — defensive only: our Checkout creates no Stripe trials since the trial is app-side, but a dashboard-created subscription could carry one, and these events also set `currentPeriodEnd` so `effectivePlan`'s trialing-expiry check stays coherent; `active→active`, `past_due→past_due`, `canceled/unpaid/incomplete_expired→canceled`, `incomplete/paused→none`); `plan:'pro'`; `currentPeriodEnd` from the subscription; on `active`/`trialing` clear `graceUntil: null`; on `past_due` leave `graceUntil` untouched (payment_failed sets it). Skip entirely (ack) if the workspace row's plan is `enterprise` — administrative plans are never driven by Stripe. |
| `customer.subscription.deleted` | `applyPlanState(plan:'free', planStatus:'none', stripeSubscriptionId: null, currentPeriodEnd: null, graceUntil: null)` — full revert to Free LIMITS; the customer id is kept for re-subscribes; no data deletion. |
| `invoice.payment_failed` | `planStatus:'past_due'` (plan unchanged) and set `graceUntil = now + BILLING_GRACE_DAYS days` ONLY if currently null (first failure starts the clock; retries don't extend it). |
| anything else | ack `{ received: true }`, no-op. |

- [ ] **Step 1: Write the failing tests.** Create `packages/hub/test/stripeWebhook.test.ts` (DB-gated, billing-enabled config with `STRIPE_WEBHOOK_SECRET: "whsec_test"`). Use the REAL stripe SDK's signature utilities so verification is tested end-to-end without network:

```typescript
import Stripe from "stripe";
const stripe = new Stripe("sk_test_dummy");

function signedInject(app: FastifyInstance, event: object, secret = "whsec_test") {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({ payload, secret });
  return app.inject({
    method: "POST",
    url: "/stripe/webhook",
    headers: { "stripe-signature": signature, "content-type": "application/json" },
    payload,
  });
}

it("rejects a missing or bad signature with 401 and changes nothing", async () => {
  const res = await app.inject({ method: "POST", url: "/stripe/webhook", payload: "{}" });
  expect(res.statusCode).toBe(401);
  const bad = await signedInject(app, { type: "checkout.session.completed" }, "whsec_wrong");
  expect(bad.statusCode).toBe(401);
});

it("checkout.session.completed links ids and flips the workspace to pro/active", async () => {
  const res = await signedInject(app, {
    id: "evt_1", type: "checkout.session.completed",
    data: { object: { id: "cs_1", customer: "cus_hook", subscription: "sub_hook", metadata: { workspaceId: wsId } } },
  });
  expect(res.statusCode).toBe(200);
  const row = await getWorkspacePlanRow(pool, wsId);
  expect(row).toMatchObject({
    plan: "pro", plan_status: "active",
    stripe_customer_id: "cus_hook", stripe_subscription_id: "sub_hook",
  });
});

it("subscription.updated trialing → trialing with period end; canceled status → canceled", async () => { /* two signedInjects asserting plan_status + current_period_end */ });
it("invoice.payment_failed sets past_due and starts (but never extends) the grace clock", async () => { /* fail twice; grace_until unchanged after the second */ });
it("subscription.deleted reverts to free/none, keeps the customer id, deletes no coordination data", async () => { /* seed an announcement first; assert it survives */ });
it("unknown event types are acked with { received: true }", async () => { /* type: "product.created" → 200 */ });
```

(Write each in full. Seed the workspace with `stripe_customer_id = 'cus_hook'` for the customer-keyed events.)

- [ ] **Step 2: Run to verify failure** (404 — route absent).

- [ ] **Step 3: Create `packages/hub/src/billing/webhook.ts`**

```typescript
/**
 * Stripe webhook processing — the ONLY unauthenticated write path in the hub,
 * so it is guarded by Stripe's HMAC signature instead of resolveTenant (the
 * same auth-exempt posture as /health, but verified; see the exemption note in
 * server.ts's onRequest hook). Fail-closed: any missing/invalid signature is a
 * 401 with the generic auth reply, never a reason.
 *
 * State transitions implement the design's downgrade-never-lock-out rule: the
 * only thing a webhook ever changes is the plan columns on workspaces —
 * NO coordination data is touched here, ever.
 */

import type Stripe from "stripe";
import { getContext } from "../context.js";
import { getStripe } from "./stripe.js";
import { AuthError } from "../errors.js";
import {
  applyPlanState,
  findWorkspaceIdByStripeCustomerId,
  getWorkspacePlanRow,
  setStripeCustomerId,
} from "../repo.js";
import type { PlanStatusT } from "@shepherd/shared";

/** Stripe subscription status → our plan_status vocabulary. */
function mapSubscriptionStatus(status: Stripe.Subscription.Status): PlanStatusT {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
    case "unpaid":
    case "incomplete_expired":
      return "canceled";
    default: // incomplete, paused — not (yet) paying
      return "none";
  }
}

/**
 * The subscription's paid-through timestamp. Tolerates both SDK shapes (the
 * field moved from the subscription to its items in newer API versions).
 */
function subscriptionPeriodEnd(sub: Stripe.Subscription): Date | null {
  const fromItems = sub.items?.data?.[0]?.current_period_end;
  const legacy = (sub as unknown as { current_period_end?: number }).current_period_end;
  const unix = fromItems ?? legacy;
  return typeof unix === "number" ? new Date(unix * 1000) : null;
}

/**
 * Resolve which workspace an event object belongs to: subscription/session
 * metadata first (set at checkout creation, ordering-proof), then the stored
 * customer link. Null = not ours (e.g. an event predating a linkage) → ack.
 */
async function resolveWorkspace(
  metadataWorkspaceId: string | undefined,
  customerId: string | null
): Promise<string | null> {
  const { pool } = getContext();
  if (metadataWorkspaceId !== undefined && metadataWorkspaceId !== "") {
    return metadataWorkspaceId;
  }
  if (customerId !== null) {
    return findWorkspaceIdByStripeCustomerId(pool, customerId);
  }
  return null;
}

/** Verify + apply one webhook delivery. See the module header. */
export async function handleStripeWebhook(
  rawBody: Buffer,
  signatureHeader: string | undefined
): Promise<{ received: true }> {
  const { pool, config } = getContext();
  const stripe = getStripe(config);
  if (signatureHeader === undefined || config.STRIPE_WEBHOOK_SECRET === undefined) {
    throw new AuthError(401, "missing stripe webhook signature/secret");
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signatureHeader, config.STRIPE_WEBHOOK_SECRET);
  } catch {
    throw new AuthError(401, "stripe webhook signature verification failed");
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const customerId = typeof session.customer === "string" ? session.customer : null;
      const workspaceId = await resolveWorkspace(session.metadata?.workspaceId, customerId);
      if (workspaceId === null) break;
      if (customerId !== null) await setStripeCustomerId(pool, workspaceId, customerId);
      await applyPlanState(pool, workspaceId, {
        plan: "pro",
        planStatus: "active", // optimistic unlock; subscription events refine
        stripeSubscriptionId: typeof session.subscription === "string" ? session.subscription : null,
      });
      break;
    }

    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const sub = event.data.object;
      const customerId = typeof sub.customer === "string" ? sub.customer : null;
      const workspaceId = await resolveWorkspace(sub.metadata?.workspaceId, customerId);
      if (workspaceId === null) break;
      const row = await getWorkspacePlanRow(pool, workspaceId);
      if (row === null || row.plan === "enterprise") break; // administrative plans are never Stripe-driven
      const planStatus = mapSubscriptionStatus(sub.status);
      await applyPlanState(pool, workspaceId, {
        plan: "pro",
        planStatus,
        stripeSubscriptionId: sub.id,
        currentPeriodEnd: subscriptionPeriodEnd(sub),
        // Recovered payment ends the grace window; past_due leaves it to
        // invoice.payment_failed (which starts it).
        ...(planStatus === "active" || planStatus === "trialing" ? { graceUntil: null } : {}),
      });
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const customerId = typeof sub.customer === "string" ? sub.customer : null;
      const workspaceId = await resolveWorkspace(sub.metadata?.workspaceId, customerId);
      if (workspaceId === null) break;
      const row = await getWorkspacePlanRow(pool, workspaceId);
      if (row === null || row.plan === "enterprise") break;
      // Full revert to Free LIMITS. Customer id is kept for a re-subscribe;
      // no coordination data is touched (downgrade, never lock out).
      await applyPlanState(pool, workspaceId, {
        plan: "free",
        planStatus: "none",
        stripeSubscriptionId: null,
        currentPeriodEnd: null,
        graceUntil: null,
      });
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const customerId = typeof invoice.customer === "string" ? invoice.customer : null;
      const workspaceId = await resolveWorkspace(undefined, customerId);
      if (workspaceId === null) break;
      const row = await getWorkspacePlanRow(pool, workspaceId);
      if (row === null || row.plan !== "pro") break;
      await applyPlanState(pool, workspaceId, {
        plan: row.plan,
        planStatus: "past_due",
        // First failure starts the grace clock; retries never extend it.
        ...(row.grace_until === null
          ? { graceUntil: new Date(Date.now() + config.BILLING_GRACE_DAYS * 86_400_000) }
          : {}),
      });
      break;
    }

    default:
      // Not a billing-relevant event — ack so Stripe stops retrying.
      break;
  }

  return { received: true };
}
```

- [ ] **Step 4: Register the route in `server.ts`.** Two changes:

(a) Add the exemption in the `onRequest` hook, right after the `/health` exemption:

```typescript
    // Exempt the Stripe webhook: it authenticates via the Stripe signature
    // (verified in the handler — handleStripeWebhook fails closed with 401),
    // not via resolveTenant. Same posture as /health. POST-only by route
    // registration; the raw body is preserved in its encapsulated scope below.
    if (url === "/stripe/webhook") {
      return;
    }
```

(b) Register an ENCAPSULATED scope with a raw-body parser (content-type parsers are plugin-scoped in Fastify, so this cannot affect any other route), after the operation routes:

```typescript
  // ---------------------------------------------------------------------------
  // Stripe webhook — auth-exempt (see the onRequest hook), signature-verified.
  // Registered in its own encapsulation context so its parse-as-buffer JSON
  // parser (Stripe's constructEvent needs the EXACT raw bytes) never leaks to
  // the rest of the app.
  // ---------------------------------------------------------------------------

  app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer", bodyLimit: 1024 * 1024 },
      (_req, body, done) => done(null, body)
    );
    scope.post("/stripe/webhook", async (request, _reply) => {
      const sig = request.headers["stripe-signature"];
      return handleStripeWebhook(
        request.body as Buffer,
        Array.isArray(sig) ? sig[0] : sig
      );
    });
  });
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run packages/hub/test/stripeWebhook.test.ts packages/hub/test/server.test.ts packages/hub/test/tenant.test.ts`
Expected: PASS (auth suites unaffected — the exemption is URL-exact).

- [ ] **Step 6: Full gate + commit**

```bash
git add packages/hub/src/billing/webhook.ts packages/hub/src/server.ts packages/hub/test/stripeWebhook.test.ts
git commit -m "feat(hub): Stripe webhook route — signature-verified plan-state transitions"
```

---

## Phase 6 — UI + BFF + docs

### Task 10: UI client billing methods

**Files:**
- Modify: `packages/ui/src/client.ts` (interface + implementation + exports)
- Test: `packages/ui/src/client.test.ts` (extend, following its existing fetch-stub pattern)

**Interfaces:**
- Consumes: `BillingStatusResponseT`, `StartTrialResponseT`, `CreateCheckoutSessionRequestT`, `CheckoutSessionResponseT`, `PortalSessionResponseT` from `@shepherd/shared` (Task 3); hub routes from Tasks 7-8.
- Produces (on `ShepherdClient`, hosted-mode section next to `landscape()`):

```typescript
  /** Current plan + usage for a workspace (any member). */
  getBilling(workspaceId: string): Promise<BillingStatusResponseT>;
  /** Start the 14-day, NO-CARD app-side Pro trial (admin-only; once per workspace). */
  startTrial(workspaceId: string): Promise<StartTrialResponseT>;
  /** Start a Pro upgrade / trial conversion — returns the Stripe Checkout URL to redirect to (admin-only). */
  startCheckout(workspaceId: string, body: CreateCheckoutSessionRequestT): Promise<CheckoutSessionResponseT>;
  /** Open the Stripe Customer Portal — returns its URL (admin-only). */
  openBillingPortal(workspaceId: string): Promise<PortalSessionResponseT>;
```

- [ ] **Step 1: Write failing tests** asserting method → `GET /workspaces/:id/billing`, `POST /workspaces/:id/billing/trial` (bodyless), `POST /workspaces/:id/billing/checkout` (JSON body pass-through), `POST /workspaces/:id/billing/portal` (bodyless), mirroring how `client.test.ts` asserts paths/methods for `listMembers` etc. Include one 402 case: a fetch stub returning status 402 with a `plan_limit` body must surface a `ShepherdClientError` with `status === 402` (the existing error path — assert it so the upgrade-prompt hook in Task 11 has a tested contract).
- [ ] **Step 2: Run to verify failure** (`npx vitest run packages/ui/src/client.test.ts`).
- [ ] **Step 3: Implement** the four methods following the file's existing `request(...)` helper conventions (e.g. `this.request("GET", \`/workspaces/${encodeURIComponent(workspaceId)}/billing\`)` — copy the exact idiom used by `listMembers`).
- [ ] **Step 4: Tests pass; commit.**

```bash
git add packages/ui/src/client.ts packages/ui/src/client.test.ts
git commit -m "feat(ui): client methods for billing status, trial, checkout, portal"
```

### Task 11: Billing panel in ConfigPanel

**Files:**
- Create: `packages/ui/src/config/Billing.tsx`
- Create: `packages/ui/src/config/Billing.test.tsx`
- Modify: `packages/ui/src/config/ConfigPanel.tsx` (add the section)
- Modify: `packages/ui/src/test/mockClient.ts` (stub the four new client methods)

**Interfaces:**
- Consumes: `ShepherdClient` methods (Task 10); `workspace: WorkspaceSummaryT` (`role`, `id`); ConfigPanel's section pattern (`ConfigPanel.tsx:29-36`).
- Produces: `<Billing workspaceId={string} isAdmin={boolean} />`.

**Behavior (follow `WorkspaceSettings.tsx` / `Members.tsx` structure, styling classes, and test harness):**
- On mount, `getBilling(workspaceId)`. While loading, the panel's standard loading treatment; on error, the standard error line.
- `billingEnabled === false` → render a single quiet line: "Billing is not enabled on this deployment." (self-host).
- Otherwise render: current plan name + status badge (while `planStatus === "trialing"` and `effectivePlan === "pro"`, show "Pro trial — N days left", N computed from `currentPeriodEnd`; when the trial has lapsed — `planStatus === "trialing"` but `effectivePlan === "free"` — show "Trial ended — back on Free limits"; "Payment past due — Pro until <graceUntil>" when `past_due`); usage rows "Members X / Y" and "Repos X / Y" (∞ for null max); "History retention: N days" (or "Unlimited").
- Admin + `trialAvailable` → primary "Start free trial — no credit card" button: `startTrial(workspaceId)`, then refetch `getBilling` and re-render (no redirect — nothing leaves the app; the trial is card-less).
- Admin + upgradable (`effectivePlan === "free"` without `trialAvailable`, OR `planStatus === "trialing"` — live or lapsed, since Checkout is the trial→paid conversion) → "Upgrade to Pro — $15/mo" button: `startCheckout(workspaceId, { interval: "month" })` then `window.location.assign(url)`. While trialing, both the days-left badge and this button show.
- Admin + a Stripe-driven state (`planStatus` in `active | past_due | canceled`) → "Manage billing" button: `openBillingPortal` then `window.location.assign(url)`. (NOT shown for a trial-only workspace — the app-side trial has no Stripe customer, and the portal endpoint would 409.)
- Non-admin: no buttons, plus the line "Ask a workspace admin to change the plan." (spec: read-only for non-admins).
- Enterprise: no self-serve buttons; "Contact sales to change your Enterprise plan."

ConfigPanel changes: add `{ id: "billing", label: "Billing" }` to `SECTIONS` (after "members"), the `Section` union member, and:

```tsx
        {section === "billing" && (
          <Billing workspaceId={workspace.id} isAdmin={isAdmin} />
        )}
```

- [ ] **Step 1: Write failing component tests** (mirror `WorkspaceSettings.test.tsx`'s render/mock harness): trial-eligible admin sees "Start free trial — no credit card" and clicking it calls `startTrial` then refetches (assert `getBilling` called twice, no navigation); a trialing workspace shows "N days left" plus the Upgrade button and NO trial or Manage-billing button; free-plan admin with `trialAvailable:false` sees the Upgrade button and usage numbers; non-admin sees numbers but no buttons; `billingEnabled:false` hides everything but the disabled line; clicking Upgrade calls `startCheckout` with `{ interval: "month" }` and navigates to the returned URL (stub `window.location.assign`).
- [ ] **Step 2: Run to verify failure** (`npx vitest run packages/ui/src/config/Billing.test.tsx`).
- [ ] **Step 3: Implement `Billing.tsx`** per the behavior list, reusing the panel's existing section/heading/button class names (copy from `WorkspaceSettings.tsx`), then wire ConfigPanel.
- [ ] **Step 4: Tests + `npm run check` pass.**
- [ ] **Step 5:** Bump `SHEPHERD_UI_VERSION` per the repo's UI release convention (see the `ui-v*` flow — version constant + tag at release time; do NOT publish locally).
- [ ] **Step 6: Commit**

```bash
git add packages/ui/src/config/Billing.tsx packages/ui/src/config/Billing.test.tsx \
        packages/ui/src/config/ConfigPanel.tsx packages/ui/src/test/mockClient.ts
git commit -m "feat(ui): Billing section — plan status, usage, no-card trial + upgrade + portal (admin-only actions)"
```

### Task 12: Runbook + external touchpoints (docs only; no code)

**Files:**
- Create: `docs/billing-runbook.md`
- Modify: `README.md` (one paragraph: self-host is unaffected by billing; hosted billing env vars)

**Content checklist for `docs/billing-runbook.md`:**

- [ ] Stripe dashboard setup: create the Pro product with a $15/mo recurring price (and optional $150/yr annual price); copy the price ids into `STRIPE_PRICE_PRO_MONTHLY` / `STRIPE_PRICE_PRO_ANNUAL`. Do NOT configure a Stripe-side trial on the price/product — the 14-day trial is app-side and card-less (hub endpoint); Checkout is always a straight paid subscription.
- [ ] Cloud Run env vars for the hosted hub: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_MONTHLY`, `PUBLIC_WEB_URL`, optional `STRIPE_PRICE_PRO_ANNUAL`, `BILLING_GRACE_DAYS`. Note: push to main auto-deploys (Cloud Build trigger) — no manual redeploy.
- [ ] Webhook endpoint registration: point Stripe at the hub's **direct** URL `https://<hub-host>/stripe/webhook` (NOT through the BFF), events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`. Local dev: `stripe listen --forward-to localhost:8080/stripe/webhook`.
- [ ] Enterprise runbook (the "DB flag" decision): the exact SQL —
  `UPDATE workspaces SET plan = 'enterprise', plan_status = 'active' WHERE slug = '<workspace-slug>';`
  and the reversal (`SET plan = 'free', plan_status = 'none'`). Note enterprise rows are ignored by webhook transitions by design.
- [ ] **Platform (BFF/console) repo touchpoints — work OUTSIDE this repo, list for the platform team:** (1) confirm the console BFF's generic `/workspaces/*` forwarder covers the new `billing` subroutes (it proxies by prefix; no Stripe logic belongs in the BFF), (2) the console's per-workspace analytics UI gates on `entitlements.analytics` from `GET /workspaces/:id/billing`, (3) the console surfaces the `?billing=success|canceled` return params, (4) 402 `plan_limit` responses proxied through the BFF should render the upgrade prompt (the UI package handles it; the BFF must pass the body through untouched).
- [ ] Commit: `git commit -m "docs: billing runbook (Stripe setup, env, enterprise, platform touchpoints)"`.

---

## Self-review (done while writing)

- **Spec coverage:** billing entity/columns → Tasks 1-2; flat pricing/plan table → `PLAN_LIMITS` (Task 2); seats → Task 4; repos → Task 5; retention → Task 6; hosted-only/self-host-unlimited → `billingEnabled` + `via === "team"` guards asserted in Tasks 4/5/6 tests; downgrade-never-lock-out → `effectivePlan` (Task 2, incl. trial expiry) + webhook transitions (Task 9) + "existing repos exempt" rule (Task 5); 14-day NO-CARD app-side trial (human decision 2026-07-08, supersedes the spec's Stripe-side trial) → Tasks 2/3/7/8/11; Checkout/Portal/webhooks → Tasks 7-9; BFF-proxies-only + UI admin panel → Tasks 10-12; Enterprise administrative → runbook (Task 12); agents never gated → nothing anywhere counts agents. Deviation: `/admin/*` plan-gating replaced by the `entitlements.analytics` flag (Resolved question 7 — flagged for confirmation).
- **Type consistency:** `PlanT`/`PlanStatusT` (shared) ↔ `WorkspacePlanRow` (repo) ↔ `effectivePlan(row, now)` ↔ `applyPlanState(patch)` names checked across Tasks 2/4/5/6/7/9; client method names `getBilling`/`startCheckout`/`openBillingPortal` consistent across Tasks 10-11.
- **Placeholder scan:** the abbreviated sibling tests in Tasks 4/5/6/8/9 name their exact fixtures and assertions ("write in full following the first's structure") — the first test of each suite is complete code establishing the harness. All route/column/function names are real or defined here.

## Decisions to confirm with the human

1. `/admin/*` analytics is **not** plan-gated (it's the Korso-internal operator surface); Pro analytics ships as the `entitlements.analytics` flag for the console to gate on (Resolved question 7).
2. Grace period = **14 days** (`BILLING_GRACE_DAYS`, configurable).
3. Trial = **app-side, NO credit card**, 14 days, once per workspace ever (guard: `plan='free' AND plan_status='none' AND both Stripe ids NULL`). `current_period_end` dual-uses as the trial end; expiry reverts to Free LIMITS via `effectivePlan` (no job, no deletion); the card enters only at Checkout conversion. Accepted edge: a customer id created by an ABANDONED checkout blocks a later trial.
4. Enterprise = **SQL runbook**, no admin endpoint at launch.
5. Repo cap gates **new** repos only — a workspace already over the cap (post-downgrade) keeps its existing repos working.
6. Retention prune applies **only to announcements** (change records already expire at 3 days globally); billing-disabled deployments never prune.
