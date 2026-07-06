import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Config } from "../src/config.js";

// ---------------------------------------------------------------------------
// Mock gitContext so no real `git` is ever spawned. buildChangeReport imports
// from "./gitContext.js"; we control each detection per-test.
// ---------------------------------------------------------------------------

vi.mock("../src/gitContext.js", () => ({
  detectBranch: vi.fn(),
  detectBaseBranch: vi.fn(),
  headSha: vi.fn(),
  unlandedCommits: vi.fn(),
  dirtyPaths: vi.fn(),
}));

import {
  detectBranch,
  detectBaseBranch,
  headSha,
  unlandedCommits,
  dirtyPaths,
} from "../src/gitContext.js";
import { buildChangeReport } from "../src/changeReport.js";

const baseConfig: Config = {
  HUB_URL: "http://hub.test",
  TEAM_TOKEN: "tok",
  HEARTBEAT_INTERVAL_SECONDS: 60,
  SHEPHERD_NO_AUTO_HOOKS: false,
} as Config;

const CWD = "/repo";

beforeEach(() => {
  vi.mocked(detectBranch).mockReset();
  vi.mocked(detectBaseBranch).mockReset();
  vi.mocked(headSha).mockReset();
  vi.mocked(unlandedCommits).mockReset();
  vi.mocked(dirtyPaths).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildChangeReport", () => {
  it("builds a report with committed + uncommitted entries and branch/base/head", async () => {
    vi.mocked(detectBranch).mockReturnValue("feat/x");
    vi.mocked(headSha).mockReturnValue("headsha");
    vi.mocked(detectBaseBranch).mockReturnValue("origin/main");
    vi.mocked(unlandedCommits).mockReturnValue({
      commits: [
        { sha: "sha1", message: "fix a", paths: ["src/a.ts"] },
        { sha: "sha2", message: "fix b", paths: ["src/b.ts", "src/c.ts"] },
      ],
      truncated: false,
    });
    vi.mocked(dirtyPaths).mockReturnValue({
      paths: ["src/dirty.ts"],
      truncated: false,
    });

    const report = await buildChangeReport(CWD, baseConfig);

    expect(report).toBeDefined();
    expect(report!.branch).toBe("feat/x");
    expect(report!.baseBranch).toBe("origin/main");
    expect(report!.head).toBe("headsha");
    expect(report!.truncated).toBe(false);

    const committed = report!.entries.filter((e) => e.kind === "committed");
    const uncommitted = report!.entries.filter((e) => e.kind === "uncommitted");
    expect(committed).toEqual([
      { kind: "committed", sha: "sha1", message: "fix a", paths: ["src/a.ts"] },
      { kind: "committed", sha: "sha2", message: "fix b", paths: ["src/b.ts", "src/c.ts"] },
    ]);
    expect(uncommitted).toEqual([
      { kind: "uncommitted", sha: null, message: null, paths: ["src/dirty.ts"] },
    ]);
  });

  it("skips committed entries with empty paths (defensive against empty/merge commits)", async () => {
    vi.mocked(detectBranch).mockReturnValue("feat/x");
    vi.mocked(headSha).mockReturnValue("headsha");
    vi.mocked(detectBaseBranch).mockReturnValue("origin/main");
    vi.mocked(unlandedCommits).mockReturnValue({
      commits: [
        { sha: "empty", message: "merge commit", paths: [] },
        { sha: "real", message: "fix a", paths: ["src/a.ts"] },
      ],
      truncated: false,
    });
    vi.mocked(dirtyPaths).mockReturnValue({ paths: [], truncated: false });

    const report = await buildChangeReport(CWD, baseConfig);

    const committed = report!.entries.filter((e) => e.kind === "committed");
    expect(committed).toEqual([
      { kind: "committed", sha: "real", message: "fix a", paths: ["src/a.ts"] },
    ]);
    // No committed entry may carry empty paths (hub contract requires min(1)).
    expect(committed.every((e) => e.paths.length > 0)).toBe(true);
  });

  it("returns undefined when not a git repo (branch & head null)", async () => {
    vi.mocked(detectBranch).mockReturnValue(null);
    vi.mocked(headSha).mockReturnValue(null);
    vi.mocked(detectBaseBranch).mockReturnValue(null);
    vi.mocked(unlandedCommits).mockReturnValue({ commits: [], truncated: false });
    vi.mocked(dirtyPaths).mockReturnValue({ paths: [], truncated: false });

    const report = await buildChangeReport(CWD, baseConfig);
    expect(report).toBeUndefined();
  });

  it("returns a report with only the uncommitted entry when base is unresolvable but repo exists", async () => {
    vi.mocked(detectBranch).mockReturnValue("feat/x");
    vi.mocked(headSha).mockReturnValue("headsha");
    vi.mocked(detectBaseBranch).mockReturnValue(null); // unresolvable
    vi.mocked(dirtyPaths).mockReturnValue({
      paths: ["src/dirty.ts"],
      truncated: false,
    });

    const report = await buildChangeReport(CWD, baseConfig);

    expect(report).toBeDefined();
    expect(report!.entries).toEqual([
      { kind: "uncommitted", sha: null, message: null, paths: ["src/dirty.ts"] },
    ]);
    expect(typeof report!.baseBranch).toBe("string");
    // unlandedCommits must not be consulted when base is unresolvable.
    expect(unlandedCommits).not.toHaveBeenCalled();
  });

  it("returns a report with entries:[] when the tree is clean and nothing unlanded", async () => {
    vi.mocked(detectBranch).mockReturnValue("feat/x");
    vi.mocked(headSha).mockReturnValue("headsha");
    vi.mocked(detectBaseBranch).mockReturnValue("origin/main");
    vi.mocked(unlandedCommits).mockReturnValue({ commits: [], truncated: false });
    vi.mocked(dirtyPaths).mockReturnValue({ paths: [], truncated: false });

    const report = await buildChangeReport(CWD, baseConfig);

    expect(report).toBeDefined();
    expect(report!.entries).toEqual([]);
  });

  it("propagates truncated when unlandedCommits hit its cap", async () => {
    vi.mocked(detectBranch).mockReturnValue("feat/x");
    vi.mocked(headSha).mockReturnValue("headsha");
    vi.mocked(detectBaseBranch).mockReturnValue("origin/main");
    vi.mocked(unlandedCommits).mockReturnValue({
      commits: [{ sha: "s", message: "m", paths: ["p"] }],
      truncated: true,
    });
    vi.mocked(dirtyPaths).mockReturnValue({ paths: [], truncated: false });

    const report = await buildChangeReport(CWD, baseConfig);
    expect(report!.truncated).toBe(true);
  });

  it("propagates truncated when dirtyPaths hit its cap", async () => {
    vi.mocked(detectBranch).mockReturnValue("feat/x");
    vi.mocked(headSha).mockReturnValue("headsha");
    vi.mocked(detectBaseBranch).mockReturnValue("origin/main");
    vi.mocked(unlandedCommits).mockReturnValue({ commits: [], truncated: false });
    vi.mocked(dirtyPaths).mockReturnValue({ paths: ["p"], truncated: true });

    const report = await buildChangeReport(CWD, baseConfig);
    expect(report!.truncated).toBe(true);
  });

  it("honours config.BASE_BRANCH over detectBaseBranch", async () => {
    vi.mocked(detectBranch).mockReturnValue("feat/x");
    vi.mocked(headSha).mockReturnValue("headsha");
    vi.mocked(unlandedCommits).mockReturnValue({ commits: [], truncated: false });
    vi.mocked(dirtyPaths).mockReturnValue({ paths: [], truncated: false });

    const cfg = { ...baseConfig, BASE_BRANCH: "develop" } as Config;
    const report = await buildChangeReport(CWD, cfg);

    expect(report!.baseBranch).toBe("develop");
    expect(detectBaseBranch).not.toHaveBeenCalled();
    expect(unlandedCommits).toHaveBeenCalledWith(CWD, "develop");
  });
});
