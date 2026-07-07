import { generateName } from "@shepherd/shared";
import {
  detectRepo as realDetectRepo,
  detectBranch as realDetectBranch,
  detectHuman as realDetectHuman,
  canonicalizeRepo,
} from "./gitContext.js";
import {
  readCachedHuman as realReadCachedHuman,
  writeCachedHuman as realWriteCachedHuman,
} from "./identityCache.js";
import { DEFAULT_WORKSPACE, type Config } from "./config.js";
import {
  readMarker as realReadMarker,
  findRepoRoot as realFindRepoRoot,
  type Marker,
} from "./marker.js";
import { isDeclined as realIsDeclined } from "./declined.js";

/**
 * The first-run coordination state of this repo, derived from the committed
 * marker and the user's local declined record:
 *
 *  - `linked`     : a `.shepherd` marker is present — the repo participates.
 *  - `declined`   : no marker, but this user recorded a local "don't ask again"
 *                   decline for this repo (see {@link "./declined.js"}).
 *  - `unanswered` : no marker and no decline — the first-run choice is still open,
 *                   so `link` should prompt (auto-pick or ask).
 *
 * `linked` takes precedence: a present marker means the repo participates even if
 * a stale local decline is still on disk.
 */
export type LinkState = "linked" | "declined" | "unanswered";

/**
 * The startup-stable context the client sends on `join`. Resolved once at
 * startup from env overrides, git detection, and fallbacks — it does not change
 * for the lifetime of the connection.
 */
export interface JoinContext {
  workspace: string;
  repo: string;
  branch: string;
  human: string;
  program: string;
  /** Omitted (undefined) unless explicitly configured; never detected. */
  model: string | undefined;
  /**
   * True iff a repo-local `.shepherd` marker opted this repo in (design D8 /
   * §5.1). When false the client stays dormant: it does not `/join`, runs no
   * heartbeat, and every coordination tool returns a "not linked" advisory.
   * The marker — when present — also DECIDES `workspace` (it wins over the env
   * default), so a linked repo always joins exactly the workspace it names.
   */
  linked: boolean;
  /**
   * True iff this user recorded a local "don't ask me again" decline for this
   * repo (see {@link "./declined.js"}). Reported as the raw on-disk state even
   * when `linked` — a present marker suppresses (but does not erase) a decline,
   * so {@link linkState} is the resolved view to branch on.
   */
  declined: boolean;
  /** The resolved first-run state; see {@link LinkState}. */
  linkState: LinkState;
}

/**
 * Detection seam. Defaults to the real gitContext, identityCache, and marker
 * implementations; tests inject fakes so they never spawn `git` or touch disk.
 */
export interface ResolveContextDeps {
  detectRepo: (cwd: string) => string | null;
  detectBranch: (cwd: string) => string | null;
  detectHuman: (cwd: string) => string | null;
  readMarker: (cwd: string) => Marker | null;
  /** Resolve the repo root above `cwd` (null when not in a repo). Fail-open. */
  findRepoRoot: (cwd: string) => string | null;
  /** Whether this user declined coordination for `repoRoot`. Fail-open. */
  isDeclined: (repoRoot: string) => boolean;
  /** Read the device's cached human name (null when absent). Fail-open. */
  readCachedHuman: () => string | null;
  /** Persist a human name as the device cache. Fail-open. */
  writeCachedHuman: (human: string) => void;
}

const defaultDeps: ResolveContextDeps = {
  detectRepo: realDetectRepo,
  detectBranch: realDetectBranch,
  detectHuman: realDetectHuman,
  readMarker: realReadMarker,
  findRepoRoot: realFindRepoRoot,
  isDeclined: (repoRoot: string) => realIsDeclined(repoRoot),
  readCachedHuman: realReadCachedHuman,
  writeCachedHuman: realWriteCachedHuman,
};

/**
 * Resolve each context field in order: env override → git detection → fallback.
 *
 * Detection is fail-open (returns null), so a non-git cwd still produces a valid
 * context via the fallbacks. `async` so a future detection step may do async
 * work without changing the call site (current gitContext fns are synchronous).
 */
export async function resolveContext(
  config: Config,
  cwd: string = process.cwd(),
  deps: ResolveContextDeps = defaultDeps,
): Promise<JoinContext> {
  // Canonicalize whatever source wins (env override OR detection) so differing
  // spellings of the same repo converge — repo is the coordination boundary.
  const repo = canonicalizeRepo(
    config.REPO ?? deps.detectRepo(cwd) ?? "unknown-repo",
  );
  const branch = config.BRANCH ?? deps.detectBranch(cwd) ?? "HEAD";
  const human = resolveHuman(config, cwd, deps);
  const program = config.PROGRAM ?? "claude-code";
  const model = config.MODEL ?? undefined;

  // Repo opt-in marker (D8 / §5.1): a committed `.shepherd` is the decision to
  // participate AND names the workspace. When present it WINS over the env
  // default — a linked repo always joins exactly the workspace it names.
  // Absent → dormant (linked: false), workspace falls back to env → default.
  const marker = deps.readMarker(cwd);
  const linked = marker !== null;
  const workspace = marker?.workspace ?? config.WORKSPACE ?? DEFAULT_WORKSPACE;

  // First-run state: the local "don't ask again" decline is keyed by the repo
  // root, so it survives across the subdirs an agent may launch from. Fail-open
  // to undeclined when we can't resolve a repo root (matching marker behavior).
  const repoRoot = deps.findRepoRoot(cwd);
  const declined = repoRoot !== null ? deps.isDeclined(repoRoot) : false;
  const linkState: LinkState = linked
    ? "linked"
    : declined
      ? "declined"
      : "unanswered";

  return {
    workspace,
    repo,
    branch,
    human,
    program,
    model,
    linked,
    declined,
    linkState,
  };
}

/**
 * Resolve the human identity with device-cache persistence:
 *
 *   1. `HUMAN` env override — an intentional manual identity; wins outright and
 *      NEVER mutates the cache.
 *   2. Git detection (from the launch cwd) — authoritative when available. The
 *      detected name is written to the device cache (refreshing it when git now
 *      reports something different), so a later launch from a non-git dir reuses
 *      this name.
 *   3. Device cache — the last git-detected name on this machine. Used only when
 *      git can't detect a name from the current cwd (e.g. launched from a
 *      multi-repo parent dir), giving those launches a stable identity instead
 *      of a fresh random one each time.
 *   4. Generated name — the final fallback when there is no override, no git
 *      identity, and no cache.
 */
function resolveHuman(
  config: Config,
  cwd: string,
  deps: ResolveContextDeps,
): string {
  if (config.HUMAN) return config.HUMAN;

  const detected = deps.detectHuman(cwd);
  if (detected) {
    // Refresh the cache so non-git launches converge on the current git name.
    // writeCachedHuman is fail-open and a no-op for an unchanged value's sake is
    // cheap, so we always write rather than read-compare-write.
    deps.writeCachedHuman(detected);
    return detected;
  }

  const cached = deps.readCachedHuman();
  if (cached) return cached;

  return generateName();
}
