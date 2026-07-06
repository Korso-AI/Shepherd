import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// link/unlink operate on the repo-local `.shepherd` marker. marker.ts walks up
// to the git root; in these tests the temp dir IS the repo root, so we drop a
// `.git` marker dir in each fresh temp cwd so findRepoRoot resolves there.
import { registerTools } from "../src/tools.js";
import { readMarker } from "../src/marker.js";
import { isDeclined } from "../src/declined.js";
import { HubUnreachable, HubRequestError } from "../src/hubClient.js";
import type { HubClient } from "../src/hubClient.js";
import type { Config } from "../src/config.js";
import type { JoinContext } from "../src/resolveContext.js";
import type { Heartbeat } from "../src/heartbeat.js";

// ---------------------------------------------------------------------------
// Fake McpServer (mirrors tools.test.ts)
// ---------------------------------------------------------------------------

type ToolDef = {
  title?: string;
  description?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: any;
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (args: any) => Promise<any>;
interface CapturedTool {
  name: string;
  def: ToolDef;
  handler: ToolHandler;
}

function makeFakeServer() {
  const tools: Record<string, CapturedTool> = {};
  const server = {
    registerTool(name: string, def: ToolDef, handler: ToolHandler) {
      tools[name] = { name, def, handler };
    },
  };
  return { server, tools };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A fresh throwaway repo root (with a `.git` dir) used as the marker cwd. */
function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-link-"));
  // findRepoRoot looks for a `.git` entry; make one so marker writes land here.
  writeFileSync(join(dir, ".git"), "gitdir: x\n", "utf8");
  return dir;
}

/** A fresh throwaway dir for the per-repo declined store (never touches ~). */
function freshDeclinedDir(): string {
  return mkdtempSync(join(tmpdir(), "shepherd-declined-"));
}

/** A join response the hub returns on a successful /join (mirrors tools.test). */
const JOIN_OK = {
  agentName: "agent-auto",
  sessionId: "00000000-0000-0000-0000-0000000000aa",
};

const hostedConfig: Config = {
  HUB_URL: "http://hub.test",
  SHEPHERD_TOKEN: "shp_test",
  authToken: "shp_test",
  WORKSPACE: undefined,
  REPO: "my-repo",
  BRANCH: "main",
  HUMAN: "alice",
  PROGRAM: "shepherd",
  MODEL: "claude-test",
  HEARTBEAT_INTERVAL_SECONDS: 60,
  SHEPHERD_NO_AUTO_HOOKS: false,
};

const selfHostConfig: Config = {
  HUB_URL: "http://hub.test",
  TEAM_TOKEN: "team_test",
  authToken: "team_test",
  WORKSPACE: "team-alpha",
  REPO: "my-repo",
  BRANCH: "main",
  HUMAN: "alice",
  PROGRAM: "shepherd",
  MODEL: "claude-test",
  HEARTBEAT_INTERVAL_SECONDS: 60,
  SHEPHERD_NO_AUTO_HOOKS: false,
};

const unlinkedContext: JoinContext = {
  workspace: "default",
  repo: "ctx-repo",
  branch: "feat/ctx",
  human: "ctx-human",
  program: "claude-code",
  model: undefined,
  linked: false,
  declined: false,
  linkState: "unanswered",
};

/** Build a workspaces-list response as `GET /workspaces` returns it. */
function workspacesResponse(...slugs: string[]) {
  return {
    workspaces: slugs.map((slug, i) => ({
      id: `id-${i}`,
      slug,
      name: slug,
      role: "member" as const,
    })),
  };
}

/**
 * Register the tools with a stub hub client and a controllable cwd. The link
 * tools must work while UNLINKED (dormant gate exemption), so the default
 * context here is unlinked and the join is a no-op (no mockPost call consumed).
 */
function setup(opts?: {
  config?: Config;
  context?: JoinContext;
  cwd?: string;
  declinedDir?: string;
  get?: (path: string) => Promise<unknown>;
  getError?: Error;
  /** Implementation for hubClient.post (/join etc). Defaults to a successful join. */
  post?: (path: string, body: unknown) => Promise<unknown>;
}) {
  const cwd = opts?.cwd ?? freshRepo();
  const declinedDir = opts?.declinedDir ?? freshDeclinedDir();
  const post = vi.fn();
  if (opts?.post) {
    post.mockImplementation(opts.post);
  } else {
    post.mockResolvedValue(JOIN_OK);
  }
  const get = vi.fn();
  if (opts?.getError) {
    get.mockRejectedValue(opts.getError);
  } else if (opts?.get) {
    get.mockImplementation(opts.get);
  }
  const hubClient = { post, get } as unknown as HubClient;
  const heartbeat: Heartbeat = { start: vi.fn(), stop: vi.fn() };
  const { server, tools } = makeFakeServer();
  const { ready } = registerTools(server as any, {
    hubClient,
    config: opts?.config ?? hostedConfig,
    context: opts?.context ?? unlinkedContext,
    heartbeat,
    // The link tools must resolve the marker against THIS dir, not process.cwd().
    cwd,
    // Per-repo declined store isolated to a temp dir (never touches ~/.shepherd).
    declinedDir,
  } as any);
  return { tools, post, get, heartbeat, ready, cwd, declinedDir };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("link / unlink tools", () => {
  it("registers link and unlink tools", () => {
    const { tools } = setup();
    expect(tools["link"]).toBeDefined();
    expect(tools["unlink"]).toBeDefined();
  });

  // ---- dormant-gate exemption ------------------------------------------------

  it("link and unlink are NOT blocked by the not-linked dormant gate", async () => {
    const { tools, ready } = setup({
      get: async () => workspacesResponse("foo", "bar"),
    });
    await ready;

    const linkResult = await tools["link"].handler({});
    expect(linkResult.isError).toBeUndefined();
    // The not-linked advisory text must NOT be what link returns.
    expect(linkResult.content[0].text.toLowerCase()).not.toContain(
      "run `link` to choose",
    );

    const unlinkResult = await tools["unlink"].handler({});
    expect(unlinkResult.isError).toBeUndefined();
  });

  // ---- hosted: no arg → list memberships, write nothing ----------------------

  it("hosted link with no arg lists both memberships and writes NO marker", async () => {
    const { tools, get, ready, cwd } = setup({
      get: async () => workspacesResponse("foo", "bar"),
    });
    await ready;

    const result = await tools["link"].handler({});
    const text: string = result.content[0].text;

    expect(get).toHaveBeenCalledWith("/workspaces");
    expect(text).toContain("foo");
    expect(text).toContain("bar");
    // No marker was written.
    expect(readMarker(cwd)).toBeNull();
  });

  // ---- hosted: member slug → marker written ----------------------------------

  it("hosted link with a member slug writes the marker AND activates now (no restart)", async () => {
    const { tools, post, heartbeat, ready, cwd } = setup({
      get: async () => workspacesResponse("foo", "bar"),
    });
    await ready;

    const result = await tools["link"].handler({ workspace: "foo" });
    const text: string = result.content[0].text.toLowerCase();

    expect(text).toContain("coordinat");
    // No "restart the session" wording — linking takes effect hot.
    expect(text).not.toMatch(/restart|next launch|next session/);
    expect(readMarker(cwd)).toEqual({ workspace: "foo" });
    // Activated in-process: /join was POSTed and the heartbeat started.
    expect(post).toHaveBeenCalledWith("/join", expect.objectContaining({ workspace: "foo" }));
    expect(heartbeat.start).toHaveBeenCalledOnce();
  });

  // ---- hosted: non-member slug → rejected, no marker -------------------------

  it("hosted link with a NON-member slug is rejected and writes NO marker", async () => {
    const { tools, ready, cwd } = setup({
      get: async () => workspacesResponse("foo", "baz"),
    });
    await ready;

    const result = await tools["link"].handler({ workspace: "bar" });
    const text: string = result.content[0].text;

    expect(text.toLowerCase()).toContain("not a member");
    // Lists the valid choices.
    expect(text).toContain("foo");
    expect(text).toContain("baz");
    expect(readMarker(cwd)).toBeNull();
  });

  // ---- unlink round-trip -----------------------------------------------------

  it("unlink removes the marker (link → read → unlink → read null)", async () => {
    const { tools, ready, cwd } = setup({
      get: async () => workspacesResponse("foo"),
    });
    await ready;

    await tools["link"].handler({ workspace: "foo" });
    expect(readMarker(cwd)).toEqual({ workspace: "foo" });

    const result = await tools["unlink"].handler({});
    expect(result.content[0].text.toLowerCase()).toContain("unlinked");
    expect(readMarker(cwd)).toBeNull();
  });

  // ---- self-host: offers/writes only ALLOWED_WORKSPACE -----------------------

  it("self-host link with no arg auto-picks the sole configured workspace and skips the hub list", async () => {
    const { tools, get, post, heartbeat, ready, cwd } = setup({
      config: selfHostConfig,
      get: async () => {
        throw new Error("hub should not be called to LIST in self-host");
      },
    });
    await ready;

    const result = await tools["link"].handler({});
    const text: string = result.content[0].text;

    // Self-host has exactly ONE workspace, so no-arg auto-picks it (no ask).
    expect(get).not.toHaveBeenCalled();
    expect(text).toContain("team-alpha");
    expect(text.toLowerCase()).toContain("coordinat");
    expect(readMarker(cwd)).toEqual({ workspace: "team-alpha" });
    // Activated hot: /join POSTed with the sole workspace, heartbeat started.
    expect(post).toHaveBeenCalledWith("/join", expect.objectContaining({ workspace: "team-alpha" }));
    expect(heartbeat.start).toHaveBeenCalledOnce();
  });

  it("self-host link with the matching slug writes the marker", async () => {
    const { tools, ready, cwd } = setup({ config: selfHostConfig });
    await ready;

    await tools["link"].handler({ workspace: "team-alpha" });
    expect(readMarker(cwd)).toEqual({ workspace: "team-alpha" });
  });

  it("self-host link with a non-matching slug is rejected, no marker, no hub call", async () => {
    const { tools, get, ready, cwd } = setup({ config: selfHostConfig });
    await ready;

    const result = await tools["link"].handler({ workspace: "team-beta" });
    expect(result.content[0].text).toContain("team-alpha");
    expect(get).not.toHaveBeenCalled();
    expect(readMarker(cwd)).toBeNull();
  });

  // ---- single-workspace auto-pick (hosted) -----------------------------------

  it("hosted link no-arg auto-picks the SOLE workspace, writes marker, activates — no ask", async () => {
    const { tools, get, post, heartbeat, ready, cwd } = setup({
      get: async () => workspacesResponse("solo"),
    });
    await ready;

    const result = await tools["link"].handler({});
    const text: string = result.content[0].text.toLowerCase();

    expect(get).toHaveBeenCalledWith("/workspaces");
    expect(text).toContain("solo");
    expect(text).toContain("coordinat");
    // Single workspace → auto-picked, never asks the user to choose.
    expect(text).not.toContain("which");
    expect(readMarker(cwd)).toEqual({ workspace: "solo" });
    expect(post).toHaveBeenCalledWith("/join", expect.objectContaining({ workspace: "solo" }));
    expect(heartbeat.start).toHaveBeenCalledOnce();
  });

  // ---- multi-workspace ask (hosted) ------------------------------------------

  it("hosted link no-arg with MULTIPLE workspaces asks the user and writes nothing", async () => {
    const { tools, post, ready, cwd } = setup({
      get: async () => workspacesResponse("foo", "bar"),
    });
    await ready;

    const result = await tools["link"].handler({});
    const text: string = result.content[0].text;

    expect(text).toContain("foo");
    expect(text).toContain("bar");
    // Instructs the agent to ASK the user which, then call `link <slug>`.
    expect(text.toLowerCase()).toMatch(/ask|which/);
    expect(text).toContain("link");
    // Nothing chosen yet: no marker, no join.
    expect(readMarker(cwd)).toBeNull();
    expect(post).not.toHaveBeenCalled();
  });

  // ---- marker-write ordering: marker persists even if activation fails --------

  it("link <slug> writes the marker EVEN IF /join fails, so a later session inherits it", async () => {
    const { tools, post, ready, cwd } = setup({
      get: async () => workspacesResponse("foo"),
      post: async () => {
        throw new HubRequestError(503, "Hub returned HTTP 503 for /join: Service Unavailable");
      },
    });
    await ready;

    const result = await tools["link"].handler({ workspace: "foo" });

    // The marker is written despite the failed hot activation.
    expect(readMarker(cwd)).toEqual({ workspace: "foo" });
    expect(post).toHaveBeenCalledWith("/join", expect.objectContaining({ workspace: "foo" }));
    // Fail-open advisory, never a crash.
    expect(result.isError).toBeUndefined();
  });

  // ---- decline ---------------------------------------------------------------

  it("registers a decline tool that is NOT blocked by the coordination gate", async () => {
    const { tools } = setup();
    expect(tools["decline"]).toBeDefined();
    const result = await tools["decline"].handler({});
    expect(result.isError).toBeUndefined();
  });

  it("decline records local declined state (keyed by the repo root)", async () => {
    const { tools, cwd, declinedDir } = setup();

    const result = await tools["decline"].handler({});
    const text: string = result.content[0].text.toLowerCase();

    expect(text).toMatch(/won't|declin|change your mind/);
    expect(isDeclined(cwd, declinedDir)).toBe(true);
  });

  it("link <slug> clears a prior decline (choosing overrides decline)", async () => {
    const { tools, cwd, declinedDir, ready } = setup({
      get: async () => workspacesResponse("foo"),
    });
    await ready;

    await tools["decline"].handler({});
    expect(isDeclined(cwd, declinedDir)).toBe(true);

    await tools["link"].handler({ workspace: "foo" });
    expect(isDeclined(cwd, declinedDir)).toBe(false);
    expect(readMarker(cwd)).toEqual({ workspace: "foo" });
  });

  it("unlink removes the marker AND records a decline so it won't re-prompt", async () => {
    const { tools, cwd, declinedDir, ready } = setup({
      get: async () => workspacesResponse("foo"),
    });
    await ready;

    await tools["link"].handler({ workspace: "foo" });
    expect(isDeclined(cwd, declinedDir)).toBe(false);

    await tools["unlink"].handler({});
    expect(readMarker(cwd)).toBeNull();
    expect(isDeclined(cwd, declinedDir)).toBe(true);
  });

  // ---- hot activation opens the gate in the SAME process ---------------------

  it("link <slug> activates hot: a subsequent `work` succeeds in the same process (no restart)", async () => {
    const workLandscape = { conflicts: [], activeClaims: [], announcements: [] };
    const { tools, post, ready } = setup({
      get: async () => workspacesResponse("foo"),
      post: async (path: string) => {
        if (path === "/join") return JOIN_OK;
        if (path === "/work") return { workItemId: "wi", landscape: workLandscape };
        throw new Error(`unexpected post ${path}`);
      },
    });
    await ready;

    const linkResult = await tools["link"].handler({ workspace: "foo" });
    expect(linkResult.isError).toBeUndefined();

    // No restart: the gate is now open, so work coordinates against the live session.
    const workResult = await tools["work"].handler({ intent: "hot", pathGlobs: ["src/**"] });
    expect(workResult.isError).toBeUndefined();
    expect(workResult.content[0].text).not.toContain("isn't linked");
    expect(post).toHaveBeenCalledWith("/work", expect.objectContaining({ intent: "hot" }));
  });

  // ---- unlink tears the live session down (symmetric to activate) ------------

  it("unlink of a linked/active repo stops the heartbeat, leaves the hub, and clears the session", async () => {
    const linkedContext: JoinContext = {
      ...unlinkedContext,
      workspace: "foo",
      linked: true,
      linkState: "linked",
    };
    const { tools, post, heartbeat, ready } = setup({
      context: linkedContext,
      post: async () => JOIN_OK,
    });
    await ready;

    // Booted active: /join happened and the heartbeat started.
    expect(post).toHaveBeenCalledWith("/join", expect.objectContaining({ workspace: "foo" }));
    expect(heartbeat.start).toHaveBeenCalledOnce();

    await tools["unlink"].handler({});

    // Presence torn down NOW: heartbeat stopped + /leave attempted.
    expect(heartbeat.stop).toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith("/leave", expect.anything());

    // Session cleared: a subsequent coordination tool no longer POSTs /work.
    post.mockClear();
    const work = await tools["work"].handler({ intent: "x", pathGlobs: ["src/**"] });
    expect(work.isError).toBeUndefined();
    expect(post).not.toHaveBeenCalledWith("/work", expect.anything());
  });

  // ---- decline is a no-op guard while already linked -------------------------

  it("decline while already linked advises `unlink` and writes NO decline", async () => {
    const linkedContext: JoinContext = {
      ...unlinkedContext,
      workspace: "foo",
      linked: true,
      linkState: "linked",
    };
    const { tools, cwd, declinedDir, ready } = setup({
      context: linkedContext,
      post: async () => JOIN_OK,
    });
    await ready;

    const result = await tools["decline"].handler({});
    const text: string = result.content[0].text.toLowerCase();
    expect(text).toContain("already coordinating");
    expect(text).toContain("unlink");
    // No decline written — it would be wiped on the next boot's activation anyway.
    expect(isDeclined(cwd, declinedDir)).toBe(false);
  });

  // ---- fail-open on hub-unreachable ------------------------------------------

  it("hosted link fails open with an advisory (not a crash) when the hub is unreachable", async () => {
    const { tools, ready, cwd } = setup({
      getError: new HubUnreachable("Connection refused at /workspaces"),
    });
    await ready;

    const result = await tools["link"].handler({});
    expect(result.isError).toBeUndefined();
    // Fail-open advisory: surfaces the reach failure, link unchanged, no crash.
    expect(result.content[0].text.toLowerCase()).toMatch(/couldn't reach|unreachable|link not changed/);
    expect(readMarker(cwd)).toBeNull();
  });
});
