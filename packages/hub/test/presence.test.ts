import { describe, it, expect } from 'vitest';
import type { Config } from '../src/config.js';
import { resolveTtlSeconds, isStale, computeExpiry, presenceFor } from '../src/presence.js';

/** Fake config matching the defaults from config.ts */
const cfg: Config = {
  DATABASE_URL: 'postgres://localhost/test',
  TEAM_TOKEN: 'test-token',
  HUB_PORT: 8080,
  ALLOWED_WORKSPACE: '/test',
  DEFAULT_TTL_SECONDS: 1800,
  MIN_TTL_SECONDS: 30,
  STALE_AFTER_SECONDS: 120,
  CHANGE_RECORD_TTL_SECONDS: 604800,
  HUB_ADMIN_LABEL: 'admin',
};

/** Fixed "now" for deterministic tests */
const NOW = new Date('2026-01-01T12:00:00.000Z');

// ---------------------------------------------------------------------------
// resolveTtlSeconds
// ---------------------------------------------------------------------------
describe('resolveTtlSeconds', () => {
  it('returns DEFAULT_TTL_SECONDS when requested is undefined', () => {
    expect(resolveTtlSeconds(undefined, cfg)).toBe(1800);
  });

  it('clamps to MIN_TTL_SECONDS when requested is below the floor', () => {
    expect(resolveTtlSeconds(5, cfg)).toBe(30);
  });

  it('returns the requested value when it is above the floor', () => {
    expect(resolveTtlSeconds(600, cfg)).toBe(600);
  });

  it('returns exactly MIN_TTL_SECONDS when requested equals the floor', () => {
    expect(resolveTtlSeconds(30, cfg)).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// isStale
// ---------------------------------------------------------------------------
describe('isStale', () => {
  it('returns false when heartbeat is 119 s before now (strictly inside window)', () => {
    const heartbeat = new Date(NOW.getTime() - 119 * 1000);
    expect(isStale(heartbeat, NOW, cfg)).toBe(false);
  });

  it('returns false when heartbeat is exactly STALE_AFTER_SECONDS before now (not strictly greater)', () => {
    const heartbeat = new Date(NOW.getTime() - 120 * 1000);
    expect(isStale(heartbeat, NOW, cfg)).toBe(false);
  });

  it('returns true when heartbeat is 121 s before now (strictly outside window)', () => {
    const heartbeat = new Date(NOW.getTime() - 121 * 1000);
    expect(isStale(heartbeat, NOW, cfg)).toBe(true);
  });

  it('returns true when heartbeat is far in the past', () => {
    const heartbeat = new Date(NOW.getTime() - 3600 * 1000);
    expect(isStale(heartbeat, NOW, cfg)).toBe(true);
  });

  it('returns false when heartbeat equals now (age = 0)', () => {
    expect(isStale(NOW, NOW, cfg)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// presenceFor — wallboard presence derivation (mirrors isStale's boundary)
// ---------------------------------------------------------------------------
describe('presenceFor', () => {
  it("returns 'offline' when lastHeartbeatAt is null (no session)", () => {
    expect(presenceFor(null, NOW, cfg)).toBe('offline');
  });

  it("returns 'live' when heartbeat is well within the staleness window", () => {
    const heartbeat = new Date(NOW.getTime() - 10 * 1000);
    expect(presenceFor(heartbeat, NOW, cfg)).toBe('live');
  });

  it("returns 'live' at exactly STALE_AFTER_SECONDS (boundary is live)", () => {
    const heartbeat = new Date(NOW.getTime() - 120 * 1000);
    expect(presenceFor(heartbeat, NOW, cfg)).toBe('live');
  });

  it("returns 'offline' one second past the staleness window", () => {
    const heartbeat = new Date(NOW.getTime() - 121 * 1000);
    expect(presenceFor(heartbeat, NOW, cfg)).toBe('offline');
  });
});

// ---------------------------------------------------------------------------
// computeExpiry
// ---------------------------------------------------------------------------
describe('computeExpiry', () => {
  it('returns now + ttlSeconds', () => {
    const expiry = computeExpiry(NOW, 1800);
    const expectedMs = NOW.getTime() + 1800 * 1000;
    expect(expiry.getTime()).toBe(expectedMs);
  });

  it('does not mutate the now argument', () => {
    const nowMs = NOW.getTime();
    computeExpiry(NOW, 1800);
    expect(NOW.getTime()).toBe(nowMs);
  });

  it('works with a zero TTL', () => {
    const expiry = computeExpiry(NOW, 0);
    expect(expiry.getTime()).toBe(NOW.getTime());
  });
});
