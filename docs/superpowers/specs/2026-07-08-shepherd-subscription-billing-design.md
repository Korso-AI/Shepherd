# Shepherd Subscription Billing — Design

**Date:** 2026-07-08
**Status:** Approved (design); implementation plan pending
**Author:** daichi + Claude

## Summary

Make the **Korso-hosted** Shepherd a subscription product. Add Stripe billing and
per-plan limits so small teams can pay a cheap flat monthly fee to have Korso host
their workspace, while larger teams / those needing SSO, SLA, compliance, or a
commercial license move to a custom Enterprise tier.

This document decides **the pricing/plan model** and sketches the enforcement and
Stripe architecture at enough depth to hand to implementation planning. It does
**not** specify code-level details (route names, column types, UI component
structure) — those belong to the implementation plan.

## Product thesis

Shepherd is **AGPL and free to self-host**. Anyone technical enough to run
coordinating agents can also run a Docker container + Postgres. Therefore:

- **Self-hosting is the real free tier.** The paid product is not "the software" —
  it's **managed hosting / convenience**: "we run your workspace so you don't have
  to."
- The bet is that the tool is good enough that a small team would rather pay a
  little than stand up and babysit their own hub.
- A *generous* free **hosted** tier would be strictly bad for us: it makes us pay
  hosting costs for users who would never convert (if they cared about cost they'd
  self-host), and it cannibalizes the exact "too lazy to self-host" customer we
  want to charge. So the hosted free tier is deliberately **small** — an
  evaluation / hobby tier, not a team plan.
- The durable moat and largest deals are **Enterprise**: SSO/SAML, SLA, security
  review, and especially the **commercial self-host license** (run a *modified*
  hosted service without the AGPL source-disclosure obligation). These cannot be
  self-served around.

## Billing model

- **Billing entity = the workspace.** Each hosted workspace carries its own plan
  and is its own Stripe customer/subscription. This matches the existing data
  model exactly (a workspace already *is* the team; there is no org layer above
  it) and mirrors how Slack/Linear bill (workspace is the customer). A company
  with multiple teams simply has multiple workspaces, each billed independently.
- **Price is flat per workspace**, not per seat. Inviting a teammate never costs
  more (good for a coordination tool where you *want* more members and agents in
  the room). Revenue scales by moving up tiers, not by head-counting.
- **Agents are never a billing or plan lever.** Agents are the core value of the
  product; gating them is anti-value. Abuse (e.g. a free workspace spinning up
  thousands of agents) is handled by the **pre-auth rate limiter** being added
  separately, not by a plan cap.
- **Hosted-only.** All plan limits and billing apply **only to Korso-hosted
  workspaces** (requests resolved via the BFF `x-internal-token` path or minted
  `shp_…` API tokens). **Self-hosted mode** (`TEAM_TOKEN` → single
  `ALLOWED_WORKSPACE`) is fully unlimited and unmetered — self-hosters run their
  own hub and we never meter it.
- **Downgrade, never lock out.** On cancellation or payment failure: a grace
  period, then the workspace reverts to **Free limits**. We never delete data or
  hard-lock a workspace for non-payment.

## Plans & pricing

| | **Free** (eval / hobby) | **Pro / Team** | **Enterprise** |
|---|---|---|---|
| **Positioning** | "try hosted, or self-host free" | "we host your team's workspace, cheaply" | "hosted + SSO, SLA, compliance, commercial license" |
| **Price** | **$0** | **$15 / month flat per workspace** | **Custom — starts ~$99/month** |
| **Billing** | — | flat monthly; 14-day free trial; annual ≈ 2 months free (~$150/yr) | negotiated (may include commercial license worth far more than the hosting fee) |
| **Human seats** (memberships) | **2** | up to **20** | unlimited |
| **Active agents** | anti-abuse only | anti-abuse only | anti-abuse only |
| **Repos / workspace** | **3** | unlimited | unlimited |
| **History retention** (announcements + change records) | **7 days** | **90 days** | unlimited + audit-log export |
| **Admin analytics** (`/admin/*`, already built) | — | ✅ | ✅ |
| **Support** | community (GitHub) | email | SLA + priority + security review |
| **SSO / SAML / SCIM** | — | — | ✅ |
| **Commercial self-host license + VPC / on-prem** | — | — | ✅ |

**Conversion triggers:**

- **Free → Pro:** "I want a real team on this, hosted" — hits the 2-seat / 3-repo
  wall quickly for any real team.
- **Pro → Enterprise:** the **20-seat cap**, or needing SSO / compliance / a
  commercial license.

**Rationale for the exact numbers:**

- **Free is small on purpose** (2 seats, 3 repos, 7-day retention). It exists to
  let someone evaluate the *hosted* experience and to serve solo/hobby use. Real
  free usage is self-hosting.
- **Pro = $15/mo flat.** Deliberately cheap — "less than one lunch, and we never
  touch a server." Hosting one small workspace costs us very little, and cheap is
  the entire pitch. Flat so adding teammates/agents is free.
- **Enterprise = custom, ~$99/mo floor.** "A bit more" for 20+ dev teams, and the
  wrapper for SSO/SLA/compliance and the commercial license, which are negotiated.

**Repo limit is a segmentation lever, not a cost lever.** A repo is not a table —
it is a free-text field on coordination rows, so it costs us ~nothing. Limiting
Free to 3 repos segments serious multi-project orgs (who signal willingness to
pay) from hobby use.

## Enforcement (all in the hub; hosted workspaces only)

The hub is the source of truth for plan state, so all limit checks live there and
are **skipped entirely for self-host** (`TEAM_TOKEN`-resolved) requests.

- **Seats:** when a membership would be added (invite redeem / add member), count
  current memberships in the workspace; block additions beyond the plan cap with a
  clear seat-limit / upgrade error.
- **Repos (Free):** on the coordination calls that introduce a repo (`work`,
  `link`), count distinct repos already present in the workspace; block a new repo
  beyond the plan cap.
- **Retention:** a periodic cleanup trims announcements + change records older than
  the plan's retention window (7 / 90 days; unlimited for Enterprise).
- **Analytics:** gate the `/admin/*` analytics surface on plan ≥ Pro.
- **Agents:** no plan gate — anti-abuse only (handled by the separate pre-auth
  rate limiter).
- **Downgrade / past-due:** a grace period, then revert to Free limits. Data is
  never deleted and the workspace is never hard-locked for non-payment.

## Stripe architecture

- **Plan state lives on the `workspaces` table.** New columns (names finalized in
  the implementation plan): `plan`, `stripe_customer_id`, `stripe_subscription_id`,
  `plan_status`, `current_period_end`. A new hosted workspace defaults to Free.
- **The hub owns Stripe** (it holds the source of truth):
  - Creates **Checkout sessions** (upgrade to Pro) and **Customer Portal sessions**
    (manage/cancel), initiated by a workspace **admin**.
  - Receives Stripe **webhooks** on an **auth-exempt, signature-verified** route
    (the same auth-exempt posture as `/health`, but verified via the Stripe webhook
    signing secret). Relevant events: `checkout.session.completed`,
    `customer.subscription.updated`, `customer.subscription.deleted`,
    `invoice.payment_failed`. Webhooks flip `plan` / `plan_status` /
    `current_period_end`.
- **The BFF just proxies** the "start checkout" / "open portal" calls through to
  the hub, exactly like every other Shepherd endpoint — no Stripe logic in the BFF.
- **UI:** a billing panel in the dashboard, visible to workspace **admins only** —
  shows current plan/usage, an "Upgrade" button (→ Checkout redirect), and a
  "Manage billing" link (→ Customer Portal). Non-admins see plan status read-only.
- **Enterprise** is handled off-platform (sales/contract); the hub simply supports
  an `enterprise` plan value with unlimited limits set administratively (no
  self-serve Checkout for Enterprise at launch).

## Out of scope (this design)

- Per-seat pricing / metered agent billing (explicitly rejected — flat only).
- An org/account layer above workspace (rejected — workspace is the billing
  entity).
- Self-serve Enterprise Checkout, SSO/SAML implementation, and the commercial
  self-host license mechanics (Enterprise is sales-led; these are separate future
  work).
- Usage-based / overage billing.
- The pre-auth rate limiter (owned separately by the hub team; this design only
  *relies* on it for agent abuse protection).
- Dunning/email flows beyond what Stripe provides out of the box.

## Open questions for the implementation plan

- Exact column names/types and the migration ordering (next migration number is
  `020`).
- Whether retention cleanup is a cron/scheduled job, a boot-time sweep, or a
  lazy filter at read time.
- Precise error shape returned when a limit is hit (so the UI can render a clean
  "upgrade" prompt).
- Trial mechanics: Stripe trial vs. app-side trial window, and whether a card is
  required to start the trial.
- How `enterprise` limits are set (admin endpoint vs. DB flag).
