import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEditTripwire } from "../src/editTripwire.js";

// The tripwire polls `git status --porcelain` and fires `onEdits` ONCE when a
// path turns dirty that was NOT dirty at session start. All tests inject a fake
// git runner (a queue of porcelain outputs) and drive time with fake timers.

const INTERVAL = 30_000;

/** A git-status stub returning each queued output in turn (last one repeats). */
function statusQueue(...outputs: Array<string | null>) {
  let i = 0;
  return vi.fn(async (): Promise<string | null> => {
    const out = outputs[Math.min(i, outputs.length - 1)];
    i++;
    return out;
  });
}

function make(runGitStatus: (cwd: string) => Promise<string | null>) {
  const onEdits = vi.fn();
  const tripwire = createEditTripwire({
    cwd: "C:/fake/repo",
    intervalMs: INTERVAL,
    onEdits,
    runGitStatus,
  });
  return { tripwire, onEdits };
}

/** Flush the async arming step (baseline read) that start() kicks off. */
async function armed(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createEditTripwire", () => {
  it("does not fire while the status matches the session-start baseline", async () => {
    const { tripwire, onEdits } = make(statusQueue(" M src/old.ts\n"));
    tripwire.start();
    await armed();

    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(onEdits).not.toHaveBeenCalled();
    tripwire.stop();
  });

  it("fires ONCE when a new path turns dirty, then disarms itself", async () => {
    const run = statusQueue(
      "", // baseline: clean tree
      " M src/a.ts\n", // tick 1: new dirty path → fire
      " M src/a.ts\n M src/b.ts\n" // would be a second trigger — must not fire
    );
    const { tripwire, onEdits } = make(run);
    tripwire.start();
    await armed();

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(onEdits).toHaveBeenCalledOnce();

    // Disarmed: no more polling, no second fire.
    const callsAfterFire = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(onEdits).toHaveBeenCalledOnce();
    expect(run.mock.calls.length).toBe(callsAfterFire);
  });

  it("ignores paths already dirty at baseline (pre-existing user edits)", async () => {
    const { tripwire, onEdits } = make(
      statusQueue(" M src/preexisting.ts\n?? notes.md\n")
    );
    tripwire.start();
    await armed();

    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(onEdits).not.toHaveBeenCalled();
    tripwire.stop();
  });

  it("counts untracked (new) files as edits", async () => {
    const { tripwire, onEdits } = make(statusQueue("", "?? src/new-file.ts\n"));
    tripwire.start();
    await armed();

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(onEdits).toHaveBeenCalledOnce();
  });

  it("never arms when the baseline read fails (not a repo / git missing)", async () => {
    const run = statusQueue(null);
    const { tripwire, onEdits } = make(run);
    tripwire.start();
    await armed();

    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(onEdits).not.toHaveBeenCalled();
    // Fail-open means fail QUIET: no polling loop was ever started.
    expect(run).toHaveBeenCalledOnce();
  });

  it("skips a failed tick (fail-open) and still fires on a later good one", async () => {
    const { tripwire, onEdits } = make(statusQueue("", null, " M src/a.ts\n"));
    tripwire.start();
    await armed();

    await vi.advanceTimersByTimeAsync(INTERVAL); // failed tick — skipped
    expect(onEdits).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(INTERVAL); // good tick → fire
    expect(onEdits).toHaveBeenCalledOnce();
  });

  it("stop() disarms: no fire even when edits appear afterwards", async () => {
    const { tripwire, onEdits } = make(statusQueue("", " M src/a.ts\n"));
    tripwire.start();
    await armed();

    tripwire.stop();
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(onEdits).not.toHaveBeenCalled();
  });

  it("stop() during the async arming step wins the race (no timer leaks)", async () => {
    const run = statusQueue("");
    const { tripwire, onEdits } = make(run);
    tripwire.start();
    tripwire.stop(); // before the baseline read resolves
    await armed();

    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(onEdits).not.toHaveBeenCalled();
    expect(run).toHaveBeenCalledOnce(); // baseline read only — never polled
  });

  it("an onEdits that throws is swallowed (fail-open) and still disarms", async () => {
    const onEdits = vi.fn(() => {
      throw new Error("popup exploded");
    });
    const run = statusQueue("", " M src/a.ts\n");
    const tripwire = createEditTripwire({
      cwd: "C:/fake/repo",
      intervalMs: INTERVAL,
      onEdits,
      runGitStatus: run,
    });
    tripwire.start();
    await armed();

    await expect(vi.advanceTimersByTimeAsync(INTERVAL)).resolves.not.toThrow();
    expect(onEdits).toHaveBeenCalledOnce();
    const calls = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(run.mock.calls.length).toBe(calls); // disarmed despite the throw
  });

  it("a rename shows as one new status line and fires like any other edit", async () => {
    const { tripwire, onEdits } = make(
      statusQueue("", "R  src/old.ts -> src/new.ts\n")
    );
    tripwire.start();
    await armed();

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(onEdits).toHaveBeenCalledOnce();
  });
});
