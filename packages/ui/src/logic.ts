/**
 * Pure, auth-agnostic page logic for the Shepherd wallboard.
 *
 * Ported verbatim from packages/hub/public/app.js (the original plain-JS single
 * static page), adding TypeScript types only — behavior is byte-for-byte
 * identical, as the characterization suite in test/logic.test.ts pins. These are
 * the page's "Pure helpers" plus the "Glob containment + active-claim grouping"
 * section; the browser-only DOM-wiring half of app.js is NOT ported here.
 *
 * Times are computed against the server's clock (`serverTime` in the payload),
 * not the browser's, so countdowns and "last seen" stay correct under skew —
 * hence every time helper takes an explicit `nowMs`/`endedIso` rather than
 * reading `Date.now()`.
 *
 * Note: this module intentionally keeps its OWN browser-subset glob matcher
 * (normalizeGlob/segmentCovers/patternCovers below); it does not import the
 * server-side packages/hub/src/globs.ts, which is a deliberately-separate
 * duplicate.
 */

import type { WorkspaceTaskT, WorkspaceAgentT } from "@shepherd/shared";

/**
 * Human "N ago" for a past ISO timestamp, relative to `nowMs` (epoch ms).
 *
 * @param iso - A past instant as an ISO 8601 string.
 * @param nowMs - The reference "now" in epoch milliseconds (the server clock).
 * @returns A short relative label, e.g. `"just now"`, `"30s ago"`, `"2h ago"`.
 */
export function formatRelative(iso: string, nowMs: number): string {
  const secs = Math.floor((nowMs - Date.parse(iso)) / 1000);
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/**
 * Human "expires in N" / "expired" for a future ISO timestamp, relative to
 * `nowMs`.
 *
 * @param iso - The expiry instant as an ISO 8601 string.
 * @param nowMs - The reference "now" in epoch milliseconds (the server clock).
 * @returns `"expired"` once at/past the instant, else e.g. `"expires in 4m"`.
 */
export function formatCountdown(iso: string, nowMs: number): string {
  const secs = Math.floor((Date.parse(iso) - nowMs) / 1000);
  if (secs <= 0) return "expired";
  if (secs < 60) return `expires in ${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `expires in ${mins}m`;
  return `expires in ${Math.floor(mins / 60)}h`;
}

/**
 * Deterministic chat color for an agent name — same name always maps to the
 * same hue, so each speaker reads consistently across the announcement thread.
 * Saturation/lightness are tuned to stay legible on the dark background.
 *
 * @param name - The agent name (may be empty, which yields hue 0 — never throws).
 * @returns An `hsl(...)` CSS color string.
 */
export function colorForName(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
  return `hsl(${h}, 38%, 42%)`;
}

/**
 * Up to two initials for an avatar. Prefers the capital letters of a CamelCase
 * agent name (RedDragon → RD); otherwise the first two letters (alice → AL).
 *
 * @param name - The agent name; empty yields the `"?"` placeholder.
 * @returns A 1–2 character uppercase label.
 */
export function initialsFor(name: string): string {
  if (!name) return "?";
  const caps = name.match(/[A-Z]/g);
  if (caps && caps.length >= 2) return caps[0] + caps[1];
  return name.slice(0, 2).toUpperCase();
}

/**
 * Characters allowed in an agent-name mention token. Agent names are CamelCase
 * (`RedDragon`) or `handle-ordinal` (`alex-6`), so letters, digits, hyphen,
 * and underscore. Used by both the autocomplete and target extraction.
 */
const MENTION_CHARS = "A-Za-z0-9_-";

/**
 * The slice of a mention token the autocomplete operates on: `start`/`end` are
 * the text range to replace when a suggestion is accepted (start = the `@`),
 * and `query` is the text typed after the `@` (possibly empty).
 */
export interface MentionMatch {
  /** Index of the `@` — the start of the replaceable slice. */
  start: number;
  /** The caret index — the end of the replaceable slice. */
  end: number;
  /** The mention-name characters between the `@` and the caret. */
  query: string;
}

/**
 * The active `@mention` immediately to the LEFT of the caret, or null when the
 * caret isn't in one. Drives the autocomplete: the `@` must start the text or
 * follow whitespace (so email addresses like `a@b` don't trigger it), and only
 * mention-name characters may sit between it and the caret.
 *
 * @param text - The full input text.
 * @param caretIndex - The caret position within `text`.
 * @returns The mention slice and query, or `null` when not in a mention.
 */
export function parseMention(
  text: string,
  caretIndex: number,
): MentionMatch | null {
  const before = text.slice(0, caretIndex);
  const m = before.match(new RegExp(`(?:^|\\s)@([${MENTION_CHARS}]*)$`));
  if (!m) return null;
  const query = m[1];
  return { start: caretIndex - query.length - 1, end: caretIndex, query };
}

/**
 * The first `@mention` in `text` that matches a known agent name, returned in
 * the name's canonical casing (so `@reddragon` resolves to `RedDragon`), or null
 * when none match. This is what turns a typed message into a directed DM; an
 * unmatched `@foo` is treated as plain text and the message broadcasts.
 *
 * @param text - The message text to scan.
 * @param knownNames - Canonical agent names to resolve against (case-insensitive).
 * @returns The canonical name of the first matching mention, or `null`.
 */
export function extractTarget(
  text: string,
  knownNames: string[],
): string | null {
  const re = new RegExp(`(?:^|\\s)@([${MENTION_CHARS}]+)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const typed = m[1].toLowerCase();
    const hit = knownNames.find((n) => n.toLowerCase() === typed);
    if (hit) return hit;
  }
  return null;
}

/**
 * Sorted unique repo identifiers present across the given tasks.
 *
 * @param tasks - Items carrying a `repo` (a structural subset of {@link WorkspaceTaskT}).
 * @returns The distinct repos, ascending.
 */
export function distinctRepos(tasks: Pick<WorkspaceTaskT, "repo">[]): string[] {
  return [...new Set(tasks.map((t) => t.repo))].sort();
}

/**
 * Every distinct repo REPRESENTED anywhere on the board: tasks, agents'
 * (most-recent-session) repos, and announcements. Broader than
 * {@link distinctRepos} on purpose — deriving the selector's options from tasks
 * alone made the repo filter vanish whenever all *tasks* happened to sit in one
 * repo, even while agents or chat spanned several. Null/empty repos (an agent
 * with no session yet) are skipped.
 *
 * @param board - Landscape slices carrying `repo` fields (a structural subset
 *   of the workspace landscape response).
 * @returns The distinct non-empty repos, ascending.
 */
export function boardRepos(board: {
  tasks: Pick<WorkspaceTaskT, "repo">[];
  agents: { repo: string | null }[];
  announcements: { repo: string }[];
}): string[] {
  const repos = new Set<string>();
  for (const t of board.tasks) if (t.repo) repos.add(t.repo);
  for (const a of board.agents) if (a.repo) repos.add(a.repo);
  for (const m of board.announcements) if (m.repo) repos.add(m.repo);
  return [...repos].sort();
}

/**
 * True if `item.repo` matches the selection; `null`/`"__all__"` = all repos.
 *
 * @param item - Anything carrying a `repo`.
 * @param selected - The selected repo, or `null`/`"__all__"` for all.
 * @returns Whether the item belongs to the current board filter.
 */
export function matchesRepo(
  item: { repo: string },
  selected: string | null,
): boolean {
  return selected === null || selected === "__all__" || item.repo === selected;
}

/**
 * Live agents addressable by @mention under the current board filter: only those
 * whose (most-recent) session sits in the selected repo, so a message can't be
 * directed at someone who isn't in the repo you're viewing. Mirrors the crew the
 * board already shows for that repo; in All-repos mode everyone live is
 * addressable. Returns de-duplicated canonical names, sorted.
 *
 * @param agents - Agents carrying `name`, `presence`, and `repo` (a structural
 *   subset of {@link WorkspaceAgentT}).
 * @param selectedRepo - The selected repo, or `null`/`"__all__"` for all.
 * @returns Sorted, de-duplicated names of mentionable live agents.
 */
export function mentionableAgents(
  agents: { name: string; presence: string; repo: string }[],
  selectedRepo: string | null,
): string[] {
  return [
    ...new Set(
      agents
        .filter((a) => a.presence === "live" && matchesRepo(a, selectedRepo))
        .map((a) => a.name),
    ),
  ].sort();
}

/**
 * First-load default repo: newest active task's repo, else newest task's, else
 * null.
 *
 * @param tasks - Tasks carrying `repo` and `status` (a structural subset of
 *   {@link WorkspaceTaskT}); assumed newest-first.
 * @returns The repo to select on first load, or `null` when there are no tasks.
 */
export function defaultRepo(
  tasks: Pick<WorkspaceTaskT, "repo" | "status">[],
): string | null {
  const active = tasks.find((t) => t.status === "active");
  if (active) return active.repo;
  return tasks.length ? tasks[0].repo : null;
}

/**
 * Human label for a history task's status.
 *
 * @param status - The task status.
 * @returns `"dropped"` for a dropped task, otherwise `"done"`.
 */
export function statusLabel(status: string): string {
  return status === "dropped" ? "dropped" : "done";
}

/**
 * "active Nm/Nh" for the created->ended span; "" when the task hasn't ended.
 *
 * @param createdIso - The task's creation instant (ISO 8601 string).
 * @param endedIso - The task's end instant, or `null` while still active.
 * @returns A duration label, or the empty string for an unfinished task.
 */
export function formatActiveDuration(
  createdIso: string,
  endedIso: string | null,
): string {
  if (!endedIso) return "";
  const secs = Math.floor(
    (Date.parse(endedIso) - Date.parse(createdIso)) / 1000,
  );
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `active ${mins}m`;
  return `active ${Math.floor(mins / 60)}h`;
}

/**
 * Local-day bucket label: "Today" / "Yesterday" / "Mon D".
 *
 * @param iso - The instant to bucket (ISO 8601 string).
 * @param nowMs - The reference "now" in epoch milliseconds.
 * @returns `"Today"`, `"Yesterday"`, or a short month/day label.
 */
export function dayBucket(iso: string, nowMs: number): string {
  const d = new Date(Date.parse(iso));
  const now = new Date(nowMs);
  const startOf = (x: Date): number =>
    new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const dayDiff = Math.round((startOf(now) - startOf(d)) / 86400000);
  if (dayDiff <= 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Glob containment + active-claim grouping
// ---------------------------------------------------------------------------

/**
 * Normalize a glob into a segment list. Mirrors the server's normalize
 * (packages/hub/src/globs.ts) so the two agree on path shape: lowercase,
 * backslashes -> '/', a trailing slash claims the subtree ('dir/' -> 'dir/**'),
 * split on '/', and resolve '.'/'..'. Module-private.
 */
function normalizeGlob(pattern: string): string[] {
  let p = pattern.toLowerCase().replace(/\\/g, "/");
  if (p.endsWith("/")) p = p.replace(/\/+$/, "") + "/**";
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}

const SEG_WILDCARD = /[*?{}[\]]/;

/**
 * Does single-segment pattern `a` cover single-segment pattern `b`? Conservative:
 * '*' covers any one segment; a literal covers only the identical literal; any
 * other wildcard ('?', braces, brackets) covers only a byte-identical segment.
 * Module-private.
 */
function segmentCovers(a: string, b: string): boolean {
  if (a === "*") return true;
  if (SEG_WILDCARD.test(a)) return a === b;
  return !SEG_WILDCARD.test(b) && a === b;
}

/**
 * Does pattern A (segments) cover pattern B (segments) — i.e. every concrete path
 * matching B also matches A? '**' in A consumes zero-or-more B segments; a bounded
 * (non-'**') A segment can NEVER cover a B '**' (the safety gate that stops a
 * shallow claim from swallowing a deep one). Memoized on the (i, j) suffix.
 * Module-private.
 */
function patternCovers(a: string[], b: string[]): boolean {
  const memo = new Map<number, boolean>();
  function go(i: number, j: number): boolean {
    if (b.length - j === 0) {
      // B exhausted: A covers iff its remainder matches the empty tail, i.e.
      // every remaining A segment is '**' (which can consume zero segments).
      for (let k = i; k < a.length; k++) if (a[k] !== "**") return false;
      return true;
    }
    if (a.length - i === 0) return false; // A exhausted, B still has depth
    const key = i * (b.length + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const ah = a[i],
      bh = b[j];
    let res: boolean;
    if (ah === "**") {
      res = go(i + 1, j) || go(i, j + 1); // consume zero, or one B segment
    } else if (bh === "**") {
      res = false; // bounded A segment cannot cover an unbounded B '**'
    } else {
      res = segmentCovers(ah, bh) && go(i + 1, j + 1);
    }
    memo.set(key, res);
    return res;
  }
  return go(0, 0);
}

/**
 * Does glob set `outer` fully cover glob set `inner` — every path `inner` could
 * touch already inside `outer`? Conservative: unsure -> false, so a caller only
 * folds a claim it's certain is contained (a false negative just shows both
 * claims, which is safe). An empty `inner` is trivially covered.
 *
 * @param outer - The candidate broader glob set.
 * @param inner - The candidate narrower glob set.
 * @returns Whether every glob in `inner` is covered by some glob in `outer`.
 */
export function globsCover(outer: string[], inner: string[]): boolean {
  if (inner.length === 0) return true;
  const o = outer.map(normalizeGlob);
  return inner.every((g) => {
    const ng = normalizeGlob(g);
    return o.some((op) => patternCovers(op, ng));
  });
}

/**
 * The fields a claim must carry to be grouped: its agent, glob territory, and
 * creation order, plus the header fields surfaced on the group. A structural
 * subset of {@link WorkspaceTaskT}, so callers may pass partial task shapes.
 */
export type ClaimLike = Pick<
  WorkspaceTaskT,
  "agentName" | "pathGlobs" | "createdAt" | "model" | "program" | "repo"
>;

/**
 * One agent's grouped active claims for the board. `primaries` are the visible
 * claims; `narrower` are those strictly covered by a broader sibling and folded
 * away. Header fields (model/program/repo) come from the group's newest claim.
 *
 * @typeParam T - The concrete claim shape passed in, preserved on the members.
 */
export interface ClaimGroup<T extends ClaimLike = ClaimLike> {
  /** The agent these claims belong to. */
  agentName: string;
  /** Representative model from the group's newest claim. */
  model: T["model"];
  /** Representative program from the group's newest claim. */
  program: T["program"];
  /** Representative repo from the group's newest claim. */
  repo: T["repo"];
  /** Visible claims, newest-first. */
  primaries: T[];
  /** Claims folded under a broader sibling, newest-first. */
  narrower: T[];
}

/**
 * Group active claims by agent for the board. Within an agent's claims, one that
 * is STRICTLY covered by a broader sibling (the sibling covers it but not vice
 * versa, so identical claims don't cannibalise each other) folds into `narrower`;
 * everything else stays a visible `primary`. Distinct or merely-overlapping
 * claims all remain primaries. Pure — no DOM, no clock; `createdAt` drives order.
 *
 * Groups are newest-claim-first; `primaries`/`narrower` are each newest-first;
 * header fields (model/program/repo) come from the group's newest claim.
 *
 * @param tasks - The active claims to group (a structural subset of
 *   {@link WorkspaceTaskT}).
 * @returns One {@link ClaimGroup} per agent, newest-claim-first.
 */
export function groupActiveClaims<T extends ClaimLike>(
  tasks: T[],
): ClaimGroup<T>[] {
  const byAgent = new Map<string, T[]>();
  for (const t of tasks) {
    if (!byAgent.has(t.agentName)) byAgent.set(t.agentName, []);
    byAgent.get(t.agentName)!.push(t);
  }
  const newestFirst = (a: T, b: T): number =>
    b.createdAt.localeCompare(a.createdAt);
  const groups: ClaimGroup<T>[] = [];
  for (const [agentName, claims] of byAgent) {
    const sorted = [...claims].sort(newestFirst);
    const isNarrower = sorted.map((c) =>
      sorted.some(
        (o) =>
          o !== c &&
          globsCover(o.pathGlobs, c.pathGlobs) &&
          !globsCover(c.pathGlobs, o.pathGlobs),
      ),
    );
    const head = sorted[0];
    groups.push({
      agentName,
      model: head.model,
      program: head.program,
      repo: head.repo,
      primaries: sorted.filter((_, i) => !isNarrower[i]),
      narrower: sorted.filter((_, i) => isNarrower[i]),
    });
  }
  groups.sort((g1, g2) => {
    const t1 = g1.primaries.concat(g1.narrower)[0].createdAt;
    const t2 = g2.primaries.concat(g2.narrower)[0].createdAt;
    return t2.localeCompare(t1);
  });
  return groups;
}
