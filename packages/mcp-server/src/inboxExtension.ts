/**
 * Shepherd inbox extension for Pi (earendil-works/pi).
 *
 * Pi has no stdin/stdout hook like Claude Code / Codex; instead it loads
 * in-process TS/JS extensions. This one mirrors the `shepherd-inbox-hook` bin:
 * on every user turn (`before_agent_start`) it drains this working directory's
 * inbox file — the announcements the background heartbeat already pulled from the
 * hub — and injects them as a message the model reads, only when non-empty.
 *
 * Install: copy the bundled `dist/inboxExtension.js` to
 * `~/.pi/agent/extensions/shepherd-inbox.js` (or a project `.pi/extensions/`),
 * or run `pi -e /abs/path/to/dist/inboxExtension.js`. The dir is resolved from
 * SHEPHERD_INBOX_DIR or the built-in default — keep it matching the MCP server.
 *
 * FAIL-OPEN: any error yields no injection; it never throws into Pi.
 */

import { inboxFilePath, drainInbox, formatInboxAnnouncements, defaultInboxDir } from "./inbox.js";
import { buildLinkNudge } from "./linkNudge.js";

/** Minimal structural types — avoids a hard dependency on Pi's type package. */
interface PiExtensionContext {
  cwd: string;
}
interface PiBeforeAgentStartResult {
  message: { customType: string; content: string; display: boolean };
}
interface PiExtensionAPI {
  on(
    event: "before_agent_start",
    handler: (
      event: unknown,
      ctx: PiExtensionContext
    ) => Promise<PiBeforeAgentStartResult | undefined> | PiBeforeAgentStartResult | undefined
  ): void;
}

export default function shepherdInbox(pi: PiExtensionAPI): void {
  pi.on("before_agent_start", (_event, ctx) => {
    try {
      const dir = process.env["SHEPHERD_INBOX_DIR"] || defaultInboxDir();
      const cwd = ctx?.cwd ?? process.cwd();
      const announcements = drainInbox(inboxFilePath(dir, cwd));
      // Same two payloads as the hook bin: the unlinked-repo nudge (tool-less
      // here — Pi's before_agent_start is per user turn), then announcements.
      const content = [buildLinkNudge(cwd), formatInboxAnnouncements(announcements)]
        .filter(Boolean)
        .join("\n\n");
      if (!content) return undefined;
      return { message: { customType: "shepherd-inbox", content, display: true } };
    } catch {
      // Fail-open: never break a Pi turn on an inbox read error.
      return undefined;
    }
  });
}
