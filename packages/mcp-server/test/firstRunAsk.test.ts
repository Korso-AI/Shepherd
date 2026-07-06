import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerTools } from "../src/tools.js";
import { readMarker } from "../src/marker.js";
import { isDeclined } from "../src/declined.js";
import { NEVER_ASK_CHOICE, type ElicitFn } from "../src/linkPopup.js";
import type { EditTripwire } from "../src/editTripwire.js";
import type { HubClient } from "../src/hubClient.js";
import type { Config } from "../src/config.js";
import type { JoinContext } from "../src/resolveContext.js";
import type { Heartbeat } from "../src/heartbeat.js";

// End-to-end wiring of the zero-setup first-run ask inside registerTools:
// tripwire fires → capability check → popup → accepted answer recorded via the
// SAME paths the link/decline tools use (marker, declined store, hot activate,
// tool surface), plus the post-link procedure staged in the inbox.

type ToolDef = { title?: string; description?: string; inputSchema: unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolHandler = (args: any) => Promise<any>;
interface CapturedTool {
  name: string;
  handler: ToolHandler;
  enabled: boolean;
  enable(): void;
  disable(): void;
}

function makeFakeServer() {
  const tools: Record<string, CapturedTool> = {};
  const server = {
    registerTool(name: string, _def: ToolDef, handler: ToolHandler): CapturedTool {
      const tool: CapturedTool = {
        name,
        handler,
        enabled: true,
        enable() {
          this.enabled = true;
        },
        disable() {
          this.enabled = false;
        },
      };
      tools[name] = tool;
      return tool;
    },
  };
  return { server, tools };
}

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-ask-"));
  writeFileSync(join(dir, ".git"), "gitdir: x\n", "utf8");
  return dir;
}

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
} as Config;

const unansweredContext: JoinContext = {
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

/** A hand-fired tripwire: exposes the captured onEdits and records lifecycle. */
function fakeTripwireFactory() {
  const state = {
    started: 0,
    stopped: 0,
    fire: undefined as undefined | (() => void),
  };
  const create = (opts: { cwd: string; onEdits: () => void }): EditTripwire => {
    state.fire = opts.onEdits;
    return {
      start() {
        state.started++;
      },
      stop() {
        state.stopped++;
      },
    };
  };
  return { state, create };
}

function setup(opts?: {
  context?: JoinContext;
  elicit?: ElicitFn;
  capabilities?: { elicitation?: unknown } | undefined;
  slugs?: string[];
}) {
  const cwd = freshRepo();
  const declinedDir = mkdtempSync(join(tmpdir(), "shepherd-ask-declined-"));
  const inboxFile = join(mkdtempSync(join(tmpdir(), "shepherd-ask-inbox-")), "inbox.jsonl");
  const post = vi.fn().mockResolvedValue(JOIN_OK);
  const slugs = opts?.slugs ?? ["team-alpha"];
  const get = vi.fn().mockResolvedValue({
    workspaces: slugs.map((slug, i) => ({ id: `id-${i}`, slug, name: slug, role: "member" })),
  });
  const hubClient = { post, get } as unknown as HubClient;
  const heartbeat: Heartbeat = { start: vi.fn(), stop: vi.fn() };
  const { server, tools } = makeFakeServer();
  const tw = fakeTripwireFactory();
  const elicit =
    opts?.elicit ??
    (vi.fn(async () => ({
      action: "accept",
      content: { decision: "team-alpha" },
    })) as ElicitFn);
  const capabilities = "capabilities" in (opts ?? {}) ? opts?.capabilities : { elicitation: {} };

  const { ready } = registerTools(server as never, {
    hubClient,
    config: hostedConfig,
    context: opts?.context ?? unansweredContext,
    heartbeat,
    inboxFile,
    cwd,
    declinedDir,
    firstRunAsk: {
      createTripwire: tw.create,
      elicit,
      getClientCapabilities: () => capabilities,
    },
  });

  /** Fire the tripwire and let the async popup flow settle. */
  async function fireAndSettle(): Promise<void> {
    tw.state.fire?.();
    await vi.waitFor(() => {
      // The flow always ends by either recording something or bailing; give the
      // microtask chain a few turns.
    });
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  }

  return { tools, tw, elicit, post, get, heartbeat, ready, cwd, declinedDir, inboxFile, fireAndSettle };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("first-run ask wiring", () => {
  it("arms the tripwire ONLY in never-asked repos", () => {
    const unanswered = setup();
    expect(unanswered.tw.state.started).toBe(1);

    const linked = setup({
      context: { ...unansweredContext, workspace: "foo", linked: true, linkState: "linked" },
    });
    expect(linked.tw.state.started).toBe(0);

    const declined = setup({
      context: { ...unansweredContext, declined: true, linkState: "declined" },
    });
    expect(declined.tw.state.started).toBe(0);
  });

  it("accepted workspace → marker written, hot-activated, procedure staged in inbox", async () => {
    const s = setup();
    await s.ready;
    await s.fireAndSettle();

    // Recorded exactly like `link team-alpha`:
    expect(readMarker(s.cwd)).toEqual({ workspace: "team-alpha" });
    expect(s.post).toHaveBeenCalledWith("/join", expect.objectContaining({ workspace: "team-alpha" }));
    expect(s.heartbeat.start).toHaveBeenCalledOnce();
    expect(isDeclined(s.cwd, s.declinedDir)).toBe(false);

    // The agent (which saw none of the popup) gets its procedure via the inbox.
    expect(existsSync(s.inboxFile)).toBe(true);
    const staged = readFileSync(s.inboxFile, "utf8");
    expect(staged).toContain("team-alpha");
    expect(staged).toContain("work");
  });

  it(`accepted "${NEVER_ASK_CHOICE}" → decline recorded and tool surface hidden`, async () => {
    const s = setup({
      elicit: vi.fn(async () => ({
        action: "accept",
        content: { decision: NEVER_ASK_CHOICE },
      })),
    });
    await s.ready;
    await s.fireAndSettle();

    expect(isDeclined(s.cwd, s.declinedDir)).toBe(true);
    expect(readMarker(s.cwd)).toBeNull();
    // Layer 0 kicks in live: coordination tools disappear, link stays.
    expect(s.tools["work"].enabled).toBe(false);
    expect(s.tools["link"].enabled).toBe(true);
    // The tripwire is disarmed by the settle.
    expect(s.tw.state.stopped).toBeGreaterThan(0);
  });

  it("popup declined/dismissed → NOTHING recorded (asked again next session)", async () => {
    const s = setup({ elicit: vi.fn(async () => ({ action: "decline" })) });
    await s.ready;
    await s.fireAndSettle();

    expect(readMarker(s.cwd)).toBeNull();
    expect(isDeclined(s.cwd, s.declinedDir)).toBe(false);
    expect(s.tools["work"].enabled).toBe(true); // full surface stays
    expect(existsSync(s.inboxFile)).toBe(false); // no guidance staged
  });

  it("client without the elicitation capability → popup never attempted", async () => {
    const elicit = vi.fn(async () => ({ action: "accept", content: { decision: "team-alpha" } }));
    const s = setup({ elicit, capabilities: undefined });
    await s.ready;
    await s.fireAndSettle();

    expect(elicit).not.toHaveBeenCalled();
    expect(readMarker(s.cwd)).toBeNull();
  });

  it("agent-mediated link BEFORE the tripwire fires → fire is a no-op", async () => {
    const s = setup();
    await s.ready;

    await s.tools["link"].handler({ workspace: "team-alpha" });
    expect(s.tw.state.stopped).toBeGreaterThan(0); // settled → disarmed

    const elicitCallsBefore = (s.elicit as ReturnType<typeof vi.fn>).mock.calls.length;
    await s.fireAndSettle();
    expect((s.elicit as ReturnType<typeof vi.fn>).mock.calls.length).toBe(elicitCallsBefore);
  });

  it("agent-mediated decline disarms the tripwire", async () => {
    const s = setup();
    await s.ready;

    await s.tools["decline"].handler({});
    expect(s.tw.state.stopped).toBeGreaterThan(0);
  });
});
