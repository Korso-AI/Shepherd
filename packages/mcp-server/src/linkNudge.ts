/**
 * Unlinked-repo soft nudge — the deterministic trigger behind the "ask on your
 * first coordination-relevant action" rule in {@link "./instructions.js"}.
 *
 * The server instructions alone proved unreliable: they sit passively in the
 * agent's context, and nothing FIRES when the agent makes its first write in an
 * unlinked repo, so the ask gets silently skipped. The MCP server can't observe
 * the client's native Edit/Write calls — but the hook can. So the inbox hook
 * (already wired to PreToolUse / SessionStart / UserPromptSubmit) calls
 * {@link buildLinkNudge} on every invocation and injects the nudge at exactly
 * the moment the rule applies: about to write, in a repo that is neither linked
 * nor declined.
 *
 * The nudge self-extinguishes — the moment `link` writes the marker or
 * `decline` records the opt-out, the predicate flips and the hook goes quiet —
 * so it needs no throttle state. Like everything hook-side it is FAIL-OPEN:
 * any error yields "" and never blocks the agent's action.
 */

import { findRepoRoot, readMarker } from "./marker.js";
import { isDeclined } from "./declined.js";

/**
 * Client tools that write files — the "coordination-relevant" boundary. Tool
 * names outside this set (Read, Grep, Bash, MCP tools, …) never nudge: reading
 * an unlinked repo is fine, and Bash is overwhelmingly read-only in practice —
 * nudging it would be noise on every `git status`.
 */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/**
 * The injected nudge. Mirrors the first-run flow in the server instructions so
 * the agent gets the same procedure at the moment it applies.
 */
export const LINK_NUDGE_TEXT =
  "[Shepherd] This repo is not linked to a Shepherd workspace and has not been declined. " +
  "Before writing files here, call the shepherd `link` tool with no argument: it auto-links " +
  "if the user belongs to exactly one workspace, or lists workspaces — then ask the user " +
  "\"Coordinate this repo with Shepherd? Which workspace?\" and call `link <workspace>` with " +
  "their answer, or `decline` if they say no. Ask at most once per repo.";

/**
 * Decide whether to nudge for this hook invocation.
 *
 * Nudges only when ALL hold:
 *  - the event is write-shaped: `toolName` is a write tool, or absent (a
 *    tool-less event — SessionStart / UserPromptSubmit — nudges so the ask is
 *    front-loaded rather than interrupting mid-task);
 *  - `cwd` is inside a git repo;
 *  - the repo has no `.shepherd` marker (not linked);
 *  - the repo is not in the local declined store ("don't ask again").
 *
 * Returns {@link LINK_NUDGE_TEXT} or "". `deps.declinedDir` overrides the
 * declined-store root for tests, mirroring {@link "./declined.js"}.
 */
export function buildLinkNudge(
  cwd: string,
  toolName?: string,
  deps: { declinedDir?: string } = {}
): string {
  try {
    if (toolName !== undefined && !WRITE_TOOLS.has(toolName)) return "";
    const repoRoot = findRepoRoot(cwd);
    if (repoRoot === null) return "";
    if (readMarker(cwd) !== null) return "";
    if (isDeclined(repoRoot, deps.declinedDir)) return "";
    return LINK_NUDGE_TEXT;
  } catch {
    // Fail-open: an unreadable disk never blocks or breaks the agent's action.
    return "";
  }
}
