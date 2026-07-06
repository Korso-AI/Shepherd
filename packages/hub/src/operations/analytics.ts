/**
 * platformAnalytics operation: the cross-tenant, read-only product analytics
 * rollup behind the Korso console "Shepherd" tab. Operator-gated — see
 * `requireOperator` in tenant.ts for the trust model.
 */

import { ShepherdAnalyticsResponse } from "@shepherd/shared";

import { getContext } from "../context.js";
import { getShepherdAnalytics, type ShepherdAnalytics } from "../repo.js";
import { requireOperator, type TenantContext } from "../tenant.js";

/** Daily-trend horizon for the analytics rollup. */
const TREND_DAYS = 30;

/** How long a computed rollup is served from memory before re-running the fan-out. */
const CACHE_TTL_MS = 60_000;

// A trivial module-level cache: the rollup is identical for every operator and
// mildly expensive (~20 aggregate queries), so repeat loads inside the TTL are
// served from memory. Checked ONLY after the operator gate, so a non-operator
// can never read a cached rollup. Single-instance; resets on process restart.
let cache: { at: number; data: ShepherdAnalytics } | null = null;

/** Test-only: clear the cached rollup so each test computes fresh numbers. */
export function __resetAnalyticsCache(): void {
  cache = null;
}

export async function platformAnalytics(tenant: TenantContext): Promise<ShepherdAnalytics> {
  // Operator-only: the data is product-wide, so gate before touching the DB
  // (and before the cache, so the gate can never be bypassed by a warm entry).
  requireOperator(tenant);

  if (cache !== null && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  const { pool, config } = getContext();
  const rollup = await getShepherdAnalytics(pool, {
    liveWindowSeconds: config.STALE_AFTER_SECONDS,
    trendDays: TREND_DAYS,
  });
  // Parse against the canonical wire contract so any drift between the repo
  // rollup and @shepherd/shared's schema fails loudly here, not in a consumer.
  const data = ShepherdAnalyticsResponse.parse(rollup);
  cache = { at: Date.now(), data };
  return data;
}
