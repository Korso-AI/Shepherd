import type { AnnouncementT } from "@shepherd/shared";
import { detectClient, type ClientKind } from "./hookInstall.js";
import type { LinkState } from "./resolveContext.js";

/**
 * Server-level instructions returned in the MCP `initialize` response.
 *
 * Compliant clients (e.g. Claude Code) inject this into the agent's system
 * prompt under a "MCP Server Instructions" section, so it is the agent's
 * standing operating procedure for coordination — the thing that makes the
 * agent *know* to coordinate without a human telling it to.
 *
 * The text is keyed on the repo's first-run {@link LinkState}, resolved once at
 * startup (instructions cannot change mid-session — a hot `link` is bridged by
 * the link tool's own result text until the next session boots as linked):
 *
 *  - `linked`     : the full coordination procedure, and nothing about the
 *                   first-run ask — that decision is settled.
 *  - `unanswered` : a short block explaining that Shepherd itself will usually
 *                   ask the user (popup), with the agent as fallback asker.
 *  - `declined`   : one quiet paragraph — never raise coordination unless the
 *                   user does.
 *
 * It is injected into EVERY session, so keep each variant tight. Strong,
 * imperative phrasing on purpose: this is the procedure, not a suggestion.
 */
/**
 * Defense in depth against prompt injection. `workspace` reaches here from the
 * `.shepherd` marker (attacker-controllable via a cloned repo) and is injected
 * VERBATIM into the agent's SYSTEM PROMPT below. readMarker already slug-validates
 * it, but we strip newlines and cap length at the point of interpolation too, so
 * a future unvalidated path can't reintroduce forged directives here. Minimal on
 * purpose — a real slug (≤64 chars, no whitespace) passes through untouched.
 */
function sanitizeWorkspace(workspace: string): string {
  return workspace.replace(/\s+/g, " ").slice(0, 64);
}

export function buildInstructions(
  state: LinkState,
  workspace?: string,
): string {
  switch (state) {
    case "linked":
      return (
        `${INTRO} This repository is linked to the \`${workspace ? sanitizeWorkspace(workspace) : "team"}\` workspace, ` +
        `so coordination is active.\n\n${PROCEDURE}`
      );
    case "declined":
      return (
        "Shepherd (team coordination) is connected, but the user declined coordination " +
        "for this repository. Do not call Shepherd tools or bring up coordination here. " +
        "If the user asks to start coordinating this repo, call `link`."
      );
    case "unanswered":
      return `${INTRO}\n\n${FIRST_RUN_ASK}`;
  }
}

const INTRO =
  "You are connected to Shepherd, the shared coordination hub for a team of agents " +
  "(human and AI) working in the same repositories.";

/**
 * The unanswered-state block. Shepherd asks the user itself where it can (the
 * elicitation popup, fired when edits are detected), so the agent's job is to
 * stay out of the way — but it remains the fallback asker on clients where no
 * popup can render, keyed off its first file-changing action.
 */
const FIRST_RUN_ASK = `This repository isn't linked to a Shepherd workspace yet, so coordination is dormant. Shepherd normally asks the user directly (a popup) when file edits are detected — you don't need to raise it yourself.

If the user asks you to set up coordination — or you're about to change files and no popup or Shepherd message has settled the question — ask at most once: call \`link\` with no argument. It auto-links when the user belongs to exactly one workspace, or lists the choices; ask the user which workspace, then call \`link\` again with their answer. If they say no, call \`decline\` so they're never asked again. Once linked, the tool results will guide the coordination procedure.`;

/** The linked-state standing procedure (unchanged from the original design). */
const PROCEDURE = `Follow this procedure on every session, proactively and without being asked:

1. Before you start producing or changing files in an AREA of the codebase, call \`work\` ONCE. This includes authoring a plan or design doc: claim the doc's path (e.g. ["docs/plans/auth.md"], or the directory you'll write into) BEFORE you write it — a plan you're about to author counts as a unit of work, not exploration. Pass a one-line \`intent\` and the \`pathGlobs\` covering the files you expect to touch. Scope the globs as specifically as you reasonably can — tight enough to avoid colliding with unrelated work, broad enough to cover the task (e.g. ["src/auth/**"], not ["src/**"] and not a single file). Hold that one claim across all your edits in that area; do NOT re-claim per file. If it reports a conflict, coordinate or pick different work — never silently collide.

2. Call \`done\` when that unit of work is complete, using its \`workItemId\`, so teammates see the files freed.

3. Re-call \`work\` only when you move to a DIFFERENT area not covered by a live claim. (\`work\` and \`sync\` also renew your existing claims.)

4. Call \`announce\` whenever you discover something another agent needs — a shared decision, a gotcha, an API change, a finding. If the landscape shows a specific agent working in the affected area, direct it to them by passing their name as \`target\`; otherwise broadcast. A human teammate's name (or \`admin\`) as \`target\` reaches them on the dashboard — reply to a human's message that way, directed to its sender, never in your own chat. Awareness only, not task assignment.

5. Call \`sync\` when you resume, start a new task, or before large changes, to refresh who is doing what.

Skip \`work\` entirely for read-only exploration — reading, searching, or thinking that produces no file. The moment you're going to WRITE something, source or doc, claim it first. These tools are advisory and degrade gracefully if the hub is unreachable — never block your real work on them.

Commit work-in-progress as you go rather than sitting on a large dirty tree: committed work becomes a precise, presence-independent signal to teammates (with line-level detail and automatic resolution once it lands), whereas uncommitted edits are only a best-effort, decaying hint.`;

// ---------------------------------------------------------------------------
// Fallback delivery for clients that drop the `instructions` field
// ---------------------------------------------------------------------------
// The procedure above only shapes behaviour on clients that actually inject
// `initialize`'s `instructions` into the model's context. Codex does NOT:
// verified against codex-cli 0.148.0 on 2026-08-19, its agent has the
// `mcp__shepherd__*` tools and their descriptions, but neither
// "the shared coordination hub for a team of agents" nor "Follow this procedure
// on every session" appears anywhere in its context. The result is an agent that
// uses Shepherd when asked and never coordinates on its own — the whole point of
// the field, silently lost.
//
// So we deliver the procedure over the one channel every client shares: the
// session mailbox, drained by the inbox hook (passively, before the agent's
// first tool call) or by the first Shepherd tool result. Same transport, same
// shape, and the same synthetic-`shepherd`-announcement trick the post-link
// guidance already uses (see tools.ts).

/**
 * Whether `client` is known to inject the MCP `initialize` instructions into the
 * agent's context. Deliberately an allowlist of ONE: an unknown client that in
 * fact injects costs a duplicated procedure once per session, while an unknown
 * client that drops it silently loses all proactive coordination. Cheap
 * redundancy beats a silently uncoordinated agent.
 */
export function clientInjectsInstructions(client: ClientKind): boolean {
  return client === "claude";
}

/**
 * Stage the standing procedure in this session's mailbox when the connecting
 * client won't have surfaced it from `initialize`. Returns whether it staged.
 *
 * Only for a LINKED repo: `declined` must stay quiet, and `unanswered` is the
 * link nudge's job (see linkNudge.ts) — a procedure for coordination the user
 * hasn't opted into yet would be noise.
 */
export function stageCoordinationBriefing({
  clientName,
  linkState,
  workspace,
  append,
}: {
  clientName: string | undefined;
  linkState: LinkState;
  workspace?: string;
  append: (announcements: AnnouncementT[]) => void;
}): boolean {
  if (linkState !== "linked") return false;
  if (clientInjectsInstructions(detectClient(clientName))) return false;
  append([coordinationBriefing(workspace)]);
  return true;
}

/**
 * The briefing itself: one compact announcement, not the full PROCEDURE text.
 * It rides the announcement render (one indented line under a header), so it is
 * written as prose the way the post-link guidance is, and it names the same
 * verbs in the same order.
 */
function coordinationBriefing(workspace?: string): AnnouncementT {
  const safeWorkspace = sanitizeWorkspace(workspace ?? "team");
  return {
    // Negative, timestamp-derived: the mailbox dedupes by id and the hub's ids
    // are positive, so a locally-minted id can never collide with a real one.
    id: -Date.now(),
    fromAgentName: "shepherd",
    fromHuman: "shepherd",
    targetAgentName: null,
    createdAt: new Date().toISOString(),
    body:
      `Shepherd coordination is ACTIVE for this repository (workspace \`${safeWorkspace}\`), ` +
      "and your client does not surface Shepherd's standing instructions — so they arrive here. " +
      "Procedure from now on, proactively and without being asked: call `work` (a one-line intent " +
      "plus the `pathGlobs` you expect to touch) BEFORE you start changing files in an area — a plan " +
      "or design doc you are about to author counts — and hold that ONE claim across every edit in " +
      "that area; call `done` with its `workItemId` when the unit of work is complete; call `announce` " +
      "whenever you find something teammates need; call `sync` when you resume or switch tasks. Skip " +
      "`work` for read-only exploration that produces no file. If `work` reports a conflict, coordinate " +
      "or pick different work — never silently collide. These tools are advisory: never block real work on them.",
  };
}
