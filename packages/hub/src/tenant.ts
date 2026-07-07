/**
 * Tenancy resolution for @shepherd/hub — the security boundary.
 *
 * `resolveTenant` reduces every authenticated request to exactly ONE of three
 * credential inputs and produces a {@link TenantContext}. It is the single place
 * that decides WHO is calling and WHICH workspace they may touch; the server's
 * onRequest hook calls it and stashes the result on `request.tenant`.
 *
 * Resolution order (first match wins; on failure throws a typed AuthError):
 *   1. `x-internal-token`  → browser-via-BFF (the platform's trusted backend).
 *   2. `Authorization: Bearer shp_…` → a minted agent/API token.
 *   3. `Authorization: Bearer <TEAM_TOKEN>` → self-host single-team mode.
 *   4. none → 401.
 *
 * HARD RULE: a raw client can NEVER assert its own account. `x-account-id` is
 * trusted ONLY when it arrives alongside a matching `x-internal-token` (the BFF
 * is the one component allowed to vouch for an authenticated browser user).
 */

import crypto from "crypto";

import type { Config } from "./config.js";
import { AuthError } from "./errors.js";
import {
  findApiTokenByHash,
  findMembership,
  upsertAccountProfile,
  findWorkspaceBySlug,
  touchApiTokenLastUsed,
} from "./repo.js";
import type pg from "pg";

/**
 * The resolved identity + tenancy scope for a request.
 *
 * `workspaceId` CONTRACT:
 *  - Agent-token and self-host paths: always a concrete workspace id (the
 *    operation runs scoped to it).
 *  - Browser path on a `/workspaces/:id/*` route: the `:id` segment, AFTER
 *    membership has been validated here.
 *  - Browser path on a NON-:id route (POST /workspaces, GET /workspaces,
 *    /invites/:code/redeem, …): there is no route workspace to scope to, so
 *    `workspaceId` is the empty-string sentinel `""`. The operation layer
 *    supplies the workspace for these and is responsible
 *    for its own authorization. Operations that REQUIRE a workspace must reject
 *    a `""` workspaceId.
 *
 * `accountId`/`role` are present only when an account is known (browser + agent
 * paths). Self-host TEAM_TOKEN has full access with neither set.
 */
export interface TenantContext {
  workspaceId: string;
  accountId?: string;
  role?: "admin" | "member";
  /**
   * Which credential KIND resolved this request — the sole discriminator of
   * caller trust, set at every {@link resolveTenant} branch:
   *  - `"browser"` — the trusted browser-via-BFF path (`x-internal-token`).
   *  - `"agent"`   — a minted agent/API token (`Authorization: Bearer shp_…`).
   *  - `"team"`    — the self-host single-team `TEAM_TOKEN`.
   *
   * Security-critical routes that must accept ONLY a browser session (e.g.
   * `redeemInvite`) gate on this, NOT on the `workspaceId` sentinel: an
   * account-scoped agent token now resolves to the same `""` workspaceId a
   * browser has on a non-`:id` route, so the sentinel can no longer distinguish
   * a trusted session from a leaked token.
   */
  via: "browser" | "agent" | "team";
  /**
   * Whether this request carries a VERIFIED internal-operator identity: the
   * BFF-signed HMAC proof checked by {@link verifyOperatorProof} on the browser
   * path, for `/admin/*` URLs only. See {@link requireOperator} for the full
   * trust model. Never set on the agent/team paths.
   */
  operator?: boolean;
  /** The verified operator email, present ONLY when `operator` is true. */
  operatorEmail?: string;
}

/** The empty-string sentinel for "no route-derived workspace" (see contract above). */
export const NO_ROUTE_WORKSPACE = "";

/**
 * Assert a tenant carries a real, route-derived workspace and return it.
 *
 * The sentinel (`NO_ROUTE_WORKSPACE` = "") means resolveTenant could not derive
 * a workspace from the route (a browser call on a non-`/workspaces/:id/*` path),
 * leaving it to the operation to supply one. A coordination operation REQUIRES a
 * concrete workspace, so reaching it with the sentinel is a malformed call — we
 * reject it with a 400 rather than ever querying with an empty workspace_id
 * (which would silently match nothing). See the TenantContext contract above.
 */
export function requireWorkspaceId(tenant: TenantContext): string {
  if (tenant.workspaceId === NO_ROUTE_WORKSPACE) {
    throw new AuthError(
      400,
      "operation requires a workspace-scoped credential",
    );
  }
  return tenant.workspaceId;
}

/**
 * Require an account on the tenant, or reject with 401. A self-host TEAM_TOKEN
 * carries no accountId, so it cannot perform account-scoped management (creating
 * workspaces, owning tokens, redeeming invites). Returns the accountId.
 *
 * Shared home next to requireWorkspaceId — the workspace, token, and invite
 * operations all need this identical guard, so it lives here rather than being
 * re-declared per operation file. (It previously lived as a private copy in both
 * operations/workspaces.ts and operations/tokens.ts; later consolidated here.)
 */
export function requireAccountId(tenant: TenantContext): string {
  if (tenant.accountId === undefined) {
    throw new AuthError(401, "operation requires an account credential");
  }
  return tenant.accountId;
}

/**
 * Require the tenant to be an ADMIN of its (already-resolved) workspace, or
 * reject with 403. On a `/workspaces/:id/*` route resolveTenant has set `role`
 * from the caller's membership, so this is a pure check of that role — it does
 * NOT re-query. A self-host TEAM_TOKEN has no role (full access, single team) and
 * is therefore NOT treated as admin here: admin-gated MANAGEMENT endpoints are a
 * hosted/account surface, so requireAccountId gates them upstream. Shared so the
 * invite (3.5), member-management (3.6), and operator-announce (3.7) paths gate
 * identically.
 */
export function requireAdmin(tenant: TenantContext): void {
  if (tenant.role !== "admin") {
    throw new AuthError(403, "operation requires an admin role");
  }
}

/**
 * Require the request to carry a VERIFIED internal-operator identity, or reject
 * with 403. THE canonical explanation of the operator trust model lives here;
 * the other operator call sites (the `/admin/analytics` route, the
 * platformAnalytics operation, the analytics section of repo.ts) point at it.
 *
 * This gates the cross-tenant `/admin/*` analytics surface: the data is
 * product-wide (every workspace), so an ordinary entitled Shepherd user — even
 * a workspace admin — must NOT reach it. The operator identity is NOT the bare
 * `x-operator-verified` flag: the platform BFF, after its own internal-operator
 * gate, signs an identity proof with the dedicated OPERATOR_IDENTITY_SECRET
 * (distinct from the BFF_INTERNAL_TOKEN shared secret) — an HMAC-SHA256 over
 * version/timestamp/method/request path/account id/operator email/verified
 * flag/body hash, carried in the `x-operator-*` headers. {@link verifyOperatorProof}
 * re-verifies that proof on the browser path (signature, ±5-min freshness,
 * method+path binding, account binding, body hash, exact configured operator
 * email domain) and ONLY then sets `tenant.operator`, so a bare
 * `x-internal-token` holder cannot forge an
 * operator identity. The gate additionally requires `via === "browser"` —
 * defense-in-depth so a fabricated agent/team context can never pass even if
 * it somehow carried the flag. Everything fails closed: a missing secret,
 * missing headers, or any mismatch → not an operator → 403.
 */
export function requireOperator(tenant: TenantContext): void {
  if (tenant.via !== "browser" || tenant.operator !== true) {
    throw new AuthError(403, "operation requires an internal operator");
  }
}

// ---------------------------------------------------------------------------
// Token hashing
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex digest of a token's plaintext — the only stored form of a minted
 * agent token (matches api_tokens.token_hash). Exported so the mint path
 * and tests hash identically.
 */
export function hashToken(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/**
 * Constant-time secret comparison. Both sides are hashed to a fixed 32-byte
 * SHA-256 digest first so the compare never short-circuits on a length
 * mismatch (which would leak the secret's length). Mirrors server.ts's
 * timingSafeCompare. `expected` may be undefined (an unconfigured optional
 * secret) — that is treated as no-match WITHOUT a timing side-channel: we still
 * run a full digest compare against a constant.
 */
function timingSafeCompare(
  provided: string,
  expected: string | undefined,
): boolean {
  const ha = crypto.createHash("sha256").update(provided, "utf8").digest();
  const hb = crypto
    .createHash("sha256")
    .update(expected ?? "", "utf8")
    .digest();
  const equal = crypto.timingSafeEqual(ha, hb);
  // When `expected` is unset there is nothing to match: fail closed regardless
  // of whether `provided` happened to equal "".
  return expected === undefined ? false : equal;
}

// ---------------------------------------------------------------------------
// Operator identity proof (see requireOperator for the trust model)
// ---------------------------------------------------------------------------

/** Versioned signature payload prefix shared with the BFF's operator signer. */
const OPERATOR_SIGNATURE_VERSION = "v1";
/** Max age (either direction) of a signed operator timestamp. */
const OPERATOR_SIGNATURE_MAX_AGE_SECONDS = 300;

/** SHA-256 hex digest of a string (the body-hash convention the BFF signs). */
function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Whether `email` is a well-formed internal operator address for the configured
 * operator domain: a non-empty local part and EXACT domain equality after the
 * last `@`, lowercased (mirrors the platform's isInternalEmail — never a suffix
 * match, so lookalike suffix domains and a bare domain with no local part are
 * both rejected).
 *
 * `domain` is `config.OPERATOR_EMAIL_DOMAIN`. It is OPTIONAL and fail-closed:
 * when unset, no email can match, so the operator surface stays unreachable —
 * no org-specific domain is baked into the source.
 */
function isInternalOperatorEmail(
  email: string,
  domain: string | undefined,
): boolean {
  if (domain === undefined) return false;
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  return (
    email
      .slice(at + 1)
      .trim()
      .toLowerCase() === domain.trim().toLowerCase()
  );
}

/**
 * Verify the BFF-signed operator identity proof (`x-operator-*` headers) for
 * one request, returning the verified operator email, or null for anything
 * short of a fully valid proof. See {@link requireOperator} for the trust
 * model and the canonical payload the BFF signs (forward.ts's
 * operatorSignaturePayload; the platform verifier's _verified_operator_identity is the
 * reference verifier).
 *
 * Scoped to `/admin/*` URLs so the operator flag is never even derived on an
 * ordinary route. Fail-closed on every check: an unconfigured
 * OPERATOR_IDENTITY_SECRET, a missing/blank header, a non-internal email, a
 * stale timestamp, a method/path/account mismatch, a body-hash mismatch, or a
 * bad signature all yield null (→ not an operator).
 */
function verifyOperatorProof(
  request: ResolvableRequest,
  config: Config,
  accountId: string,
): string | null {
  const path = request.url.split("?")[0]!;
  if (!path.startsWith("/admin/")) return null;

  const email = headerValue(request, "x-operator-email");
  const verified = headerValue(request, "x-operator-verified");
  const timestampMs = headerValue(request, "x-operator-timestamp");
  const requestTarget = headerValue(request, "x-operator-request-target");
  const bodySha256 = headerValue(
    request,
    "x-operator-body-sha256",
  )?.toLowerCase();
  const signature = headerValue(request, "x-operator-signature")?.toLowerCase();
  const secret = config.OPERATOR_IDENTITY_SECRET;

  if (
    secret === undefined ||
    email === undefined ||
    verified !== "true" ||
    timestampMs === undefined ||
    requestTarget === undefined ||
    bodySha256 === undefined ||
    signature === undefined
  ) {
    return null;
  }

  if (!isInternalOperatorEmail(email, config.OPERATOR_EMAIL_DOMAIN))
    return null;

  // Freshness: the signed ms-epoch timestamp must be within the replay window.
  if (!/^\d+$/.test(timestampMs)) return null;
  if (
    Math.abs(Date.now() - Number(timestampMs)) >
    OPERATOR_SIGNATURE_MAX_AGE_SECONDS * 1000
  ) {
    return null;
  }

  // Path binding: the BFF signs the final upstream path it calls, so a proof
  // replayed onto a different route never matches. The hub is mounted at the
  // root, so this is exact equality against the request's own path.
  if (requestTarget !== path) return null;

  // Body binding. resolveTenant runs in the onRequest hook, BEFORE body
  // parsing, so the raw body is not available here — but every /admin/* route
  // is a bodyless GET (the BFF signs "" for GET/HEAD, whose bodies it drops).
  // Fail closed for any body-carrying method rather than skip the check.
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  if (!timingSafeCompare(bodySha256, sha256Hex(""))) return null;

  // Signature over the exact canonical payload the BFF signs (forward.ts).
  const payload = [
    OPERATOR_SIGNATURE_VERSION,
    timestampMs,
    method,
    requestTarget,
    accountId,
    email,
    "true",
    bodySha256,
  ].join("\n");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(payload, "utf8")
    .digest("hex");
  if (!timingSafeCompare(signature, expected)) return null;

  return email;
}

// ---------------------------------------------------------------------------
// Rate limiting — in-memory token bucket
// ---------------------------------------------------------------------------

// TODO(operational hardening): in-memory only — pending a shared-store upgrade.
//
// A coarse per-credential token bucket to blunt brute-force / runaway clients.
// Keyed by api_tokens.id on the agent path and by accountId on the browser
// path (the two identities that survive a single failed credential). Self-host
// TEAM_TOKEN is intentionally not limited (operator-trusted, single team).
// Single-instance Map; resets on process restart. Replace with a shared store
// (Redis) when the hub runs multi-replica.

/** Tokens added back per window. Small fixed allowance per the design (§4.6). */
const RATE_LIMIT_CAPACITY = 60;
/** The refill window, in milliseconds. */
const RATE_LIMIT_WINDOW_MS = 60_000;

interface Bucket {
  tokens: number;
  /** Last time (ms epoch) the bucket was refilled. */
  updatedAt: number;
}

// TODO(operational hardening): never evicted — grows by one entry per distinct key (api_tokens.id
// or accountId) for the process lifetime, bounded by the real account/token id
// space, and resets on restart. Bounded eviction lands with that shared store.
const buckets = new Map<string, Bucket>();

/**
 * Consume one token for `key`, refilling continuously at
 * CAPACITY/WINDOW per ms. Throws AuthError 429 when the bucket is empty.
 * `now` is injectable for tests; defaults to the wall clock.
 */
function consumeRateLimit(key: string, now: number = Date.now()): void {
  const refillPerMs = RATE_LIMIT_CAPACITY / RATE_LIMIT_WINDOW_MS;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_CAPACITY, updatedAt: now };
    buckets.set(key, bucket);
  } else {
    const elapsed = now - bucket.updatedAt;
    if (elapsed > 0) {
      bucket.tokens = Math.min(
        RATE_LIMIT_CAPACITY,
        bucket.tokens + elapsed * refillPerMs,
      );
      bucket.updatedAt = now;
    }
  }
  if (bucket.tokens < 1) {
    throw new AuthError(429, "rate limit exceeded");
  }
  bucket.tokens -= 1;
}

// ---------------------------------------------------------------------------
// Pre-auth failure throttle (per source IP)
// ---------------------------------------------------------------------------

// The per-credential buckets above only engage AFTER a credential resolves,
// and the bearer path costs a DB lookup per attempt — so an unauthenticated
// flood of random bearers used to be uncounted, unbounded DB work. This
// throttle counts FAILED authentications (401s) per source IP; once an IP has
// burned its budget, its requests are rejected up front — before any hashing
// or DB round-trip. Successful auths never consume, so legitimate traffic
// (including many agents behind one NAT) is unaffected unless the shared IP
// is actively spraying bad credentials.
//
// Same single-instance/in-memory caveats as the buckets above. Additionally
// the map IS bounded (unlike the per-credential maps, its key space is
// attacker-controlled): past MAX_TRACKED_IPS we sweep fully-refilled (idle)
// entries, and if the sweep can't shrink it (an attacker rotating source
// IPs), we clear the map — degrading to the pre-throttle baseline rather
// than exhausting memory.

/** Failed auths allowed per IP per window before up-front 429s. */
const PREAUTH_FAIL_CAPACITY = 30;
/** The refill window for failed-auth budgets, in milliseconds. */
const PREAUTH_FAIL_WINDOW_MS = 60_000;
/** Hard bound on distinct IPs tracked at once. */
const MAX_TRACKED_IPS = 10_000;

const preauthFailures = new Map<string, Bucket>();

function refillPreauthBucket(bucket: Bucket, now: number): void {
  const refillPerMs = PREAUTH_FAIL_CAPACITY / PREAUTH_FAIL_WINDOW_MS;
  const elapsed = now - bucket.updatedAt;
  if (elapsed > 0) {
    bucket.tokens = Math.min(
      PREAUTH_FAIL_CAPACITY,
      bucket.tokens + elapsed * refillPerMs,
    );
    bucket.updatedAt = now;
  }
}

/**
 * Throw 429 when `ip` has exhausted its failed-auth budget. Read-only apart
 * from the refill — checking never consumes, only {@link recordAuthFailure}
 * does, so an IP that stops failing recovers at CAPACITY/WINDOW.
 */
function assertPreauthBudget(ip: string, now: number = Date.now()): void {
  const bucket = preauthFailures.get(ip);
  if (bucket === undefined) return;
  refillPreauthBucket(bucket, now);
  if (bucket.tokens < 1) {
    throw new AuthError(
      429,
      "too many failed authentications from this address",
    );
  }
}

/** Consume one failed-auth token for `ip` (called on every 401). */
function recordAuthFailure(ip: string, now: number = Date.now()): void {
  let bucket = preauthFailures.get(ip);
  if (bucket === undefined) {
    if (preauthFailures.size >= MAX_TRACKED_IPS) {
      for (const [key, b] of preauthFailures) {
        refillPreauthBucket(b, now);
        if (b.tokens >= PREAUTH_FAIL_CAPACITY) preauthFailures.delete(key);
      }
      if (preauthFailures.size >= MAX_TRACKED_IPS) preauthFailures.clear();
    }
    bucket = { tokens: PREAUTH_FAIL_CAPACITY, updatedAt: now };
    preauthFailures.set(ip, bucket);
  } else {
    refillPreauthBucket(bucket, now);
  }
  bucket.tokens = Math.max(0, bucket.tokens - 1);
}

// ---------------------------------------------------------------------------
// Hot-path write throttles
// ---------------------------------------------------------------------------

// The agent hot path (work/sync/heartbeat fire every few seconds per session)
// and the browser path otherwise issue a DB WRITE on EVERY authenticated
// request: touchApiTokenLastUsed (last_used_at liveness) and upsertAccountProfile
// (the BFF profile snapshot). Neither feeds an auth DECISION — both are
// best-effort freshness — so we throttle each to at most one write per key per
// window, collapsing the steady-state hot path to just the reads the auth
// decision actually needs. Single-instance Maps, same assumption as the rate
// limiter above: they reset on restart, and a skipped write simply lands on the
// next un-throttled request.
//
// We deliberately do NOT cache the token→tenant LOOKUP itself.
// findApiTokenByHash + findMembership ARE the security decision — and the
// fail-closed membership check on the agent path depends on reading LIVE
// membership — so caching them would reintroduce exactly the revocation
// staleness that check closes. Only the non-decision writes are throttled.

/** Minimum gap between repeated last_used_at / profile writes for the same key. */
const HOT_PATH_WRITE_THROTTLE_MS = 60_000;

// TODO(operational hardening): never evicted — one entry per distinct token id / account id, bounded
// by the id space and reset on restart (mirrors the rate-limiter buckets).
const lastTokenTouch = new Map<string, number>();
const lastProfileUpsert = new Map<string, number>();

/**
 * Record a write for `key` and report whether it should be SKIPPED because the
 * previous write for that key falls inside the throttle window. The first call
 * for a key (and the first after the window lapses) always returns false (write),
 * so liveness/profile freshness is never indefinitely starved.
 */
function throttleWrite(
  seen: Map<string, number>,
  key: string,
  now: number,
): boolean {
  const last = seen.get(key);
  if (last !== undefined && now - last < HOT_PATH_WRITE_THROTTLE_MS) {
    return true; // skip — written recently
  }
  seen.set(key, now);
  return false;
}

/**
 * Test-only: clear all in-memory per-credential state — the rate-limit buckets
 * AND the hot-path write throttles — so each test starts fresh (e.g. a test
 * that asserts last_used_at moves, or that the profile is upserted, on the very
 * first request after a reset).
 */
export function __resetRateLimiter(): void {
  buckets.clear();
  preauthFailures.clear();
  lastTokenTouch.clear();
  lastProfileUpsert.clear();
}

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

/**
 * The minimal slice of a Fastify request resolveTenant reads. Declared
 * structurally so tests can pass a plain `{ headers, url, method }` object.
 */
interface ResolvableRequest {
  headers: Record<string, string | string[] | undefined>;
  url: string;
  method: string;
  /**
   * Source address for the pre-auth failure throttle (Fastify's request.ip —
   * XFF-derived when trustProxy is on). Optional so test fakes stay minimal;
   * absent values share one "unknown" bucket.
   */
  ip?: string;
}

/** First value of a (possibly array-valued) header, trimmed; undefined if absent/empty. */
function headerValue(req: ResolvableRequest, name: string): string | undefined {
  const raw = req.headers[name];
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v === undefined) return undefined;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Extract the `:id` segment of a `/workspaces/:id/...` route, or null when the
 * route is not workspace-scoped (e.g. `/workspaces`, `/workspaces/`, or a
 * non-/workspaces path). The id is whatever sits in that segment — membership
 * lookup validates it, so a bogus value simply fails the membership check.
 */
function routeWorkspaceId(url: string): string | null {
  const path = url.split("?")[0]!;
  const segments = path.split("/").filter((s) => s.length > 0);
  // ["workspaces", ":id", ...] — need at least the id segment present.
  if (segments[0] === "workspaces" && segments.length >= 2) {
    return decodeURIComponent(segments[1]!);
  }
  return null;
}

// ---------------------------------------------------------------------------
// resolveTenant
// ---------------------------------------------------------------------------

/**
 * Resolve a request to a {@link TenantContext} from exactly ONE credential.
 * Throws {@link AuthError} (with an internal-only message and an HTTP status)
 * on any failure. See the module header for the resolution order and the
 * TenantContext `workspaceId` contract for the route-derived-workspace rule.
 *
 * Wraps the credential resolution in the pre-auth failure throttle: an IP
 * that has recently burned its failed-auth budget is 429'd BEFORE any header
 * compare, hash, or DB lookup, and every 401 the resolution produces consumes
 * from that budget. Only 401s count — 404/400 come from callers that already
 * authenticated (a matched BFF token or a valid member), and 429 is the
 * per-credential limiter's own signal.
 */
export async function resolveTenant(
  request: ResolvableRequest,
  config: Config,
  pool: pg.Pool,
): Promise<TenantContext> {
  const ip = request.ip ?? "unknown";
  assertPreauthBudget(ip);
  try {
    return await resolveCredentials(request, config, pool);
  } catch (err) {
    if (err instanceof AuthError && err.status === 401) {
      recordAuthFailure(ip);
    }
    throw err;
  }
}

/** The credential resolution itself — see {@link resolveTenant} for the contract. */
async function resolveCredentials(
  request: ResolvableRequest,
  config: Config,
  pool: pg.Pool,
): Promise<TenantContext> {
  const internalToken = headerValue(request, "x-internal-token");

  // --- 1. Browser-via-BFF -------------------------------------------------
  if (internalToken !== undefined) {
    if (!timingSafeCompare(internalToken, config.BFF_INTERNAL_TOKEN)) {
      // An internal token was presented but does NOT match (or BFF mode is
      // unconfigured). Do not fall through to other modes: a presented-but-wrong
      // internal token is a failed BFF call, not an agent/team caller.
      throw new AuthError(401, "internal token mismatch");
    }

    const accountId = headerValue(request, "x-account-id");
    if (accountId === undefined) {
      // A matched internal token with no account is a malformed BFF call.
      throw new AuthError(400, "malformed BFF call: missing x-account-id");
    }

    // Per-account rate limit on the browser path.
    consumeRateLimit(`acct:${accountId}`);

    // Refresh the trusted profile snapshot from the BFF-supplied headers — but at
    // most once per throttle window per account. The snapshot is display
    // metadata, not an auth input, so a slightly stale refresh is harmless; this
    // keeps an unconditional write off every browser request.
    if (!throttleWrite(lastProfileUpsert, accountId, Date.now())) {
      await upsertAccountProfile(pool, {
        accountId,
        displayName: headerValue(request, "x-display-name") ?? null,
        githubLogin: headerValue(request, "x-github-login") ?? null,
        email: headerValue(request, "x-email") ?? null,
        avatarUrl: headerValue(request, "x-avatar-url") ?? null,
      });
    }

    // A verified internal operator: the BFF-signed HMAC proof, re-verified
    // here (never the bare x-operator-verified flag) and derived ONLY on
    // /admin/* URLs. See requireOperator for the trust model.
    const operatorEmail = verifyOperatorProof(request, config, accountId);
    const operatorFields =
      operatorEmail !== null
        ? { operator: true, operatorEmail }
        : { operator: false };

    const workspaceId = routeWorkspaceId(request.url);
    if (workspaceId === null) {
      // Non-:id route: no workspace to validate here. The operation supplies it.
      return {
        workspaceId: NO_ROUTE_WORKSPACE,
        accountId,
        via: "browser",
        ...operatorFields,
      };
    }

    // :id route: the caller must be a member of THIS workspace. A missing
    // membership is reported as 404 — never reveal whether the workspace exists.
    const membership = await findMembership(pool, accountId, workspaceId);
    if (membership === null) {
      throw new AuthError(404, "not a member of the requested workspace");
    }
    return {
      workspaceId,
      accountId,
      role: membership.role,
      via: "browser",
      ...operatorFields,
    };
  }

  // --- 2 & 3. Bearer token ------------------------------------------------
  const authHeader = headerValue(request, "authorization");
  if (authHeader === undefined || !authHeader.startsWith("Bearer ")) {
    throw new AuthError(401, "missing bearer credential");
  }
  const bearer = authHeader.slice("Bearer ".length).trim();

  // 2. Agent/API token. We try the api_tokens table for ANY bearer (the token
  //    format `shp_…` is a convention, not a gate — we hash and look up). A hit
  //    that is non-revoked resolves the tenant. Per the design, the agent token
  //    is checked BEFORE the team token: we look up the hash first, and only on
  //    a miss fall through to the TEAM_TOKEN check (step 3) below.
  const tokenHash = hashToken(bearer);
  const tokenRow = await findApiTokenByHash(pool, tokenHash);
  if (tokenRow !== null) {
    // Per-token rate limit on the agent path — applies to BOTH token kinds.
    consumeRateLimit(`tok:${tokenRow.id}`);
    // last_used_at is best-effort liveness — throttle it off the hot path.
    // Also common to both kinds, so it happens before we branch on scope.
    if (!throttleWrite(lastTokenTouch, tokenRow.id, Date.now())) {
      await touchApiTokenLastUsed(pool, tokenRow.id);
    }

    if (tokenRow.workspace_id === null) {
      // ACCOUNT-scoped token (migration 015): bound to an account, not a single
      // workspace. There is no route workspace to validate here — resolve to the
      // NO_ROUTE_WORKSPACE sentinel carrying only the accountId, exactly like the
      // browser non-`:id` path. The operation layer supplies the concrete
      // workspace and authorizes membership per request (later tasks). We do NOT
      // call findMembership: there is no workspace yet to check against.
      return {
        workspaceId: NO_ROUTE_WORKSPACE,
        accountId: tokenRow.account_id,
        via: "agent",
      };
    }

    // WORKSPACE-scoped token: the caller must still be a LIVE member of the
    // token's workspace.
    const membership = await findMembership(
      pool,
      tokenRow.account_id,
      tokenRow.workspace_id,
    );
    if (membership === null) {
      // Fail closed: the token authenticates, but its account is no longer
      // a member of the token's workspace. It is the MEMBERSHIP — not the token —
      // that grants workspace access, so a token whose membership has lapsed must
      // NOT resolve. removeMember/leaveWorkspace also revoke a member's tokens in
      // the same transaction (so this is normally unreachable), but gating on the
      // LIVE membership is the actual invariant — the token is just one way to
      // present it. 401 rather than the browser path's 404: the caller holds a
      // real token naming its OWN workspace, so there is no cross-workspace
      // existence to hide here — this is a plain authentication failure.
      throw new AuthError(
        401,
        "token account is no longer a member of its workspace",
      );
    }
    return {
      workspaceId: tokenRow.workspace_id,
      accountId: tokenRow.account_id,
      role: membership.role,
      via: "agent",
    };
  }

  // 3. Self-host TEAM_TOKEN. Constant-time compare; unconfigured TEAM_TOKEN
  //    never matches. Scope is the single ALLOWED_WORKSPACE, looked up by slug.
  if (timingSafeCompare(bearer, config.TEAM_TOKEN)) {
    const slug = config.ALLOWED_WORKSPACE;
    const ws =
      slug !== undefined ? await findWorkspaceBySlug(pool, slug) : null;
    if (ws === null) {
      // The team token is valid but its workspace was never seeded (boot seeds
      // it on startup). Treat as a server-misconfiguration auth failure.
      throw new AuthError(401, "self-host workspace not provisioned");
    }
    // Full access, no per-account identity.
    return { workspaceId: ws.id, via: "team" };
  }

  // --- 4. Nothing matched -------------------------------------------------
  throw new AuthError(401, "invalid credential");
}
