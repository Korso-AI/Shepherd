import { execFile } from "node:child_process";

/**
 * Layer 1 of the zero-setup first-run flow: a local edit detector for repos
 * where the link question is still open (never asked, not declined).
 *
 * It snapshots `git status --porcelain` at session start as a baseline, then
 * polls; the moment a path is dirty that was NOT dirty at baseline, someone —
 * almost certainly this session's agent — has started changing files, and
 * `onEdits` fires exactly once (the consumer raises the link question, e.g. the
 * elicitation popup). After firing, the tripwire disarms itself: the question
 * is asked at most once per session, and answered repos never poll at all.
 *
 * Purely local — no hub traffic, no client setup, works identically on every
 * MCP client. Fail-open throughout: a missing git, a non-repo cwd, or a failed
 * poll can only ever mean "don't ask", never a crash (stderr at most).
 */
export interface EditTripwire {
  /** Take the baseline and arm the poll loop. Restarts cleanly if armed. */
  start(): void;
  /** Disarm. Idempotent; also cancels an in-flight arming. */
  stop(): void;
}

export function createEditTripwire({
  cwd,
  intervalMs = 30_000,
  onEdits,
  runGitStatus = defaultRunGitStatus,
}: {
  /** The working directory whose repo is watched. */
  cwd: string;
  /** Poll cadence. The default trades ~2 no-op git calls/min for a prompt ask. */
  intervalMs?: number;
  /**
   * Fired exactly once, on the first newly-dirty path. Must not rely on being
   * awaited — do async work behind a `void`ed promise. A throw is swallowed.
   */
  onEdits: () => void;
  /**
   * Seam for tests: returns porcelain stdout, or null on ANY failure (not a
   * repo, git missing, timeout). Defaults to a real `git status --porcelain`.
   */
  runGitStatus?: (cwd: string) => Promise<string | null>;
}): EditTripwire {
  let timer: ReturnType<typeof setInterval> | null = null;
  let baseline: Set<string> | null = null;
  // Once stopped or fired, the tripwire never re-arms from an in-flight step.
  let disarmed = false;

  function stop(): void {
    disarmed = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function check(): Promise<void> {
    const out = await runGitStatus(cwd);
    if (out === null || baseline === null || disarmed) return; // fail-open skip
    for (const path of parsePorcelainPaths(out)) {
      if (!baseline.has(path)) {
        stop(); // disarm FIRST — one shot even if onEdits throws
        try {
          onEdits();
        } catch (err) {
          console.error(
            `[shepherd] edit-tripwire handler failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        }
        return;
      }
    }
  }

  function start(): void {
    stop();
    disarmed = false;
    void (async () => {
      const out = await runGitStatus(cwd);
      // No baseline → never arm: without a trustworthy "before", any dirty
      // path would look new and the ask would fire spuriously.
      if (out === null || disarmed) return;
      baseline = new Set(parsePorcelainPaths(out));
      timer = setInterval(() => {
        void check().catch(() => {
          /* fail-open: a poll error is just a skipped tick */
        });
      }, intervalMs);
      // Never let the tripwire alone keep the process alive.
      timer.unref();
    })();
  }

  return { start, stop };
}

/**
 * Extract the path field from `git status --porcelain` (v1) lines: two status
 * chars + space + path. A rename's "old -> new" is kept whole — it only needs
 * to be a stable, comparable key, not a filesystem path.
 */
function parsePorcelainPaths(out: string): string[] {
  return out
    .split("\n")
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3));
}

/** Real git runner: porcelain stdout, or null on any failure (fail-open). */
function defaultRunGitStatus(cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["status", "--porcelain"],
      { cwd, timeout: 5_000, windowsHide: true },
      (err, stdout) => {
        resolve(err ? null : stdout);
      }
    );
  });
}
