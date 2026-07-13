#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createHubClient } from "./hubClient.js";
import { registerTools } from "./tools.js";
import { resolveContext } from "./resolveContext.js";
import { createHeartbeat } from "./heartbeat.js";
import { buildChangeReport } from "./changeReport.js";
import { buildInstructions } from "./instructions.js";
import {
  appendAnnouncements,
  defaultInboxDir,
  sessionMailboxPath,
  writeMailboxMeta,
  removeMailboxMeta,
} from "./inbox.js";
import { quickChain, ancestorChain } from "./processTree.js";
import { autoInstallHooks } from "./hookInstall.js";
import { PACKAGE_VERSION } from "./version.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const hubClient = createHubClient({
    hubUrl: config.HUB_URL,
    token: config.authToken,
  });
  // Resolve the startup-stable identity (env → git detection → fallbacks).
  const context = await resolveContext(config);

  // Announcement push (default-on). The background heartbeat asks the hub for
  // pending announcements and stages them in this SESSION's mailbox (see
  // inbox.ts's session mailboxes section); that single file is then drained
  // both by the Shepherd tool calls (universal delivery — every client, on the
  // next work/sync/done/announce) and, where available, by a client hook that
  // pairs itself to this mailbox by process ancestry — per session, so two
  // agents in one directory can't steal each other's messages, and a mid-
  // session directory change (worktrees) strands nothing.
  // SHEPHERD_INBOX_DIR overrides the default root (a per-user dir under $HOME).
  const inboxDir = config.SHEPHERD_INBOX_DIR ?? defaultInboxDir();
  const inboxFile = sessionMailboxPath(inboxDir, process.pid);

  // Advertise the mailbox with this server's ancestor chain. The free
  // [self, parent] chain goes up immediately (enough for direct-spawn
  // layouts); the full chain — needed when an npx shim sits between the
  // client and us — replaces it as soon as the snapshot resolves (~1s on
  // Windows). The heartbeat re-writes the meta every beat (mtime = liveness).
  const launchCwd = process.cwd();
  let serverChain = quickChain();
  const liveness = {
    refresh: () =>
      writeMailboxMeta(inboxDir, process.pid, {
        cwd: launchCwd,
        chain: serverChain,
      }),
    remove: () => removeMailboxMeta(inboxDir, process.pid),
  };
  void ancestorChain()
    .then((chain) => {
      serverChain = chain;
      liveness.refresh();
    })
    .catch(() => {
      /* fail-open: the quick chain stays */
    });

  const heartbeat = createHeartbeat({
    hubClient,
    intervalSeconds: config.HEARTBEAT_INTERVAL_SECONDS,
    // Attach a best-effort change report to each beat so commits surface to
    // teammates within ~one interval. Fail-open: any git error → presence-only.
    buildReport: async () => {
      try {
        return (await buildChangeReport(process.cwd(), config)) ?? undefined;
      } catch {
        return undefined;
      }
    },
    // A model-visible sink (this session's mailbox). Its presence opts the
    // heartbeat into two-phase announcement delivery: append locally, then
    // ack the hub. appendAnnouncements is itself fail-open.
    announcementSink: (announcements) =>
      appendAnnouncements(inboxFile, announcements),
    liveness,
  });
  // Instructions are keyed on the repo's first-run state (linked / declined /
  // never-asked), so a declined repo costs one quiet paragraph instead of the
  // full procedure, and a never-asked repo gets the ask block. Resolved once —
  // a hot link mid-session is bridged by the link tool's own result text.
  const server = new McpServer(
    { name: "shepherd", version: PACKAGE_VERSION },
    { instructions: buildInstructions(context.linkState, context.workspace) },
  );
  // registerTools auto-joins the workspace (fire-and-forget) — the agent never
  // has to call a `join` tool. It starts the heartbeat once the session lands.
  const tools = registerTools(server, {
    hubClient,
    config,
    context,
    heartbeat,
    inboxFile,
  });
  const transport = new StdioServerTransport();

  // Layer 4: once the initialize handshake identifies the client, attempt the
  // once-per-machine hook auto-install (fire-and-forget, fail-open — see
  // hookInstall.ts for the safety rules and the SHEPHERD_NO_AUTO_HOOKS opt-out).
  server.server.oninitialized = () => {
    void autoInstallHooks({
      clientName: server.server.getClientVersion()?.name,
      disabled: config.SHEPHERD_NO_AUTO_HOOKS,
    });
  };

  // On shutdown: stop the background heartbeat, then tell the hub we're leaving
  // so our live claims stop surfacing to teammates immediately (presence only —
  // claims and change records are left intact). Both halves are best-effort and
  // idempotent; `leave()` swallows its own errors and is bounded by the hub
  // client's 5s timeout, so awaiting it cannot hang shutdown indefinitely.
  // Guarded so a second signal during teardown can't run it twice.
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    heartbeat.stop();
    await tools.leave();
  };
  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
  // Also leave if the stdio transport closes (client disconnected).
  transport.onclose = () => {
    void shutdown();
  };

  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[shepherd] Fatal boot error: ${String(err)}\n`);
  if (err instanceof Error && err.stack) {
    process.stderr.write(err.stack + "\n");
  }
  process.exit(1);
});
