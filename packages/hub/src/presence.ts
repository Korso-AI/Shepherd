import type { Config } from "./config.js";

/**
 * Resolve the TTL (in seconds) for a claim.
 *
 * - If `requested` is undefined, fall back to `config.DEFAULT_TTL_SECONDS`.
 * - Otherwise clamp upward so the value is always >= `config.MIN_TTL_SECONDS`.
 */
export function resolveTtlSeconds(
  requested: number | undefined,
  config: Config,
): number {
  if (requested === undefined) {
    return config.DEFAULT_TTL_SECONDS;
  }
  return Math.max(requested, config.MIN_TTL_SECONDS);
}

/**
 * Return true when the agent has not sent a heartbeat recently enough.
 *
 * Staleness is strictly greater-than: an agent is stale only when
 * `now - lastHeartbeatAt > STALE_AFTER_SECONDS` (i.e. at exactly the
 * boundary the claim is still considered live).
 *
 * NOTE: This is the CANONICAL TS staleness definition.
 * `repo.listActiveClaims` (a later task) mirrors this threshold as an
 * inline SQL predicate:
 *   `s.last_heartbeat_at > (now - STALE_AFTER_SECONDS * interval '1 second')`
 * Both sides read the same `STALE_AFTER_SECONDS` config value; only the
 * TS implementation lives here.
 *
 * `now` is always injected — never read the clock inside this function.
 */
export function isStale(
  lastHeartbeatAt: Date,
  now: Date,
  config: Config,
): boolean {
  const elapsedSeconds = (now.getTime() - lastHeartbeatAt.getTime()) / 1000;
  return elapsedSeconds > config.STALE_AFTER_SECONDS;
}

/**
 * Derive a wallboard presence label from a session's last heartbeat.
 *
 * - `null` heartbeat (the agent has no session yet) → "offline".
 * - otherwise "offline" iff the heartbeat is stale (see `isStale`), else "live".
 *
 * This is the single presence definition the read-only wallboard endpoint uses,
 * sharing `isStale`'s exact staleness boundary so the threshold lives in one
 * place. `now` is always injected — never read the clock inside this function.
 */
export function presenceFor(
  lastHeartbeatAt: Date | null,
  now: Date,
  config: Config,
): "live" | "offline" {
  if (lastHeartbeatAt === null) {
    return "offline";
  }
  return isStale(lastHeartbeatAt, now, config) ? "offline" : "live";
}

/**
 * Compute the absolute expiry Date for a claim.
 *
 * Returns a new Date; the `now` argument is never mutated.
 * `now` is always injected — never read the clock inside this function.
 */
export function computeExpiry(now: Date, ttlSeconds: number): Date {
  return new Date(now.getTime() + ttlSeconds * 1000);
}
