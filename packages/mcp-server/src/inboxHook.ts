#!/usr/bin/env node
/**
 * shepherd-inbox-hook — Claude Code / Codex / Cursor hook that surfaces
 * Shepherd announcements delivered out-of-band by the background heartbeat, and
 * nudges the agent to run `link` before its first write in an unlinked repo.
 *
 * All three clients speak JSON-on-stdin, JSON-on-stdout; the dialects are
 * detected and answered by buildHookOutput. Claude Code and Codex send `cwd` +
 * `hook_event_name` and take a `{"hookSpecificOutput":{"hookEventName",
 * "additionalContext"}}` reply; Cursor sends `workspace_roots` (no cwd, BOM
 * prefix) and takes a top-level `{"continue":true,"additionalContext"}` reply.
 * So one bin serves all — wire it to frequent events (Claude Code: PreToolUse,
 * plus SessionStart to front-load the link ask; Codex: UserPromptSubmit,
 * SessionStart, and wildcard PreToolUse, verified for Bash, apply_patch, and
 * MCP calls but not guaranteed for richer paths such as WebSearch; Cursor:
 * beforeSubmitPrompt, the one event verified to inject context).
 * On each invocation it drains this working directory's inbox file and prints
 * the announcements as additionalContext, prefixed by the link nudge when the
 * cwd's repo is neither linked nor declined (see linkNudge.ts). Cheap: local
 * file reads, no network (the heartbeat already did the fetch).
 *
 * The inbox dir is resolved as: first CLI arg → SHEPHERD_INBOX_DIR env var →
 * the built-in default (the same per-user dir the MCP server uses). So the
 * simplest hook entry needs no arg:
 *   npx -y --package=@korso/shepherd shepherd-inbox-hook
 * Pass an explicit dir only if you also overrode SHEPHERD_INBOX_DIR on the
 * server.
 *
 * FAIL-OPEN: every path exits 0 with no output on any problem, so it can never
 * block or break a tool call.
 */

import {
  buildHookOutput,
  defaultInboxDir,
  parseHookPairingInput,
} from "./inbox.js";
import { resolveHookMailboxes } from "./hookPairing.js";

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  try {
    const raw = await readStdin();
    const inboxDir =
      process.argv[2] || process.env["SHEPHERD_INBOX_DIR"] || defaultInboxDir();
    // Pair this invocation to its session's mailbox(es) by process ancestry
    // (see hookPairing.ts). [] on any failure — the legacy cwd-keyed drain
    // below still runs, and tool-call delivery covers the rest.
    let mailboxes: string[] = [];
    try {
      mailboxes = await resolveHookMailboxes(
        inboxDir,
        parseHookPairingInput(raw),
      );
    } catch {
      /* fail-open */
    }
    const out = buildHookOutput(raw, inboxDir, undefined, undefined, mailboxes);
    if (out) process.stdout.write(out);
  } catch {
    // Fail-open: never block a tool call on a hook error.
  }
  process.exit(0);
}

void main();
