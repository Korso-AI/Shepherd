import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHubClient, HubUnreachable, HubRequestError } from "../src/hubClient.js";

const HUB_URL = "http://localhost:4000";
const TOKEN = "tok-abc123";

function makeClient() {
  return createHubClient({ hubUrl: HUB_URL, token: TOKEN });
}

describe("HubClient.post", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns parsed JSON on a 200 response", async () => {
    const mockResponse = { ok: true, status: 200, json: async () => ({ hello: "world" }) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const client = makeClient();
    const result = await client.post("/api/test", { foo: "bar" });
    expect(result).toEqual({ hello: "world" });

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:4000/api/test");
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${TOKEN}`);
    expect((opts.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(opts.body).toBe(JSON.stringify({ foo: "bar" }));
  });

  it("sends the configured bearer token regardless of its source", async () => {
    // The client treats its `token` opaquely — whether it came from SHEPHERD_TOKEN
    // or TEAM_TOKEN, whatever is passed in is what goes on the wire as the bearer.
    const mockResponse = { ok: true, status: 200, json: async () => ({}) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const client = createHubClient({ hubUrl: HUB_URL, token: "shp-hosted-cred" });
    await client.post("/join", {});

    const [, opts] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer shp-hosted-cred");
  });

  it("throws HubUnreachable on network/connection error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const client = makeClient();
    await expect(client.post("/api/test", {})).rejects.toThrow(HubUnreachable);
  });

  it("throws HubUnreachable on abort (timeout)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        const err = new DOMException("The operation was aborted.", "AbortError");
        return Promise.reject(err);
      })
    );

    const client = makeClient();
    await expect(client.post("/api/test", {})).rejects.toThrow(HubUnreachable);
  });

  it("throws HubRequestError with status on a non-2xx response", async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      json: async () => ({ error: "Internal Server Error" }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const client = makeClient();
    const err = await client.post("/api/test", {}).catch((e) => e);
    expect(err).toBeInstanceOf(HubRequestError);
    expect((err as HubRequestError).status).toBe(500);
  });

  it("includes the hub's error body in the HubRequestError message", async () => {
    const mockResponse = {
      ok: false,
      status: 400,
      json: async () => ({ error: "No live agent named 'Maeriyn' in this repo." }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const client = makeClient();
    const err = await client.post("/announce", {}).catch((e) => e);
    expect(err).toBeInstanceOf(HubRequestError);
    expect((err as HubRequestError).message).toContain(
      "No live agent named 'Maeriyn' in this repo."
    );
  });

  it("tolerates a non-JSON error body", async () => {
    const mockResponse = {
      ok: false,
      status: 502,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const client = makeClient();
    const err = await client.post("/announce", {}).catch((e) => e);
    expect(err).toBeInstanceOf(HubRequestError);
    expect((err as HubRequestError).status).toBe(502);
  });

  it("throws HubRequestError with status on a 401 response", async () => {
    const mockResponse = { ok: false, status: 401, json: async () => ({ error: "Unauthorized" }) };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const client = makeClient();
    const err = await client.post("/api/session", {}).catch((e) => e);
    expect(err).toBeInstanceOf(HubRequestError);
    expect((err as HubRequestError).status).toBe(401);
  });
});
