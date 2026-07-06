/**
 * Tests for packages/hub/src/tenant.ts — resolveTenant().
 *
 * SECURITY-CRITICAL. resolveTenant() reduces every request to exactly ONE of
 * three credential inputs and produces a TenantContext. These tests pin the
 * resolution order, the membership/isolation guards, and the rate limiter.
 *
 * DB-backed: gated on `dbAvailable`. We seed workspaces / memberships /
 * api_tokens / account_profiles via direct SQL (the migration 011 tables) and
 * drive resolveTenant with minimal fake `{ headers, url, method }` request
 * objects — resolveTenant only reads those three fields off the request.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  beforeEach,
} from "vitest";
import crypto from "crypto";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  runTestMigrations,
  truncateAll,
  truncateTenancy,
} from "./setup.js";
import {
  resolveTenant,
  hashToken,
  requireOperator,
  __resetRateLimiter,
  type TenantContext,
} from "../src/tenant.js";
import { AuthError } from "../src/errors.js";
import type { Config } from "../src/config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEAM_TOKEN = "self-host-team-token";
const BFF_INTERNAL_TOKEN = "bff-internal-secret";
const OPERATOR_IDENTITY_SECRET = "operator-identity-secret";
const ALLOWED_WORKSPACE = "default";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_URL: "postgres://localhost/test",
    TEAM_TOKEN,
    HUB_PORT: 8080,
    ALLOWED_WORKSPACE,
    BFF_INTERNAL_TOKEN,
    OPERATOR_IDENTITY_SECRET,
    DEFAULT_TTL_SECONDS: 1800,
    MIN_TTL_SECONDS: 30,
    STALE_AFTER_SECONDS: 120,
    CHANGE_RECORD_TTL_SECONDS: 604800,
    HUB_ADMIN_LABEL: "admin",
    ...overrides,
  } as Config;
}

/**
 * Build the BFF-signed operator identity headers exactly as the platform's
 * forwardToUpstream does (versioned HMAC-SHA256 over
 * version/timestamp/method/path/accountId/email/verified-flag/body-hash), so
 * the tests exercise the REAL verification path in resolveTenant.
 */
function signedOperatorHeaders(opts: {
  accountId: string;
  email?: string;
  method?: string;
  path?: string;
  secret?: string;
  body?: string;
}): Record<string, string> {
  const email = opts.email ?? "operator@korsoai.com";
  const method = (opts.method ?? "GET").toUpperCase();
  const path = opts.path ?? "/admin/analytics";
  const timestampMs = Date.now().toString();
  const bodySha256 = crypto
    .createHash("sha256")
    .update(opts.body ?? "", "utf8")
    .digest("hex");
  const payload = [
    "v1",
    timestampMs,
    method,
    path,
    opts.accountId,
    email,
    "true",
    bodySha256,
  ].join("\n");
  const signature = crypto
    .createHmac("sha256", opts.secret ?? OPERATOR_IDENTITY_SECRET)
    .update(payload, "utf8")
    .digest("hex");
  return {
    "x-operator-email": email,
    "x-operator-verified": "true",
    "x-operator-timestamp": timestampMs,
    "x-operator-request-target": path,
    "x-operator-body-sha256": bodySha256,
    "x-operator-signature": signature,
  };
}

/** Minimal fake request: resolveTenant only reads headers, url, method. */
function fakeRequest(opts: {
  headers?: Record<string, string | undefined>;
  url?: string;
  method?: string;
}): { headers: Record<string, string | undefined>; url: string; method: string } {
  return {
    headers: opts.headers ?? {},
    url: opts.url ?? "/work",
    method: opts.method ?? "POST",
  };
}

// Seed a workspace and return its id.
async function seedWorkspace(
  pool: pg.Pool,
  slug: string,
  createdBy = "seed-account"
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [slug, slug, createdBy]
  );
  return rows[0]!.id;
}

async function seedMembership(
  pool: pg.Pool,
  accountId: string,
  workspaceId: string,
  role: "admin" | "member"
): Promise<void> {
  await pool.query(
    `INSERT INTO memberships (account_id, workspace_id, role) VALUES ($1, $2, $3)`,
    [accountId, workspaceId, role]
  );
}

async function seedApiToken(
  pool: pg.Pool,
  opts: {
    plaintext: string;
    accountId: string;
    /** null → an ACCOUNT-scoped token (migration 015 dropped the NOT NULL). */
    workspaceId: string | null;
    revoked?: boolean;
  }
): Promise<string> {
  const tokenHash = hashToken(opts.plaintext);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO api_tokens (account_id, workspace_id, token_hash, name, revoked_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [
      opts.accountId,
      opts.workspaceId,
      tokenHash,
      "test-token",
      opts.revoked ? new Date() : null,
    ]
  );
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)("resolveTenant", () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    pool = createTestPool();
    await runTestMigrations(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(() => {
    __resetRateLimiter();
  });

  afterEach(async () => {
    // Clear coordination first (FK children of workspaces), then the tenancy
    // tables this suite owns.
    await truncateAll(pool);
    await truncateTenancy(pool);
  });

  // -------------------------------------------------------------------------
  // Browser-via-BFF (x-internal-token) happy path
  // -------------------------------------------------------------------------

  it("browser happy: valid internal token + account, member of route workspace", async () => {
    const wsId = await seedWorkspace(pool, "acme");
    const accountId = "gh:12345";
    await seedMembership(pool, accountId, wsId, "member");

    const req = fakeRequest({
      headers: {
        "x-internal-token": BFF_INTERNAL_TOKEN,
        "x-account-id": accountId,
        "x-display-name": "Ada Lovelace",
        "x-github-login": "ada",
        "x-email": "ada@example.com",
        "x-avatar-url": "https://example.com/ada.png",
      },
      url: `/workspaces/${wsId}/landscape`,
      method: "GET",
    });

    const ctx = await resolveTenant(req as any, makeConfig(), pool);

    expect(ctx.workspaceId).toBe(wsId);
    expect(ctx.accountId).toBe(accountId);
    expect(ctx.role).toBe("member");
    expect(ctx.via).toBe("browser");

    // account_profiles upserted with all five trusted-header fields.
    const { rows } = await pool.query(
      `SELECT account_id, display_name, github_login, email, avatar_url
       FROM account_profiles WHERE account_id = $1`,
      [accountId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      account_id: accountId,
      display_name: "Ada Lovelace",
      github_login: "ada",
      email: "ada@example.com",
      avatar_url: "https://example.com/ada.png",
    });
  });

  it("browser on a non-:id route: account set, workspaceId left as sentinel", async () => {
    const accountId = "gh:777";

    const req = fakeRequest({
      headers: {
        "x-internal-token": BFF_INTERNAL_TOKEN,
        "x-account-id": accountId,
      },
      url: `/workspaces`,
      method: "POST",
    });

    const ctx = await resolveTenant(req as any, makeConfig(), pool);
    expect(ctx.accountId).toBe(accountId);
    // No route workspace → operation layer supplies it; sentinel is "".
    expect(ctx.workspaceId).toBe("");
    expect(ctx.role).toBeUndefined();
    // No operator header on an ordinary browser call → not an operator.
    expect(ctx.operator).not.toBe(true);
  });

  it("browser with a VALID signed operator proof → tenant.operator is true", async () => {
    const accountId = "gh:op";

    const req = fakeRequest({
      headers: {
        "x-internal-token": BFF_INTERNAL_TOKEN,
        "x-account-id": accountId,
        ...signedOperatorHeaders({ accountId }),
      },
      url: `/admin/analytics`,
      method: "GET",
    });

    const ctx = await resolveTenant(req as any, makeConfig(), pool);
    expect(ctx.via).toBe("browser");
    expect(ctx.operator).toBe(true);
    expect(ctx.operatorEmail).toBe("operator@korsoai.com");
  });

  it("browser with a BARE x-operator-verified: true (no HMAC proof) → NOT an operator", async () => {
    // The pre-HMAC trust model: a flag riding the internal token alone. It must
    // no longer verify — the signed proof is the only path to tenant.operator.
    const accountId = "gh:notop";

    const req = fakeRequest({
      headers: {
        "x-internal-token": BFF_INTERNAL_TOKEN,
        "x-account-id": accountId,
        "x-operator-verified": "true",
      },
      url: `/admin/analytics`,
      method: "GET",
    });

    const ctx = await resolveTenant(req as any, makeConfig(), pool);
    expect(ctx.operator).not.toBe(true);
  });

  it("browser with a FORGED operator signature → NOT an operator", async () => {
    const accountId = "gh:forged";

    const req = fakeRequest({
      headers: {
        "x-internal-token": BFF_INTERNAL_TOKEN,
        "x-account-id": accountId,
        ...signedOperatorHeaders({ accountId, secret: "not-the-operator-secret" }),
      },
      url: `/admin/analytics`,
      method: "GET",
    });

    const ctx = await resolveTenant(req as any, makeConfig(), pool);
    expect(ctx.operator).not.toBe(true);
  });

  it("valid proof but a NON-internal operator email → NOT an operator", async () => {
    const accountId = "gh:external";

    const req = fakeRequest({
      headers: {
        "x-internal-token": BFF_INTERNAL_TOKEN,
        "x-account-id": accountId,
        // Correctly signed — but for a lookalike domain, so the exact-domain
        // email check must reject it regardless of the valid signature.
        ...signedOperatorHeaders({ accountId, email: "op@korsoai.com.evil.com" }),
      },
      url: `/admin/analytics`,
      method: "GET",
    });

    const ctx = await resolveTenant(req as any, makeConfig(), pool);
    expect(ctx.operator).not.toBe(true);
  });

  it("valid proof but OPERATOR_IDENTITY_SECRET unconfigured → NOT an operator (fail closed)", async () => {
    const accountId = "gh:nosecret";

    const req = fakeRequest({
      headers: {
        "x-internal-token": BFF_INTERNAL_TOKEN,
        "x-account-id": accountId,
        ...signedOperatorHeaders({ accountId }),
      },
      url: `/admin/analytics`,
      method: "GET",
    });

    const cfg = makeConfig({ OPERATOR_IDENTITY_SECRET: undefined });
    const ctx = await resolveTenant(req as any, cfg, pool);
    expect(ctx.operator).not.toBe(true);
  });

  it("valid proof on a NON-/admin route → NOT an operator (flag never derived there)", async () => {
    const accountId = "gh:offroute";

    const req = fakeRequest({
      headers: {
        "x-internal-token": BFF_INTERNAL_TOKEN,
        "x-account-id": accountId,
        ...signedOperatorHeaders({ accountId, path: "/workspaces" }),
      },
      url: `/workspaces`,
      method: "GET",
    });

    const ctx = await resolveTenant(req as any, makeConfig(), pool);
    expect(ctx.operator).not.toBe(true);
  });

  it("proof signed for a DIFFERENT path → NOT an operator (path binding)", async () => {
    const accountId = "gh:replay";

    const req = fakeRequest({
      headers: {
        "x-internal-token": BFF_INTERNAL_TOKEN,
        "x-account-id": accountId,
        // Signed for another admin route; replayed onto /admin/analytics.
        ...signedOperatorHeaders({ accountId, path: "/admin/other" }),
      },
      url: `/admin/analytics`,
      method: "GET",
    });

    const ctx = await resolveTenant(req as any, makeConfig(), pool);
    expect(ctx.operator).not.toBe(true);
  });

  it("browser member-of-A hitting /workspaces/<B>/... → AuthError 404", async () => {
    const wsA = await seedWorkspace(pool, "alpha");
    const wsB = await seedWorkspace(pool, "bravo");
    const accountId = "gh:42";
    await seedMembership(pool, accountId, wsA, "member"); // member of A only

    const req = fakeRequest({
      headers: {
        "x-internal-token": BFF_INTERNAL_TOKEN,
        "x-account-id": accountId,
      },
      url: `/workspaces/${wsB}/landscape`,
      method: "GET",
    });

    await expect(resolveTenant(req as any, makeConfig(), pool)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("browser with internal token but NO x-account-id → AuthError 400", async () => {
    const req = fakeRequest({
      headers: { "x-internal-token": BFF_INTERNAL_TOKEN },
      url: `/workspaces`,
      method: "POST",
    });
    await expect(resolveTenant(req as any, makeConfig(), pool)).rejects.toMatchObject({
      status: 400,
    });
  });

  // -------------------------------------------------------------------------
  // HARD RULE: a client can never assert an account
  // -------------------------------------------------------------------------

  it("x-account-id with NO internal token → ignored, falls through to 401", async () => {
    const req = fakeRequest({
      headers: { "x-account-id": "gh:impersonate" },
      url: `/work`,
      method: "POST",
    });
    await expect(resolveTenant(req as any, makeConfig(), pool)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("x-account-id with WRONG internal token → rejected (cannot assert account)", async () => {
    const req = fakeRequest({
      headers: {
        "x-internal-token": "not-the-bff-secret",
        "x-account-id": "gh:impersonate",
      },
      url: `/work`,
      method: "POST",
    });
    // Wrong internal token is not a match → header is ignored → 401.
    await expect(resolveTenant(req as any, makeConfig(), pool)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("internal token presented but BFF_INTERNAL_TOKEN unset in config → no match → 401", async () => {
    const req = fakeRequest({
      headers: {
        "x-internal-token": "anything",
        "x-account-id": "gh:x",
      },
      url: `/work`,
      method: "POST",
    });
    const cfg = makeConfig({ BFF_INTERNAL_TOKEN: undefined });
    await expect(resolveTenant(req as any, cfg, pool)).rejects.toMatchObject({
      status: 401,
    });
  });

  // -------------------------------------------------------------------------
  // Agent token (Bearer shp_…) happy path
  // -------------------------------------------------------------------------

  it("agent happy: valid shp_ token → account+workspace from row, last_used_at moves", async () => {
    const wsId = await seedWorkspace(pool, "acme");
    const accountId = "gh:agent-owner";
    await seedMembership(pool, accountId, wsId, "admin");
    const plaintext = "shp_live_token_abc";
    const tokenId = await seedApiToken(pool, { plaintext, accountId, workspaceId: wsId });

    const before = await pool.query<{ last_used_at: Date | null }>(
      `SELECT last_used_at FROM api_tokens WHERE id = $1`,
      [tokenId]
    );
    expect(before.rows[0]!.last_used_at).toBeNull();

    const req = fakeRequest({
      headers: { authorization: `Bearer ${plaintext}` },
      url: `/work`,
      method: "POST",
    });

    const ctx = await resolveTenant(req as any, makeConfig(), pool);
    expect(ctx.accountId).toBe(accountId);
    expect(ctx.workspaceId).toBe(wsId);
    expect(ctx.role).toBe("admin");
    expect(ctx.via).toBe("agent");

    const after = await pool.query<{ last_used_at: Date | null }>(
      `SELECT last_used_at FROM api_tokens WHERE id = $1`,
      [tokenId]
    );
    expect(after.rows[0]!.last_used_at).not.toBeNull();
  });

  it("account-scoped token (workspace_id NULL) → {workspaceId:'', accountId}, via agent, no role, NO membership gate", async () => {
    // An ACCOUNT-scoped token is bound to an account, not a workspace (migration
    // 015 dropped the NOT NULL). It must resolve to the NO_ROUTE_WORKSPACE
    // sentinel carrying only the accountId — the operation layer supplies and
    // authorizes the concrete workspace per request. Crucially: NO membership is
    // seeded, and resolution still succeeds — proving there is no membership gate
    // at resolve time for this token kind (unlike the workspace-scoped path).
    const accountId = "gh:account-scoped-owner";
    const plaintext = "shp_account_scoped_token";
    await seedApiToken(pool, { plaintext, accountId, workspaceId: null });

    const req = fakeRequest({
      headers: { authorization: `Bearer ${plaintext}` },
      url: `/work`,
      method: "POST",
    });

    const ctx = await resolveTenant(req as any, makeConfig(), pool);
    expect(ctx.workspaceId).toBe(""); // NO_ROUTE_WORKSPACE sentinel
    expect(ctx.accountId).toBe(accountId);
    expect(ctx.role).toBeUndefined();
    expect(ctx.via).toBe("agent");
  });

  it("account-scoped token: accountId comes from the stored row, never a header", async () => {
    // Isolation: an account-scoped token carries its accountId from the api_tokens
    // row, not from any client-supplied header. A stray x-account-id (which only
    // the BFF may assert, alongside a valid x-internal-token) must NOT override it.
    const accountId = "gh:row-account";
    const plaintext = "shp_row_account_token";
    await seedApiToken(pool, { plaintext, accountId, workspaceId: null });

    const req = fakeRequest({
      headers: {
        authorization: `Bearer ${plaintext}`,
        "x-account-id": "gh:attacker-header",
      },
      url: `/work`,
      method: "POST",
    });

    const ctx = await resolveTenant(req as any, makeConfig(), pool);
    expect(ctx.accountId).toBe(accountId); // from the row, not the header
    expect(ctx.via).toBe("agent");
  });

  it("revoked shp_ token → AuthError 401", async () => {
    const wsId = await seedWorkspace(pool, "acme");
    const accountId = "gh:revoked-owner";
    const plaintext = "shp_revoked_token";
    await seedApiToken(pool, { plaintext, accountId, workspaceId: wsId, revoked: true });

    const req = fakeRequest({
      headers: { authorization: `Bearer ${plaintext}` },
      url: `/work`,
      method: "POST",
    });
    await expect(resolveTenant(req as any, makeConfig(), pool)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("unknown shp_ token → AuthError 401", async () => {
    const req = fakeRequest({
      headers: { authorization: `Bearer shp_does_not_exist` },
      url: `/work`,
      method: "POST",
    });
    await expect(resolveTenant(req as any, makeConfig(), pool)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("valid shp_ token whose account is NOT a member of its workspace → 401 (fail-closed, P2.4)", async () => {
    // An orphaned token: the api_tokens row resolves (non-revoked), but there is
    // NO membership row for (account, workspace). It is the membership — not the
    // token — that grants access, so this must fail closed rather than resolve a
    // memberless tenant with role undefined.
    const wsId = await seedWorkspace(pool, "acme");
    const accountId = "gh:orphaned-owner";
    const plaintext = "shp_orphaned_token";
    await seedApiToken(pool, { plaintext, accountId, workspaceId: wsId }); // no seedMembership

    const req = fakeRequest({
      headers: { authorization: `Bearer ${plaintext}` },
      url: `/work`,
      method: "POST",
    });
    await expect(resolveTenant(req as any, makeConfig(), pool)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("agent path: a second request inside the throttle window does NOT re-write last_used_at (P2.6)", async () => {
    const wsId = await seedWorkspace(pool, "acme");
    const accountId = "gh:throttle-owner";
    await seedMembership(pool, accountId, wsId, "member");
    const plaintext = "shp_throttle_token";
    const tokenId = await seedApiToken(pool, { plaintext, accountId, workspaceId: wsId });

    const req = () =>
      resolveTenant(
        fakeRequest({
          headers: { authorization: `Bearer ${plaintext}` },
          url: `/work`,
          method: "POST",
        }) as any,
        makeConfig(),
        pool
      );

    // First request touches last_used_at (the throttle's first call always writes).
    await req();
    const first = await pool.query<{ last_used_at: Date | null }>(
      `SELECT last_used_at FROM api_tokens WHERE id = $1`,
      [tokenId]
    );
    expect(first.rows[0]!.last_used_at).not.toBeNull();

    // Second request inside the 60s window must SKIP the write — the timestamp is
    // unchanged (not merely "still non-null"): exact equality pins the throttle.
    await req();
    const second = await pool.query<{ last_used_at: Date | null }>(
      `SELECT last_used_at FROM api_tokens WHERE id = $1`,
      [tokenId]
    );
    expect(second.rows[0]!.last_used_at).toEqual(first.rows[0]!.last_used_at);
  });

  // -------------------------------------------------------------------------
  // Self-host (Bearer TEAM_TOKEN) happy path
  // -------------------------------------------------------------------------

  it("self-host happy: valid TEAM_TOKEN → seeded workspaceId, no account/role", async () => {
    const wsId = await seedWorkspace(pool, ALLOWED_WORKSPACE);

    const req = fakeRequest({
      headers: { authorization: `Bearer ${TEAM_TOKEN}` },
      url: `/work`,
      method: "POST",
    });

    const ctx = await resolveTenant(req as any, makeConfig(), pool);
    expect(ctx.workspaceId).toBe(wsId);
    expect(ctx.accountId).toBeUndefined();
    expect(ctx.role).toBeUndefined();
    expect(ctx.via).toBe("team");
  });

  it("TEAM_TOKEN valid but ALLOWED_WORKSPACE slug not seeded → AuthError", async () => {
    // No workspace row for ALLOWED_WORKSPACE.
    const req = fakeRequest({
      headers: { authorization: `Bearer ${TEAM_TOKEN}` },
      url: `/work`,
      method: "POST",
    });
    await expect(resolveTenant(req as any, makeConfig(), pool)).rejects.toBeInstanceOf(
      AuthError
    );
  });

  // -------------------------------------------------------------------------
  // No credential
  // -------------------------------------------------------------------------

  it("no credential at all → AuthError 401", async () => {
    const req = fakeRequest({ headers: {}, url: `/work`, method: "POST" });
    await expect(resolveTenant(req as any, makeConfig(), pool)).rejects.toMatchObject({
      status: 401,
    });
  });

  it("bare wrong Bearer token (neither shp_ nor TEAM_TOKEN) → AuthError 401", async () => {
    const req = fakeRequest({
      headers: { authorization: `Bearer totally-wrong` },
      url: `/work`,
      method: "POST",
    });
    await expect(resolveTenant(req as any, makeConfig(), pool)).rejects.toMatchObject({
      status: 401,
    });
  });

  // -------------------------------------------------------------------------
  // Rate limit (token bucket → 429 on burst)
  // -------------------------------------------------------------------------

  it("agent path: burst beyond bucket allowance → AuthError 429", async () => {
    const wsId = await seedWorkspace(pool, "acme");
    const accountId = "gh:ratelimited";
    await seedMembership(pool, accountId, wsId, "member");
    const plaintext = "shp_burst_token";
    await seedApiToken(pool, { plaintext, accountId, workspaceId: wsId });

    const req = () =>
      resolveTenant(
        fakeRequest({
          headers: { authorization: `Bearer ${plaintext}` },
          url: `/work`,
          method: "POST",
        }) as any,
        makeConfig(),
        pool
      );

    // Hammer the same token. Within a single window the bucket must exhaust and
    // start throwing 429. We don't pin the exact allowance — just that a large
    // burst eventually yields a 429.
    let saw429 = false;
    for (let i = 0; i < 200; i++) {
      try {
        await req();
      } catch (err) {
        if (err instanceof AuthError && err.status === 429) {
          saw429 = true;
          break;
        }
        throw err; // any non-429 error is a real failure
      }
    }
    expect(saw429).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// hashToken — pure unit (no DB) so it runs even without Postgres.
// ---------------------------------------------------------------------------

describe("hashToken", () => {
  it("is a stable hex SHA-256 of the plaintext", () => {
    const expected = crypto.createHash("sha256").update("shp_x", "utf8").digest("hex");
    expect(hashToken("shp_x")).toBe(expected);
    expect(hashToken("shp_x")).toBe(hashToken("shp_x"));
    expect(hashToken("shp_x")).not.toBe(hashToken("shp_y"));
  });
});

// ---------------------------------------------------------------------------
// requireOperator — pure unit (no DB): the cross-tenant analytics gate.
// See requireOperator in tenant.ts for the trust model.
// ---------------------------------------------------------------------------

describe("requireOperator", () => {
  const browser = (operator?: boolean): TenantContext => ({
    workspaceId: "",
    accountId: "gh:1",
    via: "browser",
    ...(operator === undefined ? {} : { operator }),
  });

  it("passes for a verified operator (via browser, operator === true)", () => {
    expect(() => requireOperator(browser(true))).not.toThrow();
  });

  it("rejects with 403 when operator is false/absent", () => {
    for (const t of [browser(false), browser(undefined)]) {
      expect(() => requireOperator(t)).toThrow(AuthError);
      try {
        requireOperator(t);
      } catch (err) {
        expect((err as AuthError).status).toBe(403);
      }
    }
  });

  it("rejects an agent/team credential even if it somehow carried operator: true", () => {
    // Defense-in-depth: resolveTenant never sets operator off the agent/team
    // branches, but the gate must not rely on that alone — a fabricated
    // non-browser context CARRYING operator: true must still be rejected
    // (requireOperator also requires via === "browser").
    const fabricated: TenantContext[] = [
      { workspaceId: "w1", accountId: "gh:2", via: "agent", operator: true },
      { workspaceId: "w1", via: "team", operator: true },
    ];
    for (const t of fabricated) {
      expect(() => requireOperator(t)).toThrow(AuthError);
      try {
        requireOperator(t);
      } catch (err) {
        expect((err as AuthError).status).toBe(403);
      }
    }
  });
});
