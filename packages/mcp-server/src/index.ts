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
  inboxFilePath,
  appendAnnouncements,
  defaultInboxDir,
  presenceFilePath,
  refreshPresence,
  removePresence,
  hasOtherLivePresence,
} from "./inbox.js";
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
  // pending announcements and stages them in this working dir's inbox file; that
  // single file is then drained both by the Shepherd tool calls (universal
  // delivery — every client, on the next work/sync/done/announce) and, where
  // available, by a client hook for passive delivery with no tool call.
  // SHEPHERD_INBOX_DIR overrides the default root (a per-user dir under $HOME).
  const inboxDir = config.SHEPHERD_INBOX_DIR ?? defaultInboxDir();
  const inboxFile = inboxFilePath(inboxDir, process.cwd());

  // Shared-directory contention guard (see inbox.ts's server presence
  // section): a sibling server in this same working dir means the shared inbox
  // file would let one client's hook steal the other agent's announcements, so
  // a contended heartbeat skips passive delivery. A mark is considered live
  // within 3 heartbeat intervals, tolerating a missed beat either side.
  const presenceFile = presenceFilePath(inboxDir, process.cwd(), process.pid);
  const presenceStaleMs = config.HEARTBEAT_INTERVAL_SECONDS * 3 * 1000;
  const presence = {
    refresh: () => refreshPresence(presenceFile),
    contended: () =>
      hasOtherLivePresence(
        inboxDir,
        process.cwd(),
        process.pid,
        presenceStaleMs,
      ),
    remove: () => removePresence(presenceFile),
  };

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
    // A model-visible sink (this working dir's inbox file). Its presence opts
    // the heartbeat into two-phase announcement delivery: append locally, then
    // ack the hub. appendAnnouncements is itself fail-open.
    announcementSink: (announcements) =>
      appendAnnouncements(inboxFile, announcements),
    presence,
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
