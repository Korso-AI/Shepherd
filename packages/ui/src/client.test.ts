import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  createShepherdClient,
  ShepherdClientError,
  describeError,
} from "./client.js";
import type { ShepherdClient } from "./client.js";

// ---------------------------------------------------------------------------
// ShepherdClient — fetch-mock unit tests (DB-free; mocks global `fetch`).
//
// Each method asserts: the request URL (baseUrl + exact encoded path), the HTTP
// method, that auth headers from getAuthHeader are merged (Bearer-string, header-
// map, and undefined/no-op cases), Content-Type + body JSON on bodied requests,
// and that the response is validated by the @shepherd/shared zod schema. A
// malformed 2xx body throws "Invalid response schema"; a non-2xx rejects with a
// typed ShepherdClientError carrying `.status`; a 401 fires onUnauthorized first.
// ---------------------------------------------------------------------------

const BASE = "https://hub.example.com";

/** Build a Response-like object for a mocked fetch resolution. */
function jsonResponse(
  body: unknown,
  init?: { status?: number; statusText?: string },
): Response {
  const status = init?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: init?.statusText ?? "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The single call recorded on the fetch mock: [url, init]. */
function lastCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls[0];
  return [call[0] as string, call[1] as RequestInit];
}

/** Read a header from a recorded RequestInit (headers stored as a plain record). */
function header(init: RequestInit, name: string): string | undefined {
  const h = init.headers as Record<string, string> | undefined;
  if (!h) return undefined;
  const key = Object.keys(h).find(
    (k) => k.toLowerCase() === name.toLowerCase(),
  );
  return key ? h[key] : undefined;
}

// --- fixtures matching the @shepherd/shared schemas ------------------------

const WORKSPACE_SUMMARY = {
  id: "ws_1",
  slug: "acme",
  name: "Acme",
  role: "admin" as const,
  isOwner: true,
};

const LANDSCAPE = {
  agents: [],
  tasks: [],
  announcements: [],
  serverTime: "2026-06-29T00:00:00.000Z",
};

describe("createShepherdClient", () => {
  let client: ShepherdClient;

  beforeEach(() => {
    client = createShepherdClient({ baseUrl: BASE });
  });

  // --- self-host singular methods (preserved from main) -------------------

  describe("getLandscape (self-host)", () => {
    it("GETs /workspace/landscape and returns the validated body", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(LANDSCAPE));
      const out = await client.getLandscape();
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/workspace/landscape`);
      expect(init.method).toBe("GET");
      expect(out).toEqual(LANDSCAPE);
    });
  });

  describe("announce (self-host)", () => {
    it("POSTs /workspace/announce with the request body", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ok: true, announcementIds: [1] }),
      );
      const out = await client.announce({ body: "hello" });
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/workspace/announce`);
      expect(init.method).toBe("POST");
      expect(header(init, "Content-Type")).toBe("application/json");
      expect(JSON.parse(init.body as string)).toEqual({ body: "hello" });
      expect(out).toEqual({ ok: true, announcementIds: [1] });
    });
  });

  // --- plural multi-workspace surface -------------------------------------

  describe("listWorkspaces", () => {
    it("GETs /workspaces and returns the validated body", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ workspaces: [WORKSPACE_SUMMARY] }),
      );
      const out = await client.listWorkspaces();
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/workspaces`);
      expect(init.method).toBe("GET");
      expect(out).toEqual({ workspaces: [WORKSPACE_SUMMARY] });
    });

    it("throws 'Invalid response schema' when the body fails validation", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ workspaces: [{ id: "x" }] }),
      );
      await expect(client.listWorkspaces()).rejects.toThrow(
        "Invalid response schema",
      );
    });

    it("rejects with a ShepherdClientError carrying the status on non-2xx", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          { error: "boom" },
          { status: 500, statusText: "Server Error" },
        ),
      );
      await expect(client.listWorkspaces()).rejects.toBeInstanceOf(
        ShepherdClientError,
      );
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          { error: "boom" },
          { status: 500, statusText: "Server Error" },
        ),
      );
      await expect(client.listWorkspaces()).rejects.toMatchObject({
        status: 500,
      });
    });

    it("fires onUnauthorized then throws a 401 on a 401 response", async () => {
      const onUnauthorized = vi.fn();
      const c = createShepherdClient({ baseUrl: BASE, onUnauthorized });
      fetchMock.mockResolvedValueOnce(
        jsonResponse(
          { error: "nope" },
          { status: 401, statusText: "Unauthorized" },
        ),
      );
      await expect(c.listWorkspaces()).rejects.toMatchObject({ status: 401 });
      expect(onUnauthorized).toHaveBeenCalledOnce();
    });
  });

  describe("createWorkspace", () => {
    it("POSTs /workspaces with a JSON body and returns the WorkspaceSummary", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(WORKSPACE_SUMMARY));
      const out = await client.createWorkspace({ name: "Acme" });
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/workspaces`);
      expect(init.method).toBe("POST");
      expect(header(init, "Content-Type")).toBe("application/json");
      expect(JSON.parse(init.body as string)).toEqual({ name: "Acme" });
      expect(out).toEqual(WORKSPACE_SUMMARY);
    });
  });

  describe("deleteWorkspace", () => {
    it("DELETEs /workspaces/:id, validates { deleted: true }, and sends NO JSON content-type", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ deleted: true }));
      const out = await client.deleteWorkspace("ws_1");
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/workspaces/ws_1`);
      expect(init.method).toBe("DELETE");
      // Bodyless: no body and no Content-Type (the empty-JSON-body 500 fix).
      expect(init.body).toBeUndefined();
      expect(header(init, "Content-Type")).toBeUndefined();
      expect(out).toEqual({ deleted: true });
    });
  });

  describe("mintToken", () => {
    it("POSTs /workspaces/:id/tokens and returns the MintTokenResponse", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ token: "shp_abc", id: "tok_1" }),
      );
      const out = await client.mintToken("ws_1", { name: "ci" });
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/workspaces/ws_1/tokens`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ name: "ci" });
      expect(out).toEqual({ token: "shp_abc", id: "tok_1" });
    });
  });

  describe("listTokens", () => {
    it("GETs /workspaces/:id/tokens and returns the ListTokensResponse", async () => {
      const token = {
        id: "tok_1",
        name: "ci",
        lastUsedAt: null,
        createdAt: "2026-06-29T00:00:00.000Z",
        revokedAt: null,
      };
      fetchMock.mockResolvedValueOnce(jsonResponse({ tokens: [token] }));
      const out = await client.listTokens("ws_1");
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/workspaces/ws_1/tokens`);
      expect(init.method).toBe("GET");
      expect(out).toEqual({ tokens: [token] });
    });
  });

  describe("revokeToken", () => {
    it("DELETEs /workspaces/:id/tokens/:tokenId (no schema validation)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
      await client.revokeToken("ws_1", "tok_1");
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/workspaces/ws_1/tokens/tok_1`);
      expect(init.method).toBe("DELETE");
    });
  });

  describe("mintAccountToken", () => {
    it("POSTs /tokens (no workspace segment) and returns the MintTokenResponse", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ token: "shp_abc", id: "tok_1" }),
      );
      const out = await client.mintAccountToken({ name: "ci" });
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/tokens`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ name: "ci" });
      expect(out).toEqual({ token: "shp_abc", id: "tok_1" });
    });
  });

  describe("listAccountTokens", () => {
    it("GETs /tokens (no workspace segment) and returns the ListTokensResponse", async () => {
      const token = {
        id: "tok_1",
        name: "ci",
        lastUsedAt: null,
        createdAt: "2026-06-29T00:00:00.000Z",
        revokedAt: null,
      };
      fetchMock.mockResolvedValueOnce(jsonResponse({ tokens: [token] }));
      const out = await client.listAccountTokens();
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/tokens`);
      expect(init.method).toBe("GET");
      expect(out).toEqual({ tokens: [token] });
    });
  });

  describe("revokeAccountToken", () => {
    it("DELETEs /tokens/:id (no workspace segment, no schema validation)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
      await client.revokeAccountToken("tok_1");
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/tokens/tok_1`);
      expect(init.method).toBe("DELETE");
    });
  });

  describe("createInvite", () => {
    it("POSTs /workspaces/:id/invites and returns the InviteResponse", async () => {
      const invite = {
        code: "inv_abc",
        expiresAt: null,
        maxUses: 5,
        useCount: 0,
      };
      fetchMock.mockResolvedValueOnce(jsonResponse(invite));
      const out = await client.createInvite("ws_1", { maxUses: 5 });
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/workspaces/ws_1/invites`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({ maxUses: 5 });
      expect(out).toEqual(invite);
    });
  });

  describe("revokeInvite", () => {
    it("POSTs /workspaces/:id/invites/:code/revoke (encodes the code)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
      await client.revokeInvite("ws_1", "a/b code");
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/workspaces/ws_1/invites/a%2Fb%20code/revoke`);
      expect(init.method).toBe("POST");
    });
  });

  describe("redeemInvite", () => {
    it("POSTs /invites/:code/redeem and returns the RedeemInviteResponse", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ workspace: WORKSPACE_SUMMARY }),
      );
      const out = await client.redeemInvite("inv_abc");
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/invites/inv_abc/redeem`);
      expect(init.method).toBe("POST");
      expect(out).toEqual({ workspace: WORKSPACE_SUMMARY });
    });
  });

  describe("listMembers", () => {
    it("GETs /workspaces/:id/members and returns the ListMembersResponse", async () => {
      const member = {
        accountId: "acc_1",
        displayName: "Dana",
        githubLogin: "dana",
        email: null,
        avatarUrl: null,
        role: "member" as const,
        isOwner: false,
      };
      fetchMock.mockResolvedValueOnce(jsonResponse({ members: [member] }));
      const out = await client.listMembers("ws_1");
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/workspaces/ws_1/members`);
      expect(init.method).toBe("GET");
      expect(out).toEqual({ members: [member] });
    });
  });

  describe("removeMember", () => {
    it("DELETEs /workspaces/:id/members/:accountId (encodes the accountId)", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
      await client.removeMember("ws_1", "acc/1");
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/workspaces/ws_1/members/acc%2F1`);
      expect(init.method).toBe("DELETE");
    });
  });

  describe("leave", () => {
    it("POSTs /workspaces/:id/leave with no body and NO JSON content-type", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
      await client.leave("ws_1");
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/workspaces/ws_1/leave`);
      expect(init.method).toBe("POST");
      // Regression guard: a bodyless POST must NOT advertise a JSON body, or the
      // hub's Fastify parser rejects the empty body (FST_ERR_CTP_EMPTY_JSON_BODY)
      // and the user sees an opaque HTTP 500 instead of a clean leave.
      expect(init.body).toBeUndefined();
      expect(header(init, "Content-Type")).toBeUndefined();
    });
  });

  describe("landscape", () => {
    it("GETs /workspaces/:id/landscape and returns the WorkspaceLandscapeResponse", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(LANDSCAPE));
      const out = await client.landscape("ws_1");
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/workspaces/ws_1/landscape`);
      expect(init.method).toBe("GET");
      expect(out).toEqual(LANDSCAPE);
    });
  });

  describe("announceTo", () => {
    it("POSTs /workspaces/:id/announce and returns the WorkspaceAnnounceResponse", async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ ok: true, announcementIds: [1, 2] }),
      );
      const out = await client.announceTo("ws_1", { body: "hello", repo: "r" });
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/workspaces/ws_1/announce`);
      expect(init.method).toBe("POST");
      expect(header(init, "Content-Type")).toBe("application/json");
      expect(JSON.parse(init.body as string)).toEqual({
        body: "hello",
        repo: "r",
      });
      expect(out).toEqual({ ok: true, announcementIds: [1, 2] });
    });
  });

  describe("submitFeedback", () => {
    it("POSTs /workspaces/:id/feedback when a workspaceId is given", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, id: "fb_1" }));
      const out = await client.submitFeedback(
        { type: "bug", body: "it's broken" },
        "ws_1",
      );
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/workspaces/ws_1/feedback`);
      expect(init.method).toBe("POST");
      expect(header(init, "Content-Type")).toBe("application/json");
      expect(JSON.parse(init.body as string)).toEqual({
        type: "bug",
        body: "it's broken",
      });
      expect(out).toEqual({ ok: true, id: "fb_1" });
    });

    it("POSTs the flat /feedback when no workspaceId is given", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true, id: "fb_2" }));
      const out = await client.submitFeedback({
        type: "suggestion",
        body: "add dark mode",
      });
      const [url, init] = lastCall();
      expect(url).toBe(`${BASE}/feedback`);
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body as string)).toEqual({
        type: "suggestion",
        body: "add dark mode",
      });
      expect(out).toEqual({ ok: true, id: "fb_2" });
    });
  });

  // --- encodeURIComponent on path params ----------------------------------

  describe("path-param encoding", () => {
    it("encodes the workspaceId segment", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse(LANDSCAPE));
      await client.landscape("ws/1 special");
      const [url] = lastCall();
      expect(url).toBe(`${BASE}/workspaces/ws%2F1%20special/landscape`);
    });

    it("encodes a tokenId with a special char", async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ ok: true }));
      await client.revokeToken("ws_1", "tok/1");
      const [url] = lastCall();
      expect(url).toBe(`${BASE}/workspaces/ws_1/tokens/tok%2F1`);
    });
  });

  // --- baseUrl exposure ---------------------------------------------------

  describe("baseUrl", () => {
    it("exposes the normalized baseUrl on the client", () => {
      expect(client.baseUrl).toBe(BASE);
    });

    it("strips a trailing slash in the exposed baseUrl", () => {
      const c = createShepherdClient({ baseUrl: `${BASE}/` });
      expect(c.baseUrl).toBe(BASE);
    });
  });
});

// --- baseUrl joining --------------------------------------------------------

describe("baseUrl joining", () => {
  it("does not double-slash when baseUrl has a trailing slash", async () => {
    const fm = vi.fn().mockResolvedValueOnce(jsonResponse({ workspaces: [] }));
    vi.stubGlobal("fetch", fm);
    const client = createShepherdClient({ baseUrl: `${BASE}/` });
    await client.listWorkspaces();
    expect(fm.mock.calls[0][0]).toBe(`${BASE}/workspaces`);
    vi.unstubAllGlobals();
  });

  it("supports same-origin ('') baseUrl producing a root-relative path", async () => {
    const fm = vi.fn().mockResolvedValueOnce(jsonResponse({ workspaces: [] }));
    vi.stubGlobal("fetch", fm);
    const client = createShepherdClient({ baseUrl: "" });
    await client.listWorkspaces();
    expect(fm.mock.calls[0][0]).toBe("/workspaces");
    vi.unstubAllGlobals();
  });
});

// --- getAuthHeader resolution: all three return shapes, sync + async --------

describe("getAuthHeader injection", () => {
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(jsonResponse({ workspaces: [] }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("merges a Bearer string into the Authorization header (sync)", async () => {
    const client = createShepherdClient({
      baseUrl: BASE,
      getAuthHeader: () => "Bearer team_tok",
    });
    await client.listWorkspaces();
    const [, init] = lastCall();
    expect(header(init, "Authorization")).toBe("Bearer team_tok");
  });

  it("merges a Bearer string returned asynchronously", async () => {
    const client = createShepherdClient({
      baseUrl: BASE,
      getAuthHeader: async () => "Bearer async_tok",
    });
    await client.listWorkspaces();
    const [, init] = lastCall();
    expect(header(init, "Authorization")).toBe("Bearer async_tok");
  });

  it("merges a header-map return", async () => {
    const client = createShepherdClient({
      baseUrl: BASE,
      getAuthHeader: () => ({
        Authorization: "Bearer map_tok",
        "X-Extra": "1",
      }),
    });
    await client.listWorkspaces();
    const [, init] = lastCall();
    expect(header(init, "Authorization")).toBe("Bearer map_tok");
    expect(header(init, "X-Extra")).toBe("1");
  });

  it("sends no auth header when getAuthHeader is omitted (same-origin BFF)", async () => {
    const client = createShepherdClient({ baseUrl: BASE });
    await client.listWorkspaces();
    const [, init] = lastCall();
    expect(header(init, "Authorization")).toBeUndefined();
  });

  it("sends no auth header when getAuthHeader resolves to undefined", async () => {
    const client = createShepherdClient({
      baseUrl: BASE,
      getAuthHeader: () => undefined,
    });
    await client.listWorkspaces();
    const [, init] = lastCall();
    expect(header(init, "Authorization")).toBeUndefined();
  });
});

// --- transport edge cases: network failure, error detail, abort/timeout -----
//
// These exercise the request() plumbing rather than a specific method, so they
// drive getLandscape() and manage their own fetch stub / fake timers per case.

describe("transport edge cases", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("announce accepts a nullable+optional body without rejecting it", async () => {
    const fm = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, announcementIds: [42] }));
    vi.stubGlobal("fetch", fm);
    const client = createShepherdClient({ baseUrl: BASE });

    // The client must NOT validate the request body; the full shape is forwarded.
    await expect(
      client.announce({ body: "hi", targetAgentName: null, repo: null }),
    ).resolves.toEqual({ ok: true, announcementIds: [42] });

    const init = fm.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe(
      JSON.stringify({ body: "hi", targetAgentName: null, repo: null }),
    );
  });

  it("throws a ShepherdClientError with NO status on a network failure", async () => {
    const fm = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fm);
    const client = createShepherdClient({ baseUrl: BASE });

    let caught: unknown;
    try {
      await client.getLandscape();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ShepherdClientError);
    expect((caught as ShepherdClientError).status).toBeUndefined();
  });

  it("throws status 500 (with upstream detail) and does NOT call onUnauthorized", async () => {
    const fm = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: "server boom" },
          { status: 500, statusText: "Server Error" },
        ),
      );
    vi.stubGlobal("fetch", fm);
    const onUnauthorized = vi.fn();
    const client = createShepherdClient({ baseUrl: BASE, onUnauthorized });

    let caught: unknown;
    try {
      await client.getLandscape();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ShepherdClientError);
    expect((caught as ShepherdClientError).status).toBe(500);
    // Best-effort upstream detail is surfaced in the message.
    expect((caught as ShepherdClientError).message).toContain("server boom");
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it("aborts a hung request after the default timeout and throws a status-less error", async () => {
    vi.useFakeTimers();
    try {
      // A fetch that resolves only if its abort signal fires — models a hung
      // request the client's own timeout must terminate.
      const fm = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new Error("The operation was aborted")),
            );
          }),
      );
      vi.stubGlobal("fetch", fm);

      const client = createShepherdClient({ baseUrl: BASE });
      // Capture the rejection as a value so advancing timers can't trip an
      // unhandled rejection before we assert on it.
      const settled = client.getLandscape().catch((e: unknown) => e);

      // Default timeout is 5000ms; crossing it fires controller.abort().
      await vi.advanceTimersByTimeAsync(5000);

      const caught = await settled;
      expect(caught).toBeInstanceOf(ShepherdClientError);
      expect((caught as ShepherdClientError).status).toBeUndefined();
      // The per-request timer is cleared in finally — none left pending.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honors a custom timeoutMs: in flight at t-1, aborted at t", async () => {
    vi.useFakeTimers();
    try {
      const fm = vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      );
      vi.stubGlobal("fetch", fm);

      const client = createShepherdClient({ baseUrl: BASE, timeoutMs: 1000 });
      const settled = client.getLandscape().catch((e: unknown) => e);

      // Just before the custom deadline the request is still in flight.
      await vi.advanceTimersByTimeAsync(999);
      expect(vi.getTimerCount()).toBe(1);

      // Crossing 1000ms aborts it.
      await vi.advanceTimersByTimeAsync(1);
      const caught = await settled;
      expect(caught).toBeInstanceOf(ShepherdClientError);
      expect((caught as ShepherdClientError).status).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT leak the timeout timer when getAuthHeader rejects (no request issued)", async () => {
    vi.useFakeTimers();
    try {
      const fm = vi.fn().mockResolvedValue(jsonResponse(LANDSCAPE));
      vi.stubGlobal("fetch", fm);

      const client = createShepherdClient({
        baseUrl: BASE,
        // An async auth source that rejects before any request goes out.
        getAuthHeader: () => Promise.reject(new Error("token fetch failed")),
      });

      const caught = await client.getLandscape().catch((e: unknown) => e);

      expect(caught).toBeInstanceOf(ShepherdClientError);
      // No request went out, and the abort timer was cleared, not leaked.
      expect(fm).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- describeError: error → human-friendly string ---------------------------

describe("describeError", () => {
  it("surfaces a ShepherdClientError's own message", () => {
    expect(describeError(new ShepherdClientError("HTTP 500: boom", 500))).toBe(
      "HTTP 500: boom",
    );
  });

  it("surfaces a plain Error's message", () => {
    expect(describeError(new Error("network down"))).toBe("network down");
  });

  it("falls back to a generic string for a non-Error value", () => {
    expect(describeError("oops")).toBe("Something went wrong.");
    expect(describeError(undefined)).toBe("Something went wrong.");
    expect(describeError({ weird: true })).toBe("Something went wrong.");
  });
});
