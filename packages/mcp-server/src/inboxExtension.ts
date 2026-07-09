/**
 * Shepherd inbox extension for Pi (earendil-works/pi).
 *
 * Pi has no stdin/stdout hook like Claude Code / Codex; instead it loads
 * in-process TS/JS extensions. This one mirrors the `shepherd-inbox-hook` bin:
 * on every user turn (`before_agent_start`) it drains this working directory's
 * inbox file — the announcements the background heartbeat already pulled from the
 * hub — and injects them as a message the model reads, only when non-empty.
 *
 * It ALSO stands in for the MCP `initialize` `instructions` field (see
 * {@link "./instructions.js"}). Compliant clients (Claude Code) inject that
 * field into the agent's system prompt automatically, so the agent learns the
 * standing coordination procedure with zero extra setup. Pi's MCP adapter
 * parses `instructions` but never forwards it to the model — so without this,
 * Pi users get the `work`/`done`/`announce`/`sync` tools wired up but no
 * guidance on when to use them. {@link buildProcedureInjection} re-delivers
 * the SAME procedure text by appending it to `event.systemPrompt` on every
 * `before_agent_start`, the one hook Pi extensions get to shape the prompt.
 *
 * Install: copy the bundled `dist/inboxExtension.js` to
 * `~/.pi/agent/extensions/shepherd-inbox.js` (or a project `.pi/extensions/`),
 * or run `pi -e /abs/path/to/dist/inboxExtension.js`. The dir is resolved from
 * SHEPHERD_INBOX_DIR or the built-in default — keep it matching the MCP server.
 *
 * FAIL-OPEN: any error yields no injection; it never throws into Pi.
 */

import {
  inboxFilePath,
  drainInbox,
  formatInboxAnnouncements,
  defaultInboxDir,
  mergeAnnouncements,
  selectSessionMailboxes,
} from "./inbox.js";
import { buildLinkNudge } from "./linkNudge.js";
import { buildInstructions } from "./instructions.js";
import { readMarker } from "./marker.js";

/**
 * The system-prompt addition for this cwd: the full linked-state procedure
 * when the repo has a `.shepherd` marker, else "" (an unlinked or declined
 * repo is handled by {@link buildLinkNudge}'s per-turn message instead —
 * injecting the first-run ask into the system prompt too would duplicate it
 * on every turn).
 */
export function buildProcedureInjection(cwd: string): string {
  const marker = readMarker(cwd);
  if (marker === null) return "";
  return buildInstructions("linked", marker.workspace);
}

/** Minimal structural types — avoids a hard dependency on Pi's type package. */
interface PiBeforeAgentStartEvent {
  systemPrompt: string;
}
interface PiExtensionContext {
  cwd: string;
}
interface PiBeforeAgentStartResult {
  systemPrompt?: string;
  message?: { customType: string; content: string; display: boolean };
}
interface PiExtensionAPI {
  on(
    event: "before_agent_start",
    handler: (
      event: PiBeforeAgentStartEvent,
      ctx: PiExtensionContext,
    ) =>
      | Promise<PiBeforeAgentStartResult | undefined>
      | PiBeforeAgentStartResult
      | undefined,
  ): void;
}

export default function shepherdInbox(pi: PiExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    try {
      const dir = process.env["SHEPHERD_INBOX_DIR"] || defaultInboxDir();
      const cwd = ctx?.cwd ?? process.cwd();
      // This extension runs INSIDE the client process, so its own pid IS the
      // client pid the server's chain contains — a one-entry chain pairs it to
      // this session's mailbox(es) with no process-tree walk at all. (Not the
      // ppid: that is the terminal ABOVE the client, which a foreign session
      // may share.) The cwd-keyed legacy file is drained alongside for
      // pre-mailbox servers.
      const announcements = mergeAnnouncements(
        ...selectSessionMailboxes(dir, [process.pid], cwd).map(drainInbox),
        drainInbox(inboxFilePath(dir, cwd)),
      );
      // Same two payloads as the hook bin: the unlinked-repo nudge (tool-less
      // here — Pi's before_agent_start is per user turn), then announcements.
      const messageContent = [
        buildLinkNudge(cwd),
        formatInboxAnnouncements(announcements),
      ]
        .filter(Boolean)
        .join("\n\n");

      const procedure = buildProcedureInjection(cwd);
      const systemPrompt = procedure
        ? `${event.systemPrompt}\n\n${procedure}`
        : undefined;

      if (!messageContent && !systemPrompt) return undefined;
      return {
        ...(systemPrompt ? { systemPrompt } : {}),
        ...(messageContent
          ? {
              message: {
                customType: "shepherd-inbox",
                content: messageContent,
                display: true,
              },
            }
          : {}),
      };
    } catch {
      // Fail-open: never break a Pi turn on an inbox read error.
      return undefined;
    }
  });
}
