import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { canonicalizeRepo, normalizeRemoteUrl } from "@shepherd/shared";

// Repo canonicalization is the coordination key and MUST match the hub's, so it
// lives in @shepherd/shared as the single source of truth. Re-exported here so
// existing client call sites (resolveContext, tests) keep importing it from
// gitContext, and used internally by detectRepo via normalizeRemoteUrl.
export { canonicalizeRepo };

/**
 * gitContext — thin, individually-testable wrappers over `git` child-process calls.
 *
 * Contract for EVERY exported function:
 *  - accepts a `cwd` (default `process.cwd()`)
 *  - times out short (~2000ms)
 *  - FAILS OPEN: any failure (git absent, non-zero exit, timeout, parse error)
 *    is caught and converted to a neutral result (null / [] / false / {}).
 *    No rejection or throw ever escapes.
 */

const GIT_TIMEOUT_MS = 2000;

/** Cap on the number of unlanded commits returned. */
export const MAX_COMMITS = 100;
/** Cap on the number of paths returned per commit (hub contract limit). */
export const MAX_PATHS_PER_COMMIT = 500;
/** Cap on the number of dirty paths returned. */
export const MAX_DIRTY_PATHS = 500;
/**
 * Cap on the number of paths {@link changedLineRanges} will process. It spawns up
 * to 2 serial git calls per path, so a large path list would mean a long burst of
 * blocking spawns. Line detail is information-only, so we silently process at most
 * the first N paths and ignore the rest.
 */
export const MAX_LINE_RANGE_PATHS = 50;

export interface UnlandedCommit {
  sha: string;
  message: string;
  paths: string[];
}

/**
 * Return shape for {@link unlandedCommits}. `truncated` is true when EITHER the
 * commit cap was hit OR any single commit's path list was capped — the caller
 * (buildChangeReport) uses this to set `truncated: true` on the change report.
 */
export interface UnlandedCommitsResult {
  commits: UnlandedCommit[];
  truncated: boolean;
}

/**
 * Return shape for {@link dirtyPaths}. `truncated` is true when the path cap was hit.
 */
export interface DirtyPathsResult {
  paths: string[];
  truncated: boolean;
}

export interface LineRange {
  start: number;
  end: number;
}

/**
 * Run git and return trimmed stdout, or `null` on ANY failure. Never throws.
 */
function runGit(cwd: string, args: string[]): string | null {
  try {
    const out = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      // Keep git from prompting for credentials/editors and hanging the timeout.
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      // Capture stdout; silence stderr so failures stay quiet (we fail open).
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim();
  } catch {
    return null;
  }
}

/**
 * Run git purely for its exit code. Returns true on exit 0, false on any
 * non-zero exit, error, or timeout. Never throws.
 */
function runGitExitOk(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `sha` is a plausible git object id: lowercase hex, 4–64 chars.
 *
 * Defense-in-depth for the helpers below, which pass `sha` into `git` argument
 * vectors. The values originate from OTHER clients (relayed through the hub),
 * so they are a trust-boundary input on the receiving machine. A flag-like
 * value (e.g. "--output=<file>") would be parsed by git as an option rather
 * than a rev — `git diff` honors `--output` (arbitrary file write) — so we
 * reject anything that is not pure hex, mirroring the `baseBranch` guard in
 * unlandedCommits. The wire contract (ChangeReportEntry.sha) enforces the same
 * shape, but these helpers re-check because they accept raw arguments.
 */
function isValidSha(sha: string): boolean {
  return /^[0-9a-f]{4,64}$/.test(sha);
}

/**
 * Detect the repo identity as `owner/repo` from origin, else the toplevel
 * directory basename, else null. The raw detected value is canonicalized
 * downstream (resolveContext, and authoritatively the hub at ingestion).
 */
export function detectRepo(cwd: string = process.cwd()): string | null {
  const origin = runGit(cwd, ["config", "--get", "remote.origin.url"]);
  if (origin) {
    const normalized = normalizeRemoteUrl(origin);
    if (normalized) return normalized;
  }
  const top = runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (top) {
    const base = path.basename(top);
    if (base) return base;
  }
  return null;
}

/**
 * Detect the current branch name, "HEAD" if detached, or null if not a repo.
 */
export function detectBranch(cwd: string = process.cwd()): string | null {
  const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null || branch === "") return null;
  return branch;
}

/**
 * Detect the human identity: git `user.name` preferred, else the local-part of
 * `user.email`, else null. In BOTH cases an email address is reduced to its
 * local-part — `user.name` is frequently set to a full email, and a handle
 * ("alice") is a far better identity than "alice@example.com" (which the hub
 * would slug to "aliceexamplecom").
 */
export function detectHuman(cwd: string = process.cwd()): string | null {
  // `git config` reads global config too, so it succeeds outside a repo. Gate on
  // being inside a work tree so a non-git cwd fails open to null, per contract.
  if (!runGitExitOk(cwd, ["rev-parse", "--is-inside-work-tree"])) {
    return null;
  }
  const name = runGit(cwd, ["config", "user.name"]);
  if (name) {
    // If user.name looks like an email, keep only the local-part; otherwise use
    // it verbatim. Fall through to user.email if that leaves nothing usable.
    const local = name.includes("@") ? name.split("@")[0] : name;
    if (local) return local;
  }
  const email = runGit(cwd, ["config", "user.email"]);
  if (email) {
    const local = email.split("@")[0];
    if (local) return local;
  }
  return null;
}

/**
 * Detect the base branch as a remote-tracking ref (e.g. `origin/main`).
 * Resolves origin/HEAD if set, else probes origin/main then origin/master, else null.
 */
export function detectBaseBranch(cwd: string = process.cwd()): string | null {
  const symref = runGit(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
  if (symref) {
    // e.g. "refs/remotes/origin/main" -> "origin/main"
    const stripped = symref.replace(/^refs\/remotes\//, "");
    if (stripped) return stripped;
  }
  for (const candidate of ["origin/main", "origin/master"]) {
    if (runGitExitOk(cwd, ["rev-parse", "--verify", "--quiet", `refs/remotes/${candidate}`])) {
      return candidate;
    }
  }
  return null;
}

/** Return the HEAD commit sha, or null. */
export function headSha(cwd: string = process.cwd()): string | null {
  const sha = runGit(cwd, ["rev-parse", "HEAD"]);
  if (sha === null || sha === "") return null;
  return sha;
}

/**
 * Return commits on HEAD that are not on `baseBranch`, newest-first.
 * Capped to the most recent {@link MAX_COMMITS}, each commit's `paths` capped to
 * {@link MAX_PATHS_PER_COMMIT}. Either cap being hit sets `truncated: true`.
 * Returns `{ commits: [], truncated: false }` on any failure.
 */
export function unlandedCommits(
  cwd: string = process.cwd(),
  baseBranch: string,
): UnlandedCommitsResult {
  // Defensive guard: `baseBranch` is concatenated into the `${baseBranch}..HEAD`
  // revision token. Array invocation already prevents shell injection, but reject
  // a falsy or flag-like ref (begins with "-") rather than passing it to git.
  if (!baseBranch || baseBranch.startsWith("-")) {
    return { commits: [], truncated: false };
  }
  // NUL separates sha from subject; commits separated by record separator we
  // synthesize via the per-commit %H marker. We use --name-only with a custom
  // format and a unique field separator (\x00) between sha and subject.
  const out = runGit(cwd, [
    "log",
    `${baseBranch}..HEAD`,
    "--name-only",
    `--max-count=${MAX_COMMITS}`,
    "--format=%x01%H%x00%s",
  ]);
  if (out === null) {
    return { commits: [], truncated: false };
  }
  if (out === "") {
    return { commits: [], truncated: false };
  }

  let truncated = false;
  const commits: UnlandedCommit[] = [];

  // Records are introduced by \x01. Split on it and drop the empty leading chunk.
  const records = out.split("\x01").filter((r) => r.length > 0);
  for (const record of records) {
    // First line of the record is "<sha>\x00<subject>"; remaining non-empty
    // lines are file paths.
    const newlineIdx = record.indexOf("\n");
    const header = newlineIdx === -1 ? record : record.slice(0, newlineIdx);
    const rest = newlineIdx === -1 ? "" : record.slice(newlineIdx + 1);
    const nulIdx = header.indexOf("\x00");
    const sha = (nulIdx === -1 ? header : header.slice(0, nulIdx)).trim();
    const message = nulIdx === -1 ? "" : header.slice(nulIdx + 1);
    if (!sha) continue;

    let paths = rest
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (paths.length > MAX_PATHS_PER_COMMIT) {
      paths = paths.slice(0, MAX_PATHS_PER_COMMIT);
      truncated = true;
    }
    // `git log --name-only` emits NO file lines for merge/empty commits. The hub
    // wire contract requires every ChangeReportEntry.paths to be non-empty, so a
    // single such commit would make the hub reject the whole report. Drop them
    // here at the source. Skipping does not count toward MAX_COMMITS truncation.
    if (paths.length === 0) continue;
    commits.push({ sha, message, paths });
  }

  // --max-count already caps at MAX_COMMITS; if we hit exactly the cap there may
  // be more, so flag truncation conservatively.
  if (commits.length >= MAX_COMMITS) {
    truncated = true;
  }

  return { commits, truncated };
}

/**
 * Return deduped, repo-relative paths that are dirty (modified, staged, or
 * untracked). Capped to {@link MAX_DIRTY_PATHS}; hitting the cap sets `truncated`.
 * Returns `{ paths: [], truncated: false }` on any failure.
 */
export function dirtyPaths(cwd: string = process.cwd()): DirtyPathsResult {
  // -z gives NUL-terminated records, immune to spaces/quoting in paths.
  const out = runGit(cwd, ["status", "--porcelain", "-z", "--untracked-files=all"]);
  if (out === null) {
    return { paths: [], truncated: false };
  }

  const seen = new Set<string>();
  // Records are NUL-terminated. Each porcelain record begins with a 2-char
  // status code + a space, then the path. Renames (R/C) emit two NUL fields:
  // "<status> <to>\0<from>". We capture both endpoints.
  const fields = out.split("\x00").filter((f) => f.length > 0);
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const status = field.slice(0, 2);
    const rest = field.slice(2).replace(/^\s+/, "");
    if (rest) seen.add(rest);
    // Rename/copy: the following field is the source path.
    if (/[RC]/.test(status)) {
      const src = fields[i + 1];
      if (src) {
        seen.add(src);
        i++; // consume the source field
      }
    }
  }

  let paths = Array.from(seen);
  let truncated = false;
  if (paths.length > MAX_DIRTY_PATHS) {
    paths = paths.slice(0, MAX_DIRTY_PATHS);
    truncated = true;
  }
  return { paths, truncated };
}

/**
 * Whether `sha` is an ancestor of HEAD. Exit 0 -> true; anything else
 * (non-zero, unknown sha, error, not a repo) -> false (favor showing the heads-up).
 */
export function isAncestor(cwd: string = process.cwd(), sha: string): boolean {
  if (!isValidSha(sha)) return false;
  return runGitExitOk(cwd, ["merge-base", "--is-ancestor", sha, "HEAD"]);
}

/** Whether the commit object for `sha` is present locally. */
export function hasCommit(cwd: string = process.cwd(), sha: string): boolean {
  if (!isValidSha(sha)) return false;
  return runGitExitOk(cwd, ["cat-file", "-e", `${sha}^{commit}`]);
}

/** Parse `@@ -a,b +c,d @@` hunk headers into new-file line ranges. */
function parseHunkRanges(diff: string): LineRange[] {
  const ranges: LineRange[] = [];
  const re = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff)) !== null) {
    const start = parseInt(m[1], 10);
    const count = m[2] === undefined ? 1 : parseInt(m[2], 10);
    if (count <= 0) {
      // Pure deletion in the new file; record a zero-width marker at `start`.
      ranges.push({ start, end: start });
    } else {
      ranges.push({ start, end: start + count - 1 });
    }
  }
  return ranges;
}

/**
 * For a locally-present commit, derive new-file line ranges per path from the
 * commit's own diff. Returns `Record<path, LineRange[]>`; `{}` on any failure.
 * Information only — best effort.
 */
export function changedLineRanges(
  cwd: string = process.cwd(),
  sha: string,
  paths: string[],
): Record<string, LineRange[]> {
  if (!isValidSha(sha) || !paths || paths.length === 0) return {};
  const result: Record<string, LineRange[]> = {};
  // Defensive cap: each path costs up to 2 serial blocking git spawns, so a very
  // large path list would be a long spawn burst. Line detail is information-only,
  // so silently process at most the first MAX_LINE_RANGE_PATHS and ignore the rest.
  const capped = paths.length > MAX_LINE_RANGE_PATHS ? paths.slice(0, MAX_LINE_RANGE_PATHS) : paths;
  for (const p of capped) {
    // Normal commit: diff against its first parent.
    let diff = runGit(cwd, ["diff", "--unified=0", `${sha}~1`, sha, "--", p]);
    if (diff === null) {
      // Root commit (no parent): show the commit's own content as additions.
      diff = runGit(cwd, ["show", "--unified=0", "--format=", sha, "--", p]);
    }
    if (diff === null || diff === "") continue;
    const ranges = parseHunkRanges(diff);
    if (ranges.length > 0) {
      result[p] = ranges;
    }
  }
  return result;
}
