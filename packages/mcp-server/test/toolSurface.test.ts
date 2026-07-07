import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerTools } from "../src/tools.js";
import type { HubClient } from "../src/hubClient.js";
import type { Config } from "../src/config.js";
import type { JoinContext } from "../src/resolveContext.js";
import type { Heartbeat } from "../src/heartbeat.js";

// ---------------------------------------------------------------------------
// Fake McpServer whose registerTool returns an SDK-like RegisteredTool handle
// (enable/disable + enabled flag), so we can assert which tools are exposed.
// The other tool test files return nothing from registerTool — tools.ts must
// tolerate that (optional chaining), which this file's handles also verify by
// exercising the real toggling path.
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
  enabled: boolean;
  enableCalls: number;
  disableCalls: number;
  enable(): void;
  disable(): void;
}

function makeFakeServer() {
  const tools: Record<string, CapturedTool> = {};
  const server = {
    registerTool(
      name: string,
      def: ToolDef,
      handler: ToolHandler,
    ): CapturedTool {
      const tool: CapturedTool = {
        name,
        def,
        handler,
        enabled: true,
        enableCalls: 0,
        disableCalls: 0,
        enable() {
          this.enabled = true;
          this.enableCalls++;
        },
        disable() {
          this.enabled = false;
          this.disableCalls++;
        },
      };
      tools[name] = tool;
      return tool;
    },
  };
  return { server, tools };
}

// ---------------------------------------------------------------------------
// Fixtures (mirroring linkTools.test.ts)
// ---------------------------------------------------------------------------

/** Every tool that must disappear in a declined repo. `link` never hides. */
const GATED = [
  "work",
  "done",
  "announce",
  "sync",
  "unlink",
  "decline",
] as const;

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "shepherd-surface-"));
  writeFileSync(join(dir, ".git"), "gitdir: x\n", "utf8");
  return dir;
}

function freshDeclinedDir(): string {
  return mkdtempSync(join(tmpdir(), "shepherd-surface-declined-"));
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

const declinedContext: JoinContext = {
  ...unansweredContext,
  declined: true,
  linkState: "declined",
};

const linkedContext: JoinContext = {
  ...unansweredContext,
  workspace: "foo",
  linked: true,
  linkState: "linked",
};

function setup(context: JoinContext) {
  const post = vi.fn().mockResolvedValue(JOIN_OK);
  const get = vi.fn().mockResolvedValue({
    workspaces: [
      { id: "id-0", slug: "foo", name: "foo", role: "member" as const },
    ],
  });
  const hubClient = { post, get } as unknown as HubClient;
  const heartbeat: Heartbeat = { start: vi.fn(), stop: vi.fn() };
  const { server, tools } = makeFakeServer();
  const { ready } = registerTools(server as never, {
    hubClient,
    config: hostedConfig,
    context,
    heartbeat,
    cwd: freshRepo(),
    declinedDir: freshDeclinedDir(),
  });
  return { tools, ready };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("tool surface by link state", () => {
  it("declined repo exposes ONLY `link` — every coordination tool is disabled", async () => {
    const { tools, ready } = setup(declinedContext);
    await ready;

    for (const name of GATED) {
      expect(tools[name].enabled, name).toBe(false);
    }
    expect(tools["link"].enabled).toBe(true);
  });

  it("never-asked repo keeps the FULL surface so advisories still deliver", async () => {
    const { tools, ready } = setup(unansweredContext);
    await ready;

    for (const name of [...GATED, "link"]) {
      expect(tools[name].enabled, name).toBe(true);
    }
  });

  it("linked repo keeps the full surface, with no spurious enable/disable churn", async () => {
    const { tools, ready } = setup(linkedContext);
    await ready;

    for (const name of [...GATED, "link"]) {
      expect(tools[name].enabled, name).toBe(true);
      // No list_changed noise: the surface starts visible and stays visible.
      expect(tools[name].enableCalls + tools[name].disableCalls, name).toBe(0);
    }
  });

  it("hot decline hides the coordination tools mid-session (link stays)", async () => {
    const { tools, ready } = setup(unansweredContext);
    await ready;

    await tools["decline"].handler({});

    for (const name of GATED) {
      expect(tools[name].enabled, name).toBe(false);
    }
    expect(tools["link"].enabled).toBe(true);
  });

  it("hot link from a declined repo restores the full surface (no restart)", async () => {
    const { tools, ready } = setup(declinedContext);
    await ready;
    expect(tools["work"].enabled).toBe(false);

    await tools["link"].handler({ workspace: "foo" });

    for (const name of [...GATED, "link"]) {
      expect(tools[name].enabled, name).toBe(true);
    }
  });

  it("unlink hides the coordination tools (repo is now declined)", async () => {
    const { tools, ready } = setup(linkedContext);
    await ready;

    await tools["unlink"].handler({});

    for (const name of GATED) {
      expect(tools[name].enabled, name).toBe(false);
    }
    expect(tools["link"].enabled).toBe(true);
  });

  it("decline → link → decline round-trips without leaving stale state", async () => {
    const { tools, ready } = setup(unansweredContext);
    await ready;

    await tools["decline"].handler({});
    expect(tools["work"].enabled).toBe(false);

    await tools["link"].handler({ workspace: "foo" });
    expect(tools["work"].enabled).toBe(true);

    await tools["unlink"].handler({});
    expect(tools["work"].enabled).toBe(false);
    expect(tools["link"].enabled).toBe(true);
  });
});
