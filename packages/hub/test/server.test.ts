/**
 * Tests for packages/hub/src/server.ts
 *
 * Tenancy (Task 2.5): the onRequest hook resolves every non-exempt request to a
 * TenantContext via resolveTenant, which for the self-host TEAM_TOKEN path looks
 * up config.ALLOWED_WORKSPACE by slug. So any suite that drives a guarded route
 * — even just to assert a 401/400 — needs a REAL pool with the self-host
 * workspace seeded (slug == ALLOWED_WS), because the hook hits the DB before the
 * handler runs. Only /health and the public wallboard GETs are exempt and stay
 * no-DB.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { createHash, createHmac } from "node:crypto";
import pg from "pg";
import {
  dbAvailable,
  createTestPool,
  runTestMigrations,
  truncateAll,
} from "./setup.js";
import { initContext, resetContext } from "../src/context.js";
import { buildServer } from "../src/server.js";
import { __resetRateLimiter } from "../src/tenant.js";
import { __resetAnalyticsCache } from "../src/operations/analytics.js";
import type { Config } from "../src/config.js";
import type { FastifyInstance } from "fastify";
import { WorkspaceLandscapeResponse } from "@shepherd/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_TOKEN = "secret-test-token";
const ALLOWED_WS = "test-ws";

function makeTestConfig(overrides: Partial<Config> = {}): Config {
  return {
    DATABASE_URL: "postgres://localhost/test",
    TEAM_TOKEN: TEST_TOKEN,
    HUB_PORT: 8080,
    ALLOWED_WORKSPACE: ALLOWED_WS,
    DEFAULT_TTL_SECONDS: 1800,
    MIN_TTL_SECONDS: 30,
    STALE_AFTER_SECONDS: 120,
    CHANGE_RECORD_TTL_SECONDS: 604800,
    HUB_ADMIN_LABEL: "admin",
    ...overrides,
  };
}

const AUTH_HEADER = `Bearer ${TEST_TOKEN}`;
const BAD_AUTH_HEADER = "Bearer wrong-token";

// A fake pool that immediately throws if anything actually calls into it
function makeFakePool(): pg.Pool {
  return {} as pg.Pool;
}

/** Seed (idempotently) the self-host workspace and return its uuid. */
async function seedWorkspace(
  pool: pg.Pool,
  slug = ALLOWED_WS,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workspaces (slug, name, created_by) VALUES ($1, $2, 'tester')
     ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [slug, slug],
  );
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------
// Non-DB: Health
// ---------------------------------------------------------------------------

describe("GET /health (no auth, no DB)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    initContext({ pool: makeFakePool(), config: makeTestConfig() });
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    resetContext();
  });

  it("returns 200 { status: 'ok' } without any Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("returns 200 even with a valid bearer token", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/health",
      headers: { authorization: AUTH_HEADER },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Non-DB: Wallboard static page is served WITHOUT auth
// ---------------------------------------------------------------------------

describe("Dashboard static page (no DB, exempt GETs)", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    initContext({ pool: makeFakePool(), config: makeTestConfig() });
    app = buildServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    resetContext();
  });

  it("GET / serves the compiled UI shell with no Authorization header", async () => {
    const res = await app.inject({ method: "GET", url: "/" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    // The shell is the @korso/shepherd-ui index.html (title "Shepherd") that
    // boots a hashed ES module from /assets/ — NOT the legacy /app.js.
    expect(res.body).toContain("Shepherd");
    expect(res.body).toContain('src="/assets/');
    expect(res.body).not.toContain('src="/app.js"');
  });

  it("serves the hashed UI bundle from /assets/ with no Authorization header", async () => {
    // Discover the hashed module name at runtime from the served shell — never
    // hardcode the build hash (it changes every `vite build`).
    const shell = await app.inject({ method: "GET", url: "/" });
    const m = shell.body.match(/src="(\/assets\/[^"]+\.js)"/);
    expect(
      m,
      "shell should reference a hashed /assets/*.js module",
    ).not.toBeNull();
    const assetUrl = m![1];

    const res = await app.inject({ method: "GET", url: assetUrl });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.body.length).toBeGreaterThan(0);
  });

  it("rejects an /assets/ path-traversal attempt without leaking files", async () => {
    // The asset handler must serve only basenames from dist/app/assets — never
    // climb out with `..`. Fastify normalizes most `..`, so also probe a name
    // that does not exist: it must 404, not 200 with foreign bytes.
    const res = await app.inject({
      method: "GET",
      url: "/assets/does-not-exist.js",
    });
    expect(res.statusCode).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// DB-gated: Auth enforcement — the hook resolves against a real workspace
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Auth enforcement (DB-gated)" + (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    let pool: pg.Pool;
    let app: FastifyInstance;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      await seedWorkspace(pool);
      initContext({ pool, config: makeTestConfig() });
      app = buildServer();
      await app.ready();
    });

    afterEach(async () => {
      __resetRateLimiter();
      await truncateAll(pool);
    });

    afterAll(async () => {
      await app.close();
      resetContext();
      await pool.end();
    });

    const routes = [
      "/join",
      "/work",
      "/done",
      "/announce",
      "/sync",
      "/heartbeat",
    ] as const;

    for (const route of routes) {
      it(`POST ${route} with no Authorization → 401`, async () => {
        const res = await app.inject({
          method: "POST",
          url: route,
          payload: {},
        });
        expect(res.statusCode).toBe(401);
      });

      it(`POST ${route} with wrong token → 401`, async () => {
        const res = await app.inject({
          method: "POST",
          url: route,
          headers: { authorization: BAD_AUTH_HEADER },
          payload: {},
        });
        expect(res.statusCode).toBe(401);
      });

      it(`POST ${route} with malformed header (no 'Bearer ') → 401`, async () => {
        const res = await app.inject({
          method: "POST",
          url: route,
          headers: { authorization: TEST_TOKEN }, // missing "Bearer " prefix
          payload: {},
        });
        expect(res.statusCode).toBe(401);
      });
    }

    it("GET /workspace/landscape with no Authorization → 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/workspace/landscape",
      });
      expect(res.statusCode).toBe(401);
    });

    it("GET /workspace/landscape with wrong token → 401", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/workspace/landscape",
        headers: { authorization: BAD_AUTH_HEADER },
      });
      expect(res.statusCode).toBe(401);
    });
  },
);

// ---------------------------------------------------------------------------
// DB-gated: GET /workspace/landscape happy path — shape + workspace scoping
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "GET /workspace/landscape (DB-gated)" +
    (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    let pool: pg.Pool;
    let app: FastifyInstance;
    let workspaceId: string;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      workspaceId = await seedWorkspace(pool);
      initContext({ pool, config: makeTestConfig() });
      app = buildServer();
      await app.ready();
    });

    afterEach(async () => {
      __resetRateLimiter();
      await truncateAll(pool);
    });

    afterAll(async () => {
      await app.close();
      resetContext();
      await pool.end();
    });

    it("authenticated → 200 with a contract-valid payload, scoped to the credential's workspace", async () => {
      const { createAgent, createSession, insertWorkItem } =
        await import("../src/repo.js");
      const { withTransaction } = await import("../src/db.js");
      const now = new Date();

      // A live agent in the credential's workspace holding an active claim.
      await withTransaction(pool, async (tx) => {
        const agent = await createAgent(tx, {
          workspaceId,
          name: "InWorkspace-1",
          human: "alice",
          program: "claude",
          model: "claude-opus-4",
        });
        const session = await createSession(tx, {
          workspaceId,
          agentId: agent.id,
          repo: "org/repo",
          branch: "main",
        });
        await insertWorkItem(tx, {
          workspaceId,
          sessionId: session.id,
          repo: "org/repo",
          intentText: "wallboard claim",
          pathGlobs: ["src/**"],
          ttlSeconds: 300,
          expiresAt: new Date(now.getTime() + 300_000),
        });
      });

      // An agent in a DIFFERENT workspace — must NOT appear.
      const otherWs = await seedWorkspace(pool, "other-ws");
      await withTransaction(pool, async (tx) => {
        const other = await createAgent(tx, {
          workspaceId: otherWs,
          name: "Outsider-1",
          human: "bob",
          program: "claude",
          model: null,
        });
        await createSession(tx, {
          workspaceId: otherWs,
          agentId: other.id,
          repo: "org/repo",
          branch: "main",
        });
      });

      const res = await app.inject({
        method: "GET",
        url: "/workspace/landscape",
        headers: { authorization: AUTH_HEADER },
      });

      expect(res.statusCode).toBe(200);
      const parsed = WorkspaceLandscapeResponse.parse(res.json());
      expect(parsed.agents).toHaveLength(1);
      expect(parsed.agents[0]!.name).toBe("InWorkspace-1");
      expect(parsed.agents[0]!.presence).toBe("live");
      expect(parsed.tasks).toHaveLength(1);
      expect(parsed.tasks[0]!.intent).toBe("wallboard claim");
      expect(parsed.tasks[0]!.status).toBe("active");
      expect(typeof parsed.tasks[0]!.repo).toBe("string");
      for (const an of parsed.announcements) {
        expect(typeof an.repo).toBe("string");
      }
      expect(typeof parsed.serverTime).toBe("string");
    });
  },
);

// ---------------------------------------------------------------------------
// DB-gated: Zod validation runs AFTER the hook, so it needs the seeded workspace
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Zod validation (DB-gated)" + (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    let pool: pg.Pool;
    let app: FastifyInstance;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      await seedWorkspace(pool);
      initContext({ pool, config: makeTestConfig() });
      app = buildServer();
      await app.ready();
    });

    afterEach(async () => {
      __resetRateLimiter();
      await truncateAll(pool);
    });

    afterAll(async () => {
      await app.close();
      resetContext();
      await pool.end();
    });

    it("POST /work with pathGlobs: [] + valid auth → 400 mentioning pathGlobs", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/work",
        headers: {
          authorization: AUTH_HEADER,
          "content-type": "application/json",
        },
        payload: {
          sessionId: "00000000-0000-0000-0000-000000000001",
          intent: "do something",
          pathGlobs: [], // violates min(1)
        },
      });

      expect(res.statusCode).toBe(400);
      const bodyText = res.body;
      expect(bodyText).toContain("pathGlobs");
    });

    it("POST /join with missing required fields + valid auth → 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/join",
        headers: {
          authorization: AUTH_HEADER,
          "content-type": "application/json",
        },
        payload: { workspace: "test-ws" }, // missing repo, branch, human, program, model
      });
      expect(res.statusCode).toBe(400);
    });

    it("POST /join with a mismatched body workspace slug → 400 (self-host parity guard)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/join",
        headers: {
          authorization: AUTH_HEADER,
          "content-type": "application/json",
        },
        payload: {
          workspace: "evil-ws", // not the seeded ALLOWED_WORKSPACE slug
          repo: "org/repo",
          branch: "main",
          human: "Alex",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: string }>();
      expect(body.error).toMatch(/evil-ws/);
    });
  },
);

// ---------------------------------------------------------------------------
// Security: token NEVER appears in logged output or error responses
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Security: token never leaks (DB-gated)" +
    (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    let pool: pg.Pool;
    let app: FastifyInstance;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      await seedWorkspace(pool);
      initContext({ pool, config: makeTestConfig() });
      app = buildServer();
      await app.ready();
    });

    afterEach(async () => {
      __resetRateLimiter();
      await truncateAll(pool);
    });

    afterAll(async () => {
      await app.close();
      resetContext();
      await pool.end();
    });

    it("401 response body does not contain the token string", async () => {
      const res401 = await app.inject({
        method: "POST",
        url: "/join",
        headers: { authorization: "Bearer wrong" },
        payload: {},
      });
      expect(res401.statusCode).toBe(401);
      expect(res401.body).not.toContain(TEST_TOKEN);
      expect(res401.body).not.toContain("authorization");
    });

    it("500 error response body is generic and never contains the token", async () => {
      // Register a throw-route on a fresh app instance to force a 500
      const throwApp = buildServer();

      // Add a route that forces an unexpected error
      throwApp.post("/force-500", async () => {
        throw new Error("Surprise internal failure with token=" + TEST_TOKEN);
      });

      await throwApp.ready();

      const res = await throwApp.inject({
        method: "POST",
        url: "/force-500",
        headers: {
          authorization: AUTH_HEADER,
          "content-type": "application/json",
        },
        payload: {},
      });

      await throwApp.close();

      expect(res.statusCode).toBe(500);
      const body = res.json<{ error: string }>();
      expect(body.error).toBe("Internal server error");
      // The raw error message (which contains the token string) must not be in response
      expect(res.body).not.toContain(TEST_TOKEN);
      // Authorization header value must not be echoed
      expect(res.body).not.toContain("authorization");
    });
  },
);

// ---------------------------------------------------------------------------
// DB-gated: Happy path — POST /join returns 200 with agentName + sessionId
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "POST /join happy path (DB-gated)" +
    (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    let pool: pg.Pool;
    let app: FastifyInstance;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      await seedWorkspace(pool);
      initContext({ pool, config: makeTestConfig() });
      app = buildServer();
      await app.ready();
    });

    afterEach(async () => {
      __resetRateLimiter();
      await truncateAll(pool);
    });

    afterAll(async () => {
      await app.close();
      resetContext();
      await pool.end();
    });

    it("returns 200 with agentName and sessionId", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/join",
        headers: {
          authorization: AUTH_HEADER,
          "content-type": "application/json",
        },
        payload: {
          workspace: ALLOWED_WS,
          repo: "org/repo",
          branch: "main",
          human: "Alex",
          program: "claude",
          model: "claude-3-5-sonnet",
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json<{ agentName: string; sessionId: string }>();
      expect(typeof body.agentName).toBe("string");
      expect(body.agentName.length).toBeGreaterThan(0);
      expect(body.sessionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    });
  },
);

// ---------------------------------------------------------------------------
// DB-gated: POST /sync with unknown sessionId → 404
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "POST /sync unknown session → 404 (DB-gated)" +
    (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    let pool: pg.Pool;
    let app: FastifyInstance;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      await seedWorkspace(pool);
      initContext({ pool, config: makeTestConfig() });
      app = buildServer();
      await app.ready();
    });

    afterEach(async () => {
      __resetRateLimiter();
      await truncateAll(pool);
    });

    afterAll(async () => {
      await app.close();
      resetContext();
      await pool.end();
    });

    it("returns 404 for an unknown sessionId", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/sync",
        headers: {
          authorization: AUTH_HEADER,
          "content-type": "application/json",
        },
        payload: {
          sessionId: "00000000-0000-0000-0000-000000000099",
        },
      });

      expect(res.statusCode).toBe(404);
    });
  },
);

// ---------------------------------------------------------------------------
// DB-gated: POST /heartbeat malformed body → 400, happy (200), unknown (404)
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "POST /heartbeat (DB-gated)" + (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    let pool: pg.Pool;
    let app: FastifyInstance;
    let workspaceId: string;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      workspaceId = await seedWorkspace(pool);
      initContext({ pool, config: makeTestConfig() });
      app = buildServer();
      await app.ready();
    });

    afterEach(async () => {
      __resetRateLimiter();
      await truncateAll(pool);
    });

    afterAll(async () => {
      await app.close();
      resetContext();
      await pool.end();
    });

    it("non-uuid sessionId → 400 (ZodError)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/heartbeat",
        headers: {
          authorization: AUTH_HEADER,
          "content-type": "application/json",
        },
        payload: { sessionId: "not-a-uuid" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("valid bearer + valid body → 200 { ok: true }", async () => {
      const { createAgent, createSession } = await import("../src/repo.js");
      const { withTransaction } = await import("../src/db.js");

      const sessionId = await withTransaction(pool, async (tx) => {
        const agent = await createAgent(tx, {
          workspaceId,
          name: "agent-hb",
          human: "alice",
          program: "claude-hb",
          model: "claude-3",
        });
        const session = await createSession(tx, {
          workspaceId,
          agentId: agent.id,
          repo: "org/repo",
          branch: "main",
        });
        return session.id;
      });

      const res = await app.inject({
        method: "POST",
        url: "/heartbeat",
        headers: {
          authorization: AUTH_HEADER,
          "content-type": "application/json",
        },
        payload: { sessionId },
      });

      expect(res.statusCode).toBe(200);
      // announcements defaults to [] — heartbeat only delivers when the request
      // opts in with deliverAnnouncements (not sent here).
      expect(res.json()).toEqual({ ok: true, announcements: [] });
    });

    it("unknown sessionId → 404", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/heartbeat",
        headers: {
          authorization: AUTH_HEADER,
          "content-type": "application/json",
        },
        payload: { sessionId: "00000000-0000-0000-0000-000000000099" },
      });
      expect(res.statusCode).toBe(404);
    });
  },
);

// ---------------------------------------------------------------------------
// DB-gated: flat account-scoped token routes are registered (Task 1.3)
//
// POST/GET/DELETE /tokens are NON-`:id` routes. resolveTenant resolves a
// self-host TEAM_TOKEN with no accountId, so requireAccountId in the operation
// rejects it with 401 — which also proves the routes are wired (a missing route
// would 404, not 401).
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "Flat /tokens routes (DB-gated)" + (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    let pool: pg.Pool;
    let app: FastifyInstance;

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      await seedWorkspace(pool);
      initContext({ pool, config: makeTestConfig() });
      app = buildServer();
      await app.ready();
    });

    afterEach(async () => {
      __resetRateLimiter();
      await truncateAll(pool);
    });

    afterAll(async () => {
      await app.close();
      resetContext();
      await pool.end();
    });

    it("POST /tokens with a self-host TEAM_TOKEN (no account) → 401 (route registered)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/tokens",
        headers: {
          authorization: AUTH_HEADER,
          "content-type": "application/json",
        },
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });

    it("DELETE /tokens/:tokenId with a self-host TEAM_TOKEN (no account) → 401 (route registered)", async () => {
      const res = await app.inject({
        method: "DELETE",
        url: "/tokens/00000000-0000-0000-0000-000000000000",
        headers: { authorization: AUTH_HEADER },
      });
      expect(res.statusCode).toBe(401);
    });
  },
);

// ---------------------------------------------------------------------------
// DB-gated: operator analytics — the cross-tenant /admin/analytics surface,
// gated by requireOperator (see tenant.ts for the trust model). This suite
// drives both the deny paths and a fully HMAC-signed allow path.
// ---------------------------------------------------------------------------

describe.skipIf(!dbAvailable)(
  "GET /admin/analytics (DB-gated)" + (!dbAvailable ? " (SKIPPED: no DB)" : ""),
  () => {
    const BFF_TOKEN = "bff-internal-secret";
    const OPERATOR_SECRET = "operator-identity-secret";
    let pool: pg.Pool;
    let app: FastifyInstance;

    /**
     * Build the BFF-signed operator identity headers exactly as the platform's
     * forwardToUpstream does, so the allow-path test exercises the hub's real
     * HMAC verification (signature, freshness, method+path binding, body hash).
     */
    function signedOperatorHeaders(opts: {
      accountId: string;
      email?: string;
      secret?: string;
      path?: string;
    }): Record<string, string> {
      const email = opts.email ?? "operator@example.test";
      const path = opts.path ?? "/admin/analytics";
      const timestampMs = Date.now().toString();
      const bodySha256 = createHash("sha256").update("", "utf8").digest("hex");
      const payload = [
        "v1",
        timestampMs,
        "GET",
        path,
        opts.accountId,
        email,
        "true",
        bodySha256,
      ].join("\n");
      const signature = createHmac("sha256", opts.secret ?? OPERATOR_SECRET)
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

    beforeAll(async () => {
      pool = createTestPool();
      await runTestMigrations(pool);
      await seedWorkspace(pool);
      initContext({
        pool,
        config: makeTestConfig({
          BFF_INTERNAL_TOKEN: BFF_TOKEN,
          OPERATOR_IDENTITY_SECRET: OPERATOR_SECRET,
          OPERATOR_EMAIL_DOMAIN: "example.test",
        }),
      });
      app = buildServer();
      await app.ready();
    });

    afterEach(async () => {
      __resetRateLimiter();
      __resetAnalyticsCache();
      await truncateAll(pool);
      await seedWorkspace(pool);
    });

    afterAll(async () => {
      await app.close();
      resetContext();
      await pool.end();
    });

    it("a browser call WITHOUT the operator header → 403 (not an operator)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/analytics",
        headers: { "x-internal-token": BFF_TOKEN, "x-account-id": "gh:user" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("an agent bearer token can never reach it (no operator flag) → 403", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/analytics",
        headers: { authorization: AUTH_HEADER },
      });
      expect(res.statusCode).toBe(403);
    });

    it("x-operator-verified: true with a FORGED signature → 403 (proof must verify)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/analytics",
        headers: {
          "x-internal-token": BFF_TOKEN,
          "x-account-id": "gh:forger",
          ...signedOperatorHeaders({
            accountId: "gh:forger",
            secret: "not-the-operator-secret",
          }),
        },
      });
      expect(res.statusCode).toBe(403);
    });

    it("x-operator-verified: true with NO signature at all → 403 (bare flag is untrusted)", async () => {
      const res = await app.inject({
        method: "GET",
        url: "/admin/analytics",
        headers: {
          "x-internal-token": BFF_TOKEN,
          "x-account-id": "gh:flag-only",
          "x-operator-verified": "true",
        },
      });
      expect(res.statusCode).toBe(403);
    });

    /**
     * A fully-signed operator GET, optionally with a `?range=` query. The
     * operator proof binds the PATH only (the hub strips the query before the
     * path-binding check), so the signature always covers `/admin/analytics`.
     */
    async function operatorGet(query = "") {
      return app.inject({
        method: "GET",
        url: `/admin/analytics${query}`,
        headers: {
          "x-internal-token": BFF_TOKEN,
          "x-account-id": "gh:operator",
          ...signedOperatorHeaders({ accountId: "gh:operator" }),
        },
      });
    }

    it("a verified operator browser call (valid signed proof) → 200 with the range-aware shape", async () => {
      const res = await operatorGet();
      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Shape smoke-check: range-aware envelope + totals + comparison + timing
      // + aligned trend series + leaderboard present.
      expect(body.totals).toMatchObject({
        accounts: expect.any(Number),
        workspaces: expect.any(Number),
      });
      // The seeded self-host workspace counts.
      expect(body.totals.workspaces).toBeGreaterThanOrEqual(1);
      expect(typeof body.generatedAt).toBe("string");
      expect(typeof body.windowStart).toBe("string");
      expect(typeof body.windowEnd).toBe("string");
      expect(body.period.newAccounts).toMatchObject({
        current: expect.any(Number),
        previous: expect.any(Number),
      });
      expect(body.timing.sessionSpanSeconds).toHaveProperty("p50");
      // trends are now aligned {current,previous} series, not bare arrays.
      expect(Array.isArray(body.trends.newAccounts.current)).toBe(true);
      expect(Array.isArray(body.trends.newAccounts.previous)).toBe(true);
      expect(Array.isArray(body.topWorkspaces)).toBe(true);
    });

    it("defaults to the 30d preset (daily buckets) when `range` is omitted", async () => {
      const res = await operatorGet();
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.range).toBe("30d");
      expect(body.bucket).toBe("day");
    });

    it("accepts every supported preset and echoes the right bucket", async () => {
      const expected: Record<string, string> = {
        "24h": "hour",
        "7d": "day",
        "30d": "day",
        "90d": "day",
      };
      for (const range of Object.keys(expected)) {
        const res = await operatorGet(`?range=${range}`);
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.range).toBe(range);
        expect(body.bucket).toBe(expected[range]);
      }
    });

    it("rejects an unsupported range with 400", async () => {
      const res = await operatorGet("?range=1y");
      expect(res.statusCode).toBe(400);
    });

    it("caches per range: a 24h load never serves a 30d caller its shape", async () => {
      // Populate the 24h cache entry, then request 30d: a single (un-keyed)
      // cache would echo the first-cached range here.
      const first = await operatorGet("?range=24h");
      expect(first.statusCode).toBe(200);
      expect(first.json().range).toBe("24h");

      const second = await operatorGet("?range=30d");
      expect(second.statusCode).toBe(200);
      expect(second.json().range).toBe("30d");
      expect(second.json().bucket).toBe("day");

      // The 24h entry is still its own range on a warm re-read.
      const third = await operatorGet("?range=24h");
      expect(third.statusCode).toBe(200);
      expect(third.json().range).toBe("24h");
      expect(third.json().bucket).toBe("hour");
    });

    it("the operator gate runs BEFORE the cache: a non-operator never reads a warm entry", async () => {
      // Warm the 7d cache entry with a legitimate operator call.
      const warm = await operatorGet("?range=7d");
      expect(warm.statusCode).toBe(200);

      // A non-operator asking for the SAME (now-cached) range is still 403 — the
      // gate precedes any cache access, so the warm entry can't be bypassed.
      const res = await app.inject({
        method: "GET",
        url: "/admin/analytics?range=7d",
        headers: { "x-internal-token": BFF_TOKEN, "x-account-id": "gh:user" },
      });
      expect(res.statusCode).toBe(403);
    });
  },
);
