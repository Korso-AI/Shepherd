import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SelfHostApp } from "../src/selfhost.js";

/**
 * SelfHostApp: the token gate + self-host dashboard root — the ONE place a team
 * token is handled. These tests drive the REAL client (createShepherdClient) by
 * stubbing the global `fetch` the client calls, and exercise the token lifecycle
 * through localStorage["shepherd.token"]:
 *
 *  - no token -> gate; submit stores the token and mounts the polling dashboard.
 *  - pre-stored token -> skip the gate, mount the dashboard directly.
 *  - a 401 from the hub -> onUnauthorized clears the token and the gate returns.
 *
 * The token key MUST stay "shepherd.token" for back-compat with the legacy board.
 */

const TOKEN_KEY = "shepherd.token";

/** A minimal, empty-but-valid landscape payload the client's Zod parse accepts. */
function landscapeBody(): unknown {
  return {
    agents: [],
    tasks: [],
    announcements: [],
    serverTime: "2026-06-28T12:00:00.000Z",
  };
}

/** A `fetch`-shaped 200 JSON Response for the landscape poll. */
function okResponse(): Response {
  return new Response(JSON.stringify(landscapeBody()), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A `fetch`-shaped 401 Response (triggers the client's onUnauthorized). */
function unauthorizedResponse(): Response {
  return new Response(JSON.stringify({ error: "bad token" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}

describe("SelfHostApp", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("renders the gate when no token is stored, then mounts the dashboard on submit", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<SelfHostApp />);

    // No token -> the gate is shown, the dashboard is not.
    expect(screen.getByPlaceholderText("Team token")).toBeInTheDocument();
    expect(document.getElementById("board")).toBeNull();
    // No poll yet — the client is only built once a token exists.
    expect(fetchMock).not.toHaveBeenCalled();

    await user.type(screen.getByPlaceholderText("Team token"), "secret-token");
    await user.click(screen.getByRole("button", { name: "View" }));

    // The token is persisted under the back-compat key.
    expect(localStorage.getItem(TOKEN_KEY)).toBe("secret-token");
    // The dashboard mounts (gate gone, board present) and begins polling.
    await waitFor(() => {
      expect(document.getElementById("board")).not.toBeNull();
    });
    expect(screen.queryByPlaceholderText("Team token")).not.toBeInTheDocument();

    // The real client's fetch fired for /workspace/landscape with the bearer header.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/workspace/landscape");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer secret-token");

    // Self-host is single-workspace: it polls ONLY the singular alias and never
    // touches the plural/account surface (no `/workspaces` list, no per-id
    // landscape, no token-mint). Every request must be the singular alias.
    for (const [callUrl] of fetchMock.mock.calls) {
      expect(String(callUrl)).toContain("/workspace/landscape");
    }
  });

  it("skips the gate and mounts the dashboard when a token is pre-stored", async () => {
    localStorage.setItem(TOKEN_KEY, "pre-stored");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    render(<SelfHostApp />);

    // Gate is skipped; the board mounts directly.
    expect(screen.queryByPlaceholderText("Team token")).not.toBeInTheDocument();
    await waitFor(() => {
      expect(document.getElementById("board")).not.toBeNull();
    });
    expect(
      screen.getByRole("button", { name: "Sign out" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(String(fetchMock.mock.calls[0]![0])).toContain(
      "/workspace/landscape",
    );
  });

  it("clears a pre-stored token and returns to the gate when signing out", async () => {
    localStorage.setItem(TOKEN_KEY, "pre-stored");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();

    render(<SelfHostApp />);

    await waitFor(() => {
      expect(document.getElementById("board")).not.toBeNull();
    });

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(document.getElementById("board")).toBeNull();
    expect(screen.getByPlaceholderText("Team token")).toBeInTheDocument();
  });

  it("returns to the gate when signing out even if token removal throws", async () => {
    localStorage.setItem(TOKEN_KEY, "pre-stored");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
    const user = userEvent.setup();

    render(<SelfHostApp />);

    await waitFor(() => {
      expect(document.getElementById("board")).not.toBeNull();
    });

    await user.click(screen.getByRole("button", { name: "Sign out" }));

    expect(document.getElementById("board")).toBeNull();
    expect(screen.getByPlaceholderText("Team token")).toBeInTheDocument();
  });

  it("clears the token and returns to the gate when the hub responds 401", async () => {
    localStorage.setItem(TOKEN_KEY, "stale-token");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(unauthorizedResponse());
    vi.stubGlobal("fetch", fetchMock);

    render(<SelfHostApp />);

    // Mounts the dashboard with the stale token, polls, gets 401 -> the client's
    // onUnauthorized clears the token and resets state, re-rendering the gate.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByPlaceholderText("Team token")).toBeInTheDocument();
    });
    expect(document.getElementById("board")).toBeNull();
  });
});
