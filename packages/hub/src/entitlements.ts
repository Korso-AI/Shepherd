/**
 * Workspace entitlements — the enforcement rules over the per-workspace caps
 * primitive (migration 020, repo.ts "Workspace entitlements" section).
 *
 * The whole system is inert by construction: a deployment that never sets
 * ENTITLEMENTS_DEFAULT_LIMITS gets no limits of any kind — every guard
 * returns immediately (see enforcementEnabled). When defaults ARE configured,
 * a workspace's effective caps resolve as:
 *
 *   1. A live per-workspace record (no expiry, or expiry in the future)
 *      supplies its caps verbatim — including any null (= unlimited) caps.
 *   2. An EXPIRED record is ignored entirely; the deployment defaults apply.
 *      This is what lets a temporary grant self-revert with no cleanup writer.
 *   3. No record at all: the deployment defaults apply.
 *
 * Guards that consume these rules (seat/repo caps, retention window) live
 * here too as the wiring lands; each one also no-ops for `tenant.via ===
 * "team"` so a self-host deployment is never limited even if it sets the env.
 */

import type { EntitlementLimitsT } from "@shepherd/shared";
import type { Config } from "./config.js";
import type { TenantContext } from "./tenant.js";
import { LimitExceededError } from "./errors.js";
import {
  countMembers,
  getWorkspaceEntitlements,
  listWorkspaceRepos,
  type Queryable,
  type WorkspaceEntitlementsRow,
} from "./repo.js";

/**
 * Whether this deployment enforces entitlements at all. Strictly "is
 * ENTITLEMENTS_DEFAULT_LIMITS set": no other condition may enable
 * enforcement, so self-host deployments are unlimited by construction.
 */
export function enforcementEnabled(config: Config): boolean {
  return config.ENTITLEMENTS_DEFAULT_LIMITS !== undefined;
}

/**
 * Resolve the caps that actually apply to a workspace right now — the gating
 * rules in the module header as one pure function. `record` is the
 * workspace's entitlements row (or null when it has none); `defaults` is the
 * deployment's configured default caps.
 */
export function effectiveLimits(
  record: WorkspaceEntitlementsRow | null,
  defaults: EntitlementLimitsT,
  now: Date,
): EntitlementLimitsT {
  if (record === null) return defaults;
  if (record.expires_at !== null && record.expires_at.getTime() <= now.getTime()) {
    return defaults;
  }
  return {
    seatsLimit: record.seats_limit,
    reposLimit: record.repos_limit,
    retentionDays: record.retention_days,
  };
}

/**
 * Both guard no-op conditions in one place: enforcement never configured, or
 * the caller is the self-host TEAM_TOKEN path (self-host is unlimited by
 * construction even if the env is set).
 */
function guardDisabled(config: Config, tenant: TenantContext): boolean {
  return !enforcementEnabled(config) || tenant.via === "team";
}

/**
 * Serialize this guard's check-then-write against every other caller touching
 * the same cap dimension of the same workspace. Transaction-scoped advisory
 * lock, two-key form mirroring work.ts's `(workspaceId, repo)` lock; the
 * fixed literal second key (`entitlements:seats` / `entitlements:repos`)
 * keeps these locks disjoint from work.ts's keyspace and from each other.
 * Released automatically at COMMIT/ROLLBACK.
 */
async function lockDimension(
  tx: Queryable,
  workspaceId: string,
  dimension: "entitlements:seats" | "entitlements:repos",
): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [
    workspaceId,
    dimension,
  ]);
}

/**
 * Throw LimitExceededError(402) when the workspace has no seat headroom for
 * one more member. Call INSIDE the joining transaction, BEFORE any use is
 * consumed or row written, and pass the transaction client — the advisory
 * lock is what closes the concurrent-redeem race (two redeems on different
 * codes both reading the same countMembers and both inserting; the invite-row
 * lock never serializes across codes).
 */
export async function assertSeatAvailable(
  tx: Queryable,
  config: Config,
  tenant: TenantContext,
  workspaceId: string,
): Promise<void> {
  if (guardDisabled(config, tenant)) return;
  await lockDimension(tx, workspaceId, "entitlements:seats");

  const record = await getWorkspaceEntitlements(tx, workspaceId);
  const limits = effectiveLimits(
    record,
    config.ENTITLEMENTS_DEFAULT_LIMITS!,
    new Date(),
  );
  if (limits.seatsLimit === null) return;

  const used = await countMembers(tx, workspaceId);
  if (used >= limits.seatsLimit) {
    throw new LimitExceededError("seats", used, limits.seatsLimit);
  }
}

/**
 * Throw LimitExceededError(402) when joining from `repo` would register a NEW
 * distinct repo past the workspace's cap. An EXISTING repo always passes — a
 * cap reduction never locks agents out of repos already in use. `repo` must
 * already be canonicalized (the same canonicalizeRepo the session row gets),
 * or an equal repo would miscompare against listWorkspaceRepos. Call INSIDE
 * the join transaction with the transaction client — the advisory lock closes
 * the two-new-repos race (both joins reading the same repo list and both
 * creating sessions past the cap).
 */
export async function assertRepoAllowed(
  tx: Queryable,
  config: Config,
  tenant: TenantContext,
  workspaceId: string,
  repo: string,
): Promise<void> {
  if (guardDisabled(config, tenant)) return;
  await lockDimension(tx, workspaceId, "entitlements:repos");

  const repos = await listWorkspaceRepos(tx, workspaceId);
  if (repos.includes(repo)) return;

  const record = await getWorkspaceEntitlements(tx, workspaceId);
  const limits = effectiveLimits(
    record,
    config.ENTITLEMENTS_DEFAULT_LIMITS!,
    new Date(),
  );
  if (limits.reposLimit === null) return;

  if (repos.length >= limits.reposLimit) {
    throw new LimitExceededError("repos", repos.length, limits.reposLimit);
  }
}
