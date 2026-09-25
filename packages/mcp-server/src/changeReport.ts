import { CHANGE_REPORT_MAX_BYTES, type ChangeReportT } from "@shepherd/shared";
import {
  detectBranch,
  detectBaseBranch,
  headSha,
  unlandedCommits,
  dirtyPaths,
} from "./gitContext.js";
import type { Config } from "./config.js";

/**
 * Placeholder used for the (string, per-contract) `baseBranch` field when no
 * base branch can be resolved. The report is still sent so the hub can clear
 * stale records and surface uncommitted work; the base is simply unknown.
 */
const UNRESOLVED_BASE = "(unknown)";

/**
 * Build the advisory change report the client attaches to `work`/`sync`.
 *
 * Best-effort and fail-open: it only composes the already-fail-open gitContext
 * helpers and never throws. Re-detects branch + head per-report (state changes
 * over a session). Returns `undefined` ONLY when the cwd is not a git repo at
 * all (branch AND head both null) — in that case there is nothing to report.
 *
 * When a repo IS present:
 *  - dirty paths (if any) become a single `uncommitted` entry,
 *  - committed entries are added ONLY when a base branch resolves,
 *  - a clean tree still yields `entries: []` so the hub's wholesale replace
 *    auto-clears this agent's stale records.
 */
export async function buildChangeReport(
  cwd: string,
  config: Config,
): Promise<ChangeReportT | undefined> {
  const branch = detectBranch(cwd);
  const head = headSha(cwd);

  // Not a git repo at all — nothing to report.
  if (branch === null && head === null) {
    return undefined;
  }

  const base = config.BASE_BRANCH ?? detectBaseBranch(cwd);

  const entries: ChangeReportT["entries"] = [];
  let truncated = false;

  // Uncommitted: always attempt, regardless of whether a base resolved.
  const dirty = dirtyPaths(cwd);
  if (dirty.truncated) truncated = true;
  if (dirty.paths.length > 0) {
    entries.push({
      kind: "uncommitted",
      sha: null,
      message: null,
      paths: dirty.paths,
    });
  }

  // Committed: only meaningful when we have a base to diff against.
  if (base) {
    const unlanded = unlandedCommits(cwd, base);
    if (unlanded.truncated) truncated = true;
    for (const c of unlanded.commits) {
      // Defensive: the hub contract requires committed entries to carry at least
      // one path. Skip any commit with empty paths (e.g. a merge/empty commit
      // that slipped through) so one such record can't get the whole report
      // rejected. unlandedCommits already drops these at the source.
      if (c.paths.length === 0) continue;
      entries.push({
        kind: "committed",
        sha: c.sha,
        message: c.message,
        paths: c.paths,
      });
    }
  }

  return fitToBudget({
    branch: branch ?? "HEAD",
    baseBranch: base ?? UNRESOLVED_BASE,
    head: head ?? "",
    truncated,
    entries,
  });
}

/** Serialized size of the report as the hub client will send it. */
function serializedBytes(report: ChangeReportT): number {
  return Buffer.byteLength(JSON.stringify(report));
}

/**
 * Shrink `report` until its JSON form fits {@link CHANGE_REPORT_MAX_BYTES}.
 *
 * The contract's per-field caps multiply out far past any HTTP body limit, and
 * the hub rejects an oversized body with 413 BEFORE any handler runs — which
 * silently killed every work/sync/heartbeat from a long-lived branch. Trim
 * order, least valuable first: the OLDEST committed entries (entries are
 * newest-first after the single uncommitted entry), then, only if the dirty
 * list alone is still too big, the tail of the uncommitted paths. Anything
 * dropped sets `truncated`. Mutates and returns `report`.
 */
function fitToBudget(report: ChangeReportT): ChangeReportT {
  if (serializedBytes(report) <= CHANGE_REPORT_MAX_BYTES) return report;
  report.truncated = true;

  while (
    report.entries.length > 0 &&
    report.entries[report.entries.length - 1]!.kind === "committed" &&
    serializedBytes(report) > CHANGE_REPORT_MAX_BYTES
  ) {
    report.entries.pop();
  }

  const dirty = report.entries[0];
  if (dirty?.kind === "uncommitted") {
    while (
      dirty.paths.length > 1 &&
      serializedBytes(report) > CHANGE_REPORT_MAX_BYTES
    ) {
      // Halve rather than pop one-by-one: a 500-path list re-serialized per
      // step would be quadratic; halving converges in a handful of passes.
      dirty.paths.length = Math.ceil(dirty.paths.length / 2);
    }
  }
  return report;
}
