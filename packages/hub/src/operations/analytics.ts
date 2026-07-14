/**
 * platformAnalytics operation: the cross-tenant, read-only product analytics
 * rollup behind the Korso console "Shepherd" tab. Operator-gated — see
 * `requireOperator` in tenant.ts for the trust model.
 */

import {
  ShepherdAnalyticsResponse,
  DEFAULT_ANALYTICS_RANGE,
  type AnalyticsRangeT,
} from "@shepherd/shared";

import { getContext } from "../context.js";
import { withContext } from "../scopedDb.js";
import { getShepherdAnalytics, type ShepherdAnalytics } from "../repo.js";
import { requireOperator, type TenantContext } from "../tenant.js";

/** How long a computed rollup is served from memory before re-running the fan-out. */
const CACHE_TTL_MS = 60_000;

// A small per-range cache: the rollup is identical for every operator and
// mildly expensive (~35 aggregate queries), so repeat loads of the SAME range
// inside the TTL are served from memory. Keyed by range so a 24h load never
// serves a 30d caller a stale-shaped payload. Checked ONLY after the operator
// gate, so a non-operator can never read a cached rollup. Single-instance;
// resets on process restart.
const cache = new Map<
  AnalyticsRangeT,
  { at: number; data: ShepherdAnalytics }
>();

/** Test-only: clear every cached range so each test computes fresh numbers. */
export function __resetAnalyticsCache(): void {
  cache.clear();
}

export async function platformAnalytics(
  tenant: TenantContext,
  range: AnalyticsRangeT = DEFAULT_ANALYTICS_RANGE,
): Promise<ShepherdAnalytics> {
  // Operator-only: the data is product-wide, so gate BEFORE touching the cache
  // or the DB — the gate can never be bypassed by a warm entry, and a
  // non-operator never reads any cached range.
  requireOperator(tenant);

  const hit = cache.get(range);
  if (hit !== undefined && Date.now() - hit.at < CACHE_TTL_MS) {
    return hit.data;
  }

  const { pool, config } = getContext();
  const rollup = await withContext(pool, { kind: "operator" }, (db) =>
    getShepherdAnalytics(db, {
      range,
      now: new Date(),
      liveWindowSeconds: config.STALE_AFTER_SECONDS,
    }),
  );
  // Parse against the canonical wire contract so any drift between the repo
  // rollup and @shepherd/shared's schema fails loudly here, not in a consumer.
  const data = ShepherdAnalyticsResponse.parse(rollup);
  cache.set(range, { at: Date.now(), data });
  return data;
}
