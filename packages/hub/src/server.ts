/**
 * Fastify application factory for @shepherd/hub.
 *
 * Call `buildServer()` to get a configured FastifyInstance.
 * Do NOT call `listen()` here — callers (index.ts, tests) decide that.
 */

import { readFileSync, readdirSync } from "node:fs";
import { basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import { ZodError } from "zod";

import {
  JoinRequest,
  WorkRequest,
  DoneRequest,
  AnnounceRequest,
  SyncRequest,
  HeartbeatRequest,
  LeaveRequest,
  WorkspaceAnnounceRequest,
  FeedbackRequest,
} from "@shepherd/shared";

import { getContext } from "./context.js";
import {
  resolveTenant,
  requireInternal,
  type TenantContext,
} from "./tenant.js";
import { join } from "./operations/join.js";
import { work } from "./operations/work.js";
import { done } from "./operations/done.js";
import { announce } from "./operations/announce.js";
import { sync } from "./operations/sync.js";
import { heartbeat } from "./operations/heartbeat.js";
import { leave } from "./operations/leave.js";
import { workspaceLandscape } from "./operations/workspaceLandscape.js";
import { workspaceAnnounce } from "./operations/workspaceAnnounce.js";
import { submitFeedback } from "./operations/feedback.js";
import { platformAnalytics } from "./operations/analytics.js";
import {
  createWorkspace,
  listWorkspaces,
  deleteWorkspace,
} from "./operations/workspaces.js";
import { mintToken, listTokens, revokeToken } from "./operations/tokens.js";
import {
  createInvite,
  inviteByEmail,
  listEmailInvites,
  revokeInvite,
  redeemInvite,
} from "./operations/invites.js";
import { deleteAccount } from "./operations/account.js";
import {
  putEntitlements,
  getEntitlementsStatus,
  deleteEntitlements,
} from "./operations/entitlements.js";
import {
  listWorkspaceMembers,
  removeMember,
  leaveWorkspace,
  setMemberRole,
  transferOwnership,
} from "./operations/members.js";
import {
  CreateWorkspaceRequest,
  MintTokenRequest,
  CreateInviteRequest,
  InviteByEmailRequest,
  SetMemberRoleRequest,
  TransferOwnershipRequest,
  PutEntitlementsRequest,
} from "@shepherd/shared";
import {
  UnknownSessionError,
  ValidationError,
  AuthError,
  InviteError,
  ConflictError,
  NotConfiguredError,
  LimitExceededError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Fastify module augmentation: every request carries its resolved tenant.
// The onRequest hook populates this before any handler runs (except the
// /health + static-shell GET exemptions, which return early and never read it).
// ---------------------------------------------------------------------------

declare module "fastify" {
  interface FastifyRequest {
    tenant: TenantContext;
  }
}

// Generic public messages keyed off the AuthError status. SECURITY: never echo
// the AuthError's internal message (which credential failed, whether a workspace
// exists, etc.) — only this status-keyed string is returned. Shared by the
// onRequest hook and the route-handler error path so both stay byte-identical.
const AUTH_MESSAGES: Record<number, string> = {
  400: "Bad request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not found",
  429: "Too many requests",
};

// ---------------------------------------------------------------------------
// Dashboard static shell — the compiled @korso/shepherd-ui app
//
// The hub serves the Vite build output of packages/ui (dist/selfhost/): a tiny
// index.html shell that boots a hashed ES module from /assets/. This REQUIRES
// the UI to be built first (`npm run build -w @korso/shepherd-ui`); see the hub
// README + Dockerfile. The path `../../ui/dist/selfhost/` resolves the same from
// src/ (tsx dev) and dist/ (built) — both packages/hub/{src,dist} sit one level
// under packages/hub, and packages/ui is its sibling.
//
// Unlike the old committed public/ files, dist/selfhost is a build artifact that
// may be absent (fresh checkout, CI before the UI builds). A top-level
// readFileSync that threw would break buildServer() import and take down the
// whole hub test suite, so the read is LAZY + DEFENSIVE: a missing build
// degrades to an inline placeholder served with 200/text-html, never a crash.
// ---------------------------------------------------------------------------

const UI_APP_DIR = fileURLToPath(
  new URL("../../ui/dist/selfhost/", import.meta.url),
);

/** Shown (200, text/html) when dist/selfhost is absent — the UI hasn't been built. */
const UI_NOT_BUILT_HTML =
  "<!doctype html><meta charset=utf-8><title>Shepherd</title>" +
  '<body style="font-family:system-ui;padding:2rem">' +
  "<h1>Shepherd UI not built</h1>" +
  "<p>Run <code>npm run build -w @korso/shepherd-ui</code>, then restart the hub.</p>";

/** Content-type for a static asset, derived from its extension. */
function assetContentType(name: string): string {
  switch (extname(name).toLowerCase()) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/** The shell index.html + the preloaded /assets/ bundle, or a not-built fallback. */
interface UiBundle {
  indexHtml: string;
  /** basename → file bytes; empty when the UI isn't built. */
  assets: Map<string, Buffer>;
}

/**
 * Read the compiled UI once at buildServer() time. Defensive: a missing/partial
 * build never throws — it yields the not-built placeholder with no assets, so the
 * hub still boots (and CI/tests run without first building the UI). A real build
 * then serves the real shell + hashed assets. Read-once mirrors the old pattern.
 */
function loadUiBundle(): UiBundle {
  let indexHtml: string;
  try {
    indexHtml = readFileSync(UI_APP_DIR + "index.html", "utf8");
  } catch {
    return { indexHtml: UI_NOT_BUILT_HTML, assets: new Map() };
  }
  const assets = new Map<string, Buffer>();
  try {
    for (const name of readdirSync(UI_APP_DIR + "assets")) {
      assets.set(name, readFileSync(UI_APP_DIR + "assets/" + name));
    }
  } catch {
    // index.html present but no assets/ dir — serve the shell, 404 any asset.
  }
  return { indexHtml, assets };
}

// ---------------------------------------------------------------------------
// buildServer
// ---------------------------------------------------------------------------

/** Options that shape the Fastify instance, threaded from the resolved config. */
export interface BuildServerOptions {
  /**
   * Whether Fastify should derive `request.ip` from the `X-Forwarded-For`
   * header (see the `trustProxy` comment below). Defaults to `false` — the
   * fail-safe for a directly-exposed hub. `index.ts` passes `config.TRUST_PROXY`;
   * tests and other callers omit it and get the safe default.
   */
  trustProxy?: boolean;
}

export function buildServer(options: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({
    // Conservative explicit cap, comfortably above the largest valid payload
    // the contract allows (pathGlobs 64×512 + intent 2048 + body 8192 ≈ 43 KiB).
    // Don't rely on Fastify's 1 MiB default for a bearer-auth coordination API.
    bodyLimit: 64 * 1024,
    // Derive request.ip from x-forwarded-for — OPT-IN, defaulting OFF (fail-safe).
    // When the hub sits behind a reverse proxy (Cloud Run, nginx, a self-host
    // ingress), every request arrives from the proxy's address, so without this
    // the per-IP pre-auth failure throttle (tenant.ts) would lump all callers
    // into one bucket. Enabling it makes the throttle key off the real client IP
    // the proxy forwards. BUT on a DIRECTLY-exposed hub any client can spoof
    // X-Forwarded-For and thereby dodge that per-IP throttle, so it must NOT be
    // trusted by default: only turn TRUST_PROXY on when a trusted proxy that
    // overwrites (not appends to) X-Forwarded-For actually fronts the hub. Auth
    // itself never keys off the address, so the blast radius is limited to that
    // one throttle either way.
    trustProxy: options.trustProxy ?? false,
    logger: {
      level: "info",
      redact: ["req.headers.authorization", 'req.headers["x-internal-token"]'],
    },
  });

  // -------------------------------------------------------------------------
  // HTTP security headers (@fastify/helmet)
  //
  // The hub serves an authenticated SPA shell (GET / and /index.html) plus its
  // hashed /assets/ bundle, so it needs the standard browser hardening headers.
  // Registered at the root before any route, so helmet's onRequest hook stamps
  // EVERY response (the static shell, the /assets/ files, and the JSON data API).
  //
  // Content-Security-Policy is written explicitly (`useDefaults: false`) so an
  // OSS reader can see exactly what the shell is allowed to load, and so we can
  // OMIT `upgrade-insecure-requests` — a plain-HTTP self-host (no TLS terminator)
  // would otherwise have its same-origin asset requests force-upgraded to https
  // and fail. The policy is derived from packages/ui/dist/selfhost/index.html:
  //   - script-src 'self'          — the shell loads a hashed ES module from
  //     /assets/ and has NO inline <script>, so no 'unsafe-inline'/nonce needed.
  //   - style-src 'self' + 'unsafe-inline' — the stylesheet is a hashed /assets/
  //     file, but the SPA also injects styles at runtime (CSS-in-JS / Vite),
  //     which CSP cannot hash ahead of time; 'unsafe-inline' is scoped to STYLES
  //     only (never scripts), the low-risk half of the directive.
  //   - connect-src 'self'         — the shell makes same-origin XHR/fetch to the
  //     hub data API and nothing cross-origin.
  //   - img-src 'self' data: https: — favicons/inline data URIs plus remote
  //     avatars (e.g. GitHub) the dashboard renders.
  //   - default/object/base/form/frame-ancestors are locked down; frame-ancestors
  //     'none' (plus frameguard DENY below) forbids embedding the hub in a frame.
  // HSTS: left at helmet's default (a no-op over http, correct over https).
  void app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // frame-ancestors 'none' (CSP, above) is the modern control; frameguard
    // DENY (X-Frame-Options) covers legacy browsers that ignore CSP framing.
    frameguard: { action: "deny" },
    // X-Content-Type-Options: nosniff on every response — including the
    // hand-rolled /assets/:file route, whose reply.header(...).type(...).send()
    // never clears the header helmet's onRequest hook already set.
    noSniff: true,
    // No referrer leaks the (authenticated) dashboard URL to third parties.
    referrerPolicy: { policy: "no-referrer" },
  });

  // Treat an EMPTY JSON body as "no body" instead of failing the request in
  // body parsing (FST_ERR_CTP_EMPTY_JSON_BODY -> 400). Several hub routes are
  // bodyless POSTs (redeem, revoke, leave), and real clients — the console BFF
  // proxy in particular — forward them with `content-type: application/json`
  // and a zero-length body. That combination has now bitten twice (the
  // last-admin leave 500, the invite-link join 400), so tolerate it at the
  // parser layer for EVERY route. Non-empty bodies still go through Fastify's
  // own secure default parser (prototype-poisoning protection intact), and
  // every body-consuming route Zod-parses `request.body ?? {}` anyway.
  const defaultJsonParser = app.getDefaultJsonParser("error", "error");
  app.addContentTypeParser<string>(
    "application/json",
    { parseAs: "string", bodyLimit: 64 * 1024 },
    (request, body, done) => {
      if (body === "") {
        done(null, undefined);
        return;
      }
      defaultJsonParser(request, body, done);
    },
  );

  // -------------------------------------------------------------------------
  // Health — registered BEFORE the auth hook so it is always exempt
  // -------------------------------------------------------------------------

  app.get("/health", async (_req, _reply) => {
    return { status: "ok" };
  });

  // -------------------------------------------------------------------------
  // Dashboard static shell + assets. The bearer hook applies to every route in
  // this instance regardless of registration order, so these load without a
  // token PURELY because their URLs are auth-exempted in the hook (see below):
  // the token guards the DATA endpoint, not the static shell that prompts for it.
  // -------------------------------------------------------------------------

  const ui = loadUiBundle();

  const serveHtml = async (
    _req: unknown,
    reply: import("fastify").FastifyReply,
  ) => reply.type("text/html; charset=utf-8").send(ui.indexHtml);
  app.get("/", serveHtml);
  app.get("/index.html", serveHtml);

  // Hand-rolled asset serve (no @fastify/static): preloaded Map + basename-only
  // lookup. Using only basename() means a `..` segment can never escape the
  // assets dir; an unknown name 404s rather than leaking a foreign file.
  app.get("/assets/:file", async (request, reply) => {
    const { file } = request.params as { file: string };
    const bytes = ui.assets.get(basename(file));
    if (!bytes) {
      return reply.status(404).send({ error: "Not found" });
    }
    // Vite assets are content-hashed, so the bytes behind a given name never
    // change — cache them immutably for a year. (NOT applied to the shell /
    // index.html, which must stay revalidated to pick up new bundle hashes.)
    return reply
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .type(assetContentType(file))
      .send(bytes);
  });

  // Every request carries its resolved tenant (see the fastify augmentation
  // above). The onRequest hook populates it before any handler runs; exempt
  // routes (/health, static-shell GETs) return early and never read it. We decorate
  // with a null placeholder so the property exists on the prototype WITHOUT a
  // shared object reference across requests. The augmentation types it as the
  // non-null TenantContext (handlers always run after the hook has set it), so
  // the null default is bridged here with a localized cast.
  app.decorateRequest("tenant", null as unknown as TenantContext);

  // -------------------------------------------------------------------------
  // Auth + tenancy hook — runs for every route registered AFTER this point
  // -------------------------------------------------------------------------

  app.addHook("onRequest", async (request, reply) => {
    // Exempt /health (belt-and-suspenders in case route order changes)
    const url = request.url.split("?")[0]!;
    if (url === "/health") {
      return;
    }

    // Exempt the dashboard static shell (HTML + its hashed /assets/ bundle). The
    // token guards the DATA endpoints, not the static shell that prompts for it.
    // Safe by construction: every data route is POST, or one of the two static
    // GETs (/health, /workspace[s]/.../landscape) — none equals "/" or
    // "/index.html" nor starts with "/assets/", so this prefix can't leak data.
    if (
      request.method === "GET" &&
      (url === "/" || url === "/index.html" || url.startsWith("/assets/"))
    ) {
      return;
    }

    const { config, pool } = getContext();

    try {
      request.tenant = await resolveTenant(request, config, pool);
    } catch (err) {
      if (err instanceof AuthError) {
        // Reply with the status-keyed generic message only. Full detail is
        // logged server-side; the redaction config keeps both the authorization
        // header and the x-internal-token (BFF shared secret) out of the logs.
        return reply
          .status(err.status)
          .send({ error: AUTH_MESSAGES[err.status] ?? "Unauthorized" });
      }
      // Any non-AuthError from the auth path is an internal fault — never leak
      // its detail. Log and return a generic 500 via the error handler.
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // Operation routes
  // -------------------------------------------------------------------------

  app.post("/join", async (request, _reply) => {
    const parsed = JoinRequest.safeParse(request.body);
    if (!parsed.success) {
      throw parsed.error; // caught by error handler → 400
    }
    return join(parsed.data, request.tenant);
  });

  app.post("/work", async (request, _reply) => {
    const parsed = WorkRequest.safeParse(request.body);
    if (!parsed.success) {
      throw parsed.error;
    }
    return work(parsed.data, request.tenant);
  });

  app.post("/done", async (request, _reply) => {
    const parsed = DoneRequest.safeParse(request.body);
    if (!parsed.success) {
      throw parsed.error;
    }
    return done(parsed.data, request.tenant);
  });

  app.post("/announce", async (request, _reply) => {
    const parsed = AnnounceRequest.safeParse(request.body);
    if (!parsed.success) {
      throw parsed.error;
    }
    return announce(parsed.data, request.tenant);
  });

  app.post("/sync", async (request, _reply) => {
    const parsed = SyncRequest.safeParse(request.body);
    if (!parsed.success) {
      throw parsed.error;
    }
    return sync(parsed.data, request.tenant);
  });

  app.post("/heartbeat", async (request, _reply) => {
    const parsed = HeartbeatRequest.safeParse(request.body);
    if (!parsed.success) {
      throw parsed.error;
    }
    return heartbeat(parsed.data, request.tenant);
  });

  app.post("/leave", async (request, _reply) => {
    const parsed = LeaveRequest.safeParse(request.body);
    if (!parsed.success) {
      throw parsed.error;
    }
    return leave(parsed.data, request.tenant);
  });

  // Read-only whole-workspace view for the wallboard. The :id form is the
  // canonical, multi-tenant route — resolveTenant validates the caller's
  // membership of `:id` (browser path) or matches the token's workspace.
  app.get("/workspaces/:id/landscape", async (request, _reply) => {
    return workspaceLandscape(request.tenant);
  });

  // Operator → hub: send an announcement from the dashboard, :id form. Scoped to
  // request.tenant.workspaceId (membership-validated by resolveTenant's :id branch).
  // Hosted callers must be an ADMIN of this workspace (§4.4); the op-level guard in
  // workspaceAnnounce enforces it (and skips it for self-host TEAM_TOKEN).
  app.post("/workspaces/:id/announce", async (request, _reply) => {
    const parsed = WorkspaceAnnounceRequest.safeParse(request.body);
    if (!parsed.success) {
      throw parsed.error;
    }
    return workspaceAnnounce(parsed.data, request.tenant);
  });

  // Self-host aliases for the singular routes. A single-workspace TEAM_TOKEN
  // deployment has exactly one workspace, so request.tenant.workspaceId is
  // unambiguous; the hosted dashboard always uses the :id form above. The
  // TEAM_TOKEN carries no account/role, so the admin gate in workspaceAnnounce
  // is skipped here — full single-team access is preserved.
  app.get("/workspace/landscape", async (request, _reply) => {
    return workspaceLandscape(request.tenant);
  });

  app.post("/workspace/announce", async (request, _reply) => {
    const parsed = WorkspaceAnnounceRequest.safeParse(request.body);
    if (!parsed.success) {
      throw parsed.error;
    }
    return workspaceAnnounce(parsed.data, request.tenant);
  });

  // -------------------------------------------------------------------------
  // Workspace management + account-scoped tokens — account-scoped,
  // NON-`:id` routes.
  //
  // resolveTenant resolves these to {workspaceId: NO_ROUTE_WORKSPACE, accountId}
  // for BOTH the browser-via-BFF path AND an account-scoped agent shp_ token
  // (migration 015: an account-scoped token now also resolves to
  // NO_ROUTE_WORKSPACE, not a concrete workspace). The operation keys off
  // `tenant.accountId` and rejects a self-host TEAM_TOKEN (no accountId) with 401.
  // These are static paths, distinct from the `/workspaces/:id/*` param routes
  // above (Fastify prefers the static match).
  // -------------------------------------------------------------------------

  app.post("/workspaces", async (request, _reply) => {
    const parsed = CreateWorkspaceRequest.safeParse(request.body);
    if (!parsed.success) {
      throw parsed.error;
    }
    return createWorkspace(parsed.data, request.tenant);
  });

  app.get("/workspaces", async (request, _reply) => {
    return listWorkspaces(request.tenant);
  });

  // Account-scoped token surface: mint an account-wide token, list the
  // account's tokens, revoke one the caller owns. mintToken/listTokens branch on
  // the NO_ROUTE_WORKSPACE sentinel to mint/list account-scoped here (vs. the
  // workspace-narrowed `/workspaces/:id/tokens` routes above); revoke enforces
  // account ownership in SQL, so a cross-account tokenId reads as 404.

  app.post("/tokens", async (request, _reply) => {
    const parsed = MintTokenRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw parsed.error;
    }
    return mintToken(parsed.data, request.tenant);
  });

  app.get("/tokens", async (request, _reply) => {
    return listTokens(request.tenant);
  });

  app.delete("/tokens/:tokenId", async (request, _reply) => {
    const { tokenId } = request.params as { tokenId: string };
    return revokeToken(tokenId, request.tenant);
  });

  // -------------------------------------------------------------------------
  // Agent-token management — `/workspaces/:id/*` routes.
  //
  // These are :id routes, so resolveTenant has ALREADY validated the browser
  // caller's membership of `:id` (a non-member is rejected 404 in the onRequest
  // hook). mint/revoke additionally require an accountId; revoke enforces token
  // ownership (account-scoped) in the operation, while list is workspace-scoped.
  // -------------------------------------------------------------------------

  app.post("/workspaces/:id/tokens", async (request, _reply) => {
    const parsed = MintTokenRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw parsed.error;
    }
    return mintToken(parsed.data, request.tenant);
  });

  app.get("/workspaces/:id/tokens", async (request, _reply) => {
    return listTokens(request.tenant);
  });

  app.delete("/workspaces/:id/tokens/:tokenId", async (request, _reply) => {
    const { tokenId } = request.params as { tokenId: string };
    return revokeToken(tokenId, request.tenant);
  });

  // -------------------------------------------------------------------------
  // Invite management.
  //
  // Create/revoke are admin-only `/workspaces/:id/*` routes — resolveTenant has
  // already validated the browser caller's membership of `:id` and set its role,
  // so the operation gates with requireAdmin.
  //
  // Redeem is the PUBLIC, security-critical route. It is NOT under
  // `/workspaces/:id`, so resolveTenant runs no route-membership check; the
  // operation pins the trust itself (account-only browser-via-BFF path; an agent
  // shp_ token and a self-host TEAM_TOKEN are rejected — see operations/invites.ts).
  // A forged x-account-id never reaches the handler — resolveTenant 401s in the
  // onRequest hook before this runs.
  // -------------------------------------------------------------------------

  app.post("/workspaces/:id/invites", async (request, _reply) => {
    const parsed = CreateInviteRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw parsed.error;
    }
    return createInvite(parsed.data, request.tenant);
  });

  app.post("/workspaces/:id/invites/email", async (request, _reply) => {
    const parsed = InviteByEmailRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw parsed.error;
    }
    return inviteByEmail(parsed.data.email, request.tenant);
  });

  // The pending email invites of `:id` (admin-only in the operation) — the
  // roster the Config UI renders under the "Invite by email" form. A redeemed
  // one-time invite drops out of this list on its own.
  app.get("/workspaces/:id/invites/email", async (request, _reply) => {
    return listEmailInvites(request.tenant);
  });

  app.post("/workspaces/:id/invites/:code/revoke", async (request, _reply) => {
    const { code } = request.params as { code: string };
    return revokeInvite(code, request.tenant);
  });

  app.post("/invites/:code/redeem", async (request, _reply) => {
    const { code } = request.params as { code: string };
    return redeemInvite(code, request.tenant);
  });

  // -------------------------------------------------------------------------
  // Member management — `/workspaces/:id/*` routes.
  //
  // These are :id routes, so resolveTenant has ALREADY validated the browser
  // caller's membership of `:id` (a non-member is rejected 404 in the onRequest
  // hook) and set its role. So:
  //  - list   gates on membership only (no requireAdmin — members see the roster).
  //  - remove requires admin, 404s an unknown target, refuses to remove the LAST
  //    admin (409) or the OWNER (409), and requires the OWNER to remove a fellow
  //    admin; on success it also revokes that member's tokens in this workspace
  //    so removed agents stop authenticating.
  //  - role   (PATCH …/members/:accountId/role) is OWNER-ONLY: promote/demote.
  //  - transfer-ownership is OWNER-ONLY: hand the owner flag to another member.
  //  - leave  removes the caller's own membership (+ tokens), but the last admin
  //    cannot leave (409) — a workspace must always retain an admin.
  // -------------------------------------------------------------------------

  app.get("/workspaces/:id/members", async (request, _reply) => {
    return listWorkspaceMembers(request.tenant);
  });

  app.delete("/workspaces/:id/members/:accountId", async (request, _reply) => {
    const { accountId } = request.params as { accountId: string };
    return removeMember(accountId, request.tenant);
  });

  // Change a member's role — OWNER-ONLY (enforced in setMemberRole). Promotes a
  // member to admin or demotes an admin to member; the owner's own role is fixed.
  app.patch(
    "/workspaces/:id/members/:accountId/role",
    async (request, _reply) => {
      const { accountId } = request.params as { accountId: string };
      const parsed = SetMemberRoleRequest.safeParse(request.body ?? {});
      if (!parsed.success) {
        throw parsed.error;
      }
      return setMemberRole(accountId, parsed.data.role, request.tenant);
    },
  );

  // Transfer ownership to another member — OWNER-ONLY (enforced in
  // transferOwnership). The target becomes owner (+ admin); the former owner
  // stays an admin.
  app.post("/workspaces/:id/transfer-ownership", async (request, _reply) => {
    const parsed = TransferOwnershipRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw parsed.error;
    }
    return transferOwnership(parsed.data.accountId, request.tenant);
  });

  app.post("/workspaces/:id/leave", async (request, _reply) => {
    return leaveWorkspace(request.tenant);
  });

  // -------------------------------------------------------------------------
  // Delete a workspace — `/workspaces/:id`, admin-only, permanent.
  //
  // A :id route, so resolveTenant has ALREADY validated the browser caller's
  // membership of `:id` and set its role; deleteWorkspace gates on requireAdmin
  // (any admin, regardless of member count — the type-to-confirm modal in the UI
  // is the accident guard). Bodyless, like the token/member DELETE routes above.
  // deleteWorkspace wipes every workspace-scoped row in one transaction.
  // -------------------------------------------------------------------------

  app.delete("/workspaces/:id", async (request, _reply) => {
    return deleteWorkspace(request.tenant);
  });

  // -------------------------------------------------------------------------
  // Delete the CALLER's account — a non-`:id` route, permanent.
  //
  // Like invite redemption, the operation pins the trust itself: an account
  // credential on the browser-via-BFF path only (an agent shp_ token and a
  // self-host TEAM_TOKEN are rejected — see operations/account.ts, which also
  // documents the per-workspace semantics and the last-admin 409 guard).
  // Bodyless, like the other DELETE routes.
  // -------------------------------------------------------------------------

  app.delete("/account", async (request, _reply) => {
    return deleteAccount(request.tenant);
  });

  // -------------------------------------------------------------------------
  // Feedback widget — capture a bug/suggestion/other note.
  //
  // Not admin-gated (any member may give feedback) and not workspace-required:
  // the :id form gives resolveTenant a validated workspace to attach (the
  // hosted dashboard's normal case, mirroring landscape/announce above), while
  // the flat form is for self-host (TEAM_TOKEN resolves its own workspace
  // regardless of route) and a hosted caller with no workspace selected yet
  // (e.g. the empty-state screen) — submitFeedback records null in that case.
  // -------------------------------------------------------------------------

  app.post("/workspaces/:id/feedback", async (request, _reply) => {
    const parsed = FeedbackRequest.safeParse(request.body);
    if (!parsed.success) {
      throw parsed.error;
    }
    return submitFeedback(parsed.data, request.tenant);
  });

  app.post("/feedback", async (request, _reply) => {
    const parsed = FeedbackRequest.safeParse(request.body);
    if (!parsed.success) {
      throw parsed.error;
    }
    return submitFeedback(parsed.data, request.tenant);
  });

  // -------------------------------------------------------------------------
  // Operator analytics — cross-tenant, read-only product metrics. Gated on the
  // internal-operator identity inside `platformAnalytics`; see `requireOperator`
  // in tenant.ts for the trust model.
  // -------------------------------------------------------------------------

  app.get("/admin/analytics", async (request, _reply) => {
    return platformAnalytics(request.tenant);
  });

  // -------------------------------------------------------------------------
  // Internal entitlements management — `/internal/workspaces/:id/entitlements`.
  //
  // A trusted embedding service (the BFF calling on its own behalf) pushes
  // per-workspace caps into the hub here. NOT under the top-level
  // `/workspaces/:id` prefix, so routeWorkspaceId never fires and resolveTenant
  // takes its internal service-call branch instead (matched x-internal-token +
  // /internal/ pathname + no x-account-id — see tenant.ts). requireInternal in
  // each handler pins every other credential shape out (403).
  // -------------------------------------------------------------------------

  app.put("/internal/workspaces/:id/entitlements", async (request, _reply) => {
    requireInternal(request.tenant);
    const { id } = request.params as { id: string };
    const parsed = PutEntitlementsRequest.safeParse(request.body ?? {});
    if (!parsed.success) {
      throw parsed.error;
    }
    return putEntitlements(id, parsed.data, request.tenant);
  });

  app.get("/internal/workspaces/:id/entitlements", async (request, _reply) => {
    requireInternal(request.tenant);
    const { id } = request.params as { id: string };
    return getEntitlementsStatus(id, request.tenant);
  });

  app.delete(
    "/internal/workspaces/:id/entitlements",
    async (request, _reply) => {
      requireInternal(request.tenant);
      const { id } = request.params as { id: string };
      return deleteEntitlements(id, request.tenant);
    },
  );

  // -------------------------------------------------------------------------
  // Error handler — translates domain errors to HTTP status codes
  // -------------------------------------------------------------------------

  app.setErrorHandler((err, request, reply) => {
    // ZodError → 400 with issues array
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: "Validation failed",
        issues: err.issues,
      });
    }

    // Domain: workspace / input validation → 400
    if (err instanceof ValidationError) {
      return reply.status(400).send({ error: err.message });
    }

    // Domain: unknown session → 404
    if (err instanceof UnknownSessionError) {
      return reply.status(404).send({ error: err.message });
    }

    // Domain: invite invalid/revoked/expired/exhausted → 410 Gone. One generic
    // message for every reason (never reveal whether a code ever existed) — the
    // redeem route's anti-enumeration property depends on this indistinguishability.
    if (err instanceof InviteError) {
      return reply
        .status(err.status)
        .send({ error: "Invite expired or no longer valid" });
    }

    // Domain: a well-formed, authorized action that would break an invariant
    // (e.g. removing the last admin) → 409. The message is user-facing actionable
    // guidance and is echoed verbatim (like ValidationError) — there is no
    // existence-leak concern here (the caller is an admin of this workspace).
    if (err instanceof ConflictError) {
      return reply.status(err.status).send({ error: err.message });
    }

    // Domain: the action would exceed a workspace cap → 402 with the
    // machine-readable body (LimitExceededErrorBody in @shepherd/shared).
    // Message echoed verbatim like ConflictError — user-facing guidance, no
    // existence-leak concern (the caller already reached this workspace).
    if (err instanceof LimitExceededError) {
      return reply.status(err.status).send({
        error: err.message,
        code: "limit_exceeded",
        limit: err.limit,
        current: err.current,
        max: err.max,
      });
    }

    // Domain: the request is fine but this deployment lacks the config a
    // feature needs (e.g. email invites without RESEND_API_KEY) → 501.
    if (err instanceof NotConfiguredError) {
      return reply.status(err.status).send({ error: err.message });
    }

    // Auth/tenancy errors thrown from a route handler (the onRequest hook
    // catches its own, but operations may also throw these). Reply with the
    // status-keyed generic message; never echo the internal reason.
    if (err instanceof AuthError) {
      return reply
        .status(err.status)
        .send({ error: AUTH_MESSAGES[err.status] ?? "Unauthorized" });
    }

    // Framework-level errors (not domain HubErrors) carry a numeric `statusCode`
    // — e.g. Fastify's FST_ERR_CTP_EMPTY_JSON_BODY (400) when a bodyless POST
    // arrives with `content-type: application/json`, which is what turned a
    // last-admin leave into an opaque 500. Honor a 4xx verbatim rather than
    // masking a client-side mistake as a server fault; this hardens EVERY route
    // against framework validation errors, not just the bodyless path that
    // surfaced it. A 5xx statusCode is left to the generic 500 below (never leak
    // an internal fault's detail). The message here is Fastify's own generic
    // description (no request data, no credentials), safe to echo.
    const fwErr = err as { statusCode?: unknown; message?: unknown };
    if (
      typeof fwErr.statusCode === "number" &&
      fwErr.statusCode >= 400 &&
      fwErr.statusCode < 500
    ) {
      const msg =
        typeof fwErr.message === "string" && fwErr.message.length > 0
          ? fwErr.message
          : (AUTH_MESSAGES[fwErr.statusCode] ?? "Bad request");
      return reply.status(fwErr.statusCode).send({ error: msg });
    }

    // All other errors → 500 with a generic message.
    // Log full detail server-side; NEVER echo request headers in the response.
    const safeErr = err as {
      message?: unknown;
      stack?: unknown;
      name?: unknown;
    };
    app.log.error(
      {
        err: {
          message: safeErr.message,
          stack: safeErr.stack,
          name: safeErr.name,
        },
      },
      "Unhandled server error",
    );

    return reply.status(500).send({ error: "Internal server error" });
  });

  // Generic 404 for unknown routes — never echo the path or method back.
  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({ error: "Not found" });
  });

  return app;
}
