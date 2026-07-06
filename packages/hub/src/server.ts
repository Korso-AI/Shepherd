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
import { resolveTenant, type TenantContext } from "./tenant.js";
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
  revokeInvite,
  redeemInvite,
} from "./operations/invites.js";
import {
  listWorkspaceMembers,
  removeMember,
  leaveWorkspace,
} from "./operations/members.js";
import {
  CreateWorkspaceRequest,
  MintTokenRequest,
  CreateInviteRequest,
  InviteByEmailRequest,
} from "@shepherd/shared";
import {
  UnknownSessionError,
  ValidationError,
  AuthError,
  InviteError,
  ConflictError,
  NotConfiguredError,
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

const UI_APP_DIR = fileURLToPath(new URL("../../ui/dist/selfhost/", import.meta.url));

/** Shown (200, text/html) when dist/selfhost is absent — the UI hasn't been built. */
const UI_NOT_BUILT_HTML =
  "<!doctype html><meta charset=utf-8><title>Shepherd</title>" +
  "<body style=\"font-family:system-ui;padding:2rem\">" +
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

export function buildServer(): FastifyInstance {
  const app = Fastify({
    // Conservative explicit cap, comfortably above the largest valid payload
    // the contract allows (pathGlobs 64×512 + intent 2048 + body 8192 ≈ 43 KiB).
    // Don't rely on Fastify's 1 MiB default for a bearer-auth coordination API.
    bodyLimit: 64 * 1024,
    logger: {
      level: "info",
      redact: ['req.headers.authorization', 'req.headers["x-internal-token"]'],
    },
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
    }
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

  const serveHtml = async (_req: unknown, reply: import("fastify").FastifyReply) =>
    reply.type("text/html; charset=utf-8").send(ui.indexHtml);
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
  // Workspace management (Task 3.3) + account-scoped tokens (Task 1.3) —
  // account-scoped, NON-`:id` routes.
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

  // Account-scoped token surface (Task 1.3): mint an account-wide token, list the
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
  // Agent-token management (Task 3.4) — `/workspaces/:id/*` routes.
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
  // Invite management (Task 3.5).
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

  app.post("/workspaces/:id/invites/:code/revoke", async (request, _reply) => {
    const { code } = request.params as { code: string };
    return revokeInvite(code, request.tenant);
  });

  app.post("/invites/:code/redeem", async (request, _reply) => {
    const { code } = request.params as { code: string };
    return redeemInvite(code, request.tenant);
  });

  // -------------------------------------------------------------------------
  // Member management (Task 3.6) — `/workspaces/:id/*` routes.
  //
  // These are :id routes, so resolveTenant has ALREADY validated the browser
  // caller's membership of `:id` (a non-member is rejected 404 in the onRequest
  // hook) and set its role. So:
  //  - list   gates on membership only (no requireAdmin — members see the roster).
  //  - remove requires admin, 404s an unknown target, and refuses to remove the
  //    LAST admin (409, ConflictError); on success it also revokes that member's
  //    tokens in this workspace so removed agents stop authenticating.
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
      return reply.status(err.status).send({ error: "Invite expired or no longer valid" });
    }

    // Domain: a well-formed, authorized action that would break an invariant
    // (e.g. removing the last admin) → 409. The message is user-facing actionable
    // guidance and is echoed verbatim (like ValidationError) — there is no
    // existence-leak concern here (the caller is an admin of this workspace).
    if (err instanceof ConflictError) {
      return reply.status(err.status).send({ error: err.message });
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
    const safeErr = err as { message?: unknown; stack?: unknown; name?: unknown };
    app.log.error(
      { err: { message: safeErr.message, stack: safeErr.stack, name: safeErr.name } },
      "Unhandled server error"
    );

    return reply.status(500).send({ error: "Internal server error" });
  });

  // Generic 404 for unknown routes — never echo the path or method back.
  app.setNotFoundHandler((_request, reply) => {
    return reply.status(404).send({ error: "Not found" });
  });

  return app;
}
