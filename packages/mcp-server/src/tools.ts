import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  WorkAgentInput,
  DoneAgentInput,
  AnnounceAgentInput,
  SyncAgentInput,
  JoinResponse,
  WorkResponse,
  DoneResponse,
  AnnounceResponse,
  SyncResponse,
  type LandscapeT,
  type ChangeRecordT,
  type ChangeReportT,
  type AnnouncementT,
} from "@shepherd/shared";
import { writeMarker, removeMarker, findRepoRoot } from "./marker.js";
import { setDeclined, clearDeclined } from "./declined.js";
import {
  HubUnreachable,
  HubRequestError,
  type HubClient,
} from "./hubClient.js";
import { DEFAULT_WORKSPACE, type Config } from "./config.js";
import { type JoinContext } from "./resolveContext.js";
import { type Heartbeat } from "./heartbeat.js";
import { buildChangeReport } from "./changeReport.js";
import {
  drainInbox,
  mergeAnnouncements,
  appendAnnouncements,
  REPLY_ROUTING_HINT,
  oneLine,
  indentContinuation,
} from "./inbox.js";
import { createEditTripwire, type EditTripwire } from "./editTripwire.js";
import { offerLinkPopup, type ElicitFn } from "./linkPopup.js";
import {
  isAncestor,
  hasCommit,
  changedLineRanges,
  MAX_LINE_RANGE_PATHS,
} from "./gitContext.js";

export type { HubClient };

// ---------------------------------------------------------------------------
// Auto-join failure classification
// ---------------------------------------------------------------------------

/**
 * Why the background auto-join did not produce a usable session. Captured in the
 * registration closure so `sessionNotReady()` can tell the agent the ACTUAL
 * reason (bad token, wrong workspace, hub down, malformed response) instead of
 * always blaming an unreachable hub.
 *
 *  - unreachable : network error / timeout reaching the hub (HubUnreachable).
 *  - auth        : the hub rejected our team token (HTTP 401).
 *  - validation  : the hub rejected the join request (HTTP 400, e.g. a
 *                  disallowed workspace) OR returned a response that fails the
 *                  shared JoinResponse contract / carries no usable sessionId.
 *  - unknown     : any other non-2xx status or unexpected error.
 */
type JoinFailureReason = "unreachable" | "auth" | "validation" | "unknown";

/** Map a thrown hub error to a typed join-failure reason. */
function classifyJoinFailure(err: unknown): JoinFailureReason {
  if (err instanceof HubUnreachable) return "unreachable";
  if (err instanceof HubRequestError) {
    if (err.status === 401) return "auth";
    if (err.status === 400) return "validation";
    return "unknown";
  }
  return "unknown";
}

/**
 * The reason an `activate()` attempt did not produce a live session. Combines
 * the generic {@link JoinFailureReason} with `workspaceRejected` — the 403/404
 * "this credential isn't scoped to the marker's workspace" signal that
 * {@link classifyJoinFailure} alone maps to `unknown`.
 */
type ActivateFailureReason = JoinFailureReason | "workspaceRejected";

/**
 * Outcome of a hot-activation attempt (`activate()`): either a live session was
 * established, or a typed failure the caller renders as its own advisory.
 */
type ActivateResult =
  { ok: true } | { ok: false; reason: ActivateFailureReason };

/**
 * Map a thrown hub error to an {@link ActivateFailureReason}. A 403/404 is the
 * hosted workspace-scoping rejection — it MUST be checked BEFORE falling through
 * to {@link classifyJoinFailure}, which maps every non-401/400 status (403/404
 * included) to `unknown` and would otherwise swallow the workspace-mismatch
 * signal into a generic outage.
 */
function classifyActivateFailure(err: unknown): ActivateFailureReason {
  if (
    err instanceof HubRequestError &&
    (err.status === 403 || err.status === 404)
  ) {
    return "workspaceRejected";
  }
  return classifyJoinFailure(err);
}

/** Human-readable cause clause for sessionNotReady(), keyed by failure reason. */
function joinFailureCause(reason: JoinFailureReason | null): string {
  switch (reason) {
    case "unreachable":
      return "hub unreachable at startup";
    case "auth":
      return "hub rejected the team token (check SHEPHERD/TEAM token)";
    case "validation":
      return "hub rejected the join (workspace/branch not allowed, or returned an invalid response)";
    case "unknown":
      return "join failed with an unexpected error";
    default:
      // No recorded failure but still no session — join has not settled yet.
      return "coordination session not established yet";
  }
}

// ---------------------------------------------------------------------------
// Landscape formatting
// ---------------------------------------------------------------------------

function formatLandscape(landscape: LandscapeT): string {
  const lines: string[] = [];

  // Names (agentName/human/target/from) are teammate-controlled free-text too,
  // just like intents/bodies — a raw newline could forge section headers or fake
  // senders in this structured block — so every interpolated identity field goes
  // through oneLine() alongside the message fields.
  if (landscape.conflicts.length > 0) {
    lines.push("CONFLICTS (files overlapping with your claim):");
    for (const c of landscape.conflicts) {
      lines.push(
        `  [${oneLine(c.agentName)} / ${oneLine(c.human)}] "${oneLine(c.intent)}" — globs: ${oneLine(c.pathGlobs.join(", "))}`,
      );
    }
  } else {
    lines.push("CONFLICTS: none");
  }

  if (landscape.activeClaims.length > 0) {
    lines.push("ACTIVE CLAIMS (other agents currently working):");
    for (const c of landscape.activeClaims) {
      lines.push(
        `  [${oneLine(c.agentName)} / ${oneLine(c.human)}] "${oneLine(c.intent)}" — globs: ${oneLine(c.pathGlobs.join(", "))}`,
      );
    }
  } else {
    lines.push("ACTIVE CLAIMS: none");
  }

  // The caller's own live claims — lets an agent confirm its claim registered.
  // `yourClaims` is optional in the contract (older hubs omit it); treat a
  // missing value as an empty list.
  const yourClaims = landscape.yourClaims ?? [];
  if (yourClaims.length > 0) {
    lines.push("YOUR ACTIVE CLAIMS:");
    for (const c of yourClaims) {
      lines.push(
        `  "${oneLine(c.intent)}" — globs: ${oneLine(c.pathGlobs.join(", "))} (workItemId: ${c.workItemId})`,
      );
    }
  } else {
    lines.push("YOUR ACTIVE CLAIMS: none");
  }

  if (landscape.announcements.length > 0) {
    lines.push("ANNOUNCEMENTS:");
    for (const a of landscape.announcements) {
      const target = a.targetAgentName
        ? ` → ${oneLine(a.targetAgentName)}`
        : " (broadcast)";
      lines.push(
        `  [${oneLine(a.fromAgentName)}${target}] ${indentContinuation(a.body)}`,
      );
    }
    lines.push(REPLY_ROUTING_HINT);
  } else {
    lines.push("ANNOUNCEMENTS: none");
  }

  return lines.join("\n");
}

/**
 * Render a standalone "messages for you" block from announcements delivered
 * outside the full landscape (by done/announce). Returns "" when empty so
 * callers can append unconditionally.
 */
function formatAnnouncements(announcements: AnnouncementT[]): string {
  if (!announcements || announcements.length === 0) return "";
  const lines = ["Messages for you:"];
  for (const a of announcements) {
    // Names are teammate-controlled free-text; sanitize like the body.
    const target = a.targetAgentName
      ? ` → ${oneLine(a.targetAgentName)}`
      : " (broadcast)";
    lines.push(
      `  [${oneLine(a.fromAgentName)}${target}] ${indentContinuation(a.body)}`,
    );
  }
  lines.push(REPLY_ROUTING_HINT);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Change-record rendering (advisory, inform-not-block)
// ---------------------------------------------------------------------------

/**
 * Human-readable "Nh ago" / "Nm ago" since an ISO timestamp. Best-effort; on a
 * bad/empty timestamp returns "recently" rather than throwing.
 */
function relativeAge(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "recently";
  const ms = Date.now() - then;
  if (ms < 0) return "just now";
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function presence(rec: ChangeRecordT): string {
  return rec.authorIsLive
    ? "active now"
    : `offline, last seen ${relativeAge(rec.authorLastActiveAt)}`;
}

/**
 * Render the advisory "Unlanded changes touching your area" block from the
 * hub's change records, after the local relevance filter has been applied.
 *
 * This is INFORM-not-block: it surfaces who is touching overlapping files and
 * what they're doing, plus (best-effort, info-only) line detail for commits we
 * have locally. It NEVER tells the agent which lines to avoid. Returns "" when
 * there is nothing relevant to show, so callers can append unconditionally.
 *
 * `cwd` is used for the per-record git relevance checks (all fail-open).
 */
export function formatChangeRecords(
  records: ChangeRecordT[],
  cwd: string = process.cwd(),
): string {
  if (!records || records.length === 0) return "";

  // Global budget on line-detail git work across the WHOLE render. Each path
  // costs up to 2 synchronous `git` spawns; without a global cap a landscape
  // full of locally-present committed records could trigger thousands of
  // event-loop-blocking spawns (PERF-1). The `hasCommit` gate below already
  // skips records whose commit isn't local (the common cross-agent case) for
  // one cheap spawn; this budget bounds the remaining worst case to
  // MAX_LINE_RANGE_PATHS paths total, after which we show file-level only.
  let lineRangeBudget = MAX_LINE_RANGE_PATHS;

  const lines: string[] = [];
  for (const rec of records) {
    if (rec.kind === "committed") {
      const sha = rec.commitSha;

      // Resolution is viewer-side: if the commit is already in MY branch it
      // has fully landed for me → drop silently, regardless of who still reports
      // it on the hub.
      if (sha && isAncestor(cwd, sha)) continue;

      // Distinguish the two actionable states from MY local git, reusing the
      // single hasCommit spawn for both the label and the line-detail gate:
      //   - I have the object but it isn't in my branch yet → it has landed
      //     somewhere I can reach (origin / another branch); I just pull/rebase.
      //   - I don't have it at all → it's unpushed; coordinate, it's coming.
      const present = sha ? hasCommit(cwd, sha) : false;
      const state = present
        ? "landed, not yet in your branch — pull/rebase"
        : "not yet on your base — unpushed, coordinate";

      const intent = oneLine(rec.message ?? "(work in progress)");
      // agentName/human are teammate-controlled free-text — sanitize like intent.
      lines.push(
        `  ${oneLine(rec.agentName)} / ${oneLine(rec.human)} (${presence(rec)}) — committed (${state}): "${intent}"`,
      );
      lines.push(`    files: ${oneLine(rec.paths.join(", "))}`);

      // Info-only line detail, only when the object is present locally AND we
      // still have line-range budget left for this render.
      if (sha && present && lineRangeBudget > 0) {
        const budgetedPaths = rec.paths.slice(0, lineRangeBudget);
        lineRangeBudget -= budgetedPaths.length;
        const ranges = changedLineRanges(cwd, sha, budgetedPaths);
        for (const p of Object.keys(ranges)) {
          const spans = ranges[p].map((r) =>
            r.start === r.end ? `${r.start}` : `${r.start}-${r.end}`,
          );
          if (spans.length > 0) {
            lines.push(`    ${p}: lines ${spans.join(", ")} (for context)`);
          }
        }
      }
    } else {
      // uncommitted: always a soft, file-level heads-up. Presence-dependent and
      // decaying — never line detail.
      const claim = oneLine(rec.message ?? "uncommitted edits in progress");
      lines.push(
        `  ${oneLine(rec.agentName)} / ${oneLine(rec.human)} (${presence(rec)}) — ${claim} (uncommitted, may change)`,
      );
      lines.push(`    files: ${oneLine(rec.paths.join(", "))}`);
    }
  }

  if (lines.length === 0) return "";

  return (
    "Unlanded changes touching your area (awareness only — these are not blockers):\n" +
    lines.join("\n")
  );
}

// ---------------------------------------------------------------------------
// Hub error → graceful-degradation result
// ---------------------------------------------------------------------------

// Hub errors carry a human-readable `.message`; anything else is stringified.
function hubErrorDetail(err: unknown): string {
  return err instanceof HubUnreachable || err instanceof HubRequestError
    ? err.message
    : String(err);
}

function degradedResult(err: unknown): {
  content: Array<{ type: "text"; text: string }>;
} {
  const detail = hubErrorDetail(err);
  return {
    content: [
      {
        type: "text",
        text: `Coordination hub unreachable — proceeding uncoordinated. ${detail}`,
      },
    ],
  };
}

/**
 * Graceful degradation when a hub response FAILS its shared contract schema.
 * A compromised or MITM hub could otherwise return oversized/newline-laden
 * content that flows straight into agent context, so — mirroring the `/join`
 * path (activate()'s failed safeParse) — we never trust or throw the malformed
 * body: log the rejection to stderr (stdout is the MCP protocol channel) and
 * return a benign "proceeding uncoordinated" advisory instead.
 */
function malformedResponseResult(endpoint: string): {
  content: Array<{ type: "text"; text: string }>;
} {
  console.error(
    `[shepherd] ${endpoint} returned a response that failed contract validation — proceeding uncoordinated.`,
  );
  return {
    content: [
      {
        type: "text",
        text: "Coordination hub returned an invalid response — proceeding uncoordinated.",
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// registerTools
// ---------------------------------------------------------------------------

export function registerTools(
  server: McpServer,
  deps: {
    hubClient: HubClient;
    config: Config;
    context: JoinContext;
    heartbeat: Heartbeat;
    /**
     * This working directory's announcement inbox file (staged by the
     * heartbeat). Each tool drains it and merges into its output so an
     * announcement reaches the agent on its next tool call even on clients with
     * no context hook. Undefined disables draining (used by tests).
     */
    inboxFile?: string;
    /**
     * The working directory whose repo root owns the `.shepherd` marker that
     * link/unlink read and write. Defaults to process.cwd(); tests inject a
     * throwaway repo dir so marker round-trips never touch the real repo.
     */
    cwd?: string;
    /**
     * Root of the per-user, per-repo "declined" store that `decline`/`unlink`
     * write and `link` clears. Defaults to the real `~/.shepherd/declined`; tests
     * inject a throwaway dir so decline round-trips never touch the real home.
     */
    declinedDir?: string;
    /**
     * Seams for the zero-setup first-run ask (edit tripwire + elicitation
     * popup), active only in never-asked repos. Tests inject a hand-fired
     * tripwire and a fake elicitation exchange; production omits this and gets
     * the real git poller and `server.server.elicitInput`.
     */
    firstRunAsk?: {
      createTripwire?: (opts: {
        cwd: string;
        onEdits: () => void;
      }) => EditTripwire;
      elicit?: ElicitFn;
      getClientCapabilities?: () => { elicitation?: unknown } | undefined;
    };
  },
): { ready: Promise<void>; leave: () => Promise<void> } {
  const { hubClient, config, context, heartbeat, inboxFile } = deps;
  const markerCwd = deps.cwd ?? process.cwd();
  const declinedDir = deps.declinedDir;

  // Repo root that owns both the `.shepherd` marker and this user's local
  // declined record. Null when not inside a repo — the declined helpers below
  // then no-op (there is no per-repo key to write), fail-open like the marker.
  const repoRoot = findRepoRoot(markerCwd);

  // Session + identity cache, scoped to this registration closure so each test
  // instance gets its own isolated state. `agentName` is the stable name the
  // hub assigned this identity; it is surfaced to the agent in landscape output
  // so it knows how to address itself / be addressed, without a `join` tool.
  let sessionId: string | null = null;
  let agentName: string | null = null;

  // ---- repo opt-in gating (design D8 / §5.1) --------------------------------
  // A repo participates ONLY when it carries a committed `.shepherd` marker
  // (context.linked). Otherwise the client stays dormant — no /join, no
  // heartbeat — and every COORDINATION tool returns a one-line advisory. The
  // link/unlink marker-management tools are NOT gated here.
  //
  // Mode: hosted is identified by SHEPHERD_TOKEN (it carries the workspace, so
  // the client can't validate the slug locally — a wrong workspace surfaces as a
  // 401/403/404 on /join). Self-host uses TEAM_TOKEN + a fixed workspace (the old
  // WORKSPACE env, mapping to the Hub's ALLOWED_WORKSPACE); a marker slug that
  // doesn't equal it is a mismatch we can catch locally, before any join.
  const isHosted = Boolean(config.SHEPHERD_TOKEN);

  // Self-host workspace-match guard: when linked but the marker names a workspace
  // other than this self-host deployment's single workspace, never join the wrong
  // place — go dormant with a mismatch advisory.
  const selfHostMismatch =
    !isHosted &&
    context.linked &&
    config.WORKSPACE !== undefined &&
    config.WORKSPACE !== context.workspace;

  // Hosted workspace-match guard: set when the /join is rejected as a workspace
  // scoping failure (403/404) — i.e. the token isn't for the marker's workspace.
  // 401 stays the existing "revoked/invalid token" path (auth, not workspace).
  let hostedWorkspaceRejected = false;

  // Whether this repo activates at STARTUP. Suppressed when the repo isn't
  // linked OR a self-host marker mismatch was detected up front. (Hosted mismatch
  // can only be known after the join attempt, so it is handled in activate() and
  // surfaced per-tool below.) This is a ONE-SHOT boot decision, read once below to
  // gate the startup activate(); it is NOT the mechanism behind hot linking — a
  // mid-session `link` takes effect via the mutable `linked`/`sessionId`
  // that coordinationGate() reads, not via this flag.
  const dormant = !context.linked || selfHostMismatch;

  // Mutable mirror of context.linked. coordinationGate keys off THIS, not the
  // (frozen) context.linked, so a hot `link` that calls activate() is
  // seen as linked immediately — otherwise the gate would return notLinked()
  // forever until a restart.
  let linked = context.linked;

  // Mutable mirror of context.declined: whether this user has locally opted this
  // repo out ("don't ask again"). notLinked() keys off THIS so a hot `decline`
  // switches the advisory from the run-`link` ask to the quiet declined line, and
  // a hot `link`/startup activation clears it — without a restart. Only consulted
  // while unlinked; a present marker always wins.
  let declined = context.declined;

  // ---- tool surface (Layer 0) -----------------------------------------------
  // In a DECLINED repo the coordination tools aren't just gated — they are
  // removed from the tool list entirely (SDK `disable()`), so a declined repo
  // costs the agent zero attention. Only `link` stays exposed as the way back
  // in. A never-asked repo keeps the full surface (the advisories are what
  // deliver the ask), and hot link/decline/unlink re-sync the surface live —
  // the SDK emits tools/list_changed for clients that honor it. The handles are
  // pushed after registration below; entries may be undefined under test fakes
  // whose registerTool returns nothing, hence the optional calls.
  const gatedTools: Array<{ enable(): void; disable(): void } | undefined> = [];
  let surfaceVisible = true; // tools register enabled; mirrors to avoid churn
  function syncToolSurface(): void {
    const visible = linked || !declined;
    if (visible === surfaceVisible) return;
    surfaceVisible = visible;
    for (const tool of gatedTools) {
      if (visible) tool?.enable();
      else tool?.disable();
    }
  }

  // The first-run ask's edit detector (Layers 1+2), armed only in never-asked
  // repos (created at the bottom of this function). Any path that SETTLES the
  // link question — tool-mediated or popup-mediated — disarms it, so the user
  // is never asked about a repo whose state is already decided.
  let tripwire: EditTripwire | null = null;

  // Persist a decline for this repo (decline/unlink). No-ops when not in a repo.
  function rememberDecline(): void {
    if (repoRoot !== null) setDeclined(repoRoot, declinedDir);
    declined = true;
    tripwire?.stop();
    syncToolSurface();
  }

  // Drop any prior decline for this repo (link/startup activation): choosing —
  // or inheriting — a workspace overrides a stale "don't ask again". No-ops when
  // not in a repo or when there is no decline on disk.
  function forgetDecline(): void {
    if (repoRoot !== null) clearDeclined(repoRoot, declinedDir);
    declined = false;
    syncToolSurface();
  }

  // The reason the auto-join failed (if it did), captured so sessionNotReady()
  // can report the actual cause rather than always claiming "hub unreachable".
  // Stays null while the join is in flight or after it succeeds.
  let joinFailure: JoinFailureReason | null = null;

  // ---- activation seam ------------------------------------------------------
  // The agent never calls a `join` tool — an identity is registered
  // automatically. `activate()` is the single seam that does it: build the join
  // body, POST /join, and on success cache the session, start the heartbeat, and
  // flip the `linked` flag to active. It is called at startup when the marker is
  // present, and on demand from `link` / auto-pick, so linking takes
  // effect without a restart.
  //
  // `joinInFlight` is the promise a racing tool awaits via awaitJoin(). It is
  // `let` because activate() REASSIGNS it to its own in-flight attempt: if a
  // hot activate mutated `sessionId` but awaitJoin() stayed bound to the old
  // (already-resolved, dormant) promise, a racing tool would await the stale
  // promise and then read a half-updated `sessionId` — a genuine race. Pointing
  // awaitJoin() at the CURRENT attempt closes it.
  let joinInFlight: Promise<void> = Promise.resolve();

  /**
   * Establish a coordination session for `workspaceSlug`: POST `/join`, and on a
   * validated response cache the session (never surfaced — a leaked `sessionId`
   * lets any token holder act as this agent, review P3-9), start the heartbeat,
   * and flip the `linked` flag to active. Never throws; on any failure it returns
   * a typed {@link ActivateResult} and leaves `linked`/`sessionId` untouched so
   * there is no orphaned "active but not heartbeating" state.
   *
   * @param workspaceSlug - the marker's workspace slug to join under.
   */
  async function activate(workspaceSlug: string): Promise<ActivateResult> {
    // Build the join body from the RESOLVED context (env → git → fallback), not
    // raw config, with the caller's slug. `model` is omitted entirely when unset
    // rather than sent as undefined, so the wire body stays clean for hubs that
    // validate strictly.
    const joinBody: Record<string, unknown> = {
      workspace: workspaceSlug,
      repo: context.repo,
      branch: context.branch,
      human: context.human,
      program: context.program,
    };
    if (context.model !== undefined) {
      joinBody.model = context.model;
    }

    const attempt = (async (): Promise<ActivateResult> => {
      try {
        const raw = await hubClient.post("/join", joinBody);
        // Validate the response against the shared contract BEFORE reading
        // sessionId — a malformed/garbage body must not be trusted as a session.
        // Falsy check (not `=== null`): an empty string / missing id is just as
        // unusable as a null and must be treated as a join failure.
        const parsed = JoinResponse.safeParse(raw);
        if (!parsed.success || !parsed.data.sessionId) {
          joinFailure = "validation";
          // stderr only — stdout is the stdio MCP protocol channel.
          console.error(
            "[shepherd] join failed (validation): hub returned a malformed join response (no usable sessionId)",
          );
          return { ok: false, reason: "validation" };
        }

        const newSessionId = parsed.data.sessionId;
        // Start the heartbeat BEFORE committing the session/flags. A throw here
        // must leave us dormant with NO cached session — never an orphaned
        // "active but not heartbeating" state — so it is treated as an activate
        // failure by the surrounding catch, with sessionId still null.
        heartbeat.start(newSessionId);

        // Synchronous commit block: no await, so nothing can interleave and read
        // a half-updated view. Only reached once the response is validated AND
        // the heartbeat started cleanly.
        sessionId = newSessionId;
        agentName = parsed.data.agentName;
        linked = true;
        hostedWorkspaceRejected = false;
        joinFailure = null;
        return { ok: true };
      } catch (err) {
        // Capture WHY it failed so sessionNotReady() reports the real cause, and
        // log to stderr — consistent with heartbeat.ts and leave().
        const reason = classifyActivateFailure(err);
        joinFailure = classifyJoinFailure(err);
        if (reason === "workspaceRejected") {
          // Hosted workspace-match guard: the token isn't scoped to the marker's
          // workspace, so the Hub rejected the join (403 forbidden / 404 unknown
          // slug). Surface as a cross-workspace mismatch advisory (the per-tool
          // workspaceMismatch gate), not a generic outage — and never coordinate
          // in the wrong workspace.
          hostedWorkspaceRejected = true;
          console.error(
            `[shepherd] This repo is linked to workspace "${workspaceSlug}" but your ` +
              "configured token is for a different workspace — coordination disabled.",
          );
        } else {
          console.error(
            `[shepherd] join failed (${reason}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
        return { ok: false, reason };
      }
    })();

    // Point awaitJoin()/coordinationGate() at THIS attempt before returning, so a
    // racing tool call awaits the current activation rather than a stale promise.
    // (The IIFE has already yielded at its first await, so this assignment runs
    // synchronously before activate() returns.)
    joinInFlight = attempt.then(() => undefined);
    return attempt;
  }

  // One advisory stderr line at boot when this repo will stay dormant, so the
  // operator isn't left wondering why coordination is silent (design §5.1).
  if (!context.linked) {
    console.error(
      context.declined
        ? "[shepherd] This repo was declined — staying uncoordinated. Run `link` to change your mind."
        : "[shepherd] This repo isn't linked to a Shepherd workspace — staying " +
            "uncoordinated. Run `link` to choose one.",
    );
  } else if (selfHostMismatch) {
    console.error(
      `[shepherd] This repo is linked to workspace "${context.workspace}" but your ` +
        "configured token is for a different workspace — coordination disabled.",
    );
  }

  // Startup activation: a linked, non-mismatched repo activates immediately with
  // the marker slug. Dormant repos (no marker, or a self-host workspace mismatch)
  // do NOT activate — joinInFlight stays the resolved no-op so awaitJoin() and
  // `ready` still settle, and tools fall through to the not-linked / mismatch
  // advisory because sessionId stays null. (An unlinked repo's on-demand ask is
  // driven by the first-run edit tripwire / link tool.)
  //
  // Declined-state lifecycle: when a
  // committed marker activates, drop any stale local decline — an active,
  // chosen (or inherited) marker VOIDS a prior "don't ask again", consistent
  // with the `link <slug>` path. clearDeclined no-ops when there is no decline
  // file, so this is at most one existsSync at boot for the common case.
  if (!dormant) {
    forgetDecline();
    void activate(context.workspace);
  }

  /** Await the current (possibly no-op) activation so a racing tool sees its result. */
  async function awaitJoin(): Promise<void> {
    await joinInFlight;
  }

  /**
   * Graceful degradation when auto-join hasn't produced a session — i.e. the
   * hub was unreachable at startup. Advisory, never an error: the agent should
   * keep working uncoordinated.
   */
  function sessionNotReady(): {
    content: Array<{ type: "text"; text: string }>;
  } {
    return {
      content: [
        {
          type: "text",
          text:
            `Shepherd coordination session not ready (${joinFailureCause(joinFailure)}) — ` +
            "proceeding uncoordinated.",
        },
      ],
    };
  }

  /**
   * Advisory returned by every coordination tool when the repo has no marker.
   * Two shapes, keyed off the (mutable) declined flag:
   *  - unanswered: nudge the agent to run `link` (which auto-picks or asks).
   *  - declined: a terse "not coordinating" line — the user opted out, so we
   *    never re-ask; `link` remains available to change their mind.
   */
  function notLinked(): { content: Array<{ type: "text"; text: string }> } {
    const text = declined
      ? "Not coordinating this repo — you declined. Run `link` anytime to change your mind."
      : "This repo isn't linked to a Shepherd workspace — run `link` to choose one, " +
        "or `decline` to stay uncoordinated and not be asked again.";
    return { content: [{ type: "text", text }] };
  }

  /**
   * Advisory returned by every coordination tool when the repo IS linked but the
   * marker's workspace can't be the active credential's workspace (self-host
   * marker ≠ configured workspace, or a hosted /join rejected as out-of-scope).
   */
  function workspaceMismatch(): {
    content: Array<{ type: "text"; text: string }>;
  } {
    return {
      content: [
        {
          type: "text",
          text:
            `This repo is linked to \`${context.workspace}\` but your configured token ` +
            "is for a different workspace — coordination disabled.",
        },
      ],
    };
  }

  /**
   * Single coordination-gate for work/done/sync/announce/leave: await the
   * (possibly no-op) join, then decide whether the tool may proceed. Returns the
   * advisory result to short-circuit with, or null when the caller may continue
   * (a live session exists). NOT applied to link/unlink.
   */
  async function coordinationGate(): Promise<{
    content: Array<{ type: "text"; text: string }>;
  } | null> {
    await awaitJoin();
    // Not opted in at all → not-linked advisory (no join was attempted). Keyed
    // off the mutable `linked` flag so a hot activate() is seen at once.
    if (!linked) return notLinked();
    // Linked but the workspace can't match the credential → mismatch advisory.
    if (selfHostMismatch || hostedWorkspaceRejected) return workspaceMismatch();
    // Linked and within scope, but no session (hub unreachable at startup).
    if (sessionId === null) return sessionNotReady();
    return null;
  }

  /** Prepend the agent's own identity line so it knows its name for announcements. */
  function withIdentity(body: string): string {
    return agentName ? `You are ${agentName}.\n\n${body}` : body;
  }

  /**
   * Best-effort change report to attach to a work/sync body. Fail-open: if it
   * throws OR returns undefined (not a git repo), we return undefined and the
   * caller omits `changeReport`. Never lets git issues break a tool.
   */
  async function changeReportForBody(): Promise<ChangeReportT | undefined> {
    try {
      return (await buildChangeReport(process.cwd(), config)) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Drain this working directory's inbox (announcements the heartbeat already
   * pulled from the hub). Fail-open: returns [] when no inbox is configured or on
   * any read error, so a disk hiccup never breaks a tool call.
   */
  function drainLocalInbox(): AnnouncementT[] {
    if (!inboxFile) return [];
    try {
      return drainInbox(inboxFile);
    } catch {
      return [];
    }
  }

  /** Append the advisory change-records section to landscape output (work/sync only). */
  function withChangeRecords(landscape: LandscapeT, body: string): string {
    let section = "";
    try {
      section = formatChangeRecords(
        landscape.changeRecords ?? [],
        process.cwd(),
      );
    } catch {
      section = "";
    }
    return section ? `${body}\n\n${section}` : body;
  }

  // ---- work ----------------------------------------------------------------
  const workTool = server.registerTool(
    "work",
    {
      title: "Claim a unit of work",
      description:
        "Claim a unit of work BEFORE you start producing or changing files in an area of " +
        "the codebase — source OR a plan/design doc (per unit of work, NOT per edit). " +
        "Authoring a plan counts: claim the doc's path before you write it. Pass a one-line " +
        "`intent` and the `pathGlobs` covering the files you expect to touch — scope them " +
        "as specifically as you " +
        'reasonably can (e.g. ["src/auth/**"], not ["src/**"] and not a single file). It ' +
        "atomically checks whether a teammate is already in those files and claims them for " +
        "you, returning any conflicts and what others are working on. Hold one claim across " +
        "all edits in that area; don't re-claim per file.",
      inputSchema: WorkAgentInput.shape,
    },
    async (args) => {
      const gated = await coordinationGate();
      if (gated) return gated;
      try {
        const changeReport = await changeReportForBody();
        const body = {
          sessionId,
          ...args,
          ...(changeReport ? { changeReport } : {}),
        };
        // Validate against the shared contract before trusting the body — a
        // compromised hub's oversized/newline content must not reach the agent.
        const parsed = WorkResponse.safeParse(
          await hubClient.post("/work", body),
        );
        if (!parsed.success) return malformedResponseResult("/work");
        const result = parsed.data;
        // Fold in any announcements the heartbeat already staged locally so they
        // surface in this turn's ANNOUNCEMENTS section alongside hub-fresh ones.
        result.landscape.announcements = mergeAnnouncements(
          result.landscape.announcements,
          drainLocalInbox(),
        );
        const text = withIdentity(
          withChangeRecords(
            result.landscape,
            `Work claimed (workItemId: ${result.workItemId})\n\n` +
              formatLandscape(result.landscape) +
              `\n\nYou hold this claim until you call done (workItemId: ${result.workItemId}) ` +
              `or it expires (~60 min). Calling work or sync renews it.`,
          ),
        );
        return { content: [{ type: "text", text }] };
      } catch (err) {
        if (err instanceof HubUnreachable || err instanceof HubRequestError) {
          return degradedResult(err);
        }
        throw err;
      }
    },
  );

  // ---- done ----------------------------------------------------------------
  const doneTool = server.registerTool(
    "done",
    {
      title: "Release a work claim",
      description:
        "Call when a unit of work is complete to release your claim so teammates know the " +
        "files are free. Pass the workItemId returned by the work tool.",
      inputSchema: DoneAgentInput.shape,
    },
    async (args) => {
      const gated = await coordinationGate();
      if (gated) return gated;
      try {
        const body = { sessionId, ...args };
        // Validate against the shared contract before trusting the body.
        const parsed = DoneResponse.safeParse(
          await hubClient.post("/done", body),
        );
        if (!parsed.success) return malformedResponseResult("/done");
        const result = parsed.data;
        const base =
          "Work item released. Call work again before your next edit in a new area.";
        const msgs = formatAnnouncements(
          mergeAnnouncements(result.announcements, drainLocalInbox()),
        );
        return {
          content: [{ type: "text", text: msgs ? `${base}\n\n${msgs}` : base }],
        };
      } catch (err) {
        if (err instanceof HubUnreachable || err instanceof HubRequestError) {
          return degradedResult(err);
        }
        throw err;
      }
    },
  );

  // ---- announce ------------------------------------------------------------
  const announceTool = server.registerTool(
    "announce",
    {
      title: "Message teammates (agents or humans)",
      description:
        "Broadcast a heads-up to the other agents, direct a finding to a specific teammate, or " +
        "reply to a human on the dashboard. This is awareness only — not a task assignment. " +
        "To direct it, pass ONE name as `target`: an agent's EXACT name as shown in the " +
        "landscape — including its numeric suffix (e.g. 'alex-rivera-2', NOT the bare handle " +
        "'alex-rivera'; several agents can share one handle, the suffix picks one) — OR a " +
        "human's name to reach that workspace member on the dashboard (reply to the person a " +
        "message came from by using their sender name as target), OR 'admin' to reach the " +
        "dashboard collectively. The hub rejects a target that matches no live agent and no " +
        "member — if you mean the whole team, omit target to broadcast. (targetAgentName and " +
        "toAdmin are deprecated aliases; don't combine them with target.) Delivery is " +
        "best-effort: agents see it on their next work/sync, once; humans see the feed.",
      inputSchema: AnnounceAgentInput.shape,
    },
    async (args) => {
      const gated = await coordinationGate();
      if (gated) return gated;
      try {
        const body = { sessionId, ...args };
        // Validate against the shared contract before trusting the body.
        const parsed = AnnounceResponse.safeParse(
          await hubClient.post("/announce", body),
        );
        if (!parsed.success) return malformedResponseResult("/announce");
        const result = parsed.data;
        const base = `Announcement sent (id: ${result.announcementId}).`;
        const msgs = formatAnnouncements(
          mergeAnnouncements(result.announcements, drainLocalInbox()),
        );
        return {
          content: [{ type: "text", text: msgs ? `${base}\n\n${msgs}` : base }],
        };
      } catch (err) {
        if (err instanceof HubUnreachable || err instanceof HubRequestError) {
          return degradedResult(err);
        }
        throw err;
      }
    },
  );

  // ---- sync ----------------------------------------------------------------
  const syncTool = server.registerTool(
    "sync",
    {
      title: "Sync team landscape",
      description:
        "Pull the latest team landscape (who's working on what, any messages for you) and " +
        "renew your active claims. Call when you resume, start a new task, or before large " +
        "changes — or any time you want to check for teammate activity without claiming work.",
      inputSchema: SyncAgentInput.shape,
    },
    async (_args) => {
      const gated = await coordinationGate();
      if (gated) return gated;
      try {
        const changeReport = await changeReportForBody();
        const body = { sessionId, ...(changeReport ? { changeReport } : {}) };
        // Validate against the shared contract before trusting the body.
        const parsed = SyncResponse.safeParse(
          await hubClient.post("/sync", body),
        );
        if (!parsed.success) return malformedResponseResult("/sync");
        const result = parsed.data;
        result.landscape.announcements = mergeAnnouncements(
          result.landscape.announcements,
          drainLocalInbox(),
        );
        const text = withIdentity(
          withChangeRecords(
            result.landscape,
            formatLandscape(result.landscape),
          ),
        );
        return { content: [{ type: "text", text }] };
      } catch (err) {
        if (err instanceof HubUnreachable || err instanceof HubRequestError) {
          return degradedResult(err);
        }
        throw err;
      }
    },
  );

  // ---- link / unlink / decline (marker + declined management) ---------------
  // These opt a repo IN/OUT of coordination by writing/removing the repo-local
  // `.shepherd` marker (link/unlink) or recording a local decline (decline/
  // unlink). They are the ONLY way to create the marker, so they are
  // deliberately EXEMPT from the dormant coordination gate (coordinationGate is
  // never called here) — they must work while the repo is unlinked.
  //
  // `link` only ever names a workspace the account actually belongs to:
  //   - Hosted (SHEPHERD_TOKEN): GET /workspaces lists the account's
  //     memberships; the chosen slug is validated against that list before any
  //     write (defense-in-depth on top of the Hub's own 404).
  //   - Self-host (TEAM_TOKEN): there is exactly one valid workspace — the
  //     deployment's configured WORKSPACE (the Hub's ALLOWED_WORKSPACE). No Hub
  //     call is made; the slug is validated against that single value.

  /** A textual advisory result, mirroring the other tools' content shape. */
  function advisory(text: string): {
    content: Array<{ type: "text"; text: string }>;
  } {
    return { content: [{ type: "text", text }] };
  }

  /**
   * The workspaces this account may link to. Hosted: the account's memberships
   * from `GET /workspaces` (may throw — callers decide how to fail). Self-host:
   * the deployment's single configured workspace, no hub call.
   */
  async function linkableSlugs(): Promise<string[]> {
    if (!isHosted) return config.WORKSPACE ? [config.WORKSPACE] : [];
    const res = (await hubClient.get("/workspaces")) as {
      workspaces?: Array<{ slug?: unknown }>;
    };
    return (res.workspaces ?? [])
      .map((w) => w.slug)
      .filter((s): s is string => typeof s === "string" && s.length > 0);
  }

  /**
   * Commit a workspace choice and start coordinating HOT (no restart):
   *   1. write the marker FIRST — pinned before activate so a transient `/join`
   *      failure never loses the teammate-visible choice (a later session reads
   *      the committed marker and inherits it);
   *   2. clear any prior decline — choosing a workspace overrides "don't ask";
   *   3. flip `linked` so the gate treats us as linked even if the join can't
   *      complete right now (the advisory then reads "not ready", not "not
   *      linked"), then activate.
   *
   * Returns the agent-facing advisory, distinguishing a live session from a
   * marker-written-but-join-deferred outcome.
   */
  async function linkAndActivate(
    slug: string,
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> {
    writeMarker(markerCwd, slug);
    forgetDecline();
    linked = true;
    tripwire?.stop(); // the link question is settled — never ask this session
    const result = await activate(slug);
    if (result.ok) {
      return advisory(
        `Linked this repo to \`${slug}\` — coordinating in \`${slug}\` now.`,
      );
    }
    return advisory(
      `Linked this repo to \`${slug}\`, but coordination couldn't start just now ` +
        `(${joinFailureCause(joinFailure)}). It'll connect on your next tool call or session.`,
    );
  }

  server.registerTool(
    "link",
    {
      title: "Link this repo to a Shepherd workspace",
      description:
        "Opt this repository into Shepherd coordination by writing a committed `.shepherd` " +
        "marker naming the workspace. Call with no argument: if you belong to exactly one " +
        "workspace it is linked and coordination starts immediately; if you belong to several, " +
        "the choices are listed for you to confirm one with the agent's user, then call `link` " +
        "again with that `workspace`. You can only link to a workspace you are a member of. " +
        "Takes effect immediately — no restart. Use `unlink` to opt out, or `decline` to stay " +
        "uncoordinated without linking.",
      inputSchema: z.object({
        workspace: z
          .string()
          .min(1)
          .optional()
          .describe(
            "The workspace slug to link this repo to. Omit to auto-pick or list choices.",
          ),
      }).shape,
    },
    async (args: { workspace?: string }) => {
      const requested = args.workspace;

      // Self-host: no Hub call. The single valid slug is the configured WORKSPACE
      // (the Hub's ALLOWED_WORKSPACE) — exactly one workspace, so a no-arg call
      // auto-picks it. A named slug is validated against it.
      if (!isHosted) {
        // Mirror resolveContext's fallback: an unset WORKSPACE means the hub's
        // out-of-the-box `default` workspace, so a docs-faithful setup (env var
        // left unset) can still link instead of dead-ending here.
        const allowed = config.WORKSPACE ?? DEFAULT_WORKSPACE;
        if (requested !== undefined && requested !== allowed) {
          return advisory(
            `This self-host deployment only serves the workspace \`${allowed}\`; ` +
              `you asked for \`${requested}\`. Choose: ${allowed}`,
          );
        }
        // Single workspace → auto-pick (no ask), or the matching named slug.
        return linkAndActivate(allowed);
      }

      // Hosted: list the account's memberships and validate against them.
      let slugs: string[];
      try {
        slugs = await linkableSlugs();
      } catch (err) {
        // Fail-open, consistent with the coordination tools: an unreachable Hub
        // is an advisory, never a crash. Write nothing.
        const detail = hubErrorDetail(err);
        return advisory(
          `Couldn't reach the coordination hub to list your workspaces — link not changed. ${detail}`,
        );
      }

      if (slugs.length === 0) {
        return advisory(
          "Your account isn't a member of any workspaces yet — nothing to link to. " +
            "Create one in the Shepherd dashboard, then run `link` again.",
        );
      }

      if (requested === undefined) {
        // Exactly one → auto-pick it (single-workspace, no question).
        if (slugs.length === 1) {
          return linkAndActivate(slugs[0]);
        }
        // Multiple → don't guess: list them and have the agent ASK its user.
        return advisory(
          "You're a member of multiple Shepherd workspaces:\n" +
            slugs.map((s) => `  - ${s}`).join("\n") +
            "\n\nAsk the user which one to use for this repo, then call `link` again with it " +
            "as the `workspace` argument.",
        );
      }

      if (!slugs.includes(requested)) {
        return advisory(
          `You're not a member of \`${requested}\`; choose one of: ${slugs.join(", ")}`,
        );
      }

      return linkAndActivate(requested);
    },
  );

  const unlinkTool = server.registerTool(
    "unlink",
    {
      title: "Unlink this repo from its Shepherd workspace",
      description:
        "Opt this repository OUT of Shepherd coordination by removing its `.shepherd` marker. " +
        "Also records a local decline so you aren't re-prompted to link on the next session. " +
        "The repo stays uncoordinated (no claims, no presence) until you `link` it again.",
      inputSchema: z.object({}).shape,
    },
    async () => {
      removeMarker(markerCwd);
      // Record a decline too: without it a just-unlinked repo would read as
      // `unanswered` and immediately nag the agent to re-link. `link` clears it.
      rememberDecline();
      linked = false;
      // Re-sync AFTER the linked flip: rememberDecline's own sync ran while
      // `linked` was still true, so the surface only actually hides here.
      syncToolSurface();
      // Symmetric teardown to activate(): if a session is live, stop the
      // heartbeat and tell the hub we've left so our presence + claims drop
      // NOW (not at the ~60min staleness expiry), then clear the cached
      // session. Best-effort/fail-open — leave() swallows hub errors — and a
      // no-op when nothing is active.
      if (sessionId !== null) {
        heartbeat.stop();
        await leave();
        sessionId = null;
        agentName = null;
      }
      return advisory(
        "Unlinked — this repo will stay uncoordinated and won't ask again. Run `link` to re-enable.",
      );
    },
  );

  const declineTool = server.registerTool(
    "decline",
    {
      title: "Decline Shepherd coordination for this repo",
      description:
        "Opt out of Shepherd for this repo WITHOUT linking: records a local, per-user " +
        "'don't ask again' so this repo stays uncoordinated and you aren't prompted to link on " +
        "future sessions. This is local only — it is never committed, so a teammate on the same " +
        "repo can still link it. Run `link` anytime to change your mind.",
      inputSchema: z.object({}).shape,
    },
    async () => {
      // A committed marker wins over a local decline, so declining a repo that
      // is already linked would silently do nothing (the decline is cleared on
      // the next boot's activation). Guide the agent to `unlink` instead rather
      // than write a decline that can't take effect.
      if (linked) {
        return advisory(
          `Already coordinating \`${context.workspace}\` — run \`unlink\` to stop coordinating this repo.`,
        );
      }
      rememberDecline();
      return advisory(
        "Won't coordinate this repo or ask again. Run `link` anytime to change your mind.",
      );
    },
  );

  /**
   * Clean-shutdown signal: tell the hub this session is gone so its live claims
   * stop surfacing to teammates immediately, rather than lingering for the full
   * staleness window. Best-effort and fail-open like the heartbeat — every error
   * (hub unreachable, non-2xx) is swallowed; it never throws and never writes to
   * stdout. No session (join still in flight or failed) → nothing to leave.
   *
   * Awaits the in-flight join first so a shutdown that races a just-started
   * session still reports the leave (the join promise never rejects, and the
   * hub client's own 5s timeout bounds the wait).
   */
  async function leave(): Promise<void> {
    try {
      await joinInFlight;
      if (!sessionId) return;
      await hubClient.post("/leave", { sessionId });
    } catch (err) {
      console.error(
        `[shepherd] leave failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Layer 0 surface: every hideable tool is registered by now, so apply the
  // startup state — a declined repo boots with only `link` in its tool list.
  // Pre-connect disable is silent (the SDK guards list_changed on connection).
  gatedTools.push(
    workTool,
    doneTool,
    announceTool,
    syncTool,
    unlinkTool,
    declineTool,
  );
  surfaceVisible = true;
  syncToolSurface();

  // ---- first-run ask (Layers 1+2) -------------------------------------------
  // In a never-asked repo, arm the edit tripwire: the first path that turns
  // dirty after session start means this session is producing changes, so the
  // link question is put to the USER via an elicitation popup — no client
  // setup, no agent mediation. Fires at most once per session; any path that
  // settles the question first (tool-mediated link/decline) disarms it.
  //
  // Accept-only rule: only an accepted popup submission records a decision.
  // Clients that can't render the popup surface as decline/cancel/error, which
  // records NOTHING — those users get asked through the hook nudge instead.
  async function runFirstRunAsk(): Promise<void> {
    try {
      if (linked || declined) return; // settled through the tool path meanwhile
      const getCaps =
        deps.firstRunAsk?.getClientCapabilities ??
        (() => server.server.getClientCapabilities());
      if (!getCaps()?.elicitation) return; // popup can't render on this client
      const elicit: ElicitFn =
        deps.firstRunAsk?.elicit ??
        // Generous timeout: the user may leave the dialog open while they think.
        // The param cast bridges our structural ElicitParams to the SDK's
        // stricter schema type — the shapes agree (flat string enum).
        ((params) =>
          server.server.elicitInput(
            params as Parameters<typeof server.server.elicitInput>[0],
            { timeout: 10 * 60_000 },
          ));

      const { outcome, workspace } = await offerLinkPopup({
        repoName: context.repo,
        elicit,
        listWorkspaces: linkableSlugs,
        linkWorkspace: async (slug) => {
          await linkAndActivate(slug);
        },
        neverAskAgain: rememberDecline,
      });

      // The popup is a user↔server exchange — the AGENT saw none of it. Bridge
      // the gap by staging the "coordination is now active" procedure in the
      // inbox, which the next hook injection or tool call delivers.
      if (outcome === "linked" && inboxFile) {
        appendAnnouncements(inboxFile, [postLinkGuidance(workspace ?? "")]);
      }
      if (outcome !== "unanswered") {
        console.error(
          `[shepherd] first-run ask answered by the user: ${outcome}`,
        );
      }
    } catch (err) {
      // Fail-open: a broken ask must never disturb the session.
      console.error(
        `[shepherd] first-run ask failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  if (!context.linked && !context.declined) {
    const createTripwire_ =
      deps.firstRunAsk?.createTripwire ?? createEditTripwire;
    tripwire = createTripwire_({
      cwd: markerCwd,
      onEdits: () => {
        void runFirstRunAsk();
      },
    });
    tripwire.start();
  }

  // Expose the auto-join promise so callers (and tests) can await readiness, and
  // the leave hook so the process shutdown handler can announce departure.
  return { ready: joinInFlight, leave };
}

/**
 * The synthetic inbox message staged after a POPUP-mediated link. The popup is
 * answered by the user, not the agent — the agent's instructions still say
 * "dormant" — so this bridges the gap: the next hook injection or tool call
 * hands the agent its now-active standing procedure. The negative id can never
 * collide with hub-issued announcement ids (positive DB keys) and sorts first.
 */
function postLinkGuidance(workspace: string): AnnouncementT {
  // Defense in depth: `workspace` originates from the hub's workspace list (or a
  // marker), so strip newlines and cap length before interpolating it into this
  // agent-facing guidance — a malformed value must not forge structure here.
  const safeWorkspace = workspace.replace(/\s+/g, " ").slice(0, 64);
  return {
    id: -Date.now(),
    fromAgentName: "shepherd",
    fromHuman: "shepherd",
    targetAgentName: null,
    createdAt: new Date().toISOString(),
    body:
      `The user just linked this repository to the \`${safeWorkspace}\` workspace — ` +
      "coordination is NOW ACTIVE. Standing procedure from here on: call `work` " +
      "(one-line intent + pathGlobs) BEFORE changing files in an area; `done` when " +
      "that unit of work is complete; `announce` anything teammates need to know; " +
      "`sync` when you resume or switch tasks. Start by calling `work` for the files " +
      "you're editing right now.",
  };
}
