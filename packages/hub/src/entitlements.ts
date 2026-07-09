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
import type { WorkspaceEntitlementsRow } from "./repo.js";

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
